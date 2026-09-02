---
status: accepted
date: 2026-09-02
---

# Use Rust for Agents and the Operator CLI

Managed Nodes and Operators will use Rust 2024. One Cargo workspace will produce
separate `fleet-agent` and `fleet` binaries so Node credentials and lifecycle do
not mix with Operator capabilities. Rust was chosen for predictable macOS and
Linux binaries and for the filesystem control needed by local reconciliation.

## Consequences

- The repository has .NET and Rust toolchains.
- Server and Rust protocol models do not share source code. Versioned contracts,
  shared fixtures, and cross-language tests keep them compatible.
- The Agent reconciliation core is platform-neutral where operating-system
  behavior permits. Linux and macOS adapters remain explicit.
- Dependencies are added only when a current milestone uses them.
