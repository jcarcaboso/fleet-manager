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

## Commands

The route set, scopes and response shapes are defined in the
[Operator API](operator-api.md). Every command prints one compact JSON document
on standard output. `<node>` is a Node alias or ID, passed through unchanged and
percent-encoded as one URL path segment, so aliases may contain spaces, `/`, `?`,
`#` and `%`. The CLI rejects empty, `.` and `..` names before sending anything.

| CLI command | Request |
|---|---|
| `fleet nodes list [--after C]` | `GET nodes` |
| `fleet nodes show <node>` | `GET nodes/{node}` |
| `fleet nodes attempts <node> [--target T] [--after C]` | `GET nodes/{node}/attempts` |
| `fleet nodes checkins <node> [--hours N]` | `GET nodes/{node}/checkins` (`N` is 1 to 168) |
| `fleet nodes rename <current> <new>` | `POST nodes/rename` |
| `fleet nodes revoke <node> --yes` | `GET nodes/{node}`, then `POST nodes/{nodeId}/revoke` |
| `fleet nodes remove <node> --yes` | `GET nodes/{node}`, then `POST nodes/{nodeId}/remove` with `{"alias": <current name>}` |
| `fleet retry <node> <target>` | `POST nodes/{node}/retry` with `{"target": T}` |
| `fleet issues list` | `GET issues` |
| `fleet errors list` | `GET errors` |
| `fleet explain <code>` | `GET errors/{code}` |
| `fleet doctor` | `GET issues`, then `GET errors` (see below) |
| `fleet rollouts list [--newest] [--after C]` | `GET rollouts` (`order=newest` with `--newest`) |
| `fleet rollouts attempts <rollout-id> [--after C]` | `GET rollouts/{id}/attempts` |
| `fleet revisions list [--newest] [--after C]` | `GET desired-revisions` (`order=newest` with `--newest`) |
| `fleet warnings list [--after C]` | `GET warnings` |
| `fleet scans list [--after C]` | `GET source/scans` |
| `fleet source status` | `GET source/status` |
| `fleet source rescan` | `POST source/rescan` |
| `fleet audit list [--node N] [--newest] [--after C]` | `GET audit` (`node=N`; `order=newest` with `--newest`) |
| `fleet enrollment create [--expires-in-seconds S]` | `POST enrollment-tokens` |
| `fleet enrollment links list [--after C]` | `GET enrollment-links` |
| `fleet enrollment links create <alias> [--expires-in-seconds S]` | `POST enrollment-links` |
| `fleet enrollment links revoke <id> --yes` | `POST enrollment-links/{id}/revoke` |
| `fleet credentials revoke <id> --yes` | `POST credentials/{id}/revoke` |
| `fleet models status` | `GET cliproxy/status` |
| `fleet models selection` | `GET cliproxy/selection` |
| `fleet models select [flags]` | `GET cliproxy/selection`, then `POST cliproxy/selection` |
| `fleet models refresh` | `POST cliproxy/refresh` |

The legacy `fleet nodes --after C list`, `fleet rollouts --after C list` and
`fleet warnings --after C list` forms still work.

Paged list commands accept an optional `--after <cursor>`, forward it as the
`after` query parameter and always send `limit=100`. `issues`, `errors` and
`doctor` are not paged. The paged response is:

```json
{"items": [], "nextCursor": null}
```

Pass a non-null `nextCursor` back with `--after` to read the next page. Items
are emitted as opaque JSON; the CLI does not copy sensitive content into
diagnostics.

`rollouts list`, `revisions list` and `audit list` accept `--newest`, which
sends `order=newest`: the Server then returns the newest items first (by
`createdAt`, `acceptedAt` and `recordedAt`), so the first item of the first page
is the most recent one. Without `--newest` the Server keeps its ID order, which
is stable for paging but not chronological, so never assume the first item is
the newest. A cursor is valid only with the `--newest` setting that produced it;
keep the flag on every page of one listing. `scans list` and `nodes attempts`
are always newest first.

The CLI accepts `http://` only for a loopback host with `--allow-http`:
`localhost`, an IPv4 address in 127.0.0.0/8 and the IPv6 address `::1` (written
`http://[::1]:8080`). The check uses the parsed host, so bracketed IPv6 works
and look-alike names such as `localhost.example` do not.

### Doctor

`fleet doctor` reads `GET issues` and, when there is at least one issue, `GET
errors` once. It prints one document:

```json
{
  "ok": false,
  "issues": [{"id": "...", "code": "assignment_failed", "severity": "error",
              "errorCode": "lock_failed", "commands": ["fleet retry studio-mini skills"],
              "explanation": {"title": "...", "explanation": "...", "fix": ["..."]}}],
  "summary": {"errors": 1, "warnings": 0}
}
```

Each issue is the Server's issue object plus `explanation`. The explanation comes
from the catalog entry for the issue's `errorCode`, else for its `code`, and is
`null` when neither is in the catalog. `ok` is true when no issue has severity
`error`. The command exits 0 when `ok` is true and 10 when it is false; warnings
alone exit 0. The document is printed in both cases.

### `models select`

The Server stores one policy per CLIProxy base URL and replaces it only if the
caller supplies the version it read (`stale_selection`, HTTP 409, otherwise). The
CLI therefore reads `GET cliproxy/selection`, applies the flags on top of the
current policy, and posts `{"baseUrl", "version", "policy": {"includeNew",
"disabledFamilies", "enabledFamilies", "modelOverrides",
"skipClaudeModelsForOtherClients"}}`.

| Flag | Effect |
|---|---|
| `--base-url URL` | Catalog to edit. Optional when exactly one catalog exists |
| `--selection-version N` | Replace this version instead of the one just read |
| `--include-new true\|false` | Policy `includeNew` |
| `--skip-claude-models-for-other-clients true\|false` | Policy flag of the same name |
| `--enable-family F`, `--disable-family F` | Move a family between `enabledFamilies` and `disabledFamilies` (repeatable) |
| `--enable-model M`, `--disable-model M` | Set `modelOverrides[M]` to true or false (repeatable) |
| `--clear-model-override M` | Remove `modelOverrides[M]` (repeatable) |
| `--dry-run` | Print the request instead of sending it |

At least one change flag is required. Naming the same family or model in two
opposing flags is a usage error (`conflicting_flags`).

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

`fleet retry <node> <target>` sends `{"target": "<target>"}` to
`POST /operator/v1/nodes/{node}/retry` and prints the Server's
`{"assignmentId", "attemptId", "state"}`.

`fleet enrollment links create <alias>` sends `{"alias", "expiresInSeconds"}`
(default 900) to `POST /operator/v1/enrollment-links`.

### Destructive commands

`nodes revoke`, `nodes remove`, `credentials revoke` and `enrollment links
revoke` need `--yes`. Without it the CLI sends nothing and exits 2 with error
code `confirmation_required`. `--dry-run` takes precedence over `--yes` and
performs only `GET` requests:

| Command | Reads for the preview |
|---|---|
| `nodes revoke`, `nodes remove` | `GET nodes/{node}` |
| `enrollment links revoke` | `GET enrollment-links`, paging up to 20 pages, to find the link |
| `credentials revoke` | nothing; the API has no credential lookup, so the ID is echoed |

The preview is:

```json
{"dryRun": true, "action": "nodes revoke", "target": {"nodeId": "...", "name": "..."},
 "request": {"method": "POST", "path": "nodes/<nodeId>/revoke"}}
```

`nodes revoke` and `nodes remove` resolve the Node with `GET nodes/{node}` first,
then act on the returned `nodeId`. `nodes remove` sends the Node's current name
as the `{"alias"}` confirmation body.

Mutation responses are JSON and are printed to standard output. The exact
response shapes are owned by the Server implementation; the CLI preserves
them as JSON during the POC.

## Failures

A failed command prints nothing on standard output and exactly one JSON line on
standard error:

```json
{"error": {"code": "node_not_found", "message": "no node matches that alias or ID", "status": 404}}
```

`status` is the HTTP status, or `null` when no response was involved. Messages
are written by the CLI. The CLI does not print response bodies, because they may
contain credentials or source details. For a non-success response it reads at
most 4 KiB of the body only to look for a JSON `code` string matching
`^[a-z][a-z0-9_]{0,63}$`; a valid code becomes the error `code`, and nothing else
from the body is kept. Without one, the code comes from the status:
`unauthorized` (401), `forbidden` (403), `not_found` (404), `conflict` (409),
`invalid_request` (400), `server_error` (5xx) or `request_failed`. CLI-side codes
include `confirmation_required`, `missing_token`, `invalid_configuration`,
`invalid_argument`, `no_changes`, `conflicting_flags`, `base_url_required`,
`enrollment_link_not_found`, `transport_error`, `timeout`, `response_too_large`
and `invalid_response`.

| Exit | Meaning |
|---|---|
| 0 | Success |
| 2 | Usage error: bad arguments (clap prints its usual text on stderr), missing `FLEET_OPERATOR_TOKEN`, invalid server URL, or a destructive command without `--yes` |
| 3 | Authentication or authorization failed: HTTP 401 or 403, with code `insufficient_scope` when the token's scope is too low |
| 4 | Not found: HTTP 404 |
| 5 | Conflict: HTTP 409 |
| 6 | Any other HTTP status, transport failure, timeout, or unreadable or oversized response |
| 10 | `fleet doctor` found error-severity issues (the document is on stdout) |

Clap usage errors and `--help` use clap's own text and exit codes (2 for errors,
0 for help).

## Server scopes and error bodies

The full route list is the [Operator API](operator-api.md). Two Server facts
apply to every client:

- **Scopes.** Each Operator credential has one scope, `read`, `operate` or
  `admin`, set with `Fleet:OperatorScopes:<operator-name>` (environment
  `Fleet__OperatorScopes__<operator-name>`). A credential without an entry is
  `admin`. An unknown value stops the Server at startup. A denied request returns
  HTTP 403 `{"code":"insufficient_scope","message":"..."}`. The dashboard session
  stores the scope at login, and `GET /dashboard/api/session` returns it.
- **Error bodies.** Every route under `/operator/v1` and `/dashboard/api`,
  including the routes that existed before the dashboard, returns
  `{"code":"snake_case","message":"..."}` on error, with the same status codes
  as before. This covers validation errors, the dashboard Origin and CSRF checks
  and the 401 for a missing or invalid credential (`unauthorized`). The message
  is written by the Server and never contains tokens, source content or file
  contents. The Agent protocol (`/agent/v1`) keeps returning `{"code":"..."}`.
- **Limits.** `limit` is 1 to 100 on every list, with 100 as the default. Other
  values return HTTP 400 `invalid_request`, as does a cursor that does not
  belong to the requested `order`.
