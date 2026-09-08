#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output_dir="$repo_dir/artifacts"
archive_name=fleet-linux-amd64.tar.gz
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

install -m 0755 "$work_dir/export/fleet" "$work_dir/package/fleet"
install -m 0644 "$repo_dir/LICENSE" "$work_dir/package/LICENSE"

(
    cd "$work_dir/package"
    sha256sum fleet LICENSE > SHA256SUMS
    TZ=UTC tar \
        --sort=name \
        --owner=0 \
        --group=0 \
        --numeric-owner \
        --mtime='1970-01-01 00:00:00Z' \
        -cf - \
        LICENSE SHA256SUMS fleet | gzip -n > "$output_dir/$archive_name"
)

(
    cd "$output_dir"
    sha256sum "$archive_name" > "$archive_name.sha256"
)

printf 'Built %s\n' "$output_dir/$archive_name"
printf 'Checksum: %s\n' "$output_dir/$archive_name.sha256"
