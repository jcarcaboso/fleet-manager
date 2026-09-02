# Architecture overview

## Status

This document records the accepted POC architecture. The responsibilities,
trust relationships, and direction of communication described here should
survive later implementation choices.

## Product objective

An Operator can edit Skills on any authorized workstation, commit them to the
canonical source repository, and push to `main`. The Fleet Server accepts valid
source state and every assigned macOS or Linux Node eventually installs the same
immutable Skill content when it is online.

Nodes need no inbound listener, SSH access, Git checkout, repository credential,
stable address, or root access for normal Skill installation.

## System shape

```text
 Any authorized workstation
 +--------------------------+
 | editor, Git, Fleet CLI   |
 +------------+-------------+
              |
              | commit and push to main
              v
 +--------------------------+       +--------------------------+
 | canonical source repo    |<------| Fleet Server             |
 +--------------------------+ poll  |                          |
                                    | source ingestion         |
                                    | desired revisions        |
                                    | immutable Bundles        |
                                    | Assignments and Rollouts |
                                    +------+------------+------+
                                           ^            ^
                          outbound HTTPS   |            | outbound HTTPS
                          poll/download/   |            | poll/download/
                          report           |            | report
                                           |            |
                                  +--------+---+    +---+--------+
                                  | macOS Agent|    | Linux Agent|
                                  +------+-----+    +-----+------+
                                         |                |
                                         v                v
                                  user-owned Target  user-owned Target
```

Every network exchange with a Node starts at its Agent. The Server never opens a
connection to a Node and never uses SSH.

## Fixed architectural decisions

- One central Fleet Server coordinates the POC.
- The Server is self-hosted and governs exactly one Workspace.
- Hosted control-plane operation and multiple Workspaces are outside the POC.
- Agents reach the Server through a local network or an Operator-managed private
  overlay such as Tailscale.
- Public-internet Server exposure is unsupported. Fleet does not install,
  configure, or depend on a private-overlay product.
- The Server may initiate outbound connections to its configured Git remote.
- Every configured Operator is a fully trusted administrator. Operator roles
  and permission separation are outside the POC.
- One user-level Fleet Agent represents each Node.
- Agents initiate outbound HTTPS communication and poll for desired state.
- Git `main` is the POC source of reviewable Skill content and desired state.
- The Server polls `main` on a configurable interval, initially 30 minutes, and
  scans once at startup.
- Source revisions and desired revisions are immutable after acceptance.
- Bundles are content-addressed and Agents verify their digests before use.
- One Bundle represents the complete nested directory tree of one Skill, not
  only its `SKILL.md`.
- Fleet treats Skill files as opaque, untrusted bytes. It transports and stores
  them but does not classify secrets, judge their purpose, or execute them.
- The Server sends complete declarative desired state, not filesystem operation
  commands.
- Each Agent observes local state and derives its own create, update, and delete
  operations.
- Groups organize source and Node subscriptions. Agents receive only a flat map
  of Skill names to Bundle digests.
- Git declares Target defaults and per-Node overrides. The Agent resolves and
  validates the final path.
- Git and the Server own intent and coordination. The Agent and its Receipt own
  local truth.
- Rollouts are eventually consistent across Nodes, never fleet-wide
  transactions.
- macOS and Linux are in scope. Windows is not in the POC.

## Runtime roles

### Fleet Server

The Server owns:

- Workspace identity;
- Node enrollment, authentication, revocation, and metadata;
- periodic source scanning and exact-revision ingestion;
- source validation, Skill discovery, and duplicate warnings;
- group and Target resolution for each Node;
- immutable Bundle registration and delivery;
- desired revisions, Assignments, Rollouts, Attempts, and report history;
- Agent protocol compatibility;
- operator authorization; and
- freshness and convergence projections.

The Server cannot infer local success from delivery. Only an Agent's report
after local verification can support a succeeded result.

### Fleet Agent

The Agent owns:

- its Node identity and credential;
- Server trust configuration;
- platform and home-directory discovery;
- safe Target descriptor resolution;
- observation of Fleet-owned local content;
- local plan derivation;
- Target mutation locking;
- staging, activation, terminal verification, and rollback;
- Receipts, Generations, and recovery journals; and
- structured status and result reports.

The Agent accepts typed, versioned Fleet messages. It never accepts arbitrary
shell text, general process execution, an absolute Target path, or a precomputed
filesystem operation list.

### Fleet CLI

The CLI is for Operators. It creates enrollment tokens, reads source-ingestion
warnings and Rollout status, manages credentials, and requests diagnostics or
explicit retries when those operations exist.

A Git push changes source state. The CLI does not upload Skill content, create
Rollouts for normal publication, or participate in Agent reconciliation.

The Agent and CLI may later ship in one executable with different subcommands.
That packaging choice does not merge their responsibilities.

## Module seams

### Source ingestion

Source ingestion has a small interface that returns one of three results:

```text
unchanged
invalid source with diagnostics
immutable source snapshot
```

The POC uses a Git adapter that reads the exact tip of `main`. A directory
adapter may support local development. Fleet coordination and Agents operate on
an immutable source snapshot and do not know which adapter produced it.

### Fleet coordination

The Server contains one deep Fleet coordination module. Its interface covers
enrollment, accepted source snapshots, Agent polling, Bundle access, reports,
and status queries. Its implementation hides durable transactions, duplicate
handling, Assignment supersession, Attempt state, and Rollout projections.

Avoid record-by-record CRUD interfaces and a separate shallow module for every
domain record. Tests should exercise domain transitions through the same
interface used by transport handlers.

### Agent work loop

The Agent work loop owns communication with the Server. It reports durable local
state, accepts or rejects Assignments, downloads missing Bundles, invokes local
reconciliation, and sends results. It contains no filesystem mutation sequence.

### Target reconciliation

Target reconciliation is one deep local module. Its interface accepts a
validated Assignment, verified Bundle content, and local Target policy. It
returns a structured observation, success, failure, or recovery result.

Its implementation hides:

- path containment and symlink defense;
- local locking;
- observation and exact plan derivation;
- staging and immutable Generation creation;
- activation and verification;
- Receipt updates;
- journal creation and process-crash recovery; and
- rollback after a failed activation.

Tests cross this same interface. Network handlers must not reproduce its
filesystem steps.

## Authority and persistence

| Concern | Authority |
|---|---|
| Human-authored Skill content and desired declarations | Canonical source repository |
| Accepted desired revision and current Assignment | Fleet Server |
| Enrolled Node identity and credential state | Fleet Server |
| Observed Target content and Fleet ownership | Agent Receipt plus local verification |
| Rollout convergence | Projection of per-Node Attempts |
| Node freshness | Last authenticated Agent contact |

The Server's status is eventually updated metadata. It never replaces the
Agent's Receipt as evidence of installed content.

## Status model

Convergence and freshness are separate facts.

Convergence states describe an Assignment:

```text
pending -> applying -> succeeded
                    -> failed
pending or applying -> superseded
```

Freshness uses the last authenticated contact time and a configured stale
threshold. With polling, the Server cannot know that a Node is truly offline. It
can only report when it last heard from the Node and whether that information is
fresh or stale.

Rollout status is derived from the current Assignments and their Attempts. It is
not a second independently mutable truth.

## Trust model

- A local network or private overlay supplies reachability, not Node identity.
  Fleet treats every network peer as untrusted until authentication succeeds.
- Fleet records security-relevant Operator actions but does not protect against
  deliberate misuse by an authenticated Operator. It must protect Operator
  credentials and reject unauthenticated use.
- The Agent verifies the HTTPS Server identity.
- Enrollment tokens expire, work once, and belong to one Workspace.
- Before enrollment, the Agent generates a P-256 key pair and proves possession
  through a signed certificate request.
- The Server issues a short-lived X.509 client certificate bound to one Node.
- Every ongoing Agent operation uses mTLS and an active Node and credential
  check.
- Node credentials renew, support immediate revocation, and can be replaced only
  through an Operator-authorized recovery flow.
- Operator and Agent credentials are separate.
- Agent private keys never leave the Node and use user-only file permissions.
- The Server authorizes every Assignment and Bundle request for the exact Node
  and Target.
- The Agent verifies Bundle size, schema, and digest before mutation.
- A Target descriptor has an allowed base and relative path. The Agent resolves
  it through operating-system APIs and rejects containment or symlink escapes.
- Bundle entries may contain any author-chosen bytes. Fleet never executes them.
- The Agent runs as an ordinary user.
- Logs omit enrollment tokens, credentials, and Bundle content.

Application-level request signing, hardware-backed credentials, root-owned
Targets, secret distribution, and enterprise identity providers are outside the
POC.

## Required invariants

1. Every accepted desired revision is immutable.
2. Every Bundle is addressed and verified by a cryptographic digest.
3. One Agent identity represents one Node.
4. Node credentials and Operator credentials are separate.
5. One Assignment binds a Workspace, Node, Target, desired revision, policy, and
   Rollout.
6. At most one local mutation runs for a Target at a time.
7. An Agent completes or recovers an active mutation before starting newer work
   for that Target.
8. Repeating the same Assignment is safe.
9. A stale report remains in Attempt history but cannot make an old revision
   current.
10. Connectivity loss after local success cannot cause an unsafe replay.
11. One stale Node cannot block other Nodes.
12. A Rollout is not an atomic transaction across Nodes.
13. The Server cannot request arbitrary code execution.
14. The Server sends complete desired state. The Agent derives local operations.
15. The Agent cannot mutate outside a validated user-owned Target.
16. A Skill name resolves to at most one Bundle in one effective Target.
17. Groups never appear in an Assignment or Receipt.

## Accepted implementation direction

The accepted stack is documented in
[Accepted technology stack](../technical-design/stack.md), with durable reasons
in [ADR 0001](../adr/0001-use-dotnet-and-postgresql-for-the-server.md) and
[ADR 0002](../adr/0002-use-rust-for-agents-and-operator-cli.md). Node
authentication is fixed by
[ADR 0003](../adr/0003-use-mtls-for-node-authentication.md).

In summary, the Server uses .NET 10, ASP.NET Core, PostgreSQL, EF Core, and
Npgsql. Agents and the Operator CLI use Rust 2024 as separate binaries from one
Cargo workspace.

## Still open for technical design

The architecture does not yet choose:

- HTTP routes, encoding, size limits, or timeout values;
- certificate lifetimes, issuing-key operations, Server host, TLS termination,
  or backup method;
- Agent polling and freshness budgets;
- Agent installation and user-service packaging;
- future admin frontend framework; or
- concrete security, privacy, and performance budgets.
