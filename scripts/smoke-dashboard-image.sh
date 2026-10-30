#!/usr/bin/env bash
# Run a locally built dashboard image the way Compose does (read-only, uid 1655 in the Server's group, no capabilities, a
# volume that holds only dashboard.pem, dashboard.key and the public ca.pem) with a throwaway CA, and check the container's
# HTTPS behaviour and that it reloads a renewed certificate. It needs Docker, curl and openssl.
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
    docker run --read-only --cap-drop ALL --security-opt no-new-privileges:true --user 1655:1654 \
        --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777 -v "$volume":/run/dashboard-tls:ro "$@"
}

openssl req -x509 -sha256 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -pkeyopt ec_param_enc:named_curve -nodes -keyout "$work/ca.key" -out "$work/ca.pem" \
    -days 2 -subj '/CN=Fleet dashboard smoke CA' -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign -addext subjectKeyIdentifier=hash >/dev/null 2>&1
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -pkeyopt ec_param_enc:named_curve -nodes -keyout "$work/dashboard.key" -out "$work/dashboard.csr" -subj /CN=localhost >/dev/null 2>&1
printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n' >"$work/dashboard.ext"
openssl x509 -req -sha256 -in "$work/dashboard.csr" -CA "$work/ca.pem" -CAkey "$work/ca.key" -CAcreateserial -out "$work/dashboard.pem" -days 2 -extfile "$work/dashboard.ext" >/dev/null 2>&1
docker volume create "$volume" >/dev/null
# Install the files as the configure service does: only these three, owned by the Server with mode 0640 (directory 0750).
docker run --rm --user 0:0 --entrypoint sh -v "$volume":/dashboard-tls -v "$work":/in:ro "$image" -ec \
    'cp /in/dashboard.pem /in/dashboard.key /in/ca.pem /dashboard-tls/ && chown -R 1654:1654 /dashboard-tls && chmod 0750 /dashboard-tls && chmod 0640 /dashboard-tls/*'

# Without its certificate the container must say what is missing, and how to fix an older installation.
empty=fleet-dashboard-smoke-empty-$suffix
docker volume create "$empty" >/dev/null
if output=$(docker run --rm --read-only --cap-drop ALL --user 1655:1654 --tmpfs /tmp -v "$empty":/run/dashboard-tls:ro -e FLEET_API_ORIGIN="$api" "$image" 2>&1); then
    docker volume rm "$empty" >/dev/null; fail 'the container started without a certificate'
fi
docker volume rm "$empty" >/dev/null
grep -q 'setup.py --add-dashboard' <<<"$output" || fail 'the missing-certificate message does not point at setup.py --add-dashboard'

# A bad origin must stop the container with a clear message.
for origin in '' "$api/" 'http://fleet.example.test:7443' 'https://user@fleet.example.test' 'https://[::1]:7443' 'https://[:]' 'https://[]' 'https://fleet.example.test:99999' 'https://.'; do
    if output=$(run_hardened --rm -e FLEET_API_ORIGIN="$origin" "$image" 2>&1); then fail "origin '$origin' was accepted"; fi
    grep -q 'FLEET_API_ORIGIN' <<<"$output" || fail "origin '$origin' failed without naming FLEET_API_ORIGIN"
    case "$origin" in
        *\[*) grep -q 'IPv6' <<<"$output" && grep -q 'DNS hostname' <<<"$output" || fail "origin '$origin' was refused without advice to use a hostname" ;;
    esac
done

if output=$(run_hardened --rm -e FLEET_API_ORIGIN="$api" -e FLEET_TLS_RELOAD_SECONDS=soon "$image" 2>&1); then fail 'a bad FLEET_TLS_RELOAD_SECONDS was accepted'; fi
grep -q 'FLEET_TLS_RELOAD_SECONDS' <<<"$output" || fail 'a bad FLEET_TLS_RELOAD_SECONDS failed without naming it'

run_hardened -d --name "$container" -e FLEET_API_ORIGIN="$api" -e FLEET_TLS_RELOAD_SECONDS=1 -p 127.0.0.1::8443 "$image" >/dev/null
port=$(docker port "$container" 8443/tcp | head -n1 | sed 's/.*://')
curl_args=(--silent --show-error --cacert "$work/ca.pem" --resolve "localhost:$port:127.0.0.1" --max-time 5)
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
for path in /machines/.hidden /machines/.hidden/overview /machines/%2Ehidden /machines/%2e%2Ehidden/activity /machines/a/.b /login/.x /models/%2E; do
    [ "$(get -o /dev/null -w '%{http_code}' "$base$path")" = 200 ] || fail "route fallback missing for $path"
    [ "$(get "$base$path")" = "$(get "$base/")" ] || fail "route $path did not return index.html"
done
for path in /.env /.git/config /assets/.x /%2eenv /machines/%2e%2e/.env /a/.b /missing.js /machines.js; do
    [ "$(get -o /dev/null -w '%{http_code}' --path-as-is "$base$path")" = 404 ] || fail "$path was not a 404"
done
[ "$(get -o /dev/null -w '%{http_code}' -X POST "$base/")" = 405 ] || fail 'POST was not rejected'
[ "$(get -o /dev/null -w '%{http_code}' "$base/healthz")" = 200 ] || fail 'healthz failed'
docker exec "$container" curl --fail --silent --max-time 3 --cacert /run/dashboard-tls/ca.pem https://localhost:8443/healthz >/dev/null || fail 'the in-container healthcheck command failed'
get --tlsv1.2 --tls-max 1.2 -o /dev/null "$base/" || fail 'TLS 1.2 was refused'
get --tlsv1.3 -o /dev/null "$base/" || fail 'TLS 1.3 was refused'
[ "$(docker exec "$container" id -u)" = 1655 ] || fail 'the container does not run as 1655'
[ "$(docker inspect "$container" --format '{{.HostConfig.ReadonlyRootfs}}')" = true ] || fail 'the root file system is not read-only'
# Every response nginx produces itself carries the security headers: error pages for malformed, unknown and
# disallowed requests, not only the ones a location handles.
long=$(head -c 9000 /dev/zero | tr '\0' a)
check_error() {
    local expected=$1 label=$2
    shift 2
    local response
    response=$(get --http1.1 -D - -o /dev/null "$@") || fail "$label: the request failed"
    grep -q "^HTTP/1.1 $expected" <<<"$response" || fail "$label: expected $expected, got $(head -n1 <<<"$response")"
    for header in "content-security-policy: default-src 'none'" 'referrer-policy: no-referrer' 'x-content-type-options: nosniff' 'cross-origin-opener-policy: same-origin' 'permissions-policy:'; do
        grep -qi "^$header" <<<"$response" || fail "$label ($expected) is missing $header"
    done
}
check_error 400 'path above the root' --path-as-is "$base/../../etc/passwd"
check_error 400 'encoded path above the root' --path-as-is "$base/%2e%2e/%2e%2e/etc/passwd"
check_error 404 'missing file' "$base/missing.js"
check_error 404 'dotfile' "$base/.git/config"
check_error 405 'POST' -X POST "$base/"
check_error 414 'long URI' "$base/$long"
get -o /dev/null "$base/machines?secret=hidden-in-query" || true
logs=$(docker logs "$container" 2>&1)
grep -q 'GET /machines ' <<<"$logs" || fail 'the access log has no request line'
if grep -q 'hidden-in-query' <<<"$logs"; then fail 'a query string reached the access log'; fi
# The Server renews the certificate in the shared volume: new connections must get it, without a restart.
serial() { openssl s_client -connect "127.0.0.1:$port" -servername localhost </dev/null 2>/dev/null | openssl x509 -noout -serial; }
before=$(serial)
started=$(docker inspect "$container" --format '{{.State.StartedAt}}')
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -pkeyopt ec_param_enc:named_curve -nodes -keyout "$work/renewed.key" -out "$work/renewed.csr" -subj /CN=localhost >/dev/null 2>&1
openssl x509 -req -sha256 -in "$work/renewed.csr" -CA "$work/ca.pem" -CAkey "$work/ca.key" -CAcreateserial -out "$work/renewed.pem" -days 2 -extfile "$work/dashboard.ext" >/dev/null 2>&1
docker run --rm --user 0:0 --entrypoint sh -v "$volume":/dashboard-tls -v "$work":/in:ro "$image" -ec \
    'for file in key pem; do install -o 1654 -g 1654 -m 0640 /in/renewed.$file /dashboard-tls/.tmp && mv /dashboard-tls/.tmp /dashboard-tls/dashboard.$file; done'
for _ in $(seq 1 30); do
    [ "$(serial)" != "$before" ] && break
    sleep 1
done
[ "$(serial)" = "$(openssl x509 -in "$work/renewed.pem" -noout -serial)" ] || fail 'the renewed certificate was not served'
get -o /dev/null "$base/healthz" || fail 'the renewed certificate does not verify'
[ "$(docker inspect "$container" --format '{{.State.StartedAt}}')" = "$started" ] || fail 'the container restarted to reload its certificate'

echo 'Dashboard image smoke: config.json, headers (also on error pages), routes, TLS, certificate reload, uid 1655 read-only start, and fail-fast origin and certificate checks passed'
