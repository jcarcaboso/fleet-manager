# Fleet Manager successor

Fleet Manager distributes reviewable Skill content to user-owned macOS and
Linux machines. Each managed Node runs an Agent that initiates outbound
communication, receives declarative desired state, and reconciles its own local
filesystem.

The repository now contains the .NET Server, PostgreSQL coordination module,
Git source ingestion, Rust Operator CLI, and a Rust Node Agent with local Skill
reconciliation. See the [Agent installation guide](deploy/agent/README.md).

Start with [the local HTTPS setup](docs/technical-design/server-development.md).
For a homelab deployment, use the [Docker Compose setup](deploy/homelab/README.md)
and the [standalone CLI installation guide](docs/technical-design/cli-installation.md).
Run `make restore`, `make format`, `make check`, and `make test` for the shared
development checks. PostgreSQL integration tests require Docker.

## Living documentation

- [Domain language](CONTEXT.md) defines the terms used by the product and code.
- [Architecture overview](docs/architecture/overview.md) records the system
  shape, ownership, module seams, and trust model.
- [Desired state](docs/architecture/desired-state.md) defines the source layout,
  Skill groups, Node subscriptions, Target paths, and automatic publication.
- [Agent reconciliation](docs/architecture/agent-reconciliation.md) defines how
  Agents report local state, receive desired state, and recover from failures.
- [POC scope](docs/poc-scope.md) states what the first implementation must prove
  and what it deliberately excludes.
- [Accepted stack](docs/technical-design/stack.md) records the approved .NET,
  PostgreSQL, and Rust choices and the dependency rule.
- [Engineering standards](docs/engineering-standards.md) make security, privacy,
  performance, and open-source contribution requirements part of completion.
- [Server development plan](docs/plans/server-development.md) sequences the
  Server-first implementation and its quality gates.
- [Server foundations decision map](docs/decision-maps/server-foundations.md)
  tracks authentication, threat-model, privacy, performance, deployment, and
  release questions that must still be resolved.
- [Architecture decisions](docs/adr/) record accepted choices that would be
  expensive or confusing to reverse.
- [Implementation status](docs/implementation-status.md) distinguishes the
  working Server and CLI from the remaining POC and release work.
- [Operations hardening](docs/technical-design/operations-hardening.md) covers
  listener validation, metrics, cleanup, Operator identities, and backup/restore.
- [Threat model](docs/technical-design/threat-model.md),
  [data inventory](docs/technical-design/data-inventory.md), and
  [dependency inventory](docs/technical-design/dependencies.md) document the
  current implementation's boundaries.

The [original handoff](successor-poc-handoff.md) is retained as historical input.
The living documents above take precedence where later architecture discussions
resolved or changed an earlier assumption.

## Current phase

The Server, Operator CLI, and Node Agent are under development. Operator authentication uses separately
configured bearer-token digests. The project uses the MIT license.

The Agent protocol is provisional. Full recovery reporting, real macOS deployment, measured performance budgets,
and operational release policies remain open. A private
security-reporting contact and contribution attestation policy remain open.
