#!/usr/bin/env python3
"""Create private configuration and TLS certificates for a Fleet installation.

Without options it creates a new installation. With --add-dashboard it adds the dashboard's own certificate
to an installation that was created before the dashboard had one.
"""

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

SERVER_IMAGE = 'skorcius/fleet-manager:0.11.0'
DASHBOARD_IMAGE = 'skorcius/fleet-manager:dashboard-0.11.0'

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument('--host', default=None, help='Private DNS hostname or IPv4 address (default: FLEET_HOSTNAME; with --add-dashboard, FLEET_HOSTNAME from .env)')
parser.add_argument('--bind-ip', default=None, help='Homelab interface IP published by Docker (default: 127.0.0.1)')
parser.add_argument('--port', type=int, default=None, help='Published HTTPS port of the Server (default: 7443)')
parser.add_argument('--dashboard-port', type=int, default=None, help='Published HTTPS port of the dashboard (default: 7444, or FLEET_DASHBOARD_PORT from .env)')
parser.add_argument('--directory', type=Path, default=Path(__file__).resolve().parent)
parser.add_argument('--add-dashboard', action='store_true',
                    help='Upgrade an existing installation: issue the dashboard certificate from the existing CA and add the dashboard settings')
args = parser.parse_args()

IPV6_ADVICE = ('the dashboard cannot use an IPv6 literal: browsers drop IPv6 addresses from Content-Security-Policy host sources, '
               'so every call to the Server would be blocked. Use a DNS hostname that resolves to the address')


def check_port(option, value):
    if not 1 <= value <= 65535:
        parser.error(f'{option} must be between 1 and 65535')


def parse_host(host):
    """Return (SAN entry, host as written in a URL, ip_address or None) for a DNS name or IPv4 address."""
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        if len(host) > 253 or not all(re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', label) for label in host.split('.')):
            parser.error('--host must be a DNS hostname or IPv4 address')
        return 'DNS:' + host, host, None
    if address.version == 6:
        parser.error(f'{host} is an IPv6 literal; ' + IPV6_ADVICE)
    return 'IP:' + str(address), str(address), address


def openssl(*arguments, capture=False):
    result = subprocess.run(['openssl', *arguments], check=True, stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, text=capture)
    return result.stdout


def issue_certificate(tls, name, common_name, sans, days):
    """Create tls/NAME.key and tls/NAME.pem, a server certificate signed by the CA in tls/."""
    outputs = [tls / (name + suffix) for suffix in ('.key', '.pem', '.csr', '.ext')]
    try:
        openssl('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-pkeyopt', 'ec_param_enc:named_curve', '-nodes',
                '-keyout', str(tls / (name + '.key')), '-out', str(tls / (name + '.csr')), '-subj', '/CN=' + common_name)
        # Strict verifiers (Python 3.13+ by default) reject a certificate without an authority key identifier, or with a key in
        # explicit curve parameters or signed with SHA-1, which LibreSSL does unless told otherwise. openssl x509 -req adds no key
        # identifiers of its own with -extfile, so they are explicit; keyid,issuer still works with a CA that has no SKI.
        (tls / (name + '.ext')).write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n'
                                           + 'subjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n'
                                           + 'subjectAltName=' + ','.join(dict.fromkeys(sans)) + '\n')
        openssl('x509', '-req', '-sha256', '-in', str(tls / (name + '.csr')), '-CA', str(tls / 'ca.pem'), '-CAkey', str(tls / 'ca.key'),
                '-CAcreateserial', '-out', str(tls / (name + '.pem')), '-days', str(days), '-extfile', str(tls / (name + '.ext')))
    except BaseException:
        for output in outputs[:2]:
            output.unlink(missing_ok=True)
        raise
    finally:
        for output in outputs[2:]:
            output.unlink(missing_ok=True)
        (tls / 'ca.srl').unlink(missing_ok=True)


def read_env(path):
    values = {}
    for line in path.read_text().splitlines():
        match = re.fullmatch(r'\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)', line)
        if match:
            values[match.group(1)] = match.group(2).strip().strip('\'"')
    return values


def certificate_names(certificate):
    """Subject alternative names of a certificate as 'DNS:name' and 'IP:address' entries."""
    names = []
    # -text rather than -ext subjectAltName, which LibreSSL (macOS's openssl) does not have. The names follow their header line.
    lines = openssl('x509', '-in', str(certificate), '-noout', '-text', capture=True).splitlines()
    header = next((i for i, line in enumerate(lines) if line.strip().startswith('X509v3 Subject Alternative Name')), None)
    for part in ('' if header is None else lines[header + 1]).split(','):
        part = part.strip()
        if part.startswith('DNS:'):
            names.append(part)
        elif part.startswith('IP Address:'):
            names.append('IP:' + str(ipaddress.ip_address(part[len('IP Address:'):])))
    return names


def add_dashboard():
    if args.port is not None or args.bind_ip is not None:
        parser.error('--port and --bind-ip belong to the first setup and do not apply to --add-dashboard')
    root = args.directory.resolve()
    private = root / 'secrets'
    tls = private / 'tls'
    missing = [str(path.relative_to(root)) for path in [root / '.env', private / 'server.json', tls / 'ca.pem', tls / 'ca.key', tls / 'server.pem'] if not path.is_file()]
    if missing:
        parser.error(f'{root} is not an existing installation (missing {", ".join(missing)}); run setup.py without --add-dashboard to create one')
    existing = [name for name in ['dashboard.pem', 'dashboard.key'] if (tls / name).exists()]
    if existing:
        parser.error(f'secrets/tls/{existing[0]} already exists; refusing to overwrite the dashboard identity')

    env = read_env(root / '.env')
    host = args.host or env.get('FLEET_HOSTNAME')
    if not host:
        parser.error('FLEET_HOSTNAME is not set in .env; supply --host')
    san, url_host, _ = parse_host(host)
    names = certificate_names(tls / 'server.pem')
    if san not in names:
        parser.error(f'{host} is not covered by the Server certificate ({", ".join(names) or "no names"}); '
                     'the dashboard certificate carries the same names as the Server certificate')
    try:
        server_port = int(env.get('FLEET_PORT', '7443'))
        port = int(env['FLEET_DASHBOARD_PORT']) if 'FLEET_DASHBOARD_PORT' in env else (args.dashboard_port or 7444)
    except ValueError:
        parser.error('FLEET_PORT or FLEET_DASHBOARD_PORT in .env is not a number')
    if args.dashboard_port is not None and 'FLEET_DASHBOARD_PORT' in env and args.dashboard_port != port:
        parser.error(f'.env already sets FLEET_DASHBOARD_PORT={port}; edit it there instead of passing --dashboard-port')
    check_port('the dashboard port', port)
    if port == server_port:
        parser.error('the dashboard port must differ from the Server port')
    dashboard_url = env.get('FLEET_DASHBOARD_URL') or f'https://{url_host}:{port}'

    config_path = private / 'server.json'
    config = json.loads(config_path.read_text())
    fleet = config.setdefault('Fleet', {})
    set_origin = not fleet.get('DashboardOrigin')
    if set_origin:
        fleet['DashboardOrigin'] = dashboard_url
    additions = [(key, value) for key, value in [('FLEET_DASHBOARD_IMAGE', DASHBOARD_IMAGE), ('FLEET_DASHBOARD_PORT', str(port)),
                                                 ('FLEET_DASHBOARD_URL', dashboard_url)] if key not in env]

    os.umask(0o077)
    issue_certificate(tls, 'dashboard', host, names, 90)
    if set_origin:
        temporary = config_path.with_name('server.json.new')
        temporary.write_text(json.dumps(config, indent=2) + '\n')
        temporary.replace(config_path)
    if additions:
        text = (root / '.env').read_text()
        with (root / '.env').open('a') as handle:
            handle.write(('' if text.endswith('\n') or not text else '\n') + '# Added by setup.py --add-dashboard\n'
                         + ''.join(f'{key}={value}\n' for key, value in additions))

    print('Added the dashboard certificate: secrets/tls/dashboard.pem and secrets/tls/dashboard.key, signed by the existing CA with the')
    print('same names as the Server certificate. The CA, the Server certificate, the database password and the Operator token are unchanged.')
    print('Settings added: ' + (', '.join(key for key, _ in additions) or 'none in .env (already present)') + ('; DashboardOrigin in secrets/server.json' if set_origin else '') + '.')
    print('Next steps:')
    print('  1. Replace compose.yaml with this release\'s copy. It adds the dashboard-tls volume and the dashboard service.')
    print(f'  2. Open TCP port {port} to your browsers, on the same interface and firewall as the Server port.')
    print('  3. Run: docker compose pull && docker compose up -d --force-recreate --wait')
    print(f'  4. Open {dashboard_url} and sign in as fleet with the password fleet. You must choose a new password at the first sign-in.')


if args.add_dashboard:
    add_dashboard()
    raise SystemExit(0)

host = args.host or os.environ.get('FLEET_HOSTNAME')
bind_ip = args.bind_ip or '127.0.0.1'
port = 7443 if args.port is None else args.port
dashboard_port = 7444 if args.dashboard_port is None else args.dashboard_port
if not host:
    parser.error('set FLEET_HOSTNAME or supply --host')
try:
    ipaddress.ip_address(bind_ip)
except ValueError:
    parser.error('--bind-ip must be an IP address')
check_port('--port', port)
check_port('--dashboard-port', dashboard_port)
if dashboard_port == port:
    parser.error('--dashboard-port must differ from --port')
san, url_host, _ = parse_host(host)

os.umask(0o077)
root = args.directory.resolve()
root.mkdir(parents=True, exist_ok=True)
if any((root / name).exists() for name in ['.env', 'secrets', 'operator.env']):
    parser.error('configuration already exists; refusing to replace identity, credentials, or database password. '
                 'To add the dashboard certificate to an installation created before it had one, run: setup.py --add-dashboard')
private = root / 'secrets'
tls = private / 'tls'
tls.mkdir(parents=True)
(root / 'ssh').mkdir(exist_ok=True)

openssl('req', '-x509', '-sha256', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-pkeyopt', 'ec_param_enc:named_curve', '-nodes',
        '-keyout', str(tls / 'ca.key'), '-out', str(tls / 'ca.pem'), '-days', '365', '-subj', '/CN=Fleet homelab CA',
        '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
        '-addext', 'subjectKeyIdentifier=hash')
# The Server and the dashboard get separate keys with the same names. The dashboard container never sees the Server's key or the CA key.
names = list(dict.fromkeys([san, 'DNS:localhost', 'IP:127.0.0.1', 'IP:::1']))
issue_certificate(tls, 'server', host, names, 90)
issue_certificate(tls, 'dashboard', host, names, 90)

password = secrets.token_hex(32)
token = secrets.token_urlsafe(32)
(private / 'postgres-password').write_text(password + '\n')
# PostgreSQL's unprivileged process reads this individual mounted file. The host directory remains 0700.
(private / 'postgres-password').chmod(0o444)
config = {
    'ConnectionStrings': {'Fleet': 'Host=postgres;Database=fleet;Username=fleet;Password=' + password},
    'Fleet': {'WorkspaceId': str(uuid.uuid4()), 'Operators': {'homelab-admin': hashlib.sha256(token.encode()).hexdigest()},
              'PublicUrl': f'https://{url_host}:{port}',
              'DashboardOrigin': f'https://{url_host}:{dashboard_port}',
              'IssuerCertificatePath': '/run/fleet/tls/ca.pem', 'IssuerKeyPath': '/run/fleet/tls/ca.key'},
    'Kestrel': {'Certificates': {'Default': {'Path': '/run/fleet/tls/server.pem', 'KeyPath': '/run/fleet/tls/server.key'}}},
    'Source': {'MirrorPath': '/var/lib/fleet/source.git'},
}
(private / 'server.json').write_text(json.dumps(config, indent=2) + '\n')
bind = '[' + bind_ip + ']' if ':' in bind_ip else bind_ip
(root / '.env').write_text(f'FLEET_IMAGE={SERVER_IMAGE}\nFLEET_DASHBOARD_IMAGE={DASHBOARD_IMAGE}\n'
                           + f'FLEET_HOSTNAME={host}\nFLEET_PUBLIC_URL=https://{url_host}:{port}\nFLEET_BIND_IP={bind}\nFLEET_PORT={port}\n'
                           + f'FLEET_DASHBOARD_URL=https://{url_host}:{dashboard_port}\nFLEET_DASHBOARD_PORT={dashboard_port}\nFLEET_SOURCE_REMOTE=\n')
(root / 'operator.env').write_text('export FLEET_SERVER_URL=' + shlex.quote(f'https://{url_host}:{port}') + '\n'
                                   + 'export FLEET_OPERATOR_TOKEN=' + shlex.quote(token) + '\n')
print('Created private homelab configuration. Keep secrets/ and operator.env out of source control.')
print(f'Open the dashboard at https://{url_host}:{dashboard_port} (Server: https://{url_host}:{port}). Both ports must be reachable from your browser.')
print('Sign in to the dashboard as fleet with the password fleet; it asks for a new password at the first sign-in. operator.env is for the fleet CLI.')
print('Start the stack with: docker compose up -d --wait')
