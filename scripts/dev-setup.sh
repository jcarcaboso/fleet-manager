#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
mkdir -p .local
if [[ -e .local/dev.env ]]; then
  echo 'Local configuration already exists in .local/dev.env.'
  exit 0
fi
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout .local/issuer.key -out .local/issuer.pem -days 365 \
  -subj '/CN=Fleet local development CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' 2>/dev/null
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout .local/server.key -out .local/server.csr -subj '/CN=localhost' 2>/dev/null
cat > .local/server.ext <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1
EOF
openssl x509 -req -in .local/server.csr -CA .local/issuer.pem -CAkey .local/issuer.key \
  -CAcreateserial -out .local/server.pem -days 30 -extfile .local/server.ext 2>/dev/null
python3 - <<'PY'
import hashlib
import pathlib
import secrets
import shlex
import uuid

directory = pathlib.Path('.local').resolve()
token = secrets.token_urlsafe(32)
values = {
    'ASPNETCORE_URLS': 'https://localhost:7443',
    'ConnectionStrings__Fleet': 'Host=127.0.0.1;Port=55432;Database=fleet;Username=fleet;Password=fleet-local-development',
    'Fleet__WorkspaceId': str(uuid.uuid4()),
    'Fleet__OperatorName': 'local-operator',
    'Fleet__OperatorTokenSha256': hashlib.sha256(token.encode()).hexdigest(),
    'Fleet__IssuerCertificatePath': str(directory / 'issuer.pem'),
    'Fleet__IssuerKeyPath': str(directory / 'issuer.key'),
    'Kestrel__Certificates__Default__Path': str(directory / 'server.pem'),
    'Kestrel__Certificates__Default__KeyPath': str(directory / 'server.key'),
    'FLEET_SERVER_URL': 'https://localhost:7443',
    'FLEET_OPERATOR_TOKEN': token,
}
(directory / 'dev.env').write_text(''.join(f'export {key}={shlex.quote(value)}\n' for key, value in values.items()))
PY
echo 'Created local CA, server certificate, and private configuration in .local/.'
echo 'Run: source .local/dev.env'
