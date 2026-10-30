#!/usr/bin/env bash
# Exercise TLS certificate renewal in a disposable stack from deploy/homelab/compose.yaml, with a real Agent running throughout.
# The certificates start close to expiry, and Node certificates last one day, so the Agent renews its own on every cycle.
# It checks that:
#   - the Server and the dashboard never serve the expiring files they were started with
#   - an Agent needs no change and no restart when the Server's certificate changes, or when the Server restarts
#   - a Compose run that copies the older files back undoes neither renewal
#   - a running dashboard gets a renewed certificate without a restart
# It removes everything on exit, also when something fails. It needs Docker with Compose v2, curl, openssl and Python 3.
#   scripts/smoke-tls-renewal.sh SERVER_IMAGE DASHBOARD_IMAGE AGENT_BINARY
set -euo pipefail

usage='usage: smoke-tls-renewal.sh SERVER_IMAGE DASHBOARD_IMAGE AGENT_BINARY'
server_image=${1:?$usage}
dashboard_image=${2:?$usage}
agent=$(realpath "${3:?$usage}")
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
project=fleet-tls-smoke-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')
work=$(mktemp -d)
chmod 700 "$work"
deploy=$work/deploy
issued=$work/issued
agent_pid=

log() { printf 'tls smoke: %s\n' "$*"; }
fail() { echo "tls renewal smoke test failed: $*" >&2; exit 1; }
compose() { (cd "$deploy" && docker compose -p "$project" "$@"); }

cleanup() {
    status=$?
    set +e
    [ -n "$agent_pid" ] && kill "$agent_pid" 2>/dev/null
    if [ "$status" != 0 ]; then
        compose logs --no-color --tail 30 server dashboard configure 2>&1 | sed -E 's/(token|password|secret)[^ ]*/\1<hidden>/Ig' >&2
        tail -n 20 "$work/agent.log" >&2 2>/dev/null
    fi
    compose down -v --remove-orphans >/dev/null 2>&1
    rm -rf "$work"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

wait_for() {
    local description=$1
    shift
    for _ in $(seq 1 90); do
        "$@" && return 0
        sleep 1
    done
    fail "timed out waiting: $description"
}

read -r server_port dashboard_port < <(python3 - <<'PY'
import socket
sockets = [socket.socket() for _ in range(2)]
for s in sockets:
    s.bind(('127.0.0.1', 0))
print(*[s.getsockname()[1] for s in sockets])
PY
)

mkdir -p "$deploy" "$issued"
python3 "$root/deploy/homelab/setup.py" --directory "$deploy" --host localhost --bind-ip 127.0.0.1 --port "$server_port" --dashboard-port "$dashboard_port" >/dev/null
cp "$root/deploy/homelab/compose.yaml" "$deploy/compose.yaml"
ca=$deploy/secrets/tls/ca.pem
url=https://localhost:$server_port
export FLEET_IMAGE=$server_image FLEET_DASHBOARD_IMAGE=$dashboard_image
cat >"$deploy/compose.override.yaml" <<'YAML'
services:
  server:
    environment:
      Fleet__TlsCertificateCheckSeconds: "10"
      Fleet__PollIntervalSeconds: "10"
      Fleet__CertificateLifetimeDays: "1"
  dashboard:
    environment:
      FLEET_TLS_RELOAD_SECONDS: "1"
YAML

# A certificate like the ones setup issues, with the names they have.
issue() {
    local name=$1 days=$2
    openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -pkeyopt ec_param_enc:named_curve -nodes -keyout "$issued/$name.key" -out "$issued/$name.csr" -subj /CN=localhost >/dev/null 2>&1
    printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\nsubjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1\n' >"$issued/$name.ext"
    openssl x509 -req -sha256 -in "$issued/$name.csr" -CA "$ca" -CAkey "$deploy/secrets/tls/ca.key" -CAcreateserial -CAserial "$issued/ca.srl" -out "$issued/$name.pem" -days "$days" -extfile "$issued/$name.ext" >/dev/null 2>&1
}
# Replaces two files in a volume the way the running stack sees them: as the Server's user, one rename each.
install_certificate() {
    local volume=$1 directory=$2 source=$3 target=$4
    docker run --rm --user 0:0 --network none --entrypoint sh -v "${project}_$volume":/volume -v "$issued":/in:ro "$server_image" -ec \
        "for suffix in key pem; do install -o 1654 -g 1654 -m 0640 /in/$source.\$suffix /volume/$directory/.tmp && mv /volume/$directory/.tmp /volume/$directory/$target.\$suffix; done"
}
fingerprint() { openssl x509 -in "$1" -noout -fingerprint -sha256; }
served() { openssl s_client -connect "127.0.0.1:$1" -servername localhost </dev/null 2>/dev/null | openssl x509 -outform PEM; }
served_fingerprint() { served "$1" | openssl x509 -noout -fingerprint -sha256; }
days_left() { python3 -c 'import datetime, ssl, sys; print(int((ssl.cert_time_to_seconds(sys.argv[1]) - datetime.datetime.now(datetime.timezone.utc).timestamp()) // 86400))' "$(served "$1" | openssl x509 -noout -enddate | cut -d= -f2)"; }
trusted() { curl --fail --silent --output /dev/null --max-time 5 --cacert "$ca" "https://localhost:$1$2"; }
serving() { [ "$(served_fingerprint "$server_port")" = "$1" ]; }

issue server-seed 5
issue dashboard-seed 5
cp "$issued/server-seed.pem" "$deploy/secrets/tls/server.pem"
cp "$issued/server-seed.key" "$deploy/secrets/tls/server.key"
cp "$issued/dashboard-seed.pem" "$deploy/secrets/tls/dashboard.pem"
cp "$issued/dashboard-seed.key" "$deploy/secrets/tls/dashboard.key"

log "starting $project with certificates that have 5 days left"
compose up -d --wait --quiet-pull >/dev/null 2>&1 || fail 'the stack did not become healthy'

[ "$(served_fingerprint "$server_port")" != "$(fingerprint "$issued/server-seed.pem")" ] || fail 'the Server served its expiring file'
[ "$(days_left "$server_port")" -ge 89 ] || fail 'the Server certificate was not renewed for 90 days'
trusted "$server_port" /health/ready || fail 'the renewed Server certificate does not verify against the CA'
[ "$(served_fingerprint "$dashboard_port")" != "$(fingerprint "$issued/dashboard-seed.pem")" ] || fail 'the dashboard served its expiring file'
[ "$(days_left "$dashboard_port")" -ge 89 ] || fail 'the dashboard certificate was not renewed for 90 days'
trusted "$dashboard_port" /healthz || fail 'the renewed dashboard certificate does not verify against the CA'
log 'ok: the Server and the dashboard replaced their expiring files before serving anything'

. "$deploy/operator.env"
headers=$work/operator-headers
(umask 077; printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$FLEET_OPERATOR_TOKEN" >"$headers")
unset FLEET_OPERATOR_TOKEN
operator() { curl --fail --silent --show-error --max-time 10 --cacert "$ca" --header "@$headers" "$url/operator/v1/$1" "${@:2}"; }
renewals() { operator nodes/smoke-agent | python3 -c 'import json, sys; print(json.load(sys.stdin)["credential"]["renewals"])'; }
renewals_passed() { [ "$(renewals)" -gt "$1" ]; }

agent_home=$work/agent-home
mkdir -p "$agent_home"
(umask 077; operator enrollment-tokens -X POST --data '{"expiresInSeconds":900}' >"$work/enrollment.json")
"$agent" --state-dir "$work/agent" enroll --server-url "$url" --ca-cert "$ca" --alias smoke-agent --token-file "$work/enrollment.json" --home "$agent_home" >/dev/null
"$agent" --state-dir "$work/agent" run >"$work/agent.log" 2>&1 &
agent_pid=$!
wait_for 'the Agent to renew its Node certificate' renewals_passed 1
log 'ok: an enrolled Agent polls and renews its Node certificate by itself'

count=$(renewals)
issue server-newer 120
install_certificate runtime-config tls server-newer server
wait_for 'the Server to serve the newer certificate without a restart' serving "$(fingerprint "$issued/server-newer.pem")"
wait_for 'the Agent to work with the new Server certificate' renewals_passed "$((count + 1))"
kill -0 "$agent_pid" || fail 'the Agent stopped'
log 'ok: the Agent kept working across a Server certificate change, without a restart or a change'

# Compose starts the finished configure service again and leaves the running Server alone: it cannot see inside mounted secrets.
container=$(compose ps -q server)
configured=$(docker inspect "$(compose ps -aq configure)" --format '{{.State.StartedAt}}')
compose up -d --wait --quiet-pull >/dev/null 2>&1 || fail 'the second Compose run failed'
[ "$(docker inspect "$(compose ps -aq configure)" --format '{{.State.StartedAt}}')" != "$configured" ] || fail 'the configure service did not run again'
[ "$(compose ps -q server)" = "$container" ] || fail 'a Compose run without a change recreated the Server'
[ "$(served_fingerprint "$server_port")" = "$(fingerprint "$issued/server-newer.pem")" ] || fail 'an older file replaced the Server certificate'
[ "$(days_left "$dashboard_port")" -ge 89 ] || fail 'the configure service put the older dashboard certificate back'
log 'ok: a Compose run copied the older files back and neither certificate went back with them'

count=$(renewals)
compose restart server >/dev/null 2>&1
wait_for 'the Server to return' trusted "$server_port" /health/ready
[ "$(served_fingerprint "$server_port")" != "$(fingerprint "$issued/server-seed.pem")" ] || fail 'the restarted Server served its expiring file'
[ "$(days_left "$server_port")" -ge 89 ] || fail 'the restarted Server did not renew'
wait_for 'the Agent to return after the restart' renewals_passed "$((count + 1))"
log 'ok: a restart issues a new certificate, and the Agent returned by itself'

started=$(docker inspect "$(compose ps -q dashboard)" --format '{{.State.StartedAt}}')
before=$(served_fingerprint "$dashboard_port")
issue dashboard-expiring 3
install_certificate dashboard-tls . dashboard-expiring dashboard
# Neither the certificate from before nor the expiring one: the renewal the Server wrote in between.
dashboard_renewed() {
    local current
    current=$(served_fingerprint "$dashboard_port")
    [ "$current" != "$before" ] && [ "$current" != "$(fingerprint "$issued/dashboard-expiring.pem")" ]
}
wait_for 'the running dashboard to serve a renewed certificate' dashboard_renewed
[ "$(days_left "$dashboard_port")" -ge 89 ] || fail 'the renewed dashboard certificate is not valid for 90 days'
trusted "$dashboard_port" /healthz || fail 'the dashboard certificate the Server renewed does not verify'
[ "$(docker inspect "$(compose ps -q dashboard)" --format '{{.State.StartedAt}}')" = "$started" ] || fail 'the dashboard restarted to get its certificate'
log 'ok: the Server renewed the certificate of a running dashboard, which reloaded it'

operator metrics | python3 -c '
import json, sys
metrics = json.load(sys.stdin)
for name in ("tls.ca.not_after_unix", "tls.server.not_after_unix", "tls.dashboard.not_after_unix", "tls.server.renewal.ok", "tls.dashboard.renewal.ok"):
    assert name in metrics, name
' || fail 'the renewal metrics are missing'

echo 'TLS renewal smoke: start with expiring files, Agent renewal and survival of certificate changes and restarts, Compose reruns, and dashboard reload passed'
