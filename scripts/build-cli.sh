#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output_dir="$repo_dir/artifacts"
release_commit=$(git -C "$repo_dir" rev-parse HEAD)
release_dirty=false
if [ -n "$(git -C "$repo_dir" status --porcelain)" ]; then
    release_dirty=true
fi
work_dir=$(mktemp -d)

cleanup() {
    rm -rf -- "$work_dir"
}
trap cleanup EXIT HUP INT TERM

mkdir -p \
    "$output_dir" \
    "$work_dir/context/clients/bins/fleet" \
    "$work_dir/context/contracts/operator" \
    "$work_dir/export" \
    "$work_dir/package"

install -m 0644 "$repo_dir/clients/Cargo.toml" "$work_dir/context/clients/Cargo.toml"
install -m 0644 "$repo_dir/clients/Cargo.lock" "$work_dir/context/clients/Cargo.lock"
install -m 0644 \
    "$repo_dir/clients/Dockerfile.release" \
    "$work_dir/context/clients/Dockerfile.release"
install -m 0644 \
    "$repo_dir/clients/bins/fleet/Cargo.toml" \
    "$work_dir/context/clients/bins/fleet/Cargo.toml"
cp -R "$repo_dir/clients/bins/fleet/src" "$work_dir/context/clients/bins/fleet/src"
mkdir -p "$work_dir/context/clients/bins/fleet-agent" "$work_dir/context/clients/crates/fleet-reconcile"
for client_dir in bins/fleet-agent crates/fleet-reconcile; do
    install -m 0644 "$repo_dir/clients/$client_dir/Cargo.toml" "$work_dir/context/clients/$client_dir/Cargo.toml"
    cp -R "$repo_dir/clients/$client_dir/src" "$work_dir/context/clients/$client_dir/src"
done
install -m 0644 \
    "$repo_dir/contracts/operator/nodes-page.json" \
    "$work_dir/context/contracts/operator/nodes-page.json"
install -m 0644 \
    "$repo_dir/contracts/operator/enrollment-token-response.json" \
    "$work_dir/context/contracts/operator/enrollment-token-response.json"

docker build \
    --platform linux/amd64 \
    --file "$work_dir/context/clients/Dockerfile.release" \
    --output "type=local,dest=$work_dir/export" \
    "$work_dir/context"

for binary in fleet fleet-agent; do
    archive_name="$binary-linux-amd64.tar.gz"
    package_dir="$work_dir/package/$binary"
    mkdir -p "$package_dir"
    install -m 0755 "$work_dir/export/$binary" "$package_dir/$binary"
    binary_version=$("$work_dir/export/$binary" --version)
    if [ -n "${FLEET_RELEASE_VERSION:-}" ] && [ "$binary_version" != "$binary ${FLEET_RELEASE_VERSION#v}" ]; then
        printf 'Expected %s %s, got %s\n' "$binary" "${FLEET_RELEASE_VERSION#v}" "$binary_version" >&2
        exit 1
    fi
    install -m 0644 "$repo_dir/LICENSE" "$package_dir/LICENSE"
    printf '{"version":"%s","gitCommit":"%s","dirty":%s,"platform":"linux-amd64"}\n' \
        "$binary_version" "$release_commit" "$release_dirty" > "$package_dir/BUILD.json"
    (
        cd "$package_dir"
        sha256sum "$binary" LICENSE BUILD.json > SHA256SUMS
        TZ=UTC tar --sort=name --owner=0 --group=0 --numeric-owner \
            --mtime='1970-01-01 00:00:00Z' -cf - BUILD.json LICENSE SHA256SUMS "$binary" | gzip -n > "$output_dir/$archive_name"
    )
    (
        cd "$output_dir"
        sha256sum "$archive_name" > "$archive_name.sha256"
    )
    printf 'Built %s\n' "$output_dir/$archive_name"
done
