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

## Add an Operator command

Declare its arguments and dispatch it in the commands module.
Use the existing API helper rather than constructing a separate HTTP client.
Test argument parsing, the request method and path, compact JSON output, and
the relevant error response. Do not introduce a new authentication or redirect
policy for a command.

## Add an AI client adapter

Register the client and implement its config path, rendering, restoration, and
auxiliary-state behavior. Preserve unrelated user settings. Restoration must
check Fleet-owned settings against the receipt before changing them; it must
not silently overwrite a user's intervening edits.

An Agent adapter alone does not make a client available in `fleet.yml`. Add
the corresponding Server validation and publication support, and test both
ends. Deploy compatible Agents before publishing assignments for the new
client. Do not put provider credentials in manifests, assignments, or logs.

Test adapter lookup, unknown-client rejection, render/restore round trips,
existing-file preservation, conflicts, and interrupted-write recovery. Existing
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
