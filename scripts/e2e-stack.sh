#!/usr/bin/env bash
# Run the dashboard's real-stack end-to-end journeys (dashboard/e2e/real) against a disposable stack built from this tree.
#
#   scripts/e2e-stack.sh [--keep] [-- PLAYWRIGHT_ARGS...]
#
# It builds the Server image (linux/amd64) and the dashboard image (deploy/homelab/compose.build.yaml) under local tags, creates
# a disposable deployment with deploy/homelab/setup.py in a temporary directory on free loopback ports, starts it under a unique
# Compose project name, builds the Rust clients into a temporary Cargo target directory, enrolls two real Agents (one of them
# runs once, so it has reported its OS and disk), runs `npm run e2e:real` in dashboard/, and removes everything on exit, also
# when something fails. The Operator token is read from the deployment's operator.env into the environment of the test run only:
# it is never printed, written elsewhere, or passed on a command line. The dashboard signs in with accounts: the script replaces the
# default fleet/fleet password with a random one and adds a read and an operate account, whose random passwords reach the test
# run the same way (FLEET_E2E_{ADMIN,READ,OPERATE}_{NAME,PASSWORD}).
#
# Needs: Docker with Compose v2, Python 3, Rust (cargo), Node 24 and the dashboard's dependencies (`npm ci` in dashboard/), and
# a browser: PLAYWRIGHT_CHROMIUM_EXECUTABLE, or Playwright's Chromium (`npx playwright install --with-deps chromium`).
#
# Environment:
#   FLEET_E2E_CARGO_TARGET_DIR   reuse this Cargo target directory instead of a temporary one (it is not removed)
#   FLEET_E2E_KEEP=1             same as --keep: leave the stack, images and temporary directory in place (for debugging)
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
keep=${FLEET_E2E_KEEP:-}
playwright_args=()
while [ $# -gt 0 ]; do
    case "$1" in
        --keep) keep=1 ;;
        --) shift; playwright_args=("$@"); break ;;
        -h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
        *) echo "e2e-stack: unknown argument $1" >&2; exit 64 ;;
    esac
    shift
done

for tool in docker python3 cargo npm openssl; do
    command -v "$tool" >/dev/null || { echo "e2e-stack: $tool is required" >&2; exit 69; }
done
docker compose version >/dev/null 2>&1 || { echo "e2e-stack: Docker Compose v2 is required" >&2; exit 69; }
[ -d "$root/dashboard/node_modules/@playwright" ] || { echo "e2e-stack: run 'npm ci' in dashboard/ first" >&2; exit 69; }

run_id="$(date +%s)-$(head -c 3 /dev/urandom | od -An -tx1 | tr -d ' \n')"
project="fleet-e2e-$run_id"
server_image="fleet-e2e-server:$run_id"
dashboard_image="fleet-e2e-dashboard:$run_id"
work=$(mktemp -d "${TMPDIR:-/tmp}/fleet-e2e.XXXXXX")
chmod 700 "$work"
deploy="$work/deploy"
agents="$work/agents"
cargo_target=${FLEET_E2E_CARGO_TARGET_DIR:-$work/cargo-target}
started=0

log() { printf 'e2e-stack: %s\n' "$*"; }

cleanup() {
    status=$?
    set +e
    if [ -n "$keep" ]; then
        log "leaving the stack in place (project $project, directory $work, images $server_image and $dashboard_image)."
        log "remove it with: (cd $deploy && FLEET_IMAGE=$server_image FLEET_DASHBOARD_IMAGE=$dashboard_image docker compose -p $project down -v --remove-orphans); docker rmi $server_image $dashboard_image; rm -rf $work"
        exit "$status"
    fi
    if [ "$started" = 1 ] || docker compose -p "$project" ps -aq 2>/dev/null | grep -q .; then
        (cd "$deploy" 2>/dev/null && FLEET_IMAGE=$server_image FLEET_DASHBOARD_IMAGE=$dashboard_image docker compose -p "$project" down -v --remove-orphans >/dev/null 2>&1)
    fi
    docker rmi "$server_image" "$dashboard_image" >/dev/null 2>&1
    rm -rf "$work"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ------------------------------------------------------------------ free loopback ports
read -r server_port dashboard_port < <(python3 - <<'PY'
import socket
sockets = [socket.socket() for _ in range(2)]
for s in sockets:
    s.bind(('127.0.0.1', 0))
print(*[s.getsockname()[1] for s in sockets])
PY
)
server_url="https://localhost:$server_port"
dashboard_url="https://localhost:$dashboard_port"

# ------------------------------------------------------------------ images (local tags only, never skorcius/*)
log "building the Server image $server_image (linux/amd64)"
docker build --quiet --platform linux/amd64 -t "$server_image" -f "$root/Dockerfile" "$root" >/dev/null
log "building the dashboard image $dashboard_image"
(cd "$root/deploy/homelab" && FLEET_IMAGE=$server_image FLEET_DASHBOARD_IMAGE=$dashboard_image docker compose -p "$project" -f compose.yaml -f compose.build.yaml build --quiet dashboard >/dev/null)

# ------------------------------------------------------------------ the disposable deployment
mkdir -p "$deploy" "$agents"
python3 "$root/deploy/homelab/setup.py" --directory "$deploy" --host localhost --bind-ip 127.0.0.1 --port "$server_port" --dashboard-port "$dashboard_port" >/dev/null
cp "$root/deploy/homelab/compose.yaml" "$deploy/compose.yaml"
# Two more Operators for the scope journeys, with the read and operate scopes (Fleet:OperatorScopes). Their tokens are random,
# only their SHA-256 digests go into the Server's configuration, and the tokens go to a private file for the test run.
python3 - "$deploy/secrets/server.json" "$work/scope-tokens.env" <<'PY'
import hashlib, json, os, secrets, sys
path, out = sys.argv[1:]
config = json.load(open(path))
fleet = config['Fleet']
tokens = {}
for name, scope in (('e2e-reader', 'read'), ('e2e-operator', 'operate')):
    token = secrets.token_urlsafe(32)
    fleet['Operators'][name] = hashlib.sha256(token.encode()).hexdigest()
    fleet.setdefault('OperatorScopes', {})[name] = scope
    tokens[scope] = token
with open(path, 'w') as f:
    json.dump(config, f, indent=2)
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f:
    f.write(f"FLEET_E2E_READ_TOKEN={tokens['read']}\nFLEET_E2E_OPERATE_TOKEN={tokens['operate']}\n")
PY
export FLEET_IMAGE=$server_image FLEET_DASHBOARD_IMAGE=$dashboard_image
log "starting the stack as Compose project $project (Server $server_url, dashboard $dashboard_url)"
started=1
(cd "$deploy" && docker compose -p "$project" up -d --wait --quiet-pull >/dev/null 2>&1) || {
    (cd "$deploy" && docker compose -p "$project" logs --no-color --tail 40 server dashboard migrate 2>&1 | sed -E 's/(token|password|secret)[^ ]*/\1<hidden>/Ig' >&2)
    echo "e2e-stack: the stack did not become healthy" >&2
    exit 1
}

# ------------------------------------------------------------------ dashboard accounts
# Signs in as the default fleet account, replaces its password, and adds a read and an operate account that have already chosen
# their own passwords, so the journeys start without the forced password change. Passwords go to a private file only.
log "preparing the dashboard accounts"
python3 - "$server_url" "$dashboard_url" "$deploy/secrets/tls/ca.pem" "$work/accounts.env" <<'PY'
import http.cookiejar, json, os, secrets, ssl, sys, urllib.request
server, dashboard, ca, out = sys.argv[1:]
context = ssl.create_default_context(cafile=ca)

def sign_in(name, password, new_password):
    opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=context),
                                         urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    csrf = None
    def call(method, path, body=None):
        headers = {'Origin': dashboard, 'Accept': 'application/json'}
        if method == 'POST':
            headers.update({'Content-Type': 'application/json', 'X-Fleet-CSRF': csrf})
        data = None if body is None else json.dumps(body).encode()
        with opener.open(urllib.request.Request(server + '/dashboard/api' + path, data, headers, method=method), timeout=30) as response:
            return json.load(response)
    csrf = call('GET', '/csrf')['token']
    session = call('POST', '/login', {'name': name, 'password': password})
    csrf = call('GET', '/csrf')['token']
    if session['mustChangePassword']:
        call('POST', '/account/password', {'currentPassword': password, 'newPassword': new_password})
    return call

accounts = {'ADMIN': ('fleet', secrets.token_urlsafe(24))}
admin = sign_in('fleet', 'fleet', accounts['ADMIN'][1])
for key, name, scope in (('READ', 'e2e-reader', 'read'), ('OPERATE', 'e2e-operator', 'operate')):
    first, final = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
    admin('POST', '/accounts', {'name': name, 'password': first, 'scope': scope})
    sign_in(name, first, final)
    accounts[key] = (name, final)
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f:
    for key, (name, password) in accounts.items():
        f.write(f"FLEET_E2E_{key}_NAME={name}\nFLEET_E2E_{key}_PASSWORD={password}\n")
PY

# ------------------------------------------------------------------ the Rust clients
log "building the Rust clients"
CARGO_TARGET_DIR="$cargo_target" cargo build --quiet --manifest-path "$root/clients/Cargo.toml" --bin fleet --bin fleet-agent
fleet_bin="$cargo_target/debug/fleet"
agent_bin="$cargo_target/debug/fleet-agent"
ca="$deploy/secrets/tls/ca.pem"

# The Operator CLI reads FLEET_SERVER_URL and FLEET_OPERATOR_TOKEN; they stay inside these subshells and the test run.
fleet() { (set -a; . "$deploy/operator.env"; set +a; export FLEET_SERVER_URL=$server_url; "$fleet_bin" --ca-cert "$ca" "$@"); }
agent() { local alias=$1; shift; HOME="$agents/$alias/home" "$agent_bin" --state-dir "$agents/$alias/state" "$@"; }

enroll() {
    local alias=$1
    mkdir -p "$agents/$alias/home" "$agents/$alias/state"
    chmod 700 "$agents/$alias/state"
    fleet enrollment create --expires-in-seconds 3600 >"$agents/$alias/enrollment.json"
    chmod 600 "$agents/$alias/enrollment.json"
    agent "$alias" enroll --server-url "$server_url" --ca-cert "$ca" --alias "$alias" --token-file "$agents/$alias/enrollment.json" --home "$agents/$alias/home" >/dev/null
    rm -f "$agents/$alias/enrollment.json"
}

agent_alias=e2e-alpha
idle_alias=e2e-idle
log "enrolling $agent_alias (runs once) and $idle_alias (never runs)"
enroll "$agent_alias"
enroll "$idle_alias"
agent "$agent_alias" run --once >/dev/null

# The hook the disk-refresh journey calls to make an Agent poll once: `agent-run.sh ALIAS`.
hook="$work/agent-run.sh"
cat >"$hook" <<HOOK
#!/usr/bin/env bash
set -euo pipefail
alias=\${1:?usage: agent-run.sh ALIAS}
HOME="$agents/\$alias/home" exec "$agent_bin" --state-dir "$agents/\$alias/state" run --once >/dev/null
HOOK
chmod 700 "$hook"

# ------------------------------------------------------------------ the journeys
# With --keep, the settings are also written to $work/e2e.env (mode 0600, token and passwords included) so that single journeys can be run again
# with `. $work/e2e.env; (cd dashboard && npx playwright test -c playwright.real.config.ts ...)`.
export_settings() {
    set -a; . "$deploy/operator.env"; set +a
    export FLEET_E2E_DASHBOARD_URL=$dashboard_url FLEET_E2E_SERVER_URL=$server_url FLEET_E2E_IGNORE_HTTPS_ERRORS=1
    export FLEET_E2E_OPERATOR_TOKEN=$FLEET_OPERATOR_TOKEN
    . "$work/scope-tokens.env"
    export FLEET_E2E_READ_TOKEN FLEET_E2E_OPERATE_TOKEN
    . "$work/accounts.env"
    export FLEET_E2E_ADMIN_NAME FLEET_E2E_ADMIN_PASSWORD FLEET_E2E_READ_NAME FLEET_E2E_READ_PASSWORD FLEET_E2E_OPERATE_NAME FLEET_E2E_OPERATE_PASSWORD
    export FLEET_E2E_AGENT_ALIAS=$agent_alias FLEET_E2E_IDLE_ALIAS=$idle_alias FLEET_E2E_AGENT_RUN=$hook
    unset FLEET_OPERATOR_TOKEN FLEET_SERVER_URL
}
if [ -n "$keep" ]; then
    (umask 077; export_settings; env | grep '^FLEET_E2E_' | sed -E "s/^([^=]+)=(.*)$/export \1='\2'/" >"$work/e2e.env")
fi
log "running the real-stack journeys"
status=0
(
    cd "$root/dashboard"
    export_settings
    npm run --silent e2e:real -- "${playwright_args[@]}"
) || status=$?
exit "$status"
