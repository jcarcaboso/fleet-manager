# Fleet Manager successor POC handoff

## Purpose of this document

This is the startup brief for a new Fleet Manager repository. Copy it into the
blank repository before choosing a stack or writing code. It must stand on its
own. The team starting the successor should not need the old repository or the
conversation that produced this architecture to understand the job.

The product architecture is decided. The technical design is not. The next
discussion should choose the stack, storage, authentication mechanism, Git
integration, and repository layout without reopening the basic connectivity
model unless the owner changes the requirements.

The old proof of concept remains available at
`https://gitlab.com/ai3532112/fleet-manager`. Treat it as a source of tested
filesystem behavior and failure cases, not as the base for the new application.

## Handoff state

Decided:

- Build a new application in a blank repository.
- Use a central Fleet Server and a user-level Fleet Agent on each managed
  machine.
- Agents initiate outbound HTTPS communication. The Server never connects to a
  machine and never uses SSH.
- Start with polling or long polling. A persistent connection is optional
  later.
- Support macOS and Linux. Windows is outside the product scope for now.
- Manage user-owned Skills under `~/.agents/skills` by default.
- Keep Git as the reviewable source for Skill content and fleet desired state
  in the POC.
- Let the Server coordinate desired revisions, assignments, and status.
- Let each Agent own local filesystem observation, mutation, verification,
  receipts, rollback, and recovery.
- Install and enroll the Agent once per machine. Managed machines need no SSH
  or Git credentials.
- Keep the first vertical slice small. One Server process and one durable store
  are enough.

Not decided:

- implementation language and frameworks;
- database and bundle storage;
- operator login and Agent credential format;
- Server hosting and TLS termination;
- exact HTTP routes and message encoding;
- Git webhook, repository polling, or explicit CLI publication;
- package and installer tooling; and
- production scaling and operations.

No repository code should be created until the owner confirms those technical
choices.

## Product objective

An authorized user can edit a Skill on any workstation, commit and publish the
change, and have every assigned macOS or Linux machine install the same immutable
revision when it is online.

Each managed machine runs one Agent. The Agent maintains one outbound
relationship with the Fleet Server and performs changes only on its own local
filesystem. A laptop may sleep, move to another network, or stay offline during
several publications. It catches up when it reconnects.

This replaces the original controller-push model. There is no machine-to-machine
trust mesh, no inbound listener, and no need to copy SSH configuration to every
workstation from which an operator may publish.

## Expected user experience

### Registering a machine

The user should need a flow equivalent to:

```text
1. Install the Fleet Agent.
2. Run enrollment with a Server URL and a one-time token.
3. Confirm the new Node in the Server or CLI if approval is enabled.
4. Let the installer start a user service.
```

After enrollment, the Agent starts automatically for that user through
`launchd` on macOS or `systemd --user` on Linux. It persists a Node identity and
Node-bound credential with user-only permissions.

The machine does not need:

- an SSH server;
- an SSH key shared with another machine;
- a stable IP address or hostname;
- a Git client or repository credential; or
- root access for normal Skill installation.

### Publishing a Skill change

The operator should be able to use any authorized workstation:

```text
1. Edit Skill content or assignments.
2. Validate the source state.
3. Commit and push to the canonical Git repository.
4. Tell the Fleet Server to accept that exact commit.
5. Start or confirm a Rollout.
6. Inspect per-Node progress and results.
```

Steps 4 and 5 may eventually happen through a webhook or policy. The first POC
may use an explicit CLI command because it is easy to observe and debug.

### Receiving a change

An Agent polls the Server, discovers its current assignment, downloads missing
content, verifies every digest, reconciles the local Target, and reports the
result. The operator does not connect to the Agent.

If a machine is offline, the Server marks its status as stale after a defined
period. The pending desired revision remains available. On reconnect, the Agent
finishes any local recovery first and then converges to the current assignment.

## System shape

```text
 Any authorized workstation
 +--------------------------+
 | editor, Git, Fleet CLI   |
 +------------+-------------+
              |
              | commit, push, publish exact revision
              v
 +--------------------------+       +--------------------------+
 | canonical Git repository |------>| Fleet Server             |
 +--------------------------+       |                          |
                                    | desired revisions        |
                                    | immutable bundles        |
                                    | Node assignments         |
                                    | Rollouts and status      |
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
                                  ~/.agents/skills  ~/.agents/skills
```

All network sessions with a managed machine start at the Agent. A Server
response may contain a declarative assignment, but it may never contain an
arbitrary shell command or an unrestricted filesystem path.

## Canonical terms

Use these terms consistently in code, schemas, documentation, and the CLI.

**Workspace**
: The administrative scope that contains the Skill catalog, desired state,
  registered Nodes, and Rollout history. The POC may support one Workspace.

**Skill**
: A named package of agent instructions and supporting files. Accepted content
  is immutable and addressed by digest.

**Node**
: One registered macOS or Linux machine represented by a stable ID. Hostname,
  operating system, architecture, labels, and network details are attributes.
  They do not define identity.

**Agent**
: The user-level process that represents one Node, polls the Server, and owns
  local reconciliation.

**Target**
: A named installation destination on a Node. The POC has one default Target at
  `~/.agents/skills`. The model should allow more Targets later without requiring
  them in the first implementation.

**Desired revision**
: An immutable snapshot of resolved Skill content, assignments, and policy that
  the Server has accepted from an exact source revision.

**Bundle**
: Immutable Skill content that an Agent downloads and verifies by digest. A
  bundle contains declarative files, not a remote execution script.

**Assignment**
: The Server's instruction that one Node and Target should reconcile to one
  desired revision under one policy.

**Rollout**
: The Server's coordination record for applying a desired revision to a set of
  Nodes or Targets. It has per-Node attempts and results. It is not a
  cross-machine transaction.

**Attempt**
: One Agent's processing of one Assignment. Attempts have stable IDs so retries
  and duplicate reports can be recognized.

**Receipt**
: The Target-local authoritative record of content Fleet owns, the active
  generation, and recovery information. Server status is a projection of Agent
  reports, not a substitute for the Receipt.

**Generation**
: An immutable, verified local copy of one Skill version retained for activation
  or rollback.

Avoid using `host` as a synonym for Node, `deployment` as a synonym for Rollout,
or `sync` as a catch-all for publication, delivery, and local reconciliation.
Those operations have different owners and failure modes.

## Ownership model

### Git owns reviewable source history

Git stores human-authored Skill content and desired-state declarations. It
provides review, commit identity, and conflict resolution between authoring
machines.

Agents do not clone Git repositories. The Server ingests an exact commit and
turns it into an accepted desired revision only after validation succeeds.

### The Server owns coordination

The Server owns:

- Workspace identity;
- Node enrollment, authentication, revocation, and metadata;
- source-revision ingestion and validation;
- immutable bundle registration and delivery;
- current assignments for Nodes and Targets;
- Rollout creation and per-Node progress;
- operator authorization;
- Agent protocol compatibility; and
- an audit history of enrollment, publication, assignment, and results.

The Server cannot decide that bytes reached a local filesystem merely because
it sent an Assignment. Only an Agent's verified local result can support that
status.

### The Agent owns local truth

The Agent owns:

- its Node identity and credential;
- Server trust configuration;
- platform and home-directory discovery;
- Target root policy and safe filesystem access;
- local mutation locking;
- observation and local plan derivation;
- staging, atomic activation, and terminal verification;
- Receipts, Generations, recovery journals, and rollback;
- durable knowledge of its last successful desired revision; and
- structured status reports.

The Agent accepts only typed, versioned Fleet messages. It does not accept shell
text, general process execution, or an arbitrary Target path from the Server.

### The CLI owns operator interaction

The CLI validates authoring input, publishes an exact source revision, creates
or confirms a Rollout, and reads Server status. It authenticates as an operator
and talks only to the Server.

Local Agent diagnostics may later use a Unix-domain socket. That socket is not
part of fleet delivery and is not required by the POC.

## Required invariants

The implementation must preserve these rules regardless of the chosen stack:

1. Every accepted desired revision is immutable.
2. Every Bundle is addressed and verified by a cryptographic digest.
3. One Agent identity represents one Node.
4. Node credentials and operator credentials are separate.
5. One Assignment binds a Workspace, Node, Target, desired revision, policy,
   and Rollout.
6. At most one local mutation runs for a Target at a time.
7. The Agent completes or recovers an active mutation before starting a newer
   Assignment for that Target.
8. Repeating the same Assignment is safe and does not duplicate active content.
9. A stale result remains in attempt history but cannot make an old revision
   current.
10. Loss of connectivity after local success does not trigger an unsafe replay.
    The Agent reports its durable result after reconnecting.
11. An offline Node does not block other Nodes.
12. A Rollout is eventually consistent. It is never an atomic transaction
    across machines.
13. The Server cannot request arbitrary code execution.
14. The Agent cannot mutate paths outside its configured user-owned Targets.

## Main flows

### Enrollment

1. An operator creates a short-lived, single-use enrollment token scoped to the
   Workspace.
2. The Agent submits the token, platform metadata, its protocol version, and its
   capabilities over HTTPS.
3. The Server consumes the token, creates a stable Node ID, and issues or
   registers a Node-bound credential.
4. The Agent stores the Node ID, Server identity, credential, and local state
   path with user-only permissions.
5. The Agent begins polling.

The exact credential can be an opaque token, signed-request key, or client
certificate. Choose it during technical design. It must support revocation,
replacement, Node binding, and separation from operator identity.

### Publication

1. The Server receives an exact Git commit from an authenticated operator or
   trusted Git integration.
2. It loads and validates Skill packages, assignments, and policy from that
   revision.
3. It resolves all mutable references to immutable content.
4. It builds or registers Bundles and calculates their digests.
5. It records a desired revision that binds the source commit, resolved content,
   assignments, and policy.
6. It creates a Rollout only after all validation and bundle creation succeeds.

The Server never changes an accepted desired revision. A correction produces a
new revision.

### Agent work loop

1. Recover an interrupted local operation if a recovery journal exists.
2. Poll the Server with Node identity, protocol version, capabilities, current
   revision, and recovery state.
3. Receive no work or one bounded Assignment.
4. Validate Workspace, Node, Target, revision, policy, and protocol binding.
5. Acknowledge or reject the Assignment before local mutation.
6. Download missing Bundles and verify size, digest, and schema.
7. Acquire the Target mutation lock.
8. Observe local state and derive the exact reconciliation plan.
9. Stage, activate, verify, and persist the local Receipt.
10. Release the lock and report a structured terminal result.

If the Receipt proves that the requested revision is already active and
verified, the Agent reports success without reinstalling it.

### Offline catch-up

The Server retains the current Assignment while a Node is offline. On reconnect,
the Agent reports its local revision and recovery state. It completes recovery,
then obtains the current Assignment.

The POC may skip revisions that the Agent never started. For example, an Agent
offline during revisions 4 and 5 may move directly from revision 3 to revision
5. It cannot abandon revision 4 halfway through a filesystem mutation. The
Agent must recover that attempt before it accepts revision 5.

### Duplicate delivery and reporting

Polling and reporting operate with at-least-once delivery. The Server may return
an Assignment again after a timeout, and the Agent may submit a terminal report
again after losing the response. Assignment and Attempt IDs make both paths
idempotent.

## Conceptual records

These are required concepts, not database tables or final wire schemas.

### Server records

- Workspace: ID, name, creation time.
- Node: stable ID, Workspace ID, status, credential metadata, labels, hostname,
  operating system, architecture, Agent version, capabilities, last-seen time.
- Target: stable ID, Node ID, name, policy identity, logical root identity.
- Bundle: digest, size, media or schema version, content location, creation time.
- Desired revision: stable ID or digest, source commit, policy digest, creation
  time, immutable Bundle and assignment bindings.
- Assignment: ID, Node ID, Target ID, desired revision, Rollout ID, state,
  supersession information.
- Rollout: ID, desired revision, selected Nodes or Targets, creator, creation
  time, aggregate state.
- Attempt: ID, Assignment ID, Agent-reported phase, result, structured error,
  timestamps, status freshness.
- Enrollment token: digest, Workspace scope, expiry, consumption time.
- Node credential metadata: Node binding, creation, expiry if applicable,
  revocation state. Raw reusable secrets must not appear in logs or audit data.

### Agent records

- identity: Node ID, Server identity, credential reference, protocol metadata;
- current Assignment and Attempt IDs;
- last accepted and last successfully applied desired revision;
- per-Target Receipt;
- immutable local Generations;
- active recovery journal;
- bounded diagnostic logs; and
- optional cached Bundles keyed by digest.

The Server's Node status is eventually updated metadata. The Agent's Receipt and
verified Target state remain authoritative for installed content.

## Protocol conversation

The POC needs logical operations equivalent to the following. Technical design
will choose paths, verbs, encoding, and authentication details.

### Enroll

The Agent sends an enrollment token, protocol version, capabilities, platform,
architecture, hostname, and Agent version. The Server returns a stable Node ID,
Node credential material or registration result, Workspace identity, polling
policy, and Server time.

### Poll for work

The Agent sends its Node ID, protocol version, capabilities, last successful
revision, active Assignment or Attempt, and recovery condition. The Server
returns no work, a retry delay, a compatibility error, or one Assignment.

### Obtain a Bundle

The Agent requests immutable content by digest. The Server returns bounded
bytes plus content type, schema version, size, and digest metadata. The Agent
calculates the digest over received bytes before opening the bundle for use.

### Acknowledge and report

The Agent can report accepted, rejected, applying, recovering, succeeded, or
failed. Each report includes Node, Target, desired revision, Rollout, Assignment,
and Attempt identities. Terminal failures use stable machine-readable codes and
bounded human diagnostics.

Protocol and capability versions must allow the Server to reject incompatible
work before the Agent mutates a Target. Avoid creating a general command
envelope. Model the small set of declarative Fleet operations directly.

## Local execution module

The Agent must contain one deep local execution module. Network handlers pass it
a validated Assignment, verified Bundle content, and local Target policy. The
module returns a structured observation, success, failure, or recovery result.

The module hides:

- path containment and symlink defense;
- platform descriptor adapters;
- local locking;
- current-state observation;
- exact plan derivation;
- staging and immutable Generation creation;
- atomic activation;
- terminal source and Target verification;
- Receipt updates;
- journal creation and crash recovery; and
- rollback after a failed activation.

HTTP handlers must not reproduce those filesystem steps. Tests should exercise
the same module interface used by the Agent work loop.

The old repository's `internal/targetengine` and adversarial tests are useful
references. Reuse behavior only after reviewing it against the new interface.
Do not bring over its local-versus-SSH adapter model, SSH helper protocol,
controller-oriented schemas, or assumptions that the controller opens the
connection.

## Platform behavior

The POC supports these execution environments:

### macOS

- Run as a user `LaunchAgent` through `launchd`.
- Resolve the user's home directory through operating-system APIs.
- Treat standard macOS aliases such as `/var` to `/private/var` correctly in
  filesystem safety checks.
- Manage `~/.agents/skills` without root privileges.

### Linux

- Run as a `systemd --user` service where available.
- Provide foreground execution for development and systems without a running
  user service manager.
- Resolve the user's home directory rather than assuming `/home/<name>`.
- Manage `~/.agents/skills` without root privileges.

Both platforms use the same protocol, desired-state rules, Receipt format, and
reconciliation semantics. Platform adapters may differ where filesystem and
service-manager APIs require it.

## Security baseline for the POC

The POC must establish the intended trust model even though production
hardening comes later:

- The Agent verifies the HTTPS Server identity.
- Enrollment tokens expire, work once, and belong to one Workspace.
- Every Agent receives a Node-bound credential that can be revoked.
- Agent files containing credentials use user-only permissions.
- Operator and Agent identities have separate permissions.
- The Server authorizes every Assignment for its exact Node and Target.
- The Agent verifies Bundle digests before parsing or mutation.
- Target roots come from local Agent policy.
- Skill Bundles contain declarative content only.
- Logs omit enrollment tokens, credentials, and Skill secrets.
- The Agent runs as an ordinary user.

End-to-end signing, hardware-backed credentials, enterprise identity providers,
root-owned Targets, and secret distribution are later decisions. Trusted HTTPS
plus digest verification is enough to test this architecture.

## POC boundary

The first POC proves one complete path:

1. Run one Server with one durable store.
2. Enroll one macOS Agent and one Linux Agent.
3. Publish an immutable desired revision containing one Skill.
4. Assign it to both Nodes.
5. Let both Agents poll, download, verify, reconcile
   `~/.agents/skills`, and report success.
6. Publish changed content and observe both Nodes update.
7. Leave one Node offline during an update and observe catch-up after reconnect.
8. Deliver duplicate work and receive duplicate reports without changing the
   terminal state.
9. Reject corrupted content and stale work before Target mutation.
10. Restart an Agent during a local operation and observe journal recovery.

The POC excludes:

- a web UI;
- SSH and inbound Agent control;
- arbitrary remote execution;
- high availability and horizontal scaling;
- message brokers and distributed queues;
- multiple regions;
- complex multi-tenancy or RBAC;
- progressive delivery and scheduled Rollouts;
- fleet-wide automatic rollback;
- Agent self-update;
- peer-to-peer Bundle transfer;
- production secret distribution;
- root-level Targets; and
- Windows.

## Decisions for the next technical-design session

Resolve these items with the owner before creating the blank repository's code.
For each item, record the choice and why it fits the POC.

1. Server and Agent language. Decide whether one language is used for Server,
   Agent, and CLI. Account for macOS/Linux packaging and safe filesystem APIs.
2. Server shape. Confirm one process and decide whether the CLI is a separate
   binary or subcommand.
3. Durable database. Choose the smallest database that supports restart-safe
   enrollment, assignments, and reports.
4. Bundle storage. Choose database bytes, a content-addressed local directory,
   or object storage for the POC.
5. Git ingestion. Choose explicit CLI publication, webhook, or Server polling.
   Define how the Server obtains a private repository revision if needed.
6. Operator authentication. Choose the POC login or token flow and keep it
   separate from Node authentication.
7. Node authentication. Choose the enrollment exchange, stored credential,
   revocation, and replacement flow.
8. HTTP protocol. Choose encoding, versioning, timeout, maximum message and
   Bundle sizes, polling interval, and stable error format.
9. Server deployment. Choose the first host, public URL, TLS setup, and backup
   expectations.
10. Agent packaging. Choose install, upgrade, uninstall, `launchd`, and
    `systemd --user` mechanics.
11. Desired-state format. Decide which parts of the previous manifests and Skill
    package format are worth carrying forward.
12. Test strategy. Choose how macOS-specific behavior will run alongside Linux
    tests before both real machines join the end-to-end POC.

The technical design may change implementation details. It must retain outbound
Agent communication, immutable desired revisions, declarative work, local
mutation authority, and macOS/Linux user-level operation.

## Build sequence after technical decisions

### Milestone 0: establish the new repository contract

Create a README with the product objective and developer workflow. Add a domain
glossary, the accepted architecture decision, the protocol versioning policy,
and the chosen stack ADRs. Define commands for formatting, unit tests, and the
local development loop.

Completion criterion: a new contributor can identify the Server, Agent, CLI,
local execution module, authoritative terminology, and every accepted technical
decision without opening the old repository.

### Milestone 1: prove local reconciliation in the new Agent

Build the local execution module in foreground mode. Feed it a local immutable
Bundle and desired Assignment. Install one Skill to a temporary Target, update
it, detect drift, recover from an interrupted operation, and remove only content
proved Fleet-owned.

Completion criterion: platform-focused tests pass on macOS and Linux, including
symlink ancestry, path containment, atomic activation, duplicate application,
Receipt integrity, and journal recovery.

### Milestone 2: prove Server state transitions

Build the single-process Server with durable enrollment, desired revision,
Bundle, Assignment, Rollout, Attempt, and report records. Use test adapters for
Git and Bundle bytes where the technical design defines real seams.

Completion criterion: restart tests prove that enrollment consumption,
Assignment identity, idempotent reports, supersession, and status freshness
survive process restart.

### Milestone 3: connect one foreground Agent

Implement enrollment, polling, Bundle download, acknowledgement, reconciliation,
and reporting with the real protocol. Run Server and Agent locally against a
temporary Target.

Completion criterion: one command or documented short sequence starts the
Server, enrolls a foreground Agent, publishes a fixture Skill, and reaches a
verified terminal success. Repeating network requests leaves the same local and
Server state.

### Milestone 4: run the macOS and Linux vertical slice

Package the Agent as a macOS `LaunchAgent` and Linux `systemd --user` service.
Enroll one real machine of each type against the same Server. Publish initial
and changed Skills from an authorized workstation.

Completion criterion: both machines converge without SSH or Git credentials,
and the Server reports outcomes with freshness timestamps.

### Milestone 5: exercise failure behavior

Test sleep and reconnect, offline catch-up, revoked credentials, corrupt
Bundles, stale Assignments, Server restarts, Agent restarts during mutation,
duplicate delivery, duplicate reporting, and rapid desired-revision
supersession.

Completion criterion: each acceptance scenario has an automated test where
practical and a repeatable manual script for the real-machine cases.

Stop there. Review what the POC taught before adding a UI, persistent streams,
advanced Rollouts, multi-tenancy, or production infrastructure.

## Acceptance checklist

The POC architecture is proven when every item below is true:

- [ ] A macOS Node enrolls with only an install, Server URL, and one-time token.
- [ ] A Linux Node enrolls through the same product flow.
- [ ] Neither Node exposes a Fleet listener or requires SSH access.
- [ ] Neither Node holds Git credentials.
- [ ] An operator publishes the same immutable source revision from any
      authorized workstation.
- [ ] Both Nodes install a Skill under `~/.agents/skills`.
- [ ] A later revision updates both Nodes.
- [ ] An offline Node catches up after reconnecting.
- [ ] Duplicate Assignment delivery is harmless.
- [ ] Duplicate terminal reporting is harmless.
- [ ] A corrupt Bundle changes no Target files.
- [ ] A stale Assignment cannot replace a newer desired revision.
- [ ] An Agent restart during mutation recovers from durable local state.
- [ ] The Server distinguishes pending, applying, succeeded, failed, offline,
      and stale status.
- [ ] Revoking one Node credential blocks only that Node.
- [ ] No Server message can request arbitrary shell execution or choose an
      unrestricted Target path.

## Instructions for whoever receives this handoff

Start by reading this file in full. Confirm the owner still agrees with the
items under "Handoff state." Then hold the technical-design session and record
each resolved choice as an ADR in the new repository.

Do not port the old application wholesale. Begin with the new domain terms and
module ownership described here. Inspect the old repository only when building
the local execution module or its adversarial tests. Preserve behavior that
still serves the new Agent and leave the controller-push and SSH architecture
behind.

After the technical decisions are accepted, implement the milestones in order.
The handoff is complete when the blank repository contains this brief, the
chosen stack decisions, an executable Milestone 0 developer contract, and no
unresolved assumption that would change the system shape.
