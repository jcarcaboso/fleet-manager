#!/bin/sh
# Prepare the runtime files that nginx includes, then start nginx.
#
# The image is read-only, so everything generated here goes to /tmp/fleet (a tmpfs):
#   config.json  {"apiUrl": FLEET_API_ORIGIN}, served as /config.json
#   csp.conf     the Content-Security-Policy header, with FLEET_API_ORIGIN in connect-src
set -eu

fail() {
    echo "fleet-dashboard: $*" >&2
    exit 64
}

origin="${FLEET_API_ORIGIN:-}"
[ -n "$origin" ] || fail "FLEET_API_ORIGIN is required. Set it to the Server's public HTTPS origin, for example https://fleet.home.arpa:7443."

# IPv6 literals are refused with their own message: CSP host-source syntax has no form for them, so a browser would
# drop the connect-src entry and block every API call.
case "$origin" in
    *[][]*) fail "FLEET_API_ORIGIN must not be an IPv6 literal such as https://[::1]:7443: browsers cannot allow it in the Content-Security-Policy, so every API call would be blocked. Use a DNS hostname (or an IPv4 address) for the Server, for example https://fleet.home.arpa:7443." ;;
esac
# Allow-list the characters, so that nothing that could break out of the JSON or the header gets further.
# This also rejects whitespace, quotes, newlines, userinfo (@), paths with odd characters, and queries.
case "$origin" in
    *[!A-Za-z0-9.:/-]*) fail "FLEET_API_ORIGIN contains characters that are not allowed in an origin." ;;
esac
[ "${#origin}" -le 300 ] || fail "FLEET_API_ORIGIN is too long."
origin=$(printf '%s' "$origin" | tr 'A-Z' 'a-z')

label='[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
port=':[1-9][0-9]{0,4}'
if printf '%s\n' "$origin" | grep -Eq "^https://($label)(\.$label)*($port)?\$"; then
    :
elif printf '%s\n' "$origin" | grep -Eq "^http://(localhost|127\.0\.0\.1)($port)?\$"; then
    :
else
    fail "FLEET_API_ORIGIN must be a bare HTTPS origin such as https://fleet.home.arpa:7443 (a DNS hostname or IPv4 address, no path, query, fragment, credentials or trailing slash). Plain http is accepted only for http://localhost and http://127.0.0.1. Got: $origin"
fi
if printf '%s\n' "$origin" | grep -Eq "$port\$"; then
    number="${origin##*:}"
    [ "$number" -le 65535 ] || fail "FLEET_API_ORIGIN has a port above 65535: $number"
fi

for file in /run/dashboard-tls/dashboard.pem /run/dashboard-tls/dashboard.key; do
    [ -r "$file" ] || fail "$file is missing or not readable by uid $(id -u). Mount the dashboard-tls volume (dashboard.pem and dashboard.key, plus the public ca.pem) at /run/dashboard-tls and run the container as the user that owns it. An installation created before the dashboard had its own certificate needs: python3 setup.py --add-dashboard"
done

runtime=/tmp/fleet
mkdir -p "$runtime" 2>/dev/null && [ -w "$runtime" ] || fail "$runtime is not writable. Mount a tmpfs at /tmp."
printf '{"apiUrl":"%s"}\n' "$origin" > "$runtime/config.json"
printf '%s\n' "add_header Content-Security-Policy \"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self' $origin; base-uri 'none'; frame-ancestors 'none'; form-action 'none'\" always;" > "$runtime/csp.conf"

nginx -t -q || fail "the nginx configuration is invalid."
exec "$@"
