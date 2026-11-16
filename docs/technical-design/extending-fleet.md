# Extending Fleet

Fleet uses ordinary modules and explicit, ordered registration. These are
compile-time extension points, not runtime plugins. New behavior ships with a
Server or client release; Fleet does not load code from source repositories.

The [client plan](../plans/client-modularity.md) and
[Server plan](../plans/server-modularity.md) describe the refactor scope and
the safety-critical code deliberately left together.

## Choose the boundary

| Change | Extension point | Keep shared |
| --- | --- | --- |
| Operator command | [Arguments and dispatcher](../../clients/bins/fleet/src/commands.rs) | HTTP authentication, TLS, response limits, and error handling in [api.rs](../../clients/bins/fleet/src/api.rs) |
| AI client configuration | [Adapter registry](../../clients/bins/fleet-agent/src/ai_client/adapters.rs) and adapter module | Credential retrieval, model discovery, safe writes, journal, and receipts |
| New assignment action | [Action registry](../../clients/bins/fleet-agent/src/actions/mod.rs) | Polling, reporting, retry policy, and Node identity |
| New published target | [Source target publishers](../../server/Fleet.Server/Source/SourceTargetPublishers.cs) | Git access, source validation, snapshot acceptance, and database transactions |
| Server service or route | [Hosting composition](../../server/Fleet.Server/Hosting/FleetServerHosting.cs) and the relevant endpoint module | Middleware order, authentication schemes, and authorization policies |

## Module map

Read the row for the module you are changing. A module may use the modules in
its last column and nothing else, so a change stays inside one folder plus the
files it names. Neither the Server namespaces nor the Agent modules form a
cycle; keep it that way.

### Server (`server/Fleet.Server`)

| Folder | Owns | Uses |
| --- | --- | --- |
| `Http` | API error types, the error-code to status table, error bodies | nothing |
| `Metrics` | Meter, counters, the database command interceptor | nothing |
| `Persistence` | `FleetDbContext`, migrations, `PostgresFleetCoordinator` | `Fleet.Core` |
| `Security` | Node and Operator authentication, certificates, Operator accounts, `FleetOptions` | `Http`, `Metrics`, `Persistence` |
| `Source` | Git mirror, manifest parsing, target publishers, scan polling, `SourceSettings` | `Metrics`, `Persistence`, `Security` |
| `AgentReleases` | Signed Agent release mirror | `Http`, `Security` |
| `CliProxy` | Model catalog, selections, catalog sync | `Persistence`, `Security`, `Source` |
| `Transport` | Agent routes, Operator API, issues, wire JSON | all of the above |
| `Dashboard` | Dashboard sessions, security filters, routes | `Http`, `Persistence`, `Security`, `Source`, `Transport` |
| `Hosting` | Service registration, middleware order, maintenance | everything; only `Program.cs` uses it |

`Fleet.Core/Coordination` holds the records and rules that cross the wire.
`IFleetCoordinator` inherits one interface per caller:
`INodeCredentialLookup` (authentication), `IAgentProtocol` (Agent routes),
`ISourcePublication` (scan polling), `IOperatorCommands` and
`IOperatorQueries` (Operator API and issues), and `IPersistenceMaintenance`.
Ask for the narrowest one. The `PostgresFleetCoordinator.*.cs` partial files
follow the same roles. Records live in `*Models.cs` files named after those
roles, and shared validation lives in the `*Rules` classes.

### Agent (`clients/bins/fleet-agent/src`)

| Module | Owns | Uses |
| --- | --- | --- |
| `protocol` (`protocol/wire.rs`) | HTTPS client and every JSON shape exchanged with the Server | nothing |
| `state` | State directory, lock, atomic writes, `Config` | nothing |
| `worker` | Detached single-slot background worker | nothing |
| `managed` | Installed Agent versions and the `current` link | `state` |
| `credentials` | Node key, certificate, stored identity | `protocol`, `state` |
| `run_state` | `run.json` and its legacy migration | `protocol`, `state` |
| `ai_client` (`catalog`, `config_file`, `adapters`) | AI client connection transactions | `protocol`, `state` |
| `actions` | Assignment action registry (Skills, Managed files, AI clients) | `ai_client`, `protocol`, `state`, `fleet-reconcile` |
| `detail` (`detail/redact.rs`) | Failure detail, redaction, pending detail | `actions`, `protocol`, `state` |
| `drift`, `repair` | Drift and repair-failure reports | `protocol` (`repair` also `actions`, `detail`) |
| `disk`, `telemetry` | Measurements and their report steps | `protocol`, `worker` (`telemetry` also `disk`, `managed`, `state`) |
| `updater` | Self-update, signature checks, rollback | `managed`, `protocol`, `state` |
| `service` | systemd and launchd service management | `credentials`, `managed`, `updater` |
| `enroll`, `cli` | Enrollment command and clap types | `credentials`, `protocol`, `state`, `service` |
| `inspect` | Read-only `status` and `check` | most modules, read-only |
| `agent_loop` | Poll loop, cycle, side-report order | most modules |
| `main` | Module list, argument parsing, dispatch | `agent_loop`, `cli`, `enroll`, `inspect`, `service` |

`clients/crates/fleet-reconcile` keeps its public API and error table in
`lib.rs`. `bundle` parses and validates Bundles, `observe` digests trees,
`fsx` holds the filesystem safety checks, locks and atomic JSON writes, and
`skills` and `managed_file` each hold one transaction with its receipt and
journal.

Three places are read as text by tests or scripts. `ErrorCode::as_str` must
stay in `fleet-reconcile/src/lib.rs` between `impl ReconcileError` and
`impl fmt::Display`. The `agent_update_*` literals must stay in `updater.rs`.
`scripts/smoke-agent-update.sh` patches the line that creates the `Updater`
in `agent_loop.rs`.

## Add an Operator command

Declare its arguments and dispatch it in the commands module.
Use the existing API helper rather than constructing a separate HTTP client.
Test argument parsing, the request method and path, compact JSON output, and
the relevant error response. Do not introduce a new authentication or redirect
policy for a command.

## Add an AI client adapter

Register the client and implement its config path, rendering, restoration, and
auxiliary-state behavior. Preserve unrelated user settings. The assignment
wins over local edits to the Fleet-owned settings: rendering overwrites them,
keeps the originals recorded in an existing receipt, and reports whether they
had drifted. Restoration must work from whatever is left (changed, partly
removed or missing settings, or a missing file) and must not touch anything
else. Without a receipt, never record Fleet's own leftover values as the
user's originals; provide an orphan receipt so native mode can remove them.

An Agent adapter alone does not make a client available in `fleet.yml`. Add
the corresponding Server validation and publication support, and test both
ends. Deploy compatible Agents before publishing assignments for the new
client. Do not put provider credentials in manifests, assignments, or logs.

Test adapter lookup, unknown-client rejection, render/restore round trips,
existing-file preservation, external changes and deletion of the Fleet-owned
settings, a lost receipt, conflicts, and interrupted-write recovery. Existing
receipt and journal formats remain compatibility contracts.

## Add a target publisher or action

A publisher turns validated source state into declarative targets. Register it
in the Server's ordered publisher list. Keep source validation explicit and
reject invalid declarations before accepting a snapshot. Test target names,
paths, bundle digests, deterministic ordering, and the difference between
omitted configuration and explicit empty configuration.

If the target needs new local behavior, add an Agent action that handles
validation, recovery, preparation, application, and cache retention. Reuse
existing reconciliation primitives where their semantics fit. Never turn a
target into an arbitrary shell command supplied by the Server.

A genuinely new wire shape needs protocol compatibility work in addition to
module registration. Additive code organization does not make older Agents
understand new assignments.

## Add Server services or endpoints

Register dependencies in Server composition and map routes in their owning
endpoint module. Keep process startup, listener configuration, and migration
mode explicit. Do not reorder middleware while adding a module: metrics,
HTTPS/error handling, rate limiting, timeouts, authentication, and authorization
have observable behavior.

Test authentication and authorization failures as well as successful requests.
Keep changes to persistence transitions inside the existing coordination
boundary so transaction guarantees remain reviewable.

## Verification

Run the repository's formatting, lint, test, and documentation-link checks.
Server integration tests require Docker; backup/restore tests also require
Python and the Docker CLI. Run the HTTPS smoke test against an isolated Compose
deployment when changing startup, authentication, enrollment, or route wiring.
Never point a disposable test's cleanup at a production Compose project.
