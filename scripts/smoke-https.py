#!/usr/bin/env python3
"""Exercise the running local server over real HTTPS and mutual TLS."""

import json
import os
from pathlib import Path
import ssl
import subprocess
import tempfile
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
SERVER = os.environ['FLEET_SERVER_URL']
OPERATOR = os.environ['FLEET_OPERATOR_TOKEN']
CA = Path(os.environ.get('FLEET_CA_CERT', str(ROOT / '.local/issuer.pem')))


def call(path, body=None, context=None, operator=False, method=None):
    headers = {'Content-Type': 'application/json'}
    if operator:
        headers['Authorization'] = 'Bearer ' + OPERATOR
    request = urllib.request.Request(
        SERVER + path,
        data=None if body is None else json.dumps(body).encode(),
        headers=headers,
        method=method or ('POST' if body is not None else 'GET'),
    )
    try:
        with urllib.request.urlopen(request, context=context or ssl.create_default_context(cafile=CA), timeout=10) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, None


with tempfile.TemporaryDirectory(prefix='fleet-tls-smoke-') as directory:
    directory = Path(directory)
    key = directory / 'node.key'
    csr = directory / 'node.csr'
    certificate = directory / 'node.pem'
    subprocess.run([
        'openssl', 'req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
        '-nodes', '-keyout', str(key), '-out', str(csr), '-subj', '/CN=untrusted-request-subject',
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    key.chmod(0o600)
    status, authorization = call('/operator/v1/enrollment-tokens', {'expiresInSeconds': 900}, operator=True)
    assert status == 200, 'Operator enrollment authorization failed'
    body = {'token': authorization['token'], 'certificateRequestPem': csr.read_text(),
            'nodeName': 'smoke-' + uuid.uuid4().hex[:12], 'platform': 'linux'}
    status, enrolled = call('/agent/v1/enroll', body)
    assert status == 200, 'Enrollment failed'
    assert call('/agent/v1/enroll', body) == (200, enrolled), 'Exact retry changed the issued identity'
    certificate.write_text(enrolled['certificatePem'])
    context = ssl.create_default_context(cafile=CA)
    context.load_cert_chain(certificate, key)
    assert call('/agent/v1/poll', context=context, method='POST')[0] == 200, 'Mutual TLS poll failed'
    assert call('/agent/v1/poll', method='POST')[0] == 401, 'Missing client certificate was accepted'
    assert call('/operator/v1/nodes', context=context)[0] == 401, 'Node certificate authenticated as Operator'
    status, renewal = call('/agent/v1/credentials/renew', {'certificateRequestPem': csr.read_text()}, context=context)
    assert status == 200, 'Credential renewal failed'
    assert call('/operator/v1/credentials/' + enrolled['credentialId'] + '/revoke', operator=True, method='POST')[0] == 200
    assert call('/agent/v1/poll', context=context, method='POST')[0] == 401, 'Revoked credential retained access'
    certificate.write_text(renewal['certificatePem'])
    renewed_context = ssl.create_default_context(cafile=CA)
    renewed_context.load_cert_chain(certificate, key)
    assert call('/agent/v1/poll', context=renewed_context, method='POST')[0] == 200, 'Renewed credential failed'
    assert call('/operator/v1/nodes/' + enrolled['nodeId'] + '/revoke', operator=True, method='POST')[0] == 200
    assert call('/agent/v1/poll', context=renewed_context, method='POST')[0] == 401, 'Revoked Node retained access'

print('HTTPS smoke: enrollment, exact retry, mTLS, renewal, isolation, and revocation passed')
