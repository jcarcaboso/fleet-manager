# Agent reconciliation

## Purpose

The Server knows desired state. The Agent knows the local filesystem. Neither
pretends to own both.

The Server therefore sends a complete declarative Assignment. It does not send
`create`, `update`, or `delete` commands. The Agent observes its Target and
derives those operations locally.

## Two polling loops

Fleet has two independent polling loops:

| Poller | Destination | Purpose | Initial policy |
|---|---|---|---|
| Server | Canonical source repository | Detect a new `main` tip | Configurable, initially 30 minutes |
| Agent | Fleet Server | Report local state and obtain desired state | Configurable through Server policy |

Keeping the intervals separate avoids tying source publication latency to Node
freshness. The technical design will choose the first Agent interval and stale
threshold.

## Logical protocol conversation

Exact routes and encoding remain technical choices. Node authentication follows
[ADR 0003](../adr/0003-use-mtls-for-node-authentication.md). The POC needs
operations with these meanings.

### Enroll

The Agent generates a P-256 key pair, then sends a single-use enrollment token,
signed certificate request, protocol version, capabilities, platform,
architecture, hostname, and Agent version. The Server verifies the certificate
request, atomically consumes the token, creates the Node, and returns a stable
Node ID, short-lived client certificate, Workspace identity, polling policy,
and Server time. The private key never leaves the Node.

### Poll and report local state

The Agent authenticates with mTLS and reports enough durable state for the
Server to identify its current position:

```text
Node identity from authentication
protocol and Agent versions
capabilities
per-Target active desired revision
per-Target Receipt identity or digest
active Assignment and Attempt, if any
recovery condition
last terminal result not yet acknowledged
```

The exact message may keep normal polls compact and include a detailed observed
Skill map only after a mismatch or failure. That encoding choice does not change
the ownership model.

### Receive desired state

The Server returns one of:

```text
no work plus next poll delay
one complete Assignment
compatibility rejection
credential or authorization rejection
```

An Assignment contains, conceptually:

```text
Workspace, Node, Target, Assignment, Attempt, Rollout, and desired revision IDs
constrained Target descriptor
either a complete ordered set of Skill metadata or one Managed file descriptor
policy and protocol compatibility information
```

It contains no Skill groups, source paths, Git metadata needed for execution,
shell text, or local filesystem operation list.

### Obtain Bundles

The Agent requests missing immutable content by digest. The Server returns
bounded bytes and digest, size, and schema metadata. The Agent computes the
digest before parsing or staging the Bundle. Staging reconstructs the complete
nested Skill tree under one isolated Generation. The Agent never executes
Bundle content as part of installation.

### Report progress and results

The Agent can report accepted, rejected, applying, recovering, succeeded, or
failed. Every report binds the Node, Target, desired revision, Rollout,
Assignment, and Attempt identities. Terminal failures use stable error codes and
bounded diagnostics.

## Work loop

For each Target, the Agent follows this order:

1. Recover an interrupted local mutation if a journal exists.
2. Observe and verify Fleet-owned local state.
3. Poll with the current durable state and recovery condition.
4. Receive no work or one complete Assignment.
5. Reject incompatible or incorrectly bound work before mutation.
6. Download missing Bundles and verify their size, digest, and schema.
7. Acquire the Target mutation lock.
8. Observe again under the lock and derive the exact local plan.
9. Stage, activate, verify, and update the Receipt.
10. Release the lock and report the terminal result.

The second observation closes the gap between the earlier status report and the
moment mutation starts.

## Local plan derivation

The Target reconciliation module compares the observed Fleet-owned Skill map
with the Assignment:

| Observed state | Desired state | Local operation |
|---|---|---|
| Skill absent | Skill present | Create |
| Digest differs | Skill present | Update |
| Fleet-owned Skill present | Skill absent | Delete |
| Unowned Skill present | Skill absent | Leave untouched |
| Name and verified digest match | Skill present | Keep |

The Agent refuses to claim or replace a pre-existing unowned Skill directory
with the same name. It reports an ownership conflict instead.

Managed-file Targets use the same ownership rule through a separate
reconciliation interface. The Assignment names one file and either supplies
content metadata or declares it absent. The Agent writes through a staged file
and atomic rename, records a file-specific Receipt, repairs drift, and removes
only a file named by a valid Receipt. One Managed-file Target cannot contain
Skills.

## Target resolution and containment

The Agent resolves the Assignment's Target descriptor locally:

1. map the `home` base through the operating system;
2. join the declared relative path;
3. reject absolute paths, `..`, and invalid names;
4. inspect existing ancestors without following an escape;
5. account for platform aliases such as `/var` and `/private/var` on macOS; and
6. prove that every mutation remains below the resolved Target.

Bundle entries receive the same treatment. The POC accepts nested regular files
and directories and rejects absolute entries, parent traversal, device files,
sockets, named pipes, hard links, and symlinks until a later requirement
justifies them.

## Receipt and ownership

The Receipt records:

- the logical Target and resolved path identity;
- the active desired revision and Assignment;
- each Fleet-owned Skill name and Bundle digest;
- active local Generations;
- the last verified result; and
- recovery information needed after an interrupted mutation.

The Receipt proves what Fleet intended and last completed. The Agent still
observes local content to detect later drift. A stale Receipt alone cannot prove
that bytes remain unchanged.

Fleet deletes only content its Receipt proves Fleet owns. A missing or corrupt
Receipt turns deletion into a safe failure, not a guess.

## Assignment-level completion

One Assignment contains the complete desired state for a Target. The Agent may
activate several Skill directories sequentially, but it advances the Receipt to
the new desired revision only after the complete Target verifies successfully.

The journal records enough information to restore the previous Fleet-owned set
if a later Skill fails. The filesystem may contain a temporary mixture during an
Attempt or recovery, but after recovery it must represent either the previous
successful Receipt or the new successful Receipt.

At most one mutation runs for a Target. Different Nodes never participate in one
filesystem transaction.

## Offline catch-up

The Server retains only the current desired Assignment for a Node Target, plus
historical Attempt records. It does not retain a command queue that an offline
Node must replay.

A Node may move directly from revision 4 to revision 9. It downloads the Bundles
missing from revision 9 and reconciles against revision 9's complete Skill map.
Revisions 5 through 8 are not required.

If the Agent had started mutating revision 4 before going offline, it completes
or recovers that local Attempt before accepting revision 9.

## Duplicate delivery and stale reports

Delivery and reporting use at-least-once semantics:

- the Server may return an Assignment again after a timeout;
- the Agent may repeat a terminal report after losing the response; and
- reconnecting after local success must not cause unsafe reinstallation.

Stable Assignment and Attempt identities make these repetitions idempotent.

A report for a superseded Assignment remains in history. It cannot change the
current convergence state or make an older desired revision current.

## Drift

If observed Fleet-owned bytes do not match the active Assignment, the Agent
reports drift and reconciles back to current desired state. Drift never causes
the Server to accept local files as a new source revision.

Operators edit a separate source checkout. Managed Target directories are
derived installations, not authoring worktrees.
