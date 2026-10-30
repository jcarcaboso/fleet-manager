#!/usr/bin/env python3
"""Check that deploy/homelab/setup.py issues certificates that strict TLS verifiers accept.

Python 3.13 and later verify with VERIFY_X509_STRICT by default, which rejects a certificate without an authority key
identifier, among other things. This script runs setup.py in a temporary directory, then completes a TLS handshake against
the Server and dashboard certificates with that flag set explicitly, so it fails on older Pythons as well. It repeats the
check for the dashboard certificate that `setup.py --add-dashboard` issues and for what `--renew` and `--renew-ca` produce,
including a client that still holds the CA from before the extension. It needs openssl and python3, and no network.
"""
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SETUP = ROOT / 'deploy' / 'homelab' / 'setup.py'


def handshake(tls, name, ca):
    """Serve tls/NAME.pem on a loopback port and connect to it as `localhost`, trusting only `ca`, strictly."""
    server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_context.load_cert_chain(tls / f'{name}.pem', tls / f'{name}.key')
    client_context = ssl.create_default_context(cafile=str(ca))
    client_context.verify_flags |= ssl.VERIFY_X509_STRICT
    with socket.create_server(('127.0.0.1', 0)) as listener:
        port = listener.getsockname()[1]
        failure = []

        def accept():
            connection, _ = listener.accept()
            try:
                with server_context.wrap_socket(connection, server_side=True):
                    pass
            except (ssl.SSLError, OSError) as error:
                failure.append(error)

        thread = threading.Thread(target=accept, daemon=True)
        thread.start()
        with socket.create_connection(('127.0.0.1', port), timeout=10) as raw:
            with client_context.wrap_socket(raw, server_hostname='localhost') as tls_socket:
                version = tls_socket.version()
        thread.join(10)
    return version


def check(tls, name, ca=None):
    ca = ca or tls / 'ca.pem'
    try:
        version = handshake(tls, name, ca)
    except ssl.SSLCertVerificationError as error:
        sys.exit(f'setup certificate check failed: {name}.pem is rejected by a strict verifier: {error.verify_message}')
    print(f'ok  {name}.pem verifies strictly against {ca.name} ({version})')


def field(certificate, option):
    return subprocess.run(['openssl', 'x509', '-in', str(certificate), '-noout', option], check=True, capture_output=True, text=True).stdout


def expiry(certificate):
    return ssl.cert_time_to_seconds(field(certificate, '-enddate').strip().split('=', 1)[1])


def text(certificate):
    return field(certificate, '-text')


def setup(root, *arguments):
    subprocess.run([sys.executable, str(SETUP), '--directory', str(root), *arguments], check=True, stdout=subprocess.DEVNULL)


def require(condition, message):
    if not condition:
        sys.exit(f'setup certificate check failed: {message}')


with tempfile.TemporaryDirectory(prefix='fleet-setup-certificates-') as directory:
    root = Path(directory)
    setup(root, '--host', 'fleet.home.arpa')
    tls = root / 'secrets' / 'tls'
    for name in ('server', 'dashboard'):
        check(tls, name)
    # An installation from before the dashboard had a certificate: --add-dashboard issues it from the existing CA.
    for suffix in ('.pem', '.key'):
        (tls / f'dashboard{suffix}').unlink()
    setup(root, '--add-dashboard')
    check(tls, 'dashboard')

    # --renew: new keys and serial numbers, the same names, the same CA.
    before = {name: (field(tls / f'{name}.pem', '-serial'), (tls / f'{name}.key').read_text(), field(tls / f'{name}.pem', '-subject')) for name in ('server', 'dashboard')}
    names = text(tls / 'server.pem').split('X509v3 Subject Alternative Name')[1].splitlines()[1]
    ca_before = (tls / 'ca.pem').read_bytes()
    setup(root, '--renew')
    for name in ('server', 'dashboard'):
        check(tls, name)
        require(field(tls / f'{name}.pem', '-serial') != before[name][0], f'--renew did not replace {name}.pem')
        require((tls / f'{name}.key').read_text() != before[name][1], f'--renew did not replace {name}.key')
        require(field(tls / f'{name}.pem', '-subject') == before[name][2], f'--renew changed the subject of {name}.pem')
        require(names in text(tls / f'{name}.pem'), f'--renew changed the names of {name}.pem')
    require((tls / 'ca.pem').read_bytes() == ca_before, '--renew changed the CA')
    require(sorted(path.name for path in tls.iterdir()) == ['ca.key', 'ca.pem', 'dashboard.key', 'dashboard.pem', 'server.key', 'server.pem'],
            '--renew left files behind')

    # --renew-ca: certificates from before it stay valid, and a client that keeps the old CA trusts certificates from after it.
    # Start from a 365-day CA, as installations from before 0.12.2 have: one created a moment ago would get the same date again.
    subprocess.run(['openssl', 'x509', '-in', str(tls / 'ca.pem'), '-signkey', str(tls / 'ca.key'), '-sha256', '-days', '365',
                    '-set_serial', '0x01', '-out', str(tls / 'ca.pem')], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    old_ca = root / 'old-ca.pem'
    shutil.copy(tls / 'ca.pem', old_ca)
    setup(root, '--renew-ca')
    require(expiry(tls / 'ca.pem') > expiry(old_ca), '--renew-ca did not extend the expiry')
    require(field(tls / 'ca.pem', '-serial') != field(old_ca, '-serial'), '--renew-ca kept the serial number')
    for option in ('-subject', '-pubkey'):
        require(field(tls / 'ca.pem', option) == field(old_ca, option), f'--renew-ca changed {option[1:]}')
    for extension in ('CA:TRUE', 'Certificate Sign', 'Subject Key Identifier'):
        require(extension in text(tls / 'ca.pem'), f'--renew-ca dropped {extension}')
    check(tls, 'server')
    setup(root, '--renew')
    check(tls, 'server', old_ca)
    check(tls, 'server')

    # A key that does not belong to the CA must not produce a CA, and must leave the current one in place.
    ca_before = (tls / 'ca.pem').read_bytes()
    shutil.copy(tls / 'ca.key', root / 'ca.key')
    shutil.copy(tls / 'server.key', tls / 'ca.key')
    refused = subprocess.run([sys.executable, str(SETUP), '--directory', str(root), '--renew-ca'], capture_output=True, text=True)
    require(refused.returncode != 0 and 'same subject and key' in refused.stderr, '--renew-ca accepted a key that is not the CA key')
    require((tls / 'ca.pem').read_bytes() == ca_before and not (tls / 'ca.new.pem').exists(), '--renew-ca changed the CA after refusing')
print('Setup certificates: the Server and dashboard certificates pass strict X.509 verification, also after renewal and extending the CA')
