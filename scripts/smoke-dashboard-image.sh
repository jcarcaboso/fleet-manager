#!/usr/bin/env bash
# Run a locally built dashboard image the way Compose does (read-only, non-root, no capabilities) with a
# throwaway certificate, and check the container's HTTPS behaviour. It needs Docker, curl and openssl.
#   scripts/smoke-dashboard-image.sh IMAGE
set -euo pipefail

image=${1:?usage: smoke-dashboard-image.sh IMAGE}
api=https://fleet.example.test:7443
suffix=$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')
volume=fleet-dashboard-smoke-$suffix
container=fleet-dashboard-smoke-$suffix
work=$(mktemp -d)
cleanup() {
    docker rm -f "$container" >/dev/null 2>&1 || true
    docker volume rm "$volume" >/dev/null 2>&1 || true
    rm -rf "$work"
}
trap cleanup EXIT

fail() { echo "dashboard image smoke test failed: $*" >&2; exit 1; }
run_hardened() {
    docker run --read-only --cap-drop ALL --security-opt no-new-privileges:true --user 1654:1654 \
        --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777 -v "$volume":/run/fleet:ro "$@"
}

openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout "$work/server.key" -out "$work/server.pem" \
    -days 2 -subj /CN=localhost -addext subjectAltName=DNS:localhost,IP:127.0.0.1 >/dev/null 2>&1
docker volume create "$volume" >/dev/null
# Install the files as the Server's configure service does: owned by 1654 with mode 0600.
docker run --rm --user 0:0 --entrypoint sh -v "$volume":/run/fleet -v "$work":/in:ro "$image" -ec \
    'mkdir -p /run/fleet/tls && cp /in/server.pem /in/server.key /run/fleet/tls/ && cp /in/server.pem /run/fleet/tls/ca.pem
     chown -R 1654:1654 /run/fleet && chmod 0700 /run/fleet/tls && chmod 0600 /run/fleet/tls/*'

# A bad origin must stop the container with a clear message.
for origin in '' "$api/" 'http://fleet.example.test:7443' 'https://user@fleet.example.test'; do
    if output=$(run_hardened --rm -e FLEET_API_ORIGIN="$origin" "$image" 2>&1); then fail "origin '$origin' was accepted"; fi
    grep -q 'FLEET_API_ORIGIN' <<<"$output" || fail "origin '$origin' failed without naming FLEET_API_ORIGIN"
done

run_hardened -d --name "$container" -e FLEET_API_ORIGIN="$api" -p 127.0.0.1::8443 "$image" >/dev/null
port=$(docker port "$container" 8443/tcp | head -n1 | sed 's/.*://')
curl_args=(--silent --show-error --cacert "$work/server.pem" --resolve "localhost:$port:127.0.0.1" --max-time 5)
for _ in $(seq 1 30); do
    curl "${curl_args[@]}" --fail -o /dev/null "https://localhost:$port/healthz" 2>/dev/null && break
    sleep 1
done
get() { curl "${curl_args[@]}" "$@"; }
base=https://localhost:$port

[ "$(get "$base/config.json")" = "{\"apiUrl\":\"$api\"}" ] || fail 'config.json does not carry FLEET_API_ORIGIN'
headers=$(get -D - -o /dev/null "$base/")
grep -qi "^content-security-policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self' $api; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" <<<"$headers" || fail 'unexpected Content-Security-Policy'
for header in 'referrer-policy: no-referrer' 'x-content-type-options: nosniff' 'cross-origin-opener-policy: same-origin' 'cache-control: no-store'; do
    grep -qi "^$header" <<<"$headers" || fail "missing header $header"
done
[ "$(get -o /dev/null -w '%{http_code}' "$base/machines/some-node/overview")" = 200 ] || fail 'route fallback is not index.html'
[ "$(get -o /dev/null -w '%{http_code}' "$base/missing.js")" = 404 ] || fail 'a missing file was not a 404'
[ "$(get -o /dev/null -w '%{http_code}' "$base/.env")" = 404 ] || fail 'a dotfile was served'
[ "$(get -o /dev/null -w '%{http_code}' -X POST "$base/")" = 405 ] || fail 'POST was not rejected'
[ "$(get -o /dev/null -w '%{http_code}' "$base/healthz")" = 200 ] || fail 'healthz failed'
docker exec "$container" curl --fail --silent --max-time 3 --cacert /run/fleet/tls/ca.pem https://localhost:8443/healthz >/dev/null || fail 'the in-container healthcheck command failed'
get --tlsv1.2 --tls-max 1.2 -o /dev/null "$base/" || fail 'TLS 1.2 was refused'
get --tlsv1.3 -o /dev/null "$base/" || fail 'TLS 1.3 was refused'
[ "$(docker exec "$container" id -u)" = 1654 ] || fail 'the container does not run as 1654'
[ "$(docker inspect "$container" --format '{{.HostConfig.ReadonlyRootfs}}')" = true ] || fail 'the root file system is not read-only'
get -o /dev/null "$base/machines?secret=hidden-in-query" || true
logs=$(docker logs "$container" 2>&1)
grep -q 'GET /machines ' <<<"$logs" || fail 'the access log has no request line'
if grep -q 'hidden-in-query' <<<"$logs"; then fail 'a query string reached the access log'; fi
echo 'Dashboard image smoke: config.json, headers, routes, TLS, non-root read-only start, and fail-fast origin checks passed'
