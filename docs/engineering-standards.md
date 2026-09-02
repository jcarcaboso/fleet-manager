# Engineering standards

## Purpose

Fleet Manager is intended to accept outside contributions and to run on machines
owned by different people. Security, privacy, performance, and maintainability
are acceptance criteria for every milestone. They are not cleanup phases.

No system can promise absolute security or unlimited performance. The project
will state its threat model and operating envelope, measure against them, and
reject changes that violate the agreed limits.

## Dependency discipline

- Add a dependency only when the current milestone calls it.
- Prefer the .NET or Rust standard platform when it expresses the requirement
  clearly and safely.
- Record why each runtime dependency exists.
- Check maintenance activity, security advisories, transitive dependencies, and
  license compatibility before adoption.
- Pin direct dependency versions through the normal .NET and Cargo mechanisms.
- Remove a dependency when its last caller disappears.
- Do not introduce a framework to remove a few lines of explicit code.

The accepted stack is an allowlist of possible tools, not a requirement to add
all packages during repository setup.

## Code structure

- Put behavior behind a small module interface.
- Keep HTTP, PostgreSQL, Git, YAML, and filesystem code in adapters at real seams.
- Test domain behavior through the same interfaces used by production callers.
- Do not expose record-by-record CRUD merely to make tests easier.
- Keep Agent protocol models separate from future admin BFF models.
- Keep Node credentials separate from Operator credentials in code, storage, and
  tests.
- Prefer explicit domain transitions over handler chains and reflection-based
  dispatch.

## Security standard

Every exposed operation must answer:

- who is authenticated;
- which Workspace, Node, Target, or Bundle they may access;
- whether the operation is safe to repeat;
- what untrusted input it parses;
- which resources are bounded; and
- what security event is recorded.

The project requires:

- a maintained threat model before an Agent protocol is published;
- separate authentication schemes for Nodes and Operators;
- short-lived, single-use enrollment authorization;
- revocable and replaceable ongoing Node credentials;
- Agent-generated private keys that never leave their Nodes;
- signed certificate requests during enrollment and short-lived client
  certificates for ongoing mTLS;
- an active Node and credential authorization check on every Agent operation;
- cryptographically secure random values from operating-system sources;
- hashed reusable secrets at rest when a secret-based scheme is chosen;
- authorization checks on every Node, Target, Assignment, and Bundle operation;
- redaction tests for credentials and accidental Bundle-content logging;
- size, time, and count limits on every untrusted payload;
- dependency and source security scanning in CI; and
- a private vulnerability-reporting process before the first public release.

The project will not invent a request-signing protocol. Node authentication
follows [ADR 0003](adr/0003-use-mtls-for-node-authentication.md). Operator
authentication must also use a reviewed standard.

The POC supports a local network or an Operator-managed private overlay. This
limits exposure but grants no trust. TLS, mTLS, authorization, input limits, and
rate limits remain required. The project will not claim support for direct
public-internet exposure without a later threat-model and deployment review.

Every configured POC Operator is a fully trusted administrator. Fleet must
protect Operator credentials, reject unauthenticated operations, and audit
security-relevant actions. Preventing deliberate misuse by an authenticated
Operator and separating Operator permissions require a later authorization
model.

Fleet treats Skill directory contents as opaque and untrusted. It does not scan
for secrets, enforce a content policy, or provide secret rotation. Authors are
responsible for committed content and assigned recipients. Fleet must still
authorize Bundle access, protect transport and storage, avoid content in logs,
bound every directory tree, and never execute Bundle files.

## Privacy standard

- Collect only Node metadata needed for enrollment, compatibility, assignment,
  freshness, and diagnosis.
- Document every stored field, its purpose, and its retention rule.
- Never log raw credentials, enrollment tokens, complete Skill contents, or
  arbitrary home-directory paths.
- Use bounded diagnostics and let Operators opt into more detail deliberately.
- Do not send telemetry outside the installation by default.
- Make metrics export and crash reporting explicit deployment choices.
- Keep audit history useful without copying sensitive request bodies.
- Define deletion and backup-retention behavior before supporting production
  multi-user hosting.

## Performance standard

Performance work starts with an operating envelope and budgets. Until those
numbers are resolved:

- the baseline load fixture must contain 1,000 registered Nodes polling
  regularly against one Server process and PostgreSQL database;
- database queries must be bounded and indexed for their lookup keys;
- list interfaces must be paginated;
- Bundle responses must stream or remain under an explicit in-memory limit;
- polling must avoid per-Node scans of unrelated Assignments;
- source ingestion must reuse unchanged Bundle digests;
- logs and status reports must have size limits;
- integration tests must cover concurrent enrollment-token consumption and
  duplicate Agent reports; and
- benchmarks must run against representative fleet, Skill, and Bundle fixtures
  before a public release.

An optimization that weakens correctness, authorization, privacy, or recovery is
not acceptable. A security mechanism whose cost threatens the performance budget
must be redesigned or budgeted explicitly, not silently disabled.

The 1,000-Node fixture does not authorize distributed caches, queues, or
horizontal scaling. Measurements must show that the accepted single-process
architecture cannot meet a concrete budget before adding them.

## Open-source repository standard

Before accepting outside contributions, the repository needs:

- an explicit open-source license;
- `CONTRIBUTING.md` with setup, tests, review expectations, and commit guidance;
- a code of conduct;
- `SECURITY.md` with private reporting and supported-version policy;
- issue and pull-request templates;
- a documented compatibility and deprecation policy for the Agent protocol;
- deterministic format, lint, build, and test commands;
- CI on Linux and macOS for the affected code;
- dependency update and vulnerability review; and
- release notes, checksums, and a software bill of materials for published
  binaries.

The exact license, contribution attestation method, and release-signing method
remain decisions in the server-foundations map.

## Contributor automation and Skills

Project-specific Skills can help contributors once a workflow is stable enough
to document. Good candidates include adding a Server endpoint, writing an EF
migration, changing the Agent protocol, adding an adversarial reconciliation
test, and running a security review.

A Skill must invoke the same public commands documented for humans. It must not
hide an undocumented setup step or grant broader permissions than the workflow
requires.

## Definition of done

A change is complete only when:

- behavior and failure modes are tested at the owning module interface;
- authorization and untrusted-input cases are covered;
- stored or logged data has been checked against the privacy inventory;
- affected performance budgets still pass;
- public behavior and protocol changes are documented;
- dependencies and migrations have an explicit reason; and
- Linux and macOS behavior is tested when the change touches managed Nodes.
