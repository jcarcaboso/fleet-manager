#!/usr/bin/env python3
"""Enroll a disposable real Agent through the dashboard API of a test server."""
import argparse
import base64
import http.cookiejar
import json
import os
from pathlib import Path
import ssl
import subprocess
import tempfile
import urllib.error
import urllib.request
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--agent', type=Path, required=True)
args = parser.parse_args()
server = os.environ['FLEET_SERVER_URL'].rstrip('/')
operator_token = os.environ['FLEET_OPERATOR_TOKEN']
ca = Path(os.environ['FLEET_CA_CERT'])
context = ssl.create_default_context(cafile=ca)
cookies = http.cookiejar.CookieJar()
browser = urllib.request.build_opener(urllib.request.HTTPSHandler(context=context),
                                     urllib.request.HTTPCookieProcessor(cookies))
csrf = ''


def request(path, body=None, expected=200):
    data = None if body is None else json.dumps(body).encode()
    headers = {'Content-Type': 'application/json', 'Origin': server, 'X-Fleet-CSRF': csrf}
    req = urllib.request.Request(server + path, data=data, headers=headers)
    try:
        response = browser.open(req, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        assert response.code == expected, f'{path}: unexpected HTTP {response.code}'
        return json.load(response) if expected == 200 else None


csrf = request('/dashboard/api/csrf')['token']
request('/dashboard/api/login', {'token': operator_token})
csrf = request('/dashboard/api/csrf')['token']
request('/operator/v1/nodes', expected=401)
alias = 'enrollment-smoke-' + uuid.uuid4().hex[:12]
authorization = request('/dashboard/api/enrollment-links', {'alias': alias, 'expiresInSeconds': 900})
link = authorization['link']
with tempfile.TemporaryDirectory(prefix='fleet-enrollment-smoke-') as directory:
    root = Path(directory).resolve()
    home = root / 'home'
    home.mkdir()
    state = root / 'state'
    command = [str(args.agent.resolve()), '--state-dir', str(state)]
    # Keep stdin open after Enter. This detects prompts that mistakenly wait for EOF.
    process = subprocess.Popen([*command, 'enroll', '--link', '--home', str(home)],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        process.stdin.write(link + '\n')
        process.stdin.flush()
        process.wait(timeout=45)
        output = process.stdout.read()
        error = process.stderr.read()
        assert process.returncode == 0, 'Agent enrollment failed: ' + error
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        process.stdin.close()
        process.stdout.close()
        process.stderr.close()
    identity = json.loads(output)
    assert identity['alias'] == alias
    payload_text = link.split('#fleet-v1=', 1)[1]
    payload = json.loads(base64.urlsafe_b64decode(payload_text + '=' * (-len(payload_text) % 4)))
    secret = payload['token']
    assert secret not in output + error
    for path in state.rglob('*'):
        if path.is_file():
            assert secret.encode() not in path.read_bytes(), 'Enrollment secret persisted to Agent state'
    cycle = subprocess.run([*command, 'run', '--once'], capture_output=True, text=True, timeout=45)
    assert cycle.returncode == 0, 'Enrolled Agent poll failed: ' + cycle.stderr
    nodes = request('/dashboard/api/nodes')['items']
    node = next(value for value in nodes if value['name'] == alias)
    assert node['lastContactAt'] is not None
    renamed = alias + '-renamed'
    request('/dashboard/api/nodes/rename', {'currentAlias': alias, 'alias': renamed})
    # A revoked unused authorization must fail through the actual Agent as well.
    revoked = request('/dashboard/api/enrollment-links', {'alias': alias + '-revoked'})
    request('/dashboard/api/enrollment-links/' + revoked['id'] + '/revoke', {})
    rejected = subprocess.run([str(args.agent.resolve()), '--state-dir', str(root / 'revoked'),
                               'enroll', '--link', '--home', str(home)],
                              input=revoked['link'] + '\n', capture_output=True, text=True, timeout=45)
    assert rejected.returncode != 0, 'Revoked link enrolled a Node'
    # A validly formatted CA from another issuer must fail real TLS verification.
    key = root / 'wrong.key'
    certificate = root / 'wrong.pem'
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
                    '-nodes', '-keyout', str(key), '-out', str(certificate), '-days', '1',
                    '-subj', '/CN=Wrong test CA', '-addext', 'basicConstraints=critical,CA:TRUE'],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    payload['caPem'] = certificate.read_text()
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip('=')
    wrong_trust = subprocess.run([str(args.agent.resolve()), '--state-dir', str(root / 'wrong-trust'),
                                  'enroll', '--link', '--home', str(home)],
                                 input=server + '/enroll#fleet-v1=' + encoded + '\n',
                                 capture_output=True, text=True, timeout=45)
    assert wrong_trust.returncode != 0, 'Wrong CA accepted'
    assert 'certificate' in wrong_trust.stderr.lower(), 'Wrong CA failed for an unrelated reason'
    # Remove the test Node's access after verifying the complete flow.
    cleanup = urllib.request.Request(server + '/operator/v1/nodes/' + identity['nodeId'] + '/revoke',
                                     data=b'{}', headers={'Authorization': 'Bearer ' + operator_token,
                                                         'Content-Type': 'application/json'})
    with urllib.request.urlopen(cleanup, context=context, timeout=30) as response:
        assert response.status == 200
request('/dashboard/api/logout', {})
request('/dashboard/api/session', expected=401)
print('Dashboard enrollment, newline prompt, mTLS poll, alias change, revoked link, wrong CA, and session isolation passed.')
