# Accepted technology stack

## Status

The Server, managed-client, and Node-authentication stacks are accepted for the
POC. Wire details, deployment, and performance budgets still require decisions.

The durable decisions are recorded in
[ADR 0001](../adr/0001-use-dotnet-and-postgresql-for-the-server.md) and
[ADR 0002](../adr/0002-use-rust-for-agents-and-operator-cli.md), with Node
authentication in
[ADR 0003](../adr/0003-use-mtls-for-node-authentication.md).

## Fleet Server

| Concern | Choice |
|---|---|
| Runtime | .NET 10 LTS |
| HTTP host | ASP.NET Core |
| Serialization | System.Text.Json |
| Database | PostgreSQL |
| Persistence | EF Core 10 and Npgsql |
| Source polling | Hosted `BackgroundService` |
| Git access | Installed `git` executable behind a narrow adapter |
| Desired-state parsing | YamlDotNet |
| Bundle storage | PostgreSQL binary data for the POC |
| Contract documentation | Built-in OpenAPI 3.1 generation |
| Testing | xUnit, WebApplicationFactory, and PostgreSQL Testcontainers |
| Diagnostics | Built-in structured logging and OpenTelemetry-compatible instrumentation |

The Server is one modular monolith. Start with two production assemblies:

```text
server/
  Fleet.Server/   hosting, transport, persistence, Git, and YAML adapters
  Fleet.Core/     coordination and domain modules
  Fleet.Tests/
```

The ASP.NET host keeps separate route and authentication policy groups:

```text
/agent/v1/*       Fleet Agent protocol
/operator/v1/*    Fleet CLI operations
/admin/*          future admin BFF
```

Agent protocol models and future admin view models remain separate even though
the same process hosts both interfaces.

## Managed clients

One Rust 2024 workspace produces two binaries:

```text
clients/
  Cargo.toml
  crates/
    fleet-protocol/
    fleet-reconcile/
    fleet-agent-core/
  bins/
    fleet-agent/
    fleet/
```

The initially approved Rust libraries are:

- Tokio for the Agent work loop;
- Reqwest with rustls for HTTPS;
- Serde and serde_json for protocol messages;
- Clap for command parsing;
- Tracing and tracing-subscriber for structured diagnostics;
- thiserror for module errors and anyhow at binary entry points;
- sha2 for Bundle verification;
- uuid for identifiers;
- tempfile for filesystem tests; and
- cap-std as the first choice for capability-oriented Target access.

An approved library is not an instruction to install it immediately. Add it in
the first milestone that calls its interface.

## Protocol direction

The POC uses versioned HTTPS with JSON metadata and binary Bundle responses. It
does not introduce gRPC, MessagePack, or generated Rust clients. The small
protocol starts with hand-written models, shared JSON fixtures, and contract
tests in both languages.

The Agent generates a P-256 key and enrolls it through a signed certificate
request authorized by a short-lived, single-use token. The Server issues a
short-lived client certificate, and ongoing Agent operations use mTLS. Exact
certificate lifetimes and TLS termination remain open.

The supported network is a local network or an Operator-managed private overlay
such as Tailscale. Fleet treats that network as untrusted transport, adds no
Tailscale dependency or integration, and does not support public-internet Server
exposure in the POC.

## Dependency rule

Every new runtime dependency needs:

- a current requirement that cannot be met cleanly by the standard platform;
- a maintained upstream project and acceptable security history;
- a license compatible with the project license;
- a bounded role behind an existing module seam; and
- tests at the module interface so replacement remains possible.

Convenience alone is not enough. MediatR, generic repository frameworks,
AutoMapper, Hangfire, distributed caches, message brokers, and object storage are
outside the initial stack.

## Deferred choices

- Operator authentication and future browser login;
- certificate lifetime, renewal policy, and issuing-key operations;
- exact HTTP routes, error encoding, limits, and timeouts;
- Agent polling policy and stale threshold;
- production hosting and TLS termination;
- database migration and backup deployment mechanics;
- the future admin frontend framework; and
- concrete security, privacy, and performance budgets.
