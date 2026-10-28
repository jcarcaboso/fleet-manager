#!/usr/bin/env bash
# Update a real Agent through a real Server, under a real systemd user manager, with a throwaway release key.
#
#   scripts/smoke-agent-update.sh [--keep]
#
# It generates a throwaway Ed25519 key pair and copies this tree with the public key in clients/bins/fleet-agent/release-keys/.
# From that copy it builds a Server image whose own version is the next minor version, this tree's Agent and Operator CLI, the
# Agent with the next version, and the same next Agent patched to panic right after its startup update check. It packages the
# next Agent as release archives and signs the manifest with scripts/sign-agent-release.py and the throwaway key, starts a
# disposable Server (Compose project, free loopback port, 10-second polls) and boots a Fedora container running systemd with a
# lingering user. There it enrolls the Agent, runs `fleet-agent service install`, and checks:
#
#   - the Agent announces that it can update itself (agent.selfUpdate) and reports the install method managed;
#   - a release whose new version keeps crashing: `fleet nodes update` requests it, the Agent downloads and verifies it, switches,
#     the new version starts four times, rolls back to the old one, and the old one reports agent_update_crash_loop; the Server
#     shows the update failed and raises agent_update_failed;
#   - a good release (after a Server restart, with the good files in the cache): `fleet nodes update` again, and the Agent
#     reports succeeded, runs the new version from `current`, keeps the old one for rollback, and `fleet-agent update status`
#     shows the update.
#
# The release files are placed in the Server's release cache, so nothing is downloaded from GitHub. The throwaway key never
# leaves the temporary directory. Everything is removed on exit, also when a check fails. The macOS launchd branch is not
# covered.
#
# Needs: Docker with Compose v2 (the Server stack and the Rust build), Podman (a container running systemd), OpenSSL and Python 3.
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
    *) echo "smoke-agent-update: unknown argument $1" >&2; exit 64 ;;
esac

for tool in docker podman openssl python3; do
    command -v "$tool" >/dev/null || { echo "smoke-agent-update: $tool is required" >&2; exit 69; }
done
docker compose version >/dev/null 2>&1 || { echo "smoke-agent-update: Docker Compose v2 is required" >&2; exit 69; }

run_id="$(date +%s)-$(head -c 3 /dev/urandom | od -An -tx1 | tr -d ' \n')"
project="fleet-update-smoke-$run_id"
server_image="fleet-update-smoke-server:$run_id"
node_image="fleet-update-smoke-node:$run_id"
node="fleet-update-smoke-$run_id"
rust_image="docker.io/library/rust:1.95.0"
work=$(mktemp -d "${TMPDIR:-/tmp}/fleet-update-smoke.XXXXXX")
chmod 700 "$work"
deploy="$work/deploy"
share="$work/share"
src="$work/src"
started=0

log() { printf 'smoke-agent-update: %s\n' "$*"; }
fail() { printf 'smoke-agent-update: FAILED: %s\n' "$*" >&2; exit 1; }
compose() { (cd "$deploy" && FLEET_IMAGE=$server_image FLEET_DASHBOARD_IMAGE=$server_image docker compose -p "$project" \
    -f compose.yaml -f compose.smoke.yaml "$@"); }

cleanup() {
    status=$?
    set +e
    if [ -n "$keep" ]; then
        log "leaving everything in place (Compose project $project, container $node, directory $work)."
        exit "$status"
    fi
    podman rm -f "$node" >/dev/null 2>&1
    podman rmi "$node_image" >/dev/null 2>&1
    [ "$started" = 1 ] && compose down -v --remove-orphans >/dev/null 2>&1
    docker rmi "$server_image" >/dev/null 2>&1
    rm -rf "$work" 2>/dev/null || podman unshare rm -rf "$work"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

version=$(python3 -c "import tomllib; print(tomllib.load(open('$root/clients/Cargo.toml', 'rb'))['workspace']['package']['version'])")
next=$(python3 -c "major, minor, _ = '$version'.split('-')[0].split('.'); print(f'{major}.{int(minor) + 1}.0')")
commit=$(printf '%040d' 0 | tr 0 e)

# ------------------------------------------------------------------ a throwaway release key and the source copy
log "generating a throwaway release key; copying the tree with its public key"
mkdir -p "$work/keys" "$src"
(umask 077 && openssl genpkey -algorithm ed25519 -out "$work/keys/release.key" 2>/dev/null)
openssl pkey -in "$work/keys/release.key" -pubout -out "$work/keys/release.pem"
(cd "$root" && tar --exclude=./clients/target --exclude=./dashboard/node_modules --exclude='*/bin' --exclude='*/obj' \
    --exclude=./.git -cf - .) | tar -xf - -C "$src"
rm -f "$src"/clients/bins/fleet-agent/release-keys/*.pem
cp "$work/keys/release.pem" "$src/clients/bins/fleet-agent/release-keys/smoke-test.pem"
python3 - "$src" "$version" "$next" <<'PY'
import re, sys
src, old, new = sys.argv[1:]
props = open(f"{src}/Directory.Build.props").read()
assert f"<Version>{old}</Version>" in props
open(f"{src}/Directory.Build.props", "w").write(props.replace(f"<Version>{old}</Version>", f"<Version>{new}</Version>"))
PY

# ------------------------------------------------------------------ the clients
log "building fleet and fleet-agent $version, fleet-agent $next, and a $next that crashes after its startup check"
for variant in next crash; do
    mkdir -p "$work/$variant"
    (cd "$src" && tar -cf - ./clients ./contracts) | tar -xf - -C "$work/$variant"
    python3 - "$work/$variant/clients/Cargo.toml" "$version" "$next" <<'PY'
import sys
path, old, new = sys.argv[1:]
text = open(path).read()
assert f'version = "{old}"' in text
open(path, 'w').write(text.replace(f'version = "{old}"', f'version = "{new}"', 1))
PY
done
python3 - "$work/crash/clients/bins/fleet-agent/src/main.rs" <<'PY'
import sys
path = sys.argv[1]
text = open(path).read()
anchor = "            let self_updater = updater::Updater::new(&directory);\n"
assert anchor in text
open(path, "w").write(text.replace(anchor, anchor + '            panic!("smoke test: this version crashes after its startup check");\n'))
PY
mkdir -p "$work/out"
# Release builds: debug executables exceed the 64 MiB a release may hold.
docker run --rm -v "$work:$work" -w "$work" -e CARGO_HOME="$work/cargo-home" "$rust_image" sh -ec "
    cargo build --quiet --release --locked --manifest-path $src/clients/Cargo.toml --target-dir $work/target --bin fleet --bin fleet-agent
    cp $work/target/release/fleet $work/target/release/fleet-agent $work/out/
    cargo build --quiet --release --manifest-path $work/next/clients/Cargo.toml --target-dir $work/target-next --bin fleet-agent
    cp $work/target-next/release/fleet-agent $work/out/fleet-agent-next
    cargo build --quiet --release --manifest-path $work/crash/clients/Cargo.toml --target-dir $work/target-next --bin fleet-agent
    cp $work/target-next/release/fleet-agent $work/out/fleet-agent-crash"
mkdir -p "$share"
cp "$work/out/fleet-agent" "$share/fleet-agent"
fleet_bin="$work/out/fleet"
[ "$("$work/out/fleet-agent-next" --version)" = "fleet-agent $next" ] || fail "the next Agent does not report $next"

# Writes signed release files for the given linux-amd64 binary to the directory $2, the way the tag workflow does.
release() {
    local binary=$1 out=$2 staging
    staging=$(mktemp -d "$work/package.XXXXXX")
    mkdir -p "$out"
    for platform in linux-amd64 macos-arm64 macos-amd64; do
        rm -rf "$staging"/*
        if [ "$platform" = linux-amd64 ]; then cp "$binary" "$staging/fleet-agent"; else
            printf '#!/bin/sh\necho "fleet-agent %s"\n' "$next" >"$staging/fleet-agent"; fi
        chmod 0755 "$staging/fleet-agent"
        cp "$root/LICENSE" "$staging/LICENSE"
        printf '{"version": "fleet-agent %s", "gitCommit": "%s", "dirty": false}\n' "$next" "$commit" >"$staging/BUILD.json"
        (cd "$staging" && sha256sum fleet-agent LICENSE BUILD.json >SHA256SUMS \
            && tar -czf "$out/fleet-agent-$platform.tar.gz" BUILD.json LICENSE SHA256SUMS fleet-agent)
        (cd "$out" && sha256sum "fleet-agent-$platform.tar.gz" >"fleet-agent-$platform.tar.gz.sha256")
    done
    python3 "$root/scripts/sign-agent-release.py" --version "$next" --commit "$commit" --artifacts "$out" \
        --key "$work/keys/release.key" --trusted-key "$work/keys/release.pem" >/dev/null
    rm -rf "$staging"
}
release "$work/out/fleet-agent-crash" "$work/release-crash"
release "$work/out/fleet-agent-next" "$work/release-good"

# ------------------------------------------------------------------ the Server
server_port=$(python3 -c "import socket; s = socket.socket(); s.bind(('127.0.0.1', 0)); print(s.getsockname()[1])")
dashboard_port=$(python3 -c "import socket; s = socket.socket(); s.bind(('127.0.0.1', 0)); print(s.getsockname()[1])")
server_url="https://localhost:$server_port"
log "building the Server image $server_image (version $next, trusting the throwaway key)"
docker build --quiet --platform linux/amd64 -t "$server_image" -f "$src/Dockerfile" "$src" >/dev/null
mkdir -p "$deploy"
python3 "$root/deploy/homelab/setup.py" --directory "$deploy" --host localhost --bind-ip 127.0.0.1 \
    --port "$server_port" --dashboard-port "$dashboard_port" >/dev/null
cp "$root/deploy/homelab/compose.yaml" "$deploy/compose.yaml"
cat >"$deploy/compose.smoke.yaml" <<'EOF'
services:
  server:
    environment:
      Fleet__PollIntervalSeconds: "10"
EOF
log "starting the Server as Compose project $project ($server_url)"
started=1
compose up -d --wait --quiet-pull server >/dev/null 2>&1 || {
    compose logs --no-color --tail 40 server migrate 2>&1 | sed -E 's/(token|password|secret)[^ ]*/\1<hidden>/Ig' >&2
    fail "the Server did not become healthy"
}
cp "$deploy/secrets/tls/ca.pem" "$share/ca.pem"
# Puts release files into the Server's release cache (a tmpfs, so a restart empties it).
place_release() {
    local file
    for file in "$1"/fleet-agent-release.json "$1"/fleet-agent-release.json.sig "$1"/fleet-agent-*.tar.gz; do
        compose exec -T server sh -c "mkdir -p /var/lib/fleet/agent-releases/v$next && cat >/var/lib/fleet/agent-releases/v$next/${file##*/}" <"$file"
    done
}

fleet() { (set -a; . "$deploy/operator.env"; set +a; export FLEET_SERVER_URL=$server_url; "$fleet_bin" --ca-cert "$deploy/secrets/tls/ca.pem" "$@"); }
# One field of `fleet nodes show`, as JSON-pointer-like dotted path; prints None when absent.
field() {
    fleet nodes show update-smoke | python3 -c '
import json, sys
value = json.load(sys.stdin)
for key in sys.argv[1].split("."):
    value = value.get(key) if isinstance(value, dict) else None
print(value)' "$1"
}
wait_field() {
    local path=$1 expected=$2 seconds=${3:-120} seen=
    for _ in $(seq 1 $((seconds / 2))); do
        seen=$(field "$path")
        [ "$seen" = "$expected" ] && { log "ok: $path is $expected"; return 0; }
        sleep 2
    done
    fail "$path is '$seen', expected '$expected'"
}
expect() {
    [ "$3" = "$2" ] || fail "$1: expected '$2', got '$3'"
    log "ok: $1"
}
expect_contains() {
    case "$3" in *"$2"*) log "ok: $1" ;; *) fail "$1: '$2' not in: $3" ;; esac
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
node_user() {
    podman exec -u tester -e XDG_RUNTIME_DIR=/run/user/1500 -e DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1500/bus \
        -e HOME=/home/tester -e PATH=/home/tester/bin:/usr/bin:/bin -w /home/tester "$node" bash -c "$1"
}
for _ in $(seq 1 30); do
    state=$(node_user 'systemctl --user is-system-running' 2>/dev/null || true)
    [ "$state" = running ] && break
    sleep 2
done
[ "$state" = running ] || fail "the user manager in the node container is '$state'"
state_dir=/home/tester/.local/state/fleet-agent
main_exe() { node_user 'readlink /proc/$(systemctl --user show -p MainPID --value fleet-agent.service)/exe'; }
versions() { node_user "ls $state_dir/versions | sort -V | tr '\n' ' ' | sed 's/ \$//'"; }

log "enrolling the Agent $version and installing the service"
node_user 'mkdir -p ~/bin && install -m 0755 /share/fleet-agent ~/bin/fleet-agent'
token_file="$work/enrollment.json"
(umask 077 && fleet enrollment create --expires-in-seconds 600 >"$token_file")
podman cp "$token_file" "$node:/tmp/enrollment.json"
rm -f "$token_file"
podman exec "$node" chown tester /tmp/enrollment.json
node_user "fleet-agent enroll --server-url $server_url --ca-cert /share/ca.pem --alias update-smoke \
    --token-file /tmp/enrollment.json >/dev/null; rm -f /tmp/enrollment.json"
node_user 'fleet-agent service install >/dev/null 2>&1'
wait_field agent.installMethod managed
wait_field agent.selfUpdate True
expect "outdated before the update" True "$(field agent.outdated)"
expect "service runs $version" "$state_dir/versions/$version/fleet-agent" "$(main_exe)"

# ------------------------------------------------------------------ a new version that keeps crashing
log "update to a $next that crashes: expect a rollback to $version"
place_release "$work/release-crash"
expect "update requested" requested "$(fleet nodes update update-smoke | python3 -c 'import json, sys; print(json.load(sys.stdin)["state"])')"
wait_field agentUpdate.state failed 300
expect "failure code" agent_update_crash_loop "$(field agentUpdate.errorCode)"
expect "service runs $version again" "$state_dir/versions/$version/fleet-agent" "$(main_exe)"
expect "current link" "versions/$version" "$(node_user "readlink $state_dir/current")"
expect "Agent still on $version" "$version" "$(field agent.version)"
expect_contains "the new version started four times" '"starts":4' "$(node_user "cat $state_dir/update.json")"
expect_contains "the issue agent_update_failed" "agent_update_failed:" "$(fleet issues list)"

# ------------------------------------------------------------------ a good release
log "update to the real $next"
compose restart server >/dev/null 2>&1
compose up -d --wait server >/dev/null 2>&1 || fail "the Server did not become healthy after its restart"
place_release "$work/release-good"
expect "update requested again" requested "$(fleet nodes update update-smoke | python3 -c 'import json, sys; print(json.load(sys.stdin)["state"])')"
wait_field agentUpdate.state succeeded 300
wait_field agent.version "$next"
expect "service runs $next" "$state_dir/versions/$next/fleet-agent" "$(main_exe)"
expect "current link" "versions/$next" "$(node_user "readlink $state_dir/current")"
expect "old version kept for rollback" "$version $next" "$(versions)"
expect "no longer outdated" False "$(field agent.outdated)"
status=$(node_user "$state_dir/current/fleet-agent update status")
expect_contains "update status shows the update" "\"state\":\"succeeded\"" "$status"
expect_contains "update status shows it reported" '"reported":true' "$status"
expect_contains "update requested in the audit log" "agent.update_requested" "$(fleet audit list --newest --node update-smoke)"
expect_contains "update succeeded in the audit log" "agent.update_succeeded" "$(fleet audit list --newest --node update-smoke)"
panics=$(node_user 'journalctl --user --no-pager -o cat -u fleet-agent.service | grep -c "smoke test: this version crashes" || true')
# Starts 1 to 3 reach the panic; the fourth start rolls back before it.
[ "$panics" = 3 ] || fail "expected the crashing version in the journal three times, found $panics"
log "ok: the crashing version crashed three times, and its fourth start rolled back"

log "all checks passed"
