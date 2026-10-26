# Device dashboard plan

## Goal

Replace the Operator dashboard with the Device Gallery design (prototype 04 in
`artifacts/dashboard-prototypes/`). Operators should see detailed errors,
detailed Node information and what is being deployed. The work spans four parts:

| Part | Code | Role |
|---|---|---|
| Server | `server/` | Owns all data and exposes one Operator API |
| Dashboard | `server/Fleet.Server/Dashboard/Assets/` | Device Gallery UI, served by the Server |
| Agent | `clients/bins/fleet-agent` | Reports richer state from each Node |
| Operator CLI | `clients/bins/fleet` | The same operations for people and LLM agents |

One rule ties them together: the dashboard and the CLI use the same API, so
anything possible in the dashboard is also possible with `fleet`.

## What the Server exposes today

| Surface | Auth | Used by | Routes |
|---|---|---|---|
| `/agent/v1` | Node mTLS | Agent | `POST enroll`, `POST poll` (no body), `GET bundles/{digest}`, `GET cliproxy/credential`, `GET cliproxy/models`, `POST reports` (`attemptId`, `state`, `errorCode`), `POST credentials/renew`, `PUT alias` |
| `/operator/v1` | Bearer token | `fleet` | `GET nodes`, `rollouts`, `desired-revisions`, `rollouts/{id}/attempts`, `warnings`, `audit`, `metrics`, `source/status`, `cliproxy/status`; `POST nodes/rename`, `nodes/{id}/revoke`, `enrollment-tokens`, `credentials/{id}/revoke`, `source/rescan`, `cliproxy/refresh` |
| `/dashboard/api` | Cookie + CSRF | Dashboard | `GET csrf`, `session`, `nodes`, `diagnostics`, `cliproxy/status`, `cliproxy/selection`; `POST login`, `logout`, `source/rescan`, `cliproxy/refresh`, `cliproxy/selection`, `nodes/rename`, `nodes/{id}/revoke`, `nodes/{id}/remove`, `enrollment-links`, `enrollment-links/{id}/revoke` |

Gaps:

- No endpoint returns one Node's Targets, Assignments or Attempts. Node lists
  return only ID, alias, revoked flag, last contact and freshness. Platform is
  stored but never returned.
- The two Operator surfaces have drifted apart. Only the dashboard can remove
  Nodes, manage enrollment links and select models. Only the bearer API can
  list rollouts, revisions, Attempts, warnings and audit events. The `fleet`
  CLI uses seven of the bearer routes.
- Only the latest source scan is readable, although every scan is stored.
- `AttemptRow.Diagnostic` exists but the Agent never sends one.
- Issue text is hard-coded in `DashboardDiagnostics`, so the CLI cannot show it.
- Failed Assignments stay failed until the next publication. The only
  exception is `ai_client_reconcile_failed`, which the Server re-queues after
  one minute (`RetryFailedAiAssignment`).

## Compatibility constraint

Both sides of the Agent protocol are strict:

- The Server sets `UnmappedMemberHandling.Disallow`, so an Agent that adds a
  request field gets HTTP 400 from an older Server.
- The Agent uses `deny_unknown_fields` on every response, so a Server that adds
  a field to an existing response breaks Agents 0.6.6 to 0.8.1.

Therefore:

- Existing `/agent/v1` request and response shapes do not change.
- New Agent data goes to new endpoints. The Agent treats HTTP 404 as "Server
  too old" and skips that report without failing the cycle.
- Upgrade the Server before the Agents.
- The dashboard shows "Not reported by Agent 0.8.1" when data is missing,
  never a guess.

The CLI emits list items as opaque JSON, so additive fields in `/operator/v1`
responses are safe.

## API shape

- Write each Operator handler once and map it into both `/operator/v1` (bearer
  token) and `/dashboard/api` (cookie, with CSRF on mutations). This keeps both
  existing auth filters unchanged and makes parity automatic.
- Keep `/operator/v1` additive. Add a JSON fixture to `contracts/operator/` for
  each new response and test it from both the Server and the CLI, as
  `nodes-page.json` is tested today.
- Accept a Node alias or ID wherever a route takes a Node.
- Return errors as `{ "code": "...", "message": "..." }` using catalog codes.
  The CLI may print these, because they never contain source or secrets.

## Phase 1: machines from existing data

No Agent release is needed. This phase covers most of the Device Gallery.

Server:

| Route | Returns |
|---|---|
| `GET nodes` (extended) | Adds platform, enrolledAt, credential expiry, Target state counts and current revision |
| `GET nodes/{node}` | Identity, credential validity, each Target with its current Assignment, desired revision and latest Attempt |
| `GET nodes/{node}/attempts` | Attempt history across Targets, paged |
| `GET nodes/{node}/checkins` | Polls per hour for the last 7 days |
| `GET issues` | Today's `diagnostics` as structured items: stable ID, severity, error code, affected Node and Target, and suggested CLI commands |
| `GET errors` | Error catalog: code, title, explanation and fix steps for every Agent and Server code |
| `GET source/scans` | Scan history, paged |
| `GET enrollment-links` | Active and recent links, without tokens |
| `GET audit?node=` | Audit filtered by Node |
| `POST nodes/{node}/targets/{target}/retry` | Re-queues a failed current Assignment, as `RetryFailedAiAssignment` already does for one error code. The Agent picks it up on its next poll |
| Parity | Bearer routes for remove, enrollment links and model selection; dashboard routes for rollouts, revisions, Attempts, warnings and audit |

Check-in history needs only the Server: increment an hourly counter per Node on
each poll, in a new `node_checkins` table, and prune it with the existing
history retention.

Dashboard: machine gallery, Node page (Overview, Installed, Problems,
Security, Settings, plus Activity with check-ins), Problems page, Repository,
Models, Enrollment wizard and Audit. Problems show error code, catalog text,
first seen and retry count. Fields that need later phases are hidden.

CLI: `nodes show`, `nodes attempts`, `nodes remove`, `issues list`, `explain
<code>`, `retry <node> <target>`, `revisions list`, `scans list`, `audit list`,
`enrollment links list|create|revoke` and `models list|select|refresh`.

## Phase 2: error detail

Agent: after a failed Attempt, send `POST /agent/v1/attempts/{id}/detail` with
a bounded diagnostic of at most 2 KiB, the Target-relative failing path, and the
failing step. It never includes file contents, credentials or CLIProxy keys.

Server: store the diagnostic in the existing `AttemptRow.Diagnostic`, plus new
path and step columns. Return them from `nodes/{node}`, Attempt lists and
`issues`.

Dashboard and CLI: the full failure view, with what happened, why and how to fix it.

## Phase 3: machine telemetry

Agent: send `PUT /agent/v1/telemetry` at startup and whenever a value changes.
It carries Agent version, OS name and version, architecture, hostname, user,
install method (Homebrew, archive or Cargo), service manager and state
directory.

Server: store the latest values per Node and flag Agents older than the current
release.

Dashboard: OS and Agent version on cards, "Agent outdated" issues and grouping
by platform. Agent self-update remains out of scope until signed releases exist
(see `client-updates.md`). The dashboard shows the upgrade command instead.

## Phase 4: what is being deployed

- Source scans read the commit subject and author from Git.
- `GET desired-revisions/{id}` lists Skills added, changed and removed, by
  comparing Bundle digests with the previous revision.
- `GET rollouts/{id}` returns per-Node progress, for the Deployments page.
- Agent drift reports go to `POST /agent/v1/drift` when the Agent repairs owned
  files.
- Issue acknowledge and snooze are stored in a new `issue_states` table.

## CLI for LLM agents

Extend `fleet` rather than adding a second tool. It already has bearer auth,
JSON output, response limits and safe error handling.

- Stdout is always JSON with stable field names. Errors go to stderr as
  `{ "code", "message" }` with documented exit codes.
- `fleet doctor` returns every open issue with its explanation and the exact
  `fleet` commands that fix it. This is the entry point for an LLM.
- Destructive commands (`nodes revoke`, `nodes remove`, `credentials revoke`)
  require `--yes`. `--dry-run` shows the effect without making the change.
- Add Operator token scopes: `read`, `operate` (retry, rescan, refresh, model
  selection) and `admin` (enroll, revoke, remove). An LLM can then get a token
  that cannot revoke machines. Today every Operator token has full rights.
- Publish a `fleet-operator` Skill in the source repository. It teaches AI
  clients the CLI, and Fleet distributes it to Nodes like any other Skill.

## Dashboard build rules

- Keep it served by the Server at `/dashboard`, on the same origin. Session
  cookies, the Origin check and CSRF all depend on it.
- Plain JavaScript modules and CSS files with no npm build, matching today's
  dashboard and the dependency policy. The CSP blocks inline scripts and
  styles, so the prototype's inline code moves into files. The explicit
  per-file asset routes become one route over the embedded asset folder.
- Keep `data.js` as a development fixture so the UI can be built and
  screenshot-tested without a Server.

## Order

Phases ship in order. Each phase lands Server, dashboard and CLI together.
Phase 1 is the largest and needs no Agent upgrade. Phases 2 and 3 need a Server
release first, then an Agent release. Phase 4 is independent of Phases 2 and 3.

## Open decisions

- Token scope names and the default scope for existing tokens. `admin` keeps
  current behaviour.
- Check-in retention (7 days proposed) and whether to keep it when history
  retention is disabled.
- Whether `nodes remove` should also require the alias confirmation the
  dashboard uses today.
