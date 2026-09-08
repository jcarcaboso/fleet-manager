# Implementation status

The repository contains the initial Server foundations and the Operator CLI
implementation. The implementation is not yet the complete Fleet POC described in
[`docs/poc-scope.md`](poc-scope.md).

Implemented:

- .NET 10 Server/Core project structure, locked NuGet dependencies, and a
  PostgreSQL EF Core persistence model for Workspace, Nodes, credentials,
  enrollments, Bundles, desired revisions, Assignments, Attempts, Rollouts,
  warnings, source scans, and security audit events;
- Server coordination transitions covering enrollment authorization and
  consumption, Node authentication/revocation, source publication, Agent poll,
  Bundle lookup, and idempotent Attempt reporting;
- source adapters for bounded Git inspection, manifest parsing, duplicate
  warnings, complete nested Skill Bundle encoding, and startup/periodic source
  scanning;
- separate Operator bearer-token and Node mTLS authentication policies, with
  route groups for `/operator/v1` and `/agent/v1`;
- Rust 2024 `fleet` CLI workspace with bearer-token operator requests;
- versioned `/operator/v1` route contracts for list, enrollment, credential
  revocation, and source rescan operations;
- HTTPS enforcement with a loopback-only HTTP development escape hatch; and
- repository restore, formatting, build, test, Clippy, and documentation-link
  commands.

The [first hardening pass](technical-design/operations-hardening.md) adds
transaction race protection, named Operator credentials, explicit listener and
readiness checks, bounded Git process handling, operational metrics, expired
enrollment-response cleanup, opt-in history retention, and a tested PostgreSQL
backup/restore tool.

The [homelab Compose stack](../deploy/homelab/README.md) packages the Server,
PostgreSQL, migrations, and private TLS configuration. The amd64 Server image is
published to `skorcius/fleet-manager:0.2.0`. A static Linux amd64
[Operator CLI archive](technical-design/cli-installation.md) is built locally.
Container HTTPS/mTLS smoke tests and a CLI request against the packaged Server
passed; artifact signing and automated certificate renewal remain open.

Server 0.2.0 uses unique Node aliases as source manifest keys and
supports authenticated self-service alias changes through `PUT /agent/v1/alias`
and Operator changes through `fleet nodes rename <current-alias> <new-alias>`.
The published `0.1.0` release predates this change. UUID-based manifests must
remove `id` and use each Node's current enrollment name as the key. Internal Node
IDs, certificates, and existing Assignments remain stable.

The first Node Agent implements P-256 enrollment, real mTLS, certificate renewal,
polling, bounded Bundle downloads, receipt-based ownership, journaled filesystem
activation and rollback, cached drift repair, and durable terminal report retry.
The [Agent setup guide](../deploy/agent/README.md) covers the Linux amd64 binary
and user service. It works with the deployed Server 0.2.0 API.

Still required for the full POC:

- a real macOS deployment, macOS service packaging, and broader failure exercises;
- the full Agent recovery/reporting conversation and Operator-authorized
  replacement of a lost Node key while preserving its stable identity;
- measured polling, publication, and Bundle throughput budgets. A 1,000-Node
  no-work polling fixture exists, but does not establish those budgets;
- a stable Agent compatibility policy, stale-Node aggregate metrics, and a
  deployment-selected metrics collector;
- adopted retention periods, backup scheduling/encryption and recovery
  objectives, CA rotation, and enforced source mirror disk quotas;
- release security, published artifact inventories/signing, private
  vulnerability reporting, and contribution attestation.
