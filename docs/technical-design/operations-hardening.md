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

## Multiple Operators

Every Operator remains a full administrator. Configure distinct token digests:

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
