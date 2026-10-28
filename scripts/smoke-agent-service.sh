#!/usr/bin/env bash
# Exercise `fleet-agent service` and `fleet-agent update` under a real systemd user manager.
#
#   scripts/smoke-agent-service.sh [--keep]
#
# It builds the Server image from this tree, starts a disposable Server and PostgreSQL under a unique Compose project on a free
# loopback port, builds this tree's Agent and the same Agent with the next minor version in the CI Rust image, and boots a
# Fedora container running systemd with a lingering user. In that container it enrolls an Agent, runs it the way releases up to
# 0.11.0 did (a `brew services` unit started from a Homebrew path, with a stand-in `brew` that does what `brew services stop`
# does), and checks:
#
#   - while Homebrew runs the Agent, the other service actions refuse and name `fleet-agent service install`;
#   - `service install` copies the Agent, replaces the Homebrew service, starts one Agent from `current` with Restart=always,
#     and the Server reports the install method `managed`;
#   - `status`, `check`, `update status` and `service logs`;
#   - an upgrade with `service install` and the next version, a reinstall from the active copy, and `update rollback`, each
#     confirmed by the version the Server reports;
#   - a clean exit is restarted by systemd, and `stop`, `start` and `restart`;
#   - `service uninstall --purge-binaries` keeps identity and state, and `install` refuses an Agent that is not enrolled.
#
# Everything is removed on exit, also when a check fails. The Operator and enrollment tokens are never printed or passed on a
# command line. The macOS launchd branch is not covered.
#
# Needs: Docker with Compose v2 (the Server stack), Podman (a container running systemd), and Python 3.
#
# Environment:
#   FLEET_SMOKE_KEEP=1   same as --keep: leave the containers, images and temporary directory in place (for debugging)
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
keep=${FLEET_SMOKE_KEEP:-}
case "${1:-}" in
    --keep) keep=1 ;;
    "") ;;
    -h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) echo "smoke-agent-service: unknown argument $1" >&2; exit 64 ;;
esac

for tool in docker podman python3; do
    command -v "$tool" >/dev/null || { echo "smoke-agent-service: $tool is required" >&2; exit 69; }
done
docker compose version >/dev/null 2>&1 || { echo "smoke-agent-service: Docker Compose v2 is required" >&2; exit 69; }

run_id="$(date +%s)-$(head -c 3 /dev/urandom | od -An -tx1 | tr -d ' \n')"
project="fleet-svc-smoke-$run_id"
server_image="fleet-svc-smoke-server:$run_id"
node_image="fleet-svc-smoke-node:$run_id"
node="fleet-svc-smoke-$run_id"
rust_image="docker.io/library/rust:1.95.0"
work=$(mktemp -d "${TMPDIR:-/tmp}/fleet-svc-smoke.XXXXXX")
chmod 700 "$work"
deploy="$work/deploy"
share="$work/share"
started=0

log() { printf 'smoke-agent-service: %s\n' "$*"; }
fail() { printf 'smoke-agent-service: FAILED: %s\n' "$*" >&2; exit 1; }

cleanup() {
    status=$?
    set +e
    if [ -n "$keep" ]; then
        log "leaving everything in place (Compose project $project, container $node, directory $work)."
        log "remove it with: podman rm -f $node; podman rmi $node_image; (cd $deploy && FLEET_IMAGE=$server_image FLEET_DASHBOARD_IMAGE=$server_image docker compose -p $project down -v --remove-orphans); docker rmi $server_image; rm -rf $work"
        exit "$status"
    fi
    podman rm -f "$node" >/dev/null 2>&1
    podman rmi "$node_image" >/dev/null 2>&1
    if [ "$started" = 1 ]; then
        (cd "$deploy" && FLEET_IMAGE=$server_image FLEET_DASHBOARD_IMAGE=$server_image docker compose -p "$project" down -v --remove-orphans >/dev/null 2>&1)
    fi
    docker rmi "$server_image" >/dev/null 2>&1
    # Files written by the build container may belong to a mapped user; podman unshare can remove them.
    rm -rf "$work" 2>/dev/null || podman unshare rm -rf "$work"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ------------------------------------------------------------------ the Server
server_port=$(python3 -c "import socket; s = socket.socket(); s.bind(('127.0.0.1', 0)); print(s.getsockname()[1])")
dashboard_port=$(python3 -c "import socket; s = socket.socket(); s.bind(('127.0.0.1', 0)); print(s.getsockname()[1])")
server_url="https://localhost:$server_port"

log "building the Server image $server_image"
docker build --quiet --platform linux/amd64 -t "$server_image" -f "$root/Dockerfile" "$root" >/dev/null
mkdir -p "$deploy" "$share"
python3 "$root/deploy/homelab/setup.py" --directory "$deploy" --host localhost --bind-ip 127.0.0.1 \
    --port "$server_port" --dashboard-port "$dashboard_port" >/dev/null
cp "$root/deploy/homelab/compose.yaml" "$deploy/compose.yaml"
log "starting the Server as Compose project $project ($server_url); the dashboard is not started"
started=1
(cd "$deploy" && FLEET_IMAGE=$server_image FLEET_DASHBOARD_IMAGE=$server_image \
    docker compose -p "$project" up -d --wait --quiet-pull server >/dev/null 2>&1) || {
    (cd "$deploy" && FLEET_IMAGE=$server_image FLEET_DASHBOARD_IMAGE=$server_image \
        docker compose -p "$project" logs --no-color --tail 40 server migrate 2>&1 | sed -E 's/(token|password|secret)[^ ]*/\1<hidden>/Ig' >&2)
    fail "the Server did not become healthy"
}
cp "$deploy/secrets/tls/ca.pem" "$share/ca.pem"

# ------------------------------------------------------------------ the clients
# Built in the CI Rust image so that the binaries' glibc is never newer than the node container's.
version=$(python3 -c "import tomllib; print(tomllib.load(open('$root/clients/Cargo.toml', 'rb'))['workspace']['package']['version'])")
next=$(python3 -c "major, minor, _ = '$version'.split('-')[0].split('.'); print(f'{major}.{int(minor) + 1}.0')")
log "building fleet and fleet-agent $version, and fleet-agent $next"
mkdir -p "$work/next/clients" "$work/out/current" "$work/out/next"
(cd "$root" && tar --exclude=./clients/target -cf - ./clients ./contracts) | tar -xf - -C "$work/next"
python3 - "$work/next/clients/Cargo.toml" "$version" "$next" <<'PY'
import sys
path, old, new = sys.argv[1:]
text = open(path).read()
marker = f'version = "{old}"'
assert marker in text, marker
open(path, 'w').write(text.replace(marker, f'version = "{new}"', 1))
PY
podman run --rm --quiet --security-opt label=disable -v "$root:/src:ro" -v "$work:/work" -e CARGO_HOME=/work/cargo-home \
    "$rust_image" sh -ec '
        cargo build --quiet --locked --manifest-path /src/clients/Cargo.toml --target-dir /work/target \
            --bin fleet --bin fleet-agent
        cp /work/target/debug/fleet /work/target/debug/fleet-agent /work/out/current/
        cargo build --quiet --manifest-path /work/next/clients/Cargo.toml --target-dir /work/target-next --bin fleet-agent
        cp /work/target-next/debug/fleet-agent /work/out/next/'
mkdir -p "$share/current" "$share/next"
cp "$work/out/current/fleet-agent" "$share/current/"
cp "$work/out/next/fleet-agent" "$share/next/"
fleet_bin="$work/out/current/fleet"

# The Operator CLI reads FLEET_SERVER_URL and FLEET_OPERATOR_TOKEN; they stay inside this subshell.
fleet() { (set -a; . "$deploy/operator.env"; set +a; export FLEET_SERVER_URL=$server_url; "$fleet_bin" --ca-cert "$deploy/secrets/tls/ca.pem" "$@"); }
# "VERSION INSTALL_METHOD" as the Server last received it from the Agent.
reported() {
    fleet nodes show svc-smoke | python3 -c '
import json, sys
agent = json.load(sys.stdin).get("agent") or {}
print(agent.get("version"), agent.get("installMethod"))'
}
wait_reported() {
    local expected=$1 seen=
    for _ in $(seq 1 60); do
        seen=$(reported)
        [ "$seen" = "$expected" ] && return 0
        sleep 2
    done
    fail "the Server reports '$seen', expected '$expected'"
}

# ------------------------------------------------------------------ the Node
log "building the node image $node_image (Fedora with systemd)"
mkdir -p "$work/image"
cat >"$work/image/Containerfile" <<'EOF'
FROM registry.fedoraproject.org/fedora:44
RUN dnf -y install --setopt=install_weak_deps=False systemd systemd-pam dbus-broker procps-ng util-linux \
 && dnf clean all \
 && useradd -m -u 1500 tester \
 && mkdir -p /var/lib/systemd/linger && touch /var/lib/systemd/linger/tester
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
EOF
podman build --quiet -t "$node_image" "$work/image" >"$work/node-build.log" 2>&1 || {
    tail -n 40 "$work/node-build.log" >&2
    fail "the node image did not build"
}
chmod -R a+rX "$share"
podman run -d --name "$node" --systemd=always --network host --security-opt label=disable \
    -v "$share:/share:ro" "$node_image" >/dev/null

# Runs a shell command as the test user with the user manager's environment and Homebrew's bin first on PATH.
node_user() {
    podman exec -u tester -e XDG_RUNTIME_DIR=/run/user/1500 -e DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1500/bus \
        -e HOME=/home/tester -e PATH=/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin -w /home/tester "$node" bash -c "$1"
}
expect() {
    local description=$1 expected=$2 actual=$3
    [ "$actual" = "$expected" ] || fail "$description: expected '$expected', got '$actual'"
    log "ok: $description"
}
expect_contains() {
    local description=$1 expected=$2 actual=$3
    case "$actual" in *"$expected"*) log "ok: $description" ;; *) fail "$description: '$expected' not in: $actual" ;; esac
}

for _ in $(seq 1 30); do
    state=$(node_user 'systemctl --user is-system-running' 2>/dev/null || true)
    [ "$state" = running ] && break
    sleep 2
done
[ "$state" = running ] || fail "the user manager in the node container is '$state'"

state_dir=/home/tester/.local/state/fleet-agent
brew_bin=/home/linuxbrew/.linuxbrew/bin
# Installs a release binary at the Homebrew path the way `brew upgrade` does: a new file, not a write into the running one.
brew_install() {
    podman exec "$node" bash -c "mkdir -p $brew_bin && rm -f $brew_bin/fleet-agent \
        && install -m 0755 /share/$1/fleet-agent $brew_bin/fleet-agent && chown -R tester: /home/linuxbrew"
}
main_exe() { node_user 'readlink /proc/$(systemctl --user show -p MainPID --value fleet-agent.service)/exe'; }
main_pid() { node_user 'systemctl --user show -p MainPID --value fleet-agent.service'; }

log "enrolling the Agent and running it as a Homebrew service, as releases up to 0.11.0 did"
brew_install current
cat >"$share/brew" <<'EOF'
#!/bin/bash
# Stand-in for `brew services stop fleet-agent`: stop, disable and remove the Homebrew unit.
[ "$*" = "services stop fleet-agent" ] || { echo "stand-in brew: unsupported: $*" >&2; exit 1; }
systemctl --user disable --now homebrew.fleet-agent.service
rm -f ~/.config/systemd/user/homebrew.fleet-agent.service
systemctl --user daemon-reload
EOF
podman exec "$node" install -m 0755 -o tester /share/brew "$brew_bin/brew"
token_file="$work/enrollment.json"
(umask 077 && fleet enrollment create --expires-in-seconds 600 >"$token_file")
podman cp "$token_file" "$node:/tmp/enrollment.json"
rm -f "$token_file"
podman exec "$node" chown tester /tmp/enrollment.json
node_user "fleet-agent enroll --server-url $server_url --ca-cert /share/ca.pem --alias svc-smoke \
    --token-file /tmp/enrollment.json >/dev/null; rm -f /tmp/enrollment.json"
node_user "mkdir -p ~/.config/systemd/user && printf '%s\n' '[Service]' 'ExecStart=$brew_bin/fleet-agent run' 'Restart=always' \
    '[Install]' 'WantedBy=default.target' >~/.config/systemd/user/homebrew.fleet-agent.service \
    && systemctl --user daemon-reload && systemctl --user enable --now --quiet homebrew.fleet-agent.service"
wait_reported "$version homebrew"
log "ok: the Server reports the Homebrew Agent"

# ------------------------------------------------------------------ checks
expect_contains "service status refuses while Homebrew runs the Agent" "run \`fleet-agent service install\`" \
    "$(node_user 'fleet-agent service status 2>&1' || true)"

log "service install: move from the Homebrew service"
node_user 'fleet-agent service install >/dev/null 2>&1'
expect "Homebrew unit stopped" inactive "$(node_user 'systemctl --user is-active homebrew.fleet-agent.service' || true)"
expect "Homebrew unit removed" gone "$(node_user 'test -e ~/.config/systemd/user/homebrew.fleet-agent.service && echo present || echo gone')"
expect "fleet-agent.service active" active "$(node_user 'systemctl --user is-active fleet-agent.service')"
expect "current link" "versions/$version" "$(node_user "readlink $state_dir/current")"
expect "unit runs current" "ExecStart=\"$state_dir/current/fleet-agent\" --state-dir \"$state_dir\" run" \
    "$(node_user 'grep ^ExecStart= ~/.config/systemd/user/fleet-agent.service')"
expect "unit restarts always" "Restart=always" "$(node_user 'grep ^Restart= ~/.config/systemd/user/fleet-agent.service')"
expect "service runs the managed copy" "$state_dir/versions/$version/fleet-agent" "$(main_exe)"
expect "one Agent process" 1 "$(node_user 'pgrep -c -u tester -x fleet-agent')"
wait_reported "$version managed"
log "ok: the Server reports the install method managed"

expect_contains "status shows the service version" "\"version\":\"$version\"" "$(node_user 'fleet-agent status')"
expect_contains "check passes" '"ok":true' "$(node_user 'fleet-agent check')"
expect_contains "update status from the managed copy" '"managed":true' "$(node_user "$state_dir/current/fleet-agent update status")"
expect_contains "service logs" "Fleet Manager Node Agent" "$(node_user 'fleet-agent service logs')"

log "service install: upgrade to $next"
brew_install next
node_user 'fleet-agent service install >/dev/null 2>&1'
expect "service runs $next" "$state_dir/versions/$next/fleet-agent" "$(main_exe)"
expect "both versions kept" "$version $next" "$(node_user "ls $state_dir/versions | sort -V | tr '\n' ' ' | sed 's/ \$//'")"
wait_reported "$next managed"
log "ok: the Server reports $next"

node_user "$state_dir/current/fleet-agent service install >/dev/null 2>&1"
expect "reinstalling the active copy keeps the rollback version" "$version $next" \
    "$(node_user "ls $state_dir/versions | sort -V | tr '\n' ' ' | sed 's/ \$//'")"

log "update rollback"
node_user 'fleet-agent update rollback >/dev/null 2>&1'
expect "service runs $version again" "$state_dir/versions/$version/fleet-agent" "$(main_exe)"
wait_reported "$version managed"
log "ok: the Server reports $version"

log "a clean exit is restarted (Restart=always)"
before=$(main_pid)
node_user "kill -TERM $before"
for _ in $(seq 1 20); do
    after=$(main_pid)
    [ "$after" != 0 ] && [ "$after" != "$before" ] && break
    sleep 2
done
[ "$after" != 0 ] && [ "$after" != "$before" ] || fail "systemd did not restart the Agent after a clean exit"
log "ok: restarted after a clean exit"

node_user 'fleet-agent service stop'
expect "stop" inactive "$(node_user 'systemctl --user is-active fleet-agent.service' || true)"
node_user 'fleet-agent service start'
expect "start" active "$(node_user 'systemctl --user is-active fleet-agent.service')"
before=$(main_pid)
node_user 'fleet-agent service restart'
[ "$(main_pid)" != "$before" ] || fail "restart kept the same process"
log "ok: restart"

log "service uninstall --purge-binaries"
node_user 'fleet-agent service uninstall --purge-binaries >/dev/null 2>&1'
expect "unit removed" gone "$(node_user 'test -e ~/.config/systemd/user/fleet-agent.service && echo present || echo gone')"
expect "binaries removed" gone "$(node_user "test -e $state_dir/versions || test -L $state_dir/current && echo present || echo gone")"
expect "identity and config kept" kept "$(node_user "test -f $state_dir/config.json && test -d $state_dir/credentials && echo kept")"
expect_contains "service status after uninstall" "not installed" "$(node_user 'fleet-agent service status 2>&1' || true)"

expect_contains "install refuses an Agent that is not enrolled" "enroll this Agent" \
    "$(node_user 'mkdir -m 700 -p /tmp/unenrolled && fleet-agent --state-dir /tmp/unenrolled service install 2>&1' || true)"
expect "nothing created for the unenrolled Agent" 0 "$(node_user 'ls -A /tmp/unenrolled | wc -l')"

errors=$(node_user 'journalctl --user --no-pager -o cat -u fleet-agent.service -u homebrew.fleet-agent.service | grep -ciE "error|panic" || true')
expect "no errors in the Agent journal" 0 "$errors"

log "all checks passed"
