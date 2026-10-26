#!/bin/sh
# Prepare the runtime files that nginx includes, then start nginx.
#
# The image is read-only, so everything generated here goes to /tmp/fleet (a tmpfs):
#   config.json  {"apiUrl": FLEET_API_ORIGIN}, served as /config.json
#   csp.conf     the Content-Security-Policy header, with FLEET_API_ORIGIN in connect-src
set -eu

fail() {
    echo "fleet-dashboard: $*" >&2
    exit 64
}

origin="${FLEET_API_ORIGIN:-}"
[ -n "$origin" ] || fail "FLEET_API_ORIGIN is required. Set it to the Server's public HTTPS origin, for example https://fleet.home.arpa:7443."

# Allow-list the characters first, so that nothing that could break out of the JSON or the header gets further.
# This also rejects whitespace, quotes, newlines, userinfo (@), paths with odd characters, and queries.
case "$origin" in
    *[!]A-Za-z0-9.:/[-]*) fail "FLEET_API_ORIGIN contains characters that are not allowed in an origin." ;;
esac
[ "${#origin}" -le 300 ] || fail "FLEET_API_ORIGIN is too long."
origin=$(printf '%s' "$origin" | tr 'A-Z' 'a-z')

label='[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
port=':[1-9][0-9]{0,4}'
if printf '%s\n' "$origin" | grep -Eq "^https://(($label)(\.$label)*|\[[0-9a-f:.]+\])($port)?\$"; then
    :
elif printf '%s\n' "$origin" | grep -Eq "^http://(localhost|127\.0\.0\.1)($port)?\$"; then
    :
else
    fail "FLEET_API_ORIGIN must be a bare HTTPS origin such as https://fleet.home.arpa:7443 (no path, query, fragment, credentials or trailing slash). Plain http is accepted only for http://localhost and http://127.0.0.1. Got: $origin"
fi
if printf '%s\n' "$origin" | grep -Eq "$port\$"; then
    number="${origin##*:}"
    [ "$number" -le 65535 ] || fail "FLEET_API_ORIGIN has a port above 65535: $number"
fi

for file in /run/fleet/tls/server.pem /run/fleet/tls/server.key; do
    [ -r "$file" ] || fail "$file is missing or not readable by uid $(id -u). Mount the Fleet runtime-config volume at /run/fleet and run the container as the user that owns it."
done

runtime=/tmp/fleet
mkdir -p "$runtime" 2>/dev/null && [ -w "$runtime" ] || fail "$runtime is not writable. Mount a tmpfs at /tmp."
printf '{"apiUrl":"%s"}\n' "$origin" > "$runtime/config.json"
printf '%s\n' "add_header Content-Security-Policy \"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self' $origin; base-uri 'none'; frame-ancestors 'none'; form-action 'none'\" always;" > "$runtime/csp.conf"

nginx -t -q || fail "the nginx configuration is invalid."
exec "$@"
