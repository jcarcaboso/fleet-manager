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
