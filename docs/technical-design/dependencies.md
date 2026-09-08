# Server dependencies

The runtime uses ASP.NET Core and the .NET cryptography platform for hosting,
authentication, certificate requests, and certificate issuance. No custom
cryptographic primitive or request-signing protocol is introduced.

| Package | Caller and reason | License |
|---|---|---|
| Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3 | PostgreSQL adapter for the coordination module. | PostgreSQL |
| Microsoft.EntityFrameworkCore and Relational 10.0.10 | Durable transactions, bounded projections and migration model; explicit runtime pins align the host and tests. | MIT |
| YamlDotNet 16.3.0 | Strict source manifest decoding behind source ingestion. | MIT |
| Microsoft.AspNetCore.OpenApi 10.0.10 | Separate authenticated Agent and Operator contract documents. | MIT |
| Microsoft.OpenApi 2.7.5 | Patched transitive OpenAPI dependency, explicitly pinned. | MIT |

EF Design is development-only migration tooling. xUnit, Microsoft.NET.Test.Sdk,
WebApplicationFactory, and PostgreSQL Testcontainers are test-only dependencies.
The Rust dependencies are described in [the clients README](../../clients/README.md).
Locks record the resolved transitive graphs. Review vulnerability results on
every dependency update.

The OpenAPI override addresses
[GHSA-v5pm-xwqc-g5wc](https://github.com/advisories/GHSA-v5pm-xwqc-g5wc).
Upstream compatibility information is available in the
[Npgsql 10 release notes](https://www.npgsql.org/efcore/release-notes/10.0.html).
CSR loading uses the platform's signature verification with default options,
as documented by
[CertificateRequest.LoadSigningRequestPem](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.x509certificates.certificaterequest.loadsigningrequestpem?view=net-10.0).
