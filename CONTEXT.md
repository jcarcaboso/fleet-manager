# Fleet Manager

Fleet Manager coordinates desired Skill content across user-owned macOS and
Linux machines while each machine remains responsible for its own filesystem.

## Language

**Workspace**:
The administrative scope containing desired state, registered Nodes, and
Rollout history. One Server installation governs exactly one Workspace.
_Avoid_: Fleet, tenant

**Skill**:
A uniquely named rooted directory tree containing agent instructions and any
supporting files chosen by its author.

**Skill group**:
An ordered source-level collection of Skills used to decide which Skills a Node
should receive. Groups disappear when desired state is resolved.
_Avoid_: Bundle group, Agent group

**Node**:
One registered macOS or Linux machine with a stable Fleet identity.
_Avoid_: Host, client, machine identity

**Agent**:
The user-level process that represents one Node and owns local reconciliation.
_Avoid_: Client, worker, CLI

**Operator**:
An authorized person or automation identity that administers the Workspace.
_Avoid_: Agent, Node

**Fleet CLI**:
The operator-facing command-line interface for enrollment, status, credentials,
and diagnostics. It does not perform fleet delivery.
_Avoid_: Agent

**Enrollment token**:
A short-lived, single-use credential that authorizes creation of one Node
identity in one Workspace.
_Avoid_: Node credential, Operator credential

**Node credential**:
The revocable credential through which an enrolled Node proves possession of
its private key and authenticates after its enrollment token has been consumed.
_Avoid_: Enrollment token, Operator credential

**Target**:
A named installation destination on a Node whose effective contents Fleet
reconciles independently.
_Avoid_: Path, folder

**Source revision**:
One immutable identity for the source state inspected during publication.
_Avoid_: Desired revision

**Publication**:
The Server's acceptance of one source revision as fleet desired state.
_Avoid_: Git push, sync, deployment

**Desired revision**:
An immutable snapshot of resolved Skill content, per-Node Target state, policy,
and source-ingestion warnings.
_Avoid_: Source revision, release

**Bundle**:
An immutable representation of one complete Skill directory tree, addressed and
verified by cryptographic digest.
_Avoid_: Skill group, archive

**Assignment**:
The complete declarative Skill set that one Node and Target should reconcile for
one desired revision.
_Avoid_: Command, patch, job

**Rollout**:
The coordination record for applying one desired revision to a set of Nodes and
Targets. It is not a transaction across machines.
_Avoid_: Deployment, publication

**Attempt**:
One Agent's processing of one Assignment, identified independently so retries
and duplicate reports can be recognized.

**Receipt**:
The Target-local authoritative record of content Fleet owns and the desired
revision last completed successfully.
_Avoid_: Server status

**Generation**:
An immutable verified local copy of one Skill version retained for activation
or rollback.

**Reconciliation**:
The Agent's comparison of observed Target state with an Assignment, followed by
the local changes needed to make them match.
_Avoid_: Sync, deployment

**Drift**:
A difference between observed Fleet-owned Target content and the active
Assignment.

**Convergence state**:
The progress or result of reconciling an Assignment, such as pending, applying,
succeeded, or failed.

**Freshness**:
How recently the Server received authenticated information from a Node. It does
not prove that a Node is currently online.
