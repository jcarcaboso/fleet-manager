#!/usr/bin/env python3
"""Create private configuration and TLS certificates for a new Fleet installation."""

import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import subprocess
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--host', default=os.environ.get('FLEET_HOSTNAME'), help='Private hostname or IP (default: FLEET_HOSTNAME)')
parser.add_argument('--bind-ip', default='127.0.0.1', help='Homelab interface IP published by Docker')
parser.add_argument('--port', type=int, default=7443)
parser.add_argument('--directory', type=Path, default=Path(__file__).resolve().parent)
args = parser.parse_args()
if not args.host:
    parser.error('set FLEET_HOSTNAME or supply --host')
try:
    ipaddress.ip_address(args.bind_ip)
except ValueError:
    parser.error('--bind-ip must be an IP address')
if not 1 <= args.port <= 65535:
    parser.error('--port must be between 1 and 65535')
try:
    address = ipaddress.ip_address(args.host)
    san = 'IP:' + str(address)
    url_host = '[' + str(address) + ']' if address.version == 6 else str(address)
except ValueError:
    if len(args.host) > 253 or not all(re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', label) for label in args.host.split('.')):
        parser.error('--host must be a DNS hostname or IP address')
    san = 'DNS:' + args.host
    url_host = args.host

os.umask(0o077)
root = args.directory.resolve()
root.mkdir(parents=True, exist_ok=True)
if any((root / name).exists() for name in ['.env', 'secrets', 'operator.env']):
    parser.error('configuration already exists; refusing to replace identity, credentials, or database password')
private = root / 'secrets'
tls = private / 'tls'
tls.mkdir(parents=True)
(root / 'ssh').mkdir(exist_ok=True)

def openssl(*arguments):
    subprocess.run(['openssl', *arguments], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
        '-keyout', str(tls / 'ca.key'), '-out', str(tls / 'ca.pem'), '-days', '365', '-subj', '/CN=Fleet homelab CA',
        '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign')
openssl('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
        '-keyout', str(tls / 'server.key'), '-out', str(tls / 'server.csr'), '-subj', '/CN=' + args.host)
extensions = tls / 'server.ext'
extensions.write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n'
                      + 'subjectAltName=' + ','.join(dict.fromkeys([san, 'DNS:localhost', 'IP:127.0.0.1', 'IP:::1'])) + '\n')
openssl('x509', '-req', '-in', str(tls / 'server.csr'), '-CA', str(tls / 'ca.pem'), '-CAkey', str(tls / 'ca.key'),
        '-CAcreateserial', '-out', str(tls / 'server.pem'), '-days', '90', '-extfile', str(extensions))
for name in ['server.csr', 'server.ext', 'ca.srl']:
    (tls / name).unlink(missing_ok=True)

password = secrets.token_hex(32)
token = secrets.token_urlsafe(32)
(private / 'postgres-password').write_text(password + '\n')
# PostgreSQL's unprivileged process reads this individual mounted file. The host directory remains 0700.
(private / 'postgres-password').chmod(0o444)
config = {
    'ConnectionStrings': {'Fleet': 'Host=postgres;Database=fleet;Username=fleet;Password=' + password},
    'Fleet': {'WorkspaceId': str(uuid.uuid4()), 'Operators': {'homelab-admin': hashlib.sha256(token.encode()).hexdigest()},
              'IssuerCertificatePath': '/run/fleet/tls/ca.pem', 'IssuerKeyPath': '/run/fleet/tls/ca.key'},
    'Kestrel': {'Certificates': {'Default': {'Path': '/run/fleet/tls/server.pem', 'KeyPath': '/run/fleet/tls/server.key'}}},
    'Source': {'MirrorPath': '/var/lib/fleet/source.git'},
}
(private / 'server.json').write_text(json.dumps(config, indent=2) + '\n')
bind = '[' + args.bind_ip + ']' if ':' in args.bind_ip else args.bind_ip
(root / '.env').write_text('FLEET_IMAGE=skorcius/fleet-manager:0.1.0-poc.20260908\n'
                           + f'FLEET_HOSTNAME={args.host}\nFLEET_BIND_IP={bind}\nFLEET_PORT={args.port}\nFLEET_SOURCE_REMOTE=\n')
(root / 'operator.env').write_text('export FLEET_SERVER_URL=' + shlex.quote(f'https://{url_host}:{args.port}') + '\n'
                                   + 'export FLEET_OPERATOR_TOKEN=' + shlex.quote(token) + '\n')
print('Created private homelab configuration. Keep secrets/ and operator.env out of source control.')
print('Start the stack with: docker compose up -d --wait')
