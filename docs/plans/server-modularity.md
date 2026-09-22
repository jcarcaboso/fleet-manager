# Server modularity plan

## Goal

Make the Server composition readable at its existing boundaries without changing authentication, middleware order, database transactions, routes, wire formats, or source publication order. Use explicit ASP.NET Core extension methods and static registries. Do not add a plugin system or dependencies.

## Existing seams

- `FleetEndpoints` owns the Agent and Operator coordination routes.
- `DashboardEndpoints` owns dashboard authentication, security filters, assets, and dashboard routes.
- `SourcePollingService` owns scan scheduling and publication orchestration.
- `GitSourceScanner` owns Git access, repository validation, manifest parsing, and snapshot construction. Its ordered target-publisher delegate list is already a registry in miniature.
- `PostgresFleetCoordinator` and `FleetDbContext` own persistence behavior and transaction boundaries.
- Hosting helpers already isolate listener validation, maintenance, and metrics.

## Phases

### 1. Document and lock down behavior

- Treat current middleware order as a contract: metrics, HTTPS/error mapping, rate limiting, request timeouts, authentication, authorization.
- Keep dashboard authentication registration before the Operator and Node schemes.
- Keep source target publication order: Skills, Agent instruction files, AI client configuration.
- Use existing hosting, wire-contract, source-scanner, and persistence tests as regression coverage.

### 2. Extract Server composition

- Move service registrations from `Program.cs` into one explicit Server service-registration method.
- Move the current middleware pipeline into one explicit pipeline method, preserving statement order.
- Move health, source-operation, metrics, and OpenAPI route mapping into a hosting endpoint module.
- Leave Kestrel configuration and migration-mode startup in `Program.cs`; both are process-entry concerns and are easier to audit there.

### 3. Extract the source publisher registry

- Move the ordered publisher registry and target-building functions out of `GitSourceScanner`.
- Pass a publication context containing the already validated manifest, enrolled Node aliases, built Skills, and Agent instruction bundles.
- Keep the registry static and closed. Adding runtime discovery, reflection, or dependency injection would add machinery without a current use case.

### 4. Verify

- Run formatting checks on changed C# files.
- Build the Server and tests with the pinned .NET SDK.
- Run source publication/scanner tests and hosting tests. Run the broader Server suite when the Docker-backed PostgreSQL fixture is available.
- Review the diff for unchanged route templates, authorization policies, middleware order, source publisher order, and transaction code.

## Deferred work

- Do not split `PostgresFleetCoordinator` by file size alone. Extract persistence modules only when a transaction or domain interface can move intact with focused tests.
- Do not split Git transport, repository validation, and manifest validation until one gains a second caller or needs an independent test boundary.
- Do not create endpoint discovery, module interfaces, assembly scanning, or a dynamic plugin framework.
- Do not redesign authentication schemes, dashboard sessions, source polling, migrations, metrics, or error contracts as part of this refactor.

## Outcome

Implemented phases 2 and 3. `FleetServerHosting` now contains the existing service registrations, middleware pipeline, and route composition. `Program.cs` retains Kestrel setup, migration mode, startup validation, and process execution. `SourceTargetPublishers` contains the closed, ordered Skills, Agent-file, and AI-client publisher registry plus its publication helpers.

Verification completed with .NET SDK 10.0.302:

- `dotnet format Fleet.slnx --no-restore --verify-no-changes`
- `dotnet build server/Fleet.Tests/Fleet.Tests.csproj --no-restore`: no warnings or errors
- `dotnet test server/Fleet.Tests/Fleet.Tests.csproj --no-restore`: 92 passed, 0 failed, 0 skipped, including Docker-backed PostgreSQL and backup/restore tests
- Candidate-image HTTPS smoke: readiness, enrollment retry, mTLS, alias change, credential renewal, credential isolation, and revocation passed
