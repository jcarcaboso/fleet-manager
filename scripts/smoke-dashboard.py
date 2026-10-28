#!/usr/bin/env python3
"""Check a running Server and its separate dashboard together, without a browser.

Environment: FLEET_SERVER_URL, FLEET_OPERATOR_TOKEN, FLEET_CA_CERT, FLEET_DASHBOARD_URL, and optionally
FLEET_DASHBOARD_NAME and FLEET_DASHBOARD_PASSWORD (a dashboard account; default fleet/fleet).

It verifies the dashboard container (files, config.json, headers, route fallback, asset content types), the
Server's redirect from /dashboard, the CORS contract of /dashboard/api for the dashboard origin and its absence
for any other origin, and an account sign-in from the dashboard origin with a cookie jar. The Operator token is
used only for /operator/v1. An account that still has to change its password is checked to be refused by every
other route; the script never changes a password. A browser is still needed to see the application render; this
script proves the wiring it depends on.
"""

import http.cookiejar
import json
import os
from html.parser import HTMLParser
from pathlib import Path
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

SERVER = os.environ['FLEET_SERVER_URL'].rstrip('/')
DASHBOARD = os.environ['FLEET_DASHBOARD_URL'].rstrip('/')
OPERATOR = os.environ['FLEET_OPERATOR_TOKEN']
ACCOUNT = os.environ.get('FLEET_DASHBOARD_NAME', 'fleet')
PASSWORD = os.environ.get('FLEET_DASHBOARD_PASSWORD', 'fleet')
CA = Path(os.environ['FLEET_CA_CERT'])
OTHER_ORIGIN = 'https://other-site.invalid'
CONTEXT = ssl.create_default_context(cafile=CA)


def origin_of(url):
    parts = urllib.parse.urlsplit(url)
    return f'{parts.scheme}://{parts.netloc}'.lower()


SERVER_ORIGIN = origin_of(SERVER)
DASHBOARD_ORIGIN = origin_of(DASHBOARD)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def opener(cookies=None):
    handlers = [urllib.request.HTTPSHandler(context=CONTEXT), NoRedirect()]
    if cookies is not None:
        handlers.append(urllib.request.HTTPCookieProcessor(cookies))
    return urllib.request.build_opener(*handlers)


PLAIN = opener()
passed = []


def check(condition, message):
    if not condition:
        print(f'dashboard smoke failed: {message}', file=sys.stderr)
        sys.exit(1)


def fetch(url, method='GET', headers=None, body=None, browser=PLAIN):
    """Return (status, headers, body bytes). Redirects are not followed."""
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        response = browser.open(request, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status if hasattr(response, 'status') else response.code, response.headers, response.read()


def done(name):
    passed.append(name)
    print('ok  ' + name)


# ---------------------------------------------------------------- dashboard container

EXPECTED_CSP = {
    'default-src': ["'none'"], 'script-src': ["'self'"], 'style-src': ["'self'"], 'img-src': ["'self'"],
    'font-src': ["'self'"], 'connect-src': ["'self'", SERVER_ORIGIN], 'base-uri': ["'none'"],
    'frame-ancestors': ["'none'"], 'form-action': ["'none'"],
}


def parse_csp(value):
    directives = {}
    for part in value.split(';'):
        tokens = part.split()
        if tokens:
            directives[tokens[0].lower()] = tokens[1:]
    return directives


def check_security_headers(headers, where, cache_control=None):
    check(len(headers.get_all('Content-Security-Policy') or []) == 1, f'{where}: expected one Content-Security-Policy header')
    csp = parse_csp(headers['Content-Security-Policy'])
    check(csp == {key: value for key, value in EXPECTED_CSP.items()}, f'{where}: unexpected CSP {headers["Content-Security-Policy"]!r}')
    check(headers['Referrer-Policy'] == 'no-referrer', f'{where}: Referrer-Policy')
    check(headers['X-Content-Type-Options'] == 'nosniff', f'{where}: X-Content-Type-Options')
    check(headers['Cross-Origin-Opener-Policy'] == 'same-origin', f'{where}: Cross-Origin-Opener-Policy')
    policy = headers['Permissions-Policy'] or ''
    check(policy and all(item.strip().endswith('=()') for item in policy.split(',')), f'{where}: Permissions-Policy must deny every feature it names')
    check('X-Frame-Options' not in headers, f'{where}: X-Frame-Options must be left to frame-ancestors')
    check('Server' not in headers or '/' not in headers['Server'], f'{where}: the Server header leaks a version')
    if cache_control is not None:
        check(headers['Cache-Control'] == cache_control, f'{where}: Cache-Control is {headers["Cache-Control"]!r}, expected {cache_control!r}')


class Resources(HTMLParser):
    def __init__(self):
        super().__init__()
        self.assets, self.inline_script, self.inline_style, self.inline_handlers = [], False, False, False

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if any(name.startswith('on') for name in attributes):
            self.inline_handlers = True
        if 'style' in attributes:
            self.inline_style = True
        if tag == 'script':
            if attributes.get('src'):
                self.assets.append(attributes['src'])
            else:
                self.inline_script = True
        elif tag == 'style':
            self.inline_style = True
        elif tag == 'link' and attributes.get('href') and (attributes.get('rel') or '') != 'canonical':
            self.assets.append(attributes['href'])


status, headers, index = fetch(DASHBOARD + '/')
check(status == 200, f'dashboard index returned {status}')
check(headers['Content-Type'].startswith('text/html'), 'dashboard index is not text/html')
check_security_headers(headers, 'index.html', cache_control='no-store')
done('dashboard index and security headers')

status, headers, body = fetch(DASHBOARD + '/config.json')
check(status == 200 and headers['Content-Type'].startswith('application/json'), 'config.json is not served as JSON')
check(headers['Cache-Control'] == 'no-store', 'config.json must be no-store')
config = json.loads(body)
check(config == {'apiUrl': SERVER_ORIGIN}, f'config.json apiUrl {config!r} is not the Server origin {SERVER_ORIGIN}')
check_security_headers(headers, 'config.json')
done('config.json carries the Server origin')

for route in ['/machines', '/machines/some-node/overview', '/problems', '/deployments', '/deployments/abc', '/repository',
              '/models', '/enrollment', '/audit', '/login']:
    status, headers, body = fetch(DASHBOARD + route + '?probe=1')
    check(status == 200 and body == index, f'{route} did not fall back to index.html')
    check(headers['Cache-Control'] == 'no-store', f'{route} fallback must be no-store')
done('SPA fallback for every route')

resources = Resources()
resources.feed(index.decode())
check(resources.assets, 'index.html references no script or stylesheet')
check(not resources.inline_script and not resources.inline_style and not resources.inline_handlers,
      'index.html has inline script, style or event handlers, which the content security policy blocks')
TYPES = {'.js': 'javascript', '.mjs': 'javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
         '.png': 'image/png', '.ico': 'image/', '.json': 'json', '.webmanifest': 'json'}
for reference in resources.assets:
    parts = urllib.parse.urlsplit(reference)
    check(not parts.scheme and not parts.netloc and parts.path.startswith('/'), f'index.html loads a non-local resource: {reference}')
    status, headers, body = fetch(DASHBOARD + parts.path)
    check(status == 200 and body, f'{reference} returned {status}')
    expected = TYPES.get(os.path.splitext(parts.path)[1])
    check(expected is None or expected in headers['Content-Type'], f'{reference} has Content-Type {headers["Content-Type"]}')
    check(headers['X-Content-Type-Options'] == 'nosniff', f'{reference} is missing nosniff')
    if parts.path.startswith('/assets/'):
        check('immutable' in (headers['Cache-Control'] or '') and 'max-age=31536000' in headers['Cache-Control'],
              f'{reference} is not cached as immutable')
done(f'{len(resources.assets)} asset(s) from index.html load with correct types and caching')

status, headers, _ = fetch(DASHBOARD + '/assets/missing-0000.js')
check(status == 404 and 'immutable' not in (headers['Cache-Control'] or ''), 'a missing hashed asset must be an uncached 404')
check(fetch(DASHBOARD + '/missing.js')[0] == 404, 'a missing file must be a 404, not index.html')
for path in ['/.env', '/.git/config', '/assets/.x', '/%2eenv']:
    check(fetch(DASHBOARD + path)[0] == 404, f'{path} was not a 404')
for path in ['/machines/.hidden', '/machines/.hidden/overview', '/machines/%2Ehidden', '/machines/a/.b']:
    status, _, body = fetch(DASHBOARD + path)
    check(status == 200 and body == index, f'{path}: a Node alias that starts with a dot must still get the application')
# Pages that nginx generates itself carry the same security headers.
for path, expected in [('/../../etc/passwd', 400), ('/%2e%2e/%2e%2e/etc/passwd', 400), ('/missing.js', 404), ('/.git/config', 404)]:
    status, headers, _ = fetch(DASHBOARD + path)
    check(status == expected, f'{path} returned {status}, expected {expected}')
    check_security_headers(headers, f'{expected} for {path}')
for method in ['POST', 'PUT', 'DELETE']:
    status, headers, _ = fetch(DASHBOARD + '/', method=method, headers={'Content-Type': 'application/json'}, body={})
    check(status == 405 and 'GET' in (headers['Allow'] or ''), f'{method} to the dashboard returned {status}')
    check_security_headers(headers, f'405 for {method}')
check(fetch(DASHBOARD + '/healthz')[0] == 200, 'dashboard /healthz failed')
done('404 for files, dotfiles denied, 405 for writes, healthz')

# ---------------------------------------------------------------- Server redirect

for path in ['/dashboard', '/dashboard/machines', '/dashboard/app.js', '/']:
    status, headers, _ = fetch(SERVER + path)
    check(status == 302, f'GET {path} on the Server returned {status}, not a redirect')
    check((headers['Location'] or '').rstrip('/') == DASHBOARD_ORIGIN, f'GET {path} redirects to {headers["Location"]!r}')
done('the Server redirects /, /dashboard and /dashboard/... (no assets) to the dashboard origin')

# ---------------------------------------------------------------- CORS

API = SERVER + '/dashboard/api'
preflight = {'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-fleet-csrf'}
status, headers, _ = fetch(API + '/login', 'OPTIONS', {'Origin': DASHBOARD_ORIGIN, **preflight})
check(status == 204, f'preflight from the dashboard origin returned {status}')
check(headers['Access-Control-Allow-Origin'] == DASHBOARD_ORIGIN, 'preflight: Access-Control-Allow-Origin')
check(headers['Access-Control-Allow-Credentials'] == 'true', 'preflight: Access-Control-Allow-Credentials')
check('Origin' in (headers['Vary'] or ''), 'preflight: Vary: Origin')
check(headers['Access-Control-Allow-Methods'] == 'GET, POST, OPTIONS', f'preflight: methods {headers["Access-Control-Allow-Methods"]!r}')
check(headers['Access-Control-Allow-Headers'] == 'Content-Type, X-Fleet-CSRF', f'preflight: headers {headers["Access-Control-Allow-Headers"]!r}')
check(headers['Access-Control-Max-Age'] == '600', 'preflight: Access-Control-Max-Age')
done('CORS preflight from the dashboard origin')

status, headers, _ = fetch(API + '/login', 'OPTIONS', {'Origin': OTHER_ORIGIN, **preflight})
check(status == 403, f'preflight from another origin returned {status}')
check(not [name for name in headers.keys() if name.lower().startswith('access-control-')], 'a rejected preflight carries CORS headers')
status, headers, _ = fetch(API + '/csrf', headers={'Origin': OTHER_ORIGIN})
check('Access-Control-Allow-Origin' not in headers, 'another origin received Access-Control-Allow-Origin')
status, headers, _ = fetch(API + '/csrf')
check(status == 200 and 'Access-Control-Allow-Origin' not in headers, 'a request without Origin received CORS headers')
status, headers, _ = fetch(SERVER + '/operator/v1/nodes', headers={'Origin': DASHBOARD_ORIGIN, 'Authorization': 'Bearer ' + OPERATOR})
check(status == 200 and 'Access-Control-Allow-Origin' not in headers, '/operator/v1 must not carry CORS headers')
done('no CORS for other origins, without Origin, or on /operator/v1')

# ---------------------------------------------------------------- sign-in across origins

cookies = http.cookiejar.CookieJar()
browser = opener(cookies)
as_dashboard = {'Origin': DASHBOARD_ORIGIN, 'Accept': 'application/json'}

status, headers, body = fetch(API + '/session', headers=as_dashboard, browser=browser)
check(status == 401, f'session before sign-in returned {status}')
check(headers['Access-Control-Allow-Origin'] == DASHBOARD_ORIGIN, 'a 401 from the dashboard API must still carry CORS headers')

status, headers, body = fetch(API + '/csrf', headers=as_dashboard, browser=browser)
check(status == 200 and headers['Access-Control-Allow-Origin'] == DASHBOARD_ORIGIN, 'csrf from the dashboard origin')
csrf = json.loads(body)['token']
mutation = {**as_dashboard, 'Content-Type': 'application/json', 'X-Fleet-CSRF': csrf}

status, headers, body = fetch(API + '/login', 'POST', mutation, {'name': ACCOUNT, 'password': PASSWORD + '-wrong'}, browser)
check(status == 401, f'login with a wrong password returned {status}')
# The old token body is not a login request any more: the Server refuses the unknown member before it authenticates.
status, headers, body = fetch(API + '/login', 'POST', mutation, {'token': OPERATOR}, browser)
check(status == 400 and json.loads(body).get('code') == 'invalid_request',
      f'login with the Operator token returned {status} {body[:80]!r}; the dashboard accepts only accounts')
status, headers, body = fetch(API + '/login', 'POST', mutation, {'name': ACCOUNT, 'password': PASSWORD}, browser)
check(status == 200, f'login with the account {ACCOUNT} returned {status}')
login = json.loads(body)
check(login.get('actor') and login.get('scope') and isinstance(login.get('mustChangePassword'), bool),
      'login did not return actor, scope and mustChangePassword')
check(headers['Access-Control-Allow-Origin'] == DASHBOARD_ORIGIN and headers['Access-Control-Allow-Credentials'] == 'true', 'login response lacks CORS headers')
session_cookies = [value for value in headers.get_all('Set-Cookie') or [] if value.startswith('__Host-')]
check(session_cookies, 'login did not set a __Host- session cookie')
for value in session_cookies:
    lowered = value.lower()
    check('secure' in lowered and 'httponly' in lowered and 'samesite=strict' in lowered and 'path=/' in lowered and 'domain=' not in lowered,
          'session cookie attributes are not Secure, HttpOnly, SameSite=Strict, Path=/ without Domain')
# The default password equals the default name, which the body rightly contains, so only a real password is searched for.
if len(PASSWORD) >= 10:
    check(PASSWORD not in body.decode() and PASSWORD not in ' '.join(headers.values()), 'the password was echoed back')
done('sign-in from the dashboard origin sets a hardened cookie')

status, headers, body = fetch(API + '/session', headers=as_dashboard, browser=browser)
check(status == 200 and json.loads(body) == login, f'session after login returned {status} {body[:80]!r}')
status, headers, body = fetch(API + '/nodes?limit=5', headers=as_dashboard, browser=browser)
if login['mustChangePassword']:
    check(status == 403 and json.loads(body).get('code') == 'password_change_required',
          f'GET nodes before the required password change returned {status}')
else:
    check(status == 200 and isinstance(json.loads(body).get('items'), list), 'GET nodes with the cookie failed')
check(headers['Access-Control-Allow-Origin'] == DASHBOARD_ORIGIN, 'GET nodes lacks CORS headers')
status, headers, body = fetch(API + '/nodes?limit=5', headers={'Accept': 'application/json'}, browser=opener(http.cookiejar.CookieJar()))
check(status == 401, 'the dashboard API answered without a session')
done('session and a read route work with the cookie')

csrf = json.loads(fetch(API + '/csrf', headers=as_dashboard, browser=browser)[2])['token']
for origin in [OTHER_ORIGIN, SERVER_ORIGIN]:
    status, headers, body = fetch(API + '/logout', 'POST', {'Origin': origin, 'Content-Type': 'application/json', 'X-Fleet-CSRF': csrf}, {}, browser)
    check(status == 400 and json.loads(body).get('code') == 'invalid_origin', f'a POST from {origin} returned {status}')
    check('Access-Control-Allow-Origin' not in headers, f'a POST from {origin} received CORS headers')
status, headers, body = fetch(API + '/logout', 'POST', {'Content-Type': 'application/json', 'X-Fleet-CSRF': csrf}, {}, browser)
check(status == 400, f'a POST without Origin returned {status}')
check(fetch(API + '/session', headers=as_dashboard, browser=browser)[0] == 200, 'a rejected POST ended the session')
status, headers, body = fetch(API + '/logout', 'POST', {**as_dashboard, 'Content-Type': 'application/json'}, {}, browser)
check(status == 400 and json.loads(body).get('code') == 'invalid_csrf', f'a POST without the CSRF header returned {status}')
done('POST from another Origin, or without Origin or CSRF, is rejected')

status, headers, body = fetch(API + '/logout', 'POST', mutation | {'X-Fleet-CSRF': csrf}, {}, browser)
check(status == 200 and json.loads(body) == {'signedOut': True}, f'logout returned {status}')
check(fetch(API + '/session', headers=as_dashboard, browser=browser)[0] == 401, 'the session survived logout')
done('logout ends the session')

print(f'Dashboard smoke: {len(passed)} groups passed ({DASHBOARD_ORIGIN} with {SERVER_ORIGIN})')
