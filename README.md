# Fleet Manager successor

Fleet Manager distributes reviewable Skill content to user-owned macOS and
Linux machines. Each managed Node runs an Agent that initiates outbound
communication, receives declarative desired state, and reconciles its own local
filesystem.

The POC architecture and core implementation stack are agreed. There is no
application code yet.

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

The [original handoff](successor-poc-handoff.md) is retained as historical input.
The living documents above take precedence where later architecture discussions
resolved or changed an earlier assumption.

## Current phase

The next task is the Server foundation. Before its public Agent interface is
fixed, the project must define its remaining operating envelope, validate the
accepted Node authentication against the threat model, and set its privacy,
deployment, protocol, and measurable performance budgets.
