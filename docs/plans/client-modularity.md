# Client modularity plan

## Goal

Make the next operator command or AI client integration a local change. Keep the current command line, HTTP requests, JSON output, configuration files, receipts, recovery rules, and action registry unchanged.

## Phase 1: operator command boundary

- Keep argument types and dispatch together in `fleet::commands`.
- Keep HTTP policy, authentication, response limits, and error mapping in `fleet::api`.
- Route parsed commands through `fleet::commands::run`. A new command adds its clap type and one dispatch arm; transport details stay in `api`.
- Keep stdout as compact JSON and stderr/error strings byte-for-byte compatible where tests assert them.

Checks: clap help and legacy `nodes --after` parsing, URL validation, bearer requests, response-size limits, JSON output, and status-specific errors.

## Phase 2: AI client adapters

- Use one explicit static registry for supported clients.
- Put Codex and OpenCode path, render, restore, and empty-config behavior behind their registered adapters.
- Keep credential fetching, model discovery, journaling, receipts, safe file writes, and recovery in the shared reconciler.
- Adding an adapter requires a registry entry and an adapter module. It must not require changes to the assignment action registry or transaction code.

Checks: every registered adapter resolves by name, unknown names fail, render/restore round trips retain unrelated settings, externally changed Fleet-owned settings fail, and interrupted writes recover from the same journal and receipt formats.

## Phase 3: agent command handlers, when one grows

Move enrollment-link parsing and enrollment execution into an `enrollment` module when either gains another caller or subcommand. Move run-loop persistence into a `runner` module only when its state machine needs an independent implementation or test harness. Until then, splitting `main.rs` adds file traffic without creating an extension point.

Checks for any later move must preserve clap forms, prompt text, stdout JSON, retry delays, report ordering, state JSON field names, migration of legacy run state, and certificate renewal timing.

## Compatibility constraints

- No changes to `/operator/v1` or agent protocol routes, request bodies, response limits, timeouts, TLS rules, or redirect policy.
- No changes to clap command names, flags, defaults, environment variables, help behavior, or legacy `nodes --after` support.
- No changes to target names, the existing action registry, action error codes, cache layout, state JSON, receipt and journal schemas, managed config paths, or rendered provider values.
- No new dependencies, dynamic loading, plugin framework, version bump, or migration.

## Deferred work

Do not split `fleet-reconcile` by file size alone. Its validation, filesystem checks, transaction journal, recovery, and receipt code share safety invariants. Extract a bundle codec or file reconciler only when another crate needs it or a second implementation exists.

Do not introduce traits for the operator API, action registry, or run loop with one implementation. Small modules and explicit static registration cover the current extension needs.

## Outcome

Implemented phases 1 and 2. The operator CLI now separates transport from command parsing and dispatch. AI client configuration uses an explicit adapter registry with Codex and OpenCode code in separate modules. The action registry and shared recovery transaction remain unchanged.

Validation on Rust 1.95.0 runs 62 workspace tests. Workspace formatting, clippy with warnings denied, and a locked `fleet` binary build also pass.
