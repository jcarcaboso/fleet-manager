# Operator API (device dashboard, phase 1)

This is the contract shared by the Server, the dashboard and the `fleet` CLI for
phase 1 of the [device dashboard plan](../plans/device-dashboard.md). Every
route below exists under both prefixes:

| Prefix | Auth | Client |
|---|---|---|
| `/operator/v1` | `Authorization: Bearer <token>` | `fleet` |
| `/dashboard/api` | `__Host-Fleet-Session` cookie; non-GET requests also need the Origin and CSRF checks | dashboard |

Each handler is written once and mapped into both groups. Existing routes keep
their current paths, shapes and behaviour unless this document says otherwise.
The Agent protocol (`/agent/v1`) does not change in phase 1.

## Conventions

- JSON uses camelCase properties. Enums are snake_case strings, matching
  `WireJson`: `fresh`, `stale`, `never_contacted`; `pending`, `applying`,
  `succeeded`, `failed`, `superseded`.
- Timestamps are ISO 8601 UTC strings. Absent values are `null`, never omitted.
- Lists return `{ "items": [...], "nextCursor": null | "<opaque>" }`. They
  accept `limit` (1 to 100, default 100; other values return 400
  `invalid_request`) and `after` (cursor).
- `GET desired-revisions`, `GET rollouts` and `GET audit` also accept
  `order=newest`: newest first by `acceptedAt`, `createdAt` and `recordedAt`
  respectively, with ties broken by ID and a `(timestamp, id)` cursor. Without
  `order`, they keep their existing ID ordering. A cursor is valid only with the
  `order` it came from.
- `{node}` is a Node ID (UUID) or an exact, case-sensitive alias in the
  Operator's Workspace, sent as one percent-encoded path segment. The Server
  decodes the segment from the raw request target, so `rack%2FA` means the
  alias `rack/A` and `a%252Fb` means the alias `a%2Fb`. A raw path that does not
  decode to the matched route, such as one with `.` or `..` segments, returns
  400 `invalid_request`. A UUID-shaped value is
  resolved as an ID first. Revoked
  Nodes resolve too, except where a route says otherwise.
- Errors return the HTTP status with `{ "code": "snake_case", "message": "..." }`.
  Messages never contain tokens, source content or file contents. Codes used
  here: `node_not_found` (404), `target_not_found` (404), `target_not_failed`
  (409), `node_revoked` (409), `insufficient_scope` (403), `invalid_request` (400),
  `enrollment_link_not_found` (404). Every route under both prefixes uses this
  shape for errors, including existing routes that returned `{ "code" }`.

## Operator scopes

Each Operator credential has one scope. `admin` includes `operate`, which
includes `read`.

| Scope | Allows |
|---|---|
| `read` | Every `GET` route |
| `operate` | Retry, source rescan, CLIProxy refresh, CLIProxy model selection |
| `admin` | Enrollment tokens and links, Node rename, revoke and remove, credential revoke |

Configuration: `Fleet:OperatorScopes:<operator-name>` = `read` | `operate` |
`admin`. A credential without an entry is `admin`, so existing deployments keep
their current behaviour. An unknown scope value fails Server startup
validation. The scope is checked for bearer tokens and dashboard sessions; the
session stores it at login. A denied request returns 403 `insufficient_scope`.
`GET session` returns `{ "actor": "...", "scope": "admin" }`.

## Nodes

### `GET nodes` (extended)

Existing fields are unchanged; new fields are added. Revoked Nodes are listed
with `"revoked": true` and `"freshness"` computed as today.

```json
{
  "items": [{
    "nodeId": "00000000-0000-0000-0000-000000000001",
    "name": "studio-mini",
    "revoked": false,
    "lastContactAt": "2026-10-25T14:29:10Z",
    "freshness": "fresh",
    "platform": "macos",
    "enrolledAt": "2026-09-01T10:00:00Z",
    "revokedAt": null,
    "credentialNotAfter": "2026-10-30T09:00:00Z",
    "targets": { "pending": 0, "applying": 0, "succeeded": 4, "failed": 1, "superseded": 0 },
    "currentRevision": "a3f9c21d0c5b4e8f9a1b2c3d4e5f60718293a4b5"
  }],
  "nextCursor": null
}
```

- `targets` counts the Node's current Assignments by state.
- `currentRevision` is the source revision of the newest desired revision among
  the Node's current Assignments, or `null`.
- `credentialNotAfter` is from the newest non-revoked credential, or `null`.

### `GET nodes/{node}`

```json
{
  "nodeId": "…",
  "name": "studio-mini",
  "platform": "macos",
  "enrolledAt": "…",
  "lastContactAt": "…",
  "freshness": "fresh",
  "revoked": false,
  "revokedAt": null,
  "credential": {
    "credentialId": "…",
    "notBefore": "…",
    "notAfter": "…",
    "revokedAt": null,
    "revokedBy": null,
    "renewals": 6
  },
  "targets": [{
    "name": "ai-client/claude",
    "kind": "ai-client",
    "base": "home",
    "path": ".claude",
    "assignmentId": "…",
    "state": "failed",
    "assignedAt": "…",
    "desiredRevision": { "desiredRevisionId": "…", "sourceRevision": "…", "acceptedAt": "…" },
    "lastSucceededRevision": "51c0d8a…",
    "latestAttempt": { "attemptId": "…", "state": "failed", "errorCode": "ai_client_reconcile_failed", "diagnostic": null, "updatedAt": "…" },
    "failedAttempts": 3,
    "firstFailedAt": "…",
    "skills": [],
    "file": null,
    "aiClient": { "client": "claude", "mode": "cliproxy", "baseUrl": "https://proxy.home.arpa", "model": "claude-sonnet-5-5" }
  }],
  "summary": { "pending": 0, "applying": 0, "succeeded": 4, "failed": 1, "superseded": 0 }
}
```

- `credential` is the newest credential, revoked or not. `renewals` is the
  Node's credential count minus one. `null` only if the Node has none.
- `targets` holds one entry per current Assignment, ordered by name.
- `kind` is the part of `name` before `/`, or `skills`.
- `lastSucceededRevision` is the source revision of the newest Assignment for
  this Node and Target name whose state is `succeeded`, current or not, or
  `null`.
- `failedAttempts` and `firstFailedAt` cover the current Assignment only.
- `skills` is `[{ "name", "bundleDigest" }]` in manifest order. `file` is
  `{ "name", "bundleDigest" }` (`bundleDigest` is `null` for a removal) or
  `null`. `aiClient` is `{ "client", "mode", "baseUrl", "model" }` or `null`.

### `GET nodes/{node}/attempts`

Newest first, across all Targets and Assignments, paged.

```json
{ "items": [{
  "attemptId": "…", "assignmentId": "…", "rolloutId": "…",
  "targetName": "skills", "sourceRevision": "…",
  "state": "failed", "errorCode": "lock_failed", "diagnostic": null, "updatedAt": "…"
}], "nextCursor": null }
```

Optional filter: `target=<target name>`.

### `GET nodes/{node}/checkins`

Polls received per UTC hour, oldest first, for the last `hours` hours
(1 to 168, default 168). Hours without polls are included with `polls: 0`.

```json
{ "hours": 168, "buckets": [{ "hour": "2026-10-25T13:00:00Z", "polls": 59 }] }
```

The Server increments a `node_checkins (node_id, hour, polls)` row on every
successful `/agent/v1/poll`, using an upsert. Recording is best effort: it runs
after the Assignment is found, in its own short transaction with a 500 ms lock
timeout, and a failure is logged and ignored, so a check-in can never fail a poll
or hold back an Assignment. History maintenance deletes rows
older than 7 days, independently of the opt-in history retention policy.

### `POST nodes/{node}/retry` (scope `operate`)

Body: `{ "target": "ai-client/claude" }`.

Re-queues the Node's current failed Assignment for that Target: the Assignment
becomes `pending` and a new `pending` Attempt is added, exactly like
`RetryFailedAiAssignment`. The Agent applies it on its next poll. Response:
`{ "assignmentId": "…", "attemptId": "…", "state": "pending" }`. Writes an
`assignment.retry_requested` audit event with the Node ID.

Errors: unknown Target `target_not_found`; the current Assignment is not
`failed`: `target_not_failed`; revoked Node: `node_revoked`.

### Existing Node mutations

`POST nodes/rename`, `POST nodes/{id}/revoke` and `POST nodes/{id}/remove`
(body `{ "alias": "<current alias>" }` as confirmation) are available under both
prefixes with scope `admin`. Their bodies and responses are unchanged.

## Issues and errors

### `GET issues`

The structured successor of `GET diagnostics`, which stays available unchanged
for one release.

```json
{ "items": [{
  "id": "assignment_failed:<nodeId>:skills",
  "code": "assignment_failed",
  "severity": "error",
  "title": "studio-mini: skills failed",
  "detail": "…",
  "action": "…",
  "section": "nodes",
  "errorCode": "lock_failed",
  "nodeId": "…",
  "nodeName": "studio-mini",
  "target": "skills",
  "since": "…",
  "commands": ["fleet nodes show studio-mini", "fleet explain lock_failed", "fleet retry studio-mini skills"]
}] }
```

- `id` is stable for the same underlying problem: `code`, plus Node ID and
  Target where they apply.
- `severity` is `error` or `warning`. Errors come first, then by Node name and
  Target.
- `errorCode`, `nodeId`, `nodeName`, `target` and `since` are `null` when they
  do not apply. `since` is the first failed Attempt of the current Assignment,
  or the last contact for a stale Node.
- Stale Nodes produce one `node_not_contacting` issue each, rather than one
  combined issue.
- `commands` holds `fleet` command lines that inspect or fix the issue. It may
  be empty.
- Not paged. The Server returns at most 200 issues.

### `GET errors`

The error catalog for every Agent error code and every issue code.

```json
{ "items": [{
  "code": "lock_failed",
  "source": "agent",
  "title": "Another process holds the Target lock",
  "explanation": "…",
  "fix": ["…", "…"]
}] }
```

`source` is `agent`, `server` or `issue`. The catalog covers at least:
`invalid_assignment`, `unsupported_schema`, `target_changed`,
`recovery_failed`, `ownership_conflict`, `owned_skill_drift`,
`non_regular_entry`, `missing_owned_skill`, `malformed_bundle`, `lock_failed`,
`invalid_target`, `invalid_state_directory`, `invalid_skill_name`,
`invalid_home`, `invalid_digest`, `invalid_bundle_path`, `filesystem_escape`,
`duplicate_skill`, `corrupt_receipt`, `bundle_size_mismatch`,
`bundle_path_collision`, `bundle_limit_exceeded`, `bundle_digest_mismatch`,
`assignment_superseded`, `ai_client_reconcile_failed`, and every `code` that
`GET issues` can return. `GET errors/{code}` returns one entry or 404
`invalid_request`.

## Source, rollouts and audit

| Route | Notes |
|---|---|
| `GET source/status` | Existing response, now under both prefixes |
| `GET source/scans` | Newest first, paged: `{ "scanId", "sourceRevision", "outcome", "code", "diagnostic", "observedAt", "requestedBy" }`. `outcome` is `accepted`, `unchanged`, `invalid` or `failed` |
| `POST source/rescan` | Scope `operate`. Unchanged |
| `GET desired-revisions` | Existing response, now under both prefixes |
| `GET rollouts` | Existing response, now under both prefixes |
| `GET rollouts/{id}/attempts` | Existing response, now under both prefixes |
| `GET warnings` | Existing response, now under both prefixes |
| `GET audit` | Existing response, plus optional `node={node}` filter. Items gain `"nodeName"` (`null` if the Node was removed) |

## Enrollment

| Route | Scope | Notes |
|---|---|---|
| `GET enrollment-links` | `read` | Newest expiry first, paged: `{ "id", "alias", "expiresAt", "consumedAt", "revokedAt", "revokedBy", "nodeId", "state" }`. `state` is `active`, `consumed`, `expired` or `revoked`. Tokens and links are never returned |
| `GET enrollment-links/{id}` | `read` | One item in the same shape, or 404 `enrollment_link_not_found` |
| `POST enrollment-links` | `admin` | Existing dashboard route, now under both prefixes. Body `{ "alias", "expiresInSeconds" }` |
| `POST enrollment-links/{id}/revoke` | `admin` | Existing, now under both prefixes |
| `POST enrollment-tokens` | `admin` | Existing bearer route, now under both prefixes |
| `POST credentials/{id}/revoke` | `admin` | Existing bearer route, now under both prefixes |

## CLIProxy

| Route | Scope |
|---|---|
| `GET cliproxy/status` | `read` |
| `GET cliproxy/selection` | `read` |
| `POST cliproxy/selection` | `operate` |
| `POST cliproxy/refresh` | `operate` |

Bodies and responses are unchanged.

## Dashboard assets

`GET /dashboard/{file}` serves any embedded file in
`server/Fleet.Server/Dashboard/Assets/` whose name matches
`^[a-z0-9][a-z0-9-]*\.(js|css|html|svg)$`, with the matching content type and
the existing security headers. It replaces the per-file routes. `GET
/dashboard` still serves `index.html`, and `/enroll` still serves
`enroll.html`. Other names return 404.

## Phase 2: attempt detail

Phase 2 adds a bounded description of why an Attempt failed. The Agent sends
it on a new route, so the existing `/agent/v1` shapes stay unchanged.

### `POST /agent/v1/attempts/{attemptId}/detail` (Node mTLS)

```json
{ "diagnostic": "lock is held by process 4121 since 2026-10-25T13:14:58Z", "path": ".claude/settings.json", "step": "lock" }
```

- `diagnostic` is required: 1 to 2048 characters (UTF-16 code units, as .NET
  counts) after the Agent removes control characters other than `\n` and `\t`,
  replaces the user's home directory with `~` and its state directory with
  `<state-dir>` (whole path components only), and replaces any other absolute
  path with `<path>/<last component>`. It describes the failure,
  never file contents, credentials, tokens, CLIProxy keys or environment values.
- `path` is optional, at most 512 characters, relative to the Target base
  (for example `.agents/skills/incident-runbook/SKILL.md`). It never starts
  with `/` or contains `..` segments.
- `step` is optional and is one of `lock`, `download`, `verify`, `stage`,
  `activate`, `recover`, `receipt`, `configure`, `validate`.
- The Attempt must belong to the authenticated Node and be `failed`.
  Responses: 204 on success, including a repeat; 404 `attempt_not_found` if
  the Attempt is unknown or belongs to another Node; 409 `attempt_not_failed`
  if it is not failed; 400 `invalid_request` for invalid fields. The latest
  accepted detail replaces earlier detail for that Attempt.
- Each Node may send 30 detail requests in a burst and then one every 2
  seconds; beyond that the Server returns 429 `rate_limited` with a
  `Retry-After` header, and the Agent retries later. A repeat that carries the
  stored values returns 204 without writing the row.
- The Server strips control characters again and enforces the limits. It
  stores `diagnostic` in the existing `attempts.Diagnostic` column, and `path`
  and `step` in new nullable `FailurePath` and `FailureStep` columns.

### Agent behaviour

- After a failed Attempt's terminal report is accepted, the Agent sends its
  detail. The report is never delayed or blocked by the detail.
- Pending detail is kept in its own state file, `pending-detail.json`, not in
  the run state, because the run state rejects unknown fields and an older
  Agent must still be able to read it after a downgrade.
- HTTP 404 with an empty or non-JSON body means the Server predates phase 2:
  the Agent drops the detail and does not retry it. Other failures are retried
  on later cycles, for at most 24 hours. Only the newest pending detail is
  kept.
- The Agent ignores the response body.

### Operator API changes

These fields are added; nothing is removed.

| Response | New fields |
|---|---|
| `GET nodes/{node}`: `targets[].latestAttempt` | `path`, `step` (`diagnostic` already exists and is now filled) |
| `GET nodes/{node}/attempts` items | `path`, `step` |
| `GET rollouts/{id}/attempts` items | `path`, `step` |
| `GET issues` items | `diagnostic`, `path`, `step`, from the latest failed Attempt of the Assignment; `null` otherwise |

All three are `null` when the Agent did not send detail. Agents before phase 2
never send it.
