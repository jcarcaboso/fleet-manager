# First Server hardening pass

This pass adds checks and operational tools to the initial Server. It does not
complete the public-release checklist or the Agent recovery protocol.

## Listeners and certificates

Normal startup requires explicit `ASPNETCORE_URLS` or `Kestrel:Endpoints` URLs.
The Server rejects implicit listeners, URL credentials and paths, and plain HTTP
except for opted-in loopback development. Configure a concrete private address
or hostname. Explicit all-interface addresses still need host firewall rules.
A private overlay uses the same HTTPS setup and does not alter authentication.

Kestrel permits at most 256 connections, with 128 concurrent HTTP requests and
no application waiting queue. The default request deadline is 30 seconds.
Handlers pass cancellation to database and Git operations. The Server omits its
HTTP software header. Readiness checks for pending migrations and a mismatched
Workspace under a two-second cancellation deadline.

The issuing key is loaded once per process. Startup checks CA key usage and
whether its validity covers the configured Node credential lifetime. Node
certificates require explicit client-authentication usage. Every Node operation
still checks database authorization, including on reused TLS connections.
CA replacement requires a planned restart and trust rotation. Live CA reload
is not implemented.

## Dashboard container

The dashboard is not part of the Server. `skorcius/fleet-manager-dashboard` is an
unprivileged nginx image that serves the built Vue application over HTTPS on
8443 (published as `FLEET_DASHBOARD_PORT`, 7444 by default). It has its own TLS
identity and does not share secrets with the Server. It allows TLS 1.2 and 1.3
with AEAD cipher suites only. Compose runs it as UID 1655 (the Server is 1654) on
a read-only root file system with a 16 MiB `/tmp` tmpfs, no capabilities,
`no-new-privileges`, the Server's memory and process limits, and a healthcheck
against `/healthz` that trusts the public `ca.pem`. It joins its own network, not
the database or the Server's outbound network, because it never calls the Server:
the browser does.

### Secret separation

`setup.py` issues two leaf certificates from the homelab CA, `server.pem` and
`dashboard.pem`, each with its own key and the same names. The CA private key is
only ever needed by the Server, which signs Node certificates with it. The
`configure` service (no network, brief root) copies the files into two named volumes:

| Volume | Owner and mode | Files | Mounted by |
|---|---|---|---|
| `runtime-config` | 1654, directories 0700, files 0600 | `appsettings.Production.json` (PostgreSQL password, Operator token digests), `tls/ca.key`, `tls/ca.pem`, `tls/server.key`, `tls/server.pem`, `.ssh/` | `server` and `migrate`, read-only |
| `dashboard-tls` | 1655, directory 0700, files 0600 | `dashboard.key`, `dashboard.pem`, `ca.pem` (public), nothing else | `dashboard`, read-only at `/run/dashboard-tls` |

`configure` empties `dashboard-tls` before filling it and never copies
`dashboard.*` into `runtime-config`. So a compromised dashboard container can read its own key and certificate and the
public CA certificate. It cannot read the CA key, the Server key, the database
password, the Operator token digests, the SSH configuration or the Server's
volume, and the Server cannot read the dashboard's. Stealing the dashboard key
lets an attacker impersonate the dashboard address to a browser that trusts the
CA, as the Server key does for the Server, but yields no Node credentials, no
API access and no database access.

An installation created before the dashboard had its own certificate has no
`dashboard.pem`. `configure` then stops with a message that points at
`python3 setup.py --add-dashboard`, which issues the certificate from the
existing CA in `secrets/tls` without touching the CA or the Server certificate,
adds the missing `FLEET_DASHBOARD_*` settings and `DashboardOrigin`, and refuses
to overwrite an existing dashboard certificate. Rotating the dashboard certificate
means replacing `dashboard.pem` and `dashboard.key` in `secrets/tls` with ones
signed by the same CA and recreating the stack.

At start-up the container writes `/config.json` and the Content-Security-Policy
from `FLEET_API_ORIGIN`, the Server's public HTTPS origin. It refuses to start
with a missing value or anything but a bare `https` origin with a DNS hostname or
IPv4 address (plain `http` only for `localhost` and `127.0.0.1`). IPv6 literals
are refused with a message to use a hostname: the Content-Security-Policy
host-source syntax has no form for them, so a browser would drop the
`connect-src` entry and block every API call. `setup.py` refuses an IPv6
`--host` for the same reason. Pages carry `default-src 'none'; script-src 'self';
style-src 'self'; connect-src 'self' ORIGIN; frame-ancestors 'none'` and related
headers, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, a
deny-all `Permissions-Policy` and `Cross-Origin-Opener-Policy: same-origin`.
Only GET and HEAD are served, dotfiles are refused (a Node alias under a route
such as `/machines/.name` still gets the application), and the access log leaves
out query strings and `Referer`. The same security headers are set on every
response nginx generates, error pages for malformed (400), too long (414) or
unknown (404) requests included. Hashed files under `/assets/` are cached for a
year; `index.html` and `config.json` are `no-store`.

### Dashboard origin, CORS and CSRF

The Server side of the pairing is `Fleet__DashboardOrigin` (`Fleet:DashboardOrigin`),
the dashboard's own HTTPS origin, for example `https://fleet.home.arpa:7444`.
It follows the rules of `Fleet__PublicUrl`: `https`, a host, no userinfo, path,
query or fragment, and at most 200 characters. An invalid value stops the Server
at startup. Compose sets it from `FLEET_DASHBOARD_URL`.

- **Empty:** `/dashboard/api` is not mapped and sends no CORS headers. `GET /`
  and `GET /dashboard/...` return `404 dashboard_not_configured`. With the value
  set, the same addresses redirect (302) to the dashboard so old bookmarks keep
  working. `/dashboard/api` also needs `Fleet__PublicUrl`, as before.
- **CORS, `/dashboard/api` only.** The `Origin` header must equal the configured
  origin exactly (scheme and host without case). Then every response, errors
  included (401, 403, 404, 429), carries `Access-Control-Allow-Origin: <origin>`,
  `Access-Control-Allow-Credentials: true` and `Vary: Origin`. A preflight
  (`OPTIONS` with `Origin`) gets `204` with `Access-Control-Allow-Methods: GET,
  POST, OPTIONS`, `Access-Control-Allow-Headers: Content-Type, X-Fleet-CSRF` and
  `Access-Control-Max-Age: 600`, and needs neither a session nor a CSRF token.
  A preflight from another origin gets `403 invalid_origin`. Any other origin, or
  none, gets no CORS headers. There is no wildcard, reflection or suffix match,
  and no CORS on `/operator/v1`, `/agent/v1`, `/enroll` or `/health`.
  This is middleware ahead of the rate limiter, authentication and
  authorization, because those answer 429 and 401 before any endpoint filter
  runs, and a browser can only show the Operator why a request failed when the
  failure carries the CORS headers.
- **CSRF and Origin.** A non-GET request to `/dashboard/api` must carry
  `Origin: <Fleet:DashboardOrigin>` (`400 invalid_origin` otherwise, including
  the Server's own origin) and the `X-Fleet-CSRF` token from `GET csrf`
  (`400 invalid_csrf`). `Origin` is checked first, after authentication.
- **Host check.** `/enroll` and `/dashboard/api` must be reached at
  `Fleet__PublicUrl`, otherwise `400 dashboard_origin_required`. The page that
  calls the API is no longer on this host, but the cookie (`__Host-`, host only)
  and every enrollment link still belong to the public origin, so a request that
  arrives under another name (an IP address, a stray alias) could only produce a
  session that does not work. The preflight is answered before this check, so
  the browser can read the error. Redirects do not depend on the host.
- **Headers on API responses:** `Referrer-Policy: no-referrer`,
  `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` and
  `Content-Security-Policy: default-src 'none'; base-uri 'none'; frame-ancestors
  'none'; form-action 'none'`. `/enroll` keeps its own policy.

The dashboard and the Server must share a site because the session cookie is
`SameSite=Strict`. The [separate dashboard plan](../plans/separate-dashboard.md)
has the full contract. `scripts/smoke-dashboard.py` and
`scripts/smoke-dashboard-image.sh` check both sides against a running stack and
a local image.

## Multiple Operators

Every Operator is a full administrator unless it has a scope. Configure distinct token digests:

```sh
export Fleet__Operators__alice=<sha256-hex-digest>
export Fleet__Operators__automation=<different-sha256-hex-digest>
```

Use random tokens containing at least 32 characters. The CLI reads the raw token
from `FLEET_OPERATOR_TOKEN`. Names use ASCII letters, digits, dots, hyphens, and
underscores. Startup rejects duplicate names or digests and more than 100
credentials. The previous `Fleet__OperatorTokenSha256` and `Fleet__OperatorName`
settings remain supported as one additional Operator. Audit records use the
authenticated name. Rotate or revoke a token by changing configuration and
restarting. No Operator credential administration endpoint exists yet.

### Operator scopes

Limit what a token can do with `Fleet:OperatorScopes:<operator-name>`:

```sh
export Fleet__OperatorScopes__automation=read
export Fleet__OperatorScopes__alice=operate
```

| Scope | Allows |
|---|---|
| `read` | Every `GET` route |
| `operate` | `read`, plus retry, source rescan, CLIProxy refresh and model selection |
| `admin` | `operate`, plus enrollment tokens and links, Node rename, revoke and remove, and credential revoke |

An Operator without an entry is `admin`, so existing deployments keep their
behavior. Any other value, including a different letter case, stops the Server at
startup. A dashboard session takes the scope at login and ends if the scope changes.
A denied request returns HTTP 403 with code `insufficient_scope`. Give an LLM
agent a `read` or `operate` token so it cannot revoke or remove machines.

## CLIProxyAPI credential

The optional CLIProxyAPI key is a deployment secret, not Server desired state.
Configure `Fleet:CliProxyApiKey` through the Server's ordinary .NET
configuration. Environment variables use the name `Fleet__CliProxyApiKey`; the
homelab Compose file maps `FLEET_CLIPROXY_API_KEY` to it. The value must contain
1 to 4,096 printable ASCII characters when configured. Only an authenticated
Node with a current proxy Assignment may fetch it. Follow the
[CLIProxyAPI operations guide](cliproxy-operations.md) to set it up and rotate
with an old/new key overlap. The Agent-first rollout order is a protocol
requirement: older strict clients do not understand AI-client Assignments.

## Metrics

The `Fleet.Server` .NET Meter exposes request counts and duration, database
command duration, Bundle response bytes, source scan outcomes, and maintenance
record counts. Labels use fixed operations and outcomes, without Node IDs,
Operator names, source URLs, SQL, paths, or credentials.

`GET /operator/v1/metrics` returns in-process request and source counters to
authenticated Operators. Counters reset on restart. Histograms are available
through .NET Meter listeners, not the JSON endpoint. No exporter or outbound
telemetry is enabled. Stale-Node aggregate metrics, process resource budgets,
and a deployment-selected metrics collector remain follow-up work.

## Retention

Maintenance runs every 300 seconds, with at most 500 eligible records per
category per pass. It clears enrollment delivery responses after their retry
windows expire, retaining digests and consumption metadata so tokens stay used.
Audit and source scan deletion are disabled by default. Opt in through:

```sh
export Maintenance__AuditRetentionDays=90
export Maintenance__SourceScanRetentionDays=30
```

These durations are examples, not an adopted policy. Configure
`Maintenance__IntervalSeconds` and `Maintenance__BatchSize` when needed.
Retention age determines eligibility, not a deletion deadline under backlog.
Desired revisions, Assignments, Attempts, and Bundle bytes remain retained.
Cleanup cannot remove data from existing backups.

See [persistence hardening](persistence-hardening.md),
[source hardening](source-hardening.md), and
[backup/restore](backup-restore.md) for implementation boundaries and checks.
