# Operator HTTP protocol (POC)

The Fleet CLI calls the Server's versioned operator API under `/operator/v1`.
Requests use HTTPS and carry an operator bearer token:

```http
Authorization: Bearer <operator-token>
```

The POC stores configured operator token digests on the Server. Tokens are
provided to the CLI only through `FLEET_OPERATOR_TOKEN`; the CLI never accepts
a token command-line argument, so it cannot be captured in shell history or a
process listing. The CLI requires `FLEET_SERVER_URL` or `--server-url`.

The optional `--ca-cert <FILE>` flag adds a PEM CA certificate to the default
WebPKI trust roots for private self-hosted Server deployments. The CLI rejects
URLs containing credentials, query strings, fragments, or non-root paths.

Plain HTTP is rejected. `--allow-http` permits it only when the URL host is
`localhost`, `127.0.0.1`, or `::1`, for local development and tests.
Requests have a 30-second timeout and do not follow redirects. Successful JSON
responses are limited to 1 MiB; oversized responses fail before decoding.

## Collections

The following endpoints are authenticated `GET` requests. Each list command
accepts an optional `--after <cursor>` and forwards it as the `after` query
parameter:

| CLI command | Endpoint |
|---|---|
| `fleet nodes list` | `/operator/v1/nodes` |
| `fleet rollouts list` | `/operator/v1/rollouts` |
| `fleet warnings list` | `/operator/v1/warnings` |

Each request includes `limit=100`. The server response is:

```json
{"items": [], "nextCursor": null}
```

`nextCursor` is reserved for subsequent pagination. Items are intentionally
opaque to this first CLI and are emitted as JSON without copying sensitive
content into diagnostics.

## Mutations

`fleet nodes rename <current-alias> <new-alias>` sends:

```http
POST /operator/v1/nodes/rename
Content-Type: application/json
```

```json
{"currentAlias":"homelab","alias":"homelab-mini"}
```

The response contains the unchanged `nodeId` and the new `alias`. The Server
resolves the exact, case-sensitive current alias in the Operator's Workspace and
records the Operator identity in the audit event. Both aliases must be nonblank
and at most 200 characters. Aliases travel in JSON so punctuation is not treated
as a URL path. Quote aliases with spaces when using the CLI.

Unknown current aliases return HTTP 404 with `node_not_found`. An occupied new
alias returns HTTP 409 with `node_alias_in_use`; a revoked Node returns HTTP 409
with `node_revoked`. Invalid aliases return HTTP 400. A Node certificate alone
cannot authorize this endpoint. Renaming to the current alias succeeds without
an extra audit event. After a successful rename, retrying with the old alias
returns 404 unless that alias has since been assigned to another Node. If the
response is lost, run `fleet nodes list` and verify the Node ID before retrying.

Update the alias key in `fleet.yml`, commit, and run `fleet source rescan` after
renaming. UUIDs, certificates, and existing Assignments remain unchanged. The
old alias becomes available again; update the source before reusing it.

`fleet enrollment create --expires-in-seconds 900` sends:

```http
POST /operator/v1/enrollment-tokens
Content-Type: application/json
```

```json
{"expiresInSeconds": 900}
```

`fleet credentials revoke <uuid>` sends an empty-body:

```http
POST /operator/v1/credentials/{uuid}/revoke
```

`fleet source rescan` sends:

```http
POST /operator/v1/source/rescan
```

Mutation responses are JSON and are printed to standard output. The exact
response shapes are owned by the Server implementation; the CLI preserves
them as JSON during the POC.

## Failures

Non-success status codes produce a short status-specific error. The CLI does
not read or print response bodies for failures, because they may contain
credentials or source details. Authentication failures are reported as
`operator authentication failed`; a missing route as `Fleet Server route was
not found`; other statuses as `Fleet Server request failed` with the status
code.
