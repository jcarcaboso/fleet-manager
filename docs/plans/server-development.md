# Server-first development plan

## Outcome

Build and prove the Fleet Server before connecting real managed Nodes. The
Server establishes desired-state semantics, durable transitions, enrollment,
and the Agent protocol. A fake Agent drives those interfaces until the Rust
work begins.

Security, privacy, and performance are gates inside every phase. Work does not
move to the next phase when a gate has an unresolved high-risk failure.

## Delivery order

```text
repository contract
    -> Server coordination and PostgreSQL
    -> source ingestion and desired-state resolution
    -> enrollment and Node identity
    -> polling, Bundles, reports, and status
    -> Operator interface and BFF-ready queries
    -> Server hardening
    -> Rust Agent core
    -> Linux integration
    -> macOS integration
```

The Server core belongs in the first Server phases. The Agent reconciliation
core comes before Linux and macOS adapters. Neither core is a later cleanup.

## Phase 0: public repository contract

### Build

- Record the accepted stack and architecture decisions.
- Resolve the open-source license and contribution attestation.
- Add deterministic restore, format, build, and test commands.
- Configure nullable reference types and .NET analyzers.
- Add CI for documentation, .NET formatting, build, and tests.
- Add `CONTRIBUTING.md`, a code of conduct, and `SECURITY.md` once the reporting
  contact and supported-version policy are known.
- Define dependency review and update ownership.

### Exit criteria

- A new contributor can run the empty Server test host and PostgreSQL integration
  tests from documented commands.
- CI performs the same checks as local development.
- No production dependency exists without a caller and documented reason.
- Decision-map tickets #1 and #2 have owners.

## Phase 1: Server coordination and durable state

### Build

- Create `Fleet.Server`, `Fleet.Core`, and the test project.
- Start ASP.NET Core with health, structured logging, configuration validation,
  and graceful shutdown.
- Connect EF Core and Npgsql to PostgreSQL.
- Add the first reviewed migration.
- Model Workspace, Node, Target, Bundle, desired revision, Assignment, Rollout,
  Attempt, enrollment authorization, and credential metadata.
- Implement the Fleet coordination module through domain transitions rather than
  record CRUD.
- Implement convergence and freshness as separate projections.

### Verify

- Enrollment authorization consumption, publication, Assignment supersession,
  idempotent reports, and stale-report handling run through the coordination
  interface against real PostgreSQL.
- Process restart preserves every accepted transition.
- Concurrent transition tests prove unique and monotonic state rules.

### Gates

- Security: no secret values appear in logs or test snapshots.
- Privacy: every persisted field has a purpose recorded in the data inventory.
- Performance: transaction queries are bounded and have reviewed indexes.

## Phase 2: source ingestion and desired-state resolution

### Build

- Add the source-ingestion interface and the Git adapter.
- Maintain an isolated bare mirror and invoke `git` without a shell.
- Allow outbound access only to the configured Git remote and keep repository
  credentials scoped to read access.
- Scan at startup and on the configurable 30-minute interval.
- Parse `fleet.yml` with strict schema and unknown-field handling.
- Discover group directories and Skills without a YAML catalog.
- Validate nested entry types, names, paths, depth, file counts, file sizes, and
  total source limits.
- Resolve duplicate Skill names by explicit Node order or default group-name
  order and persist warnings.
- Build deterministic immutable Bundles from complete Skill directory trees,
  calculate digests, and store bytes in PostgreSQL.
- Resolve each configured Node Target to a flat desired Skill map.
- Accept the desired revision and affected Assignments in one durable operation.

### Verify

- Invalid or partial source never changes current desired state.
- A documentation-only commit creates no unnecessary Rollout.
- Unchanged Skills reuse Bundle digests.
- Nested files and directories survive Bundle construction and extraction, and
  changing any nested file changes the digest.
- Multiple commits between scans may converge to the newest valid tip.
- Malicious paths, symlinks, oversized repositories, and Git process failures
  produce bounded diagnostics.

### Gates

- Security: untrusted repository content cannot escape its staging directory,
  execute code, or expose Git credentials.
- Privacy: logs contain source identities and bounded errors, not Skill bodies.
- Performance: a representative repository fixture has an ingestion budget from
  decision-map ticket #7.

## Phase 3: enrollment and Node identity

Node authentication follows
[ADR 0003](../adr/0003-use-mtls-for-node-authentication.md). The threat model
must still validate the interface, and tickets #8 and #9 must set its protocol
and deployment parameters.

### Build

- Add an Operator-authorized operation that creates an enrollment authorization.
- Generate it from a cryptographically secure random source.
- Store only its digest, Workspace scope, expiry, creator, and consumption state.
- Validate a bounded P-256 signed certificate request from an Agent-generated
  key.
- Consume the enrollment authorization once in the same database transaction
  that creates the Node and client-certificate credential.
- Issue a short-lived X.509 client certificate without receiving the private
  key.
- Authenticate ongoing Agent operations with mTLS and check active Node and
  credential state.
- Support certificate renewal with overlap.
- Support credential revocation and auditable replacement.
- Apply per-source rate limits and bounded failure responses.

### Verify

- Expired, reused, malformed, wrong-Workspace, and concurrently submitted tokens
  fail safely.
- A successful response lost on the network can retrieve the same certificate
  with the same token and certificate request during the delivery window. It
  cannot create a second Node or substitute a key.
- Invalid certificate requests cannot consume enrollment authorization.
- Enrollment tokens, Agent private keys, and the issuing private key never enter
  logs, audit data, or PostgreSQL backups.
- A Node certificate cannot authenticate without its matching private key.
- Revoking one Node does not affect another.

### Gates

- Security: the threat model covers token theft, replay, database compromise,
  Node compromise, rotation, and recovery.
- Privacy: enrollment collects only documented Node metadata.
- Performance: token lookup and consumption remain indexed and constant-time in
  the number of registered Nodes.

## Phase 4: Agent polling, Bundles, reports, and status

### Build

- Finalize `/agent/v1` after decision-map ticket #8.
- Authenticate and authorize every operation as one exact Node.
- Accept current revision, Receipt identity, active Attempt, recovery condition,
  capabilities, and deferred terminal result.
- Return no work or one complete current Assignment.
- Authorize Bundle download only when the Node has a relevant Assignment.
- Stream or bound Bundle responses and support digest verification metadata.
- Record acknowledgement, applying, recovering, succeeded, failed, duplicate,
  and stale reports idempotently.
- Derive Rollout status from Assignments and Attempts.
- Publish separate OpenAPI output and shared JSON contract fixtures.

### Verify

- A fake Agent covers enrollment through terminal success.
- Offline catch-up skips unstarted intermediate revisions.
- Duplicate polls and reports leave the same state.
- A stale Assignment result remains history and cannot become current.
- Node A cannot poll, download, or report for Node B.
- Polling returns flat Skills and never leaks group or Git execution concepts.

### Gates

- Security: authorization matrices and cross-Node isolation tests pass.
- Privacy: normal status responses reveal no credential or Skill content.
- Performance: decision-map ticket #7 supplies concurrent poll, report, and
  Bundle-download budgets; load tests enforce them against at least the accepted
  1,000-Node fixture.

## Phase 5: Operator interface and BFF-ready queries

### Build

- Finalize the POC Operator authentication scheme after ticket #5.
- Add `/operator/v1` operations for enrollment, Nodes, source warnings, desired
  revisions, Rollouts, Attempts, revocation, and an explicit rescan if retained.
- Paginate every collection.
- Keep Operator protocol models separate from Agent protocol models.
- Shape query results so a future admin BFF can compose them without reading EF
  entities directly.
- Record security-relevant Operator actions in the audit history.

### Verify

- Node credentials cannot call Operator operations.
- Operator authorization tests cover every route.
- Pagination remains stable under concurrent Agent reports.
- Sensitive fields never appear in list or error responses.

### Gates

- Security: least-privilege policies and audit events pass review.
- Privacy: the data inventory identifies every field exposed to Operators.
- Performance: status queries meet their budget under the target fleet fixture.

## Phase 6: Server hardening and operability

### Build

- Resolve deployment, TLS, migrations, backups, and restore through ticket #9.
- Document a local-network deployment and an Operator-managed private-overlay
  deployment without adding overlay-specific code.
- Bind only to explicitly configured interfaces and make clear that direct
  public-internet exposure is unsupported.
- Add liveness and readiness checks with bounded dependency probes.
- Add metrics for source scans, poll outcomes, report outcomes, database latency,
  Bundle throughput, authentication failures, and stale Nodes.
- Define audit and diagnostic retention.
- Exercise PostgreSQL backup and restore.
- Produce dependency inventory and software bill of materials.
- Run threat-model, privacy, and performance reviews against the release build.

### Exit criteria

- Every Server acceptance scenario in the POC scope has an automated test or a
  documented repeatable exercise.
- Backup restoration produces the same accepted desired state and credentials.
- Security scanning has no unresolved release-blocking finding.
- Privacy inventory and retention rules match actual schema and logs.
- Performance budgets pass on declared hardware and fixture sizes.
- The Server is ready for the Rust Agent without replacing its core transitions.

## Work after the Server

1. Build the Rust protocol crate against the shared contract fixtures.
2. Build the platform-neutral Agent work loop and Target reconciliation module.
3. Prove reconciliation against real temporary filesystems on Linux and macOS.
4. Add the Linux user-service adapter and run the first real Node.
5. Add the macOS LaunchAgent adapter and path-alias tests.
6. Build the separate Rust Operator CLI against `/operator/v1`.
7. Run the full macOS and Linux failure matrix before calling the POC complete.
