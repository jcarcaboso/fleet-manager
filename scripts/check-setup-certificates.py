#!/usr/bin/env python3
"""Check that deploy/homelab/setup.py issues certificates that strict TLS verifiers accept.

Python 3.13 and later verify with VERIFY_X509_STRICT by default, which rejects a certificate without an authority key
identifier, among other things. This script runs setup.py in a temporary directory, then completes a TLS handshake against
the Server and dashboard certificates with that flag set explicitly, so it fails on older Pythons as well. It repeats the
check for the dashboard certificate that `setup.py --add-dashboard` issues. It needs openssl and python3, and no network.
"""
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SETUP = ROOT / 'deploy' / 'homelab' / 'setup.py'


def handshake(tls, name):
    """Serve tls/NAME.pem on a loopback port and connect to it as `localhost`, trusting only tls/ca.pem, strictly."""
    server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_context.load_cert_chain(tls / f'{name}.pem', tls / f'{name}.key')
    client_context = ssl.create_default_context(cafile=str(tls / 'ca.pem'))
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


def check(tls, name):
    try:
        version = handshake(tls, name)
    except ssl.SSLCertVerificationError as error:
        sys.exit(f'setup certificate check failed: {name}.pem is rejected by a strict verifier: {error.verify_message}')
    print(f'ok  {name}.pem verifies strictly against ca.pem ({version})')


with tempfile.TemporaryDirectory(prefix='fleet-setup-certificates-') as directory:
    root = Path(directory)
    subprocess.run([sys.executable, str(SETUP), '--directory', str(root), '--host', 'fleet.home.arpa'],
                   check=True, stdout=subprocess.DEVNULL)
    tls = root / 'secrets' / 'tls'
    for name in ('server', 'dashboard'):
        check(tls, name)
    # An installation from before the dashboard had a certificate: --add-dashboard issues it from the existing CA.
    for suffix in ('.pem', '.key'):
        (tls / f'dashboard{suffix}').unlink()
    subprocess.run([sys.executable, str(SETUP), '--directory', str(root), '--add-dashboard'], check=True, stdout=subprocess.DEVNULL)
    check(tls, 'dashboard')
print('Setup certificates: the Server and dashboard certificates pass strict X.509 verification')
