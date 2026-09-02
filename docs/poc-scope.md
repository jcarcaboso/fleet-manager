# POC scope

## Goal

The POC must prove one complete path from a reviewed `main` commit to verified
Skill content on one macOS Node and one Linux Node. It must also prove the
failure behavior that makes the architecture credible.

One self-hosted Fleet Server process governs exactly one Workspace and uses one
durable store. The POC should stop when the scenarios below work repeatably.

## Operating envelope

One Server process with one PostgreSQL database must pass a load fixture with
1,000 registered Nodes polling regularly. This target is intentionally above
likely POC use. It exists to expose unbounded queries and per-Node scans, not to
justify caches, queues, high availability, or horizontal scaling.

The exact polling interval, payload sizes, latency thresholds, and Bundle
download profile remain performance-budget decisions.

Every configured Operator is a fully trusted administrator. The POC records
security-relevant actions but has no roles, permission separation, or protection
against deliberate misuse by an authenticated Operator.

The Server is not reachable directly from the public internet. It may make
outbound connections to its configured Git remote.

## Required source fixture

The end-to-end fixture contains:

- ordered `definitive`, `testing`, and `in-progress` groups;
- at least two Skills discovered from group directories;
- one Skill containing nested text files, a binary file, and nested
  directories;
- one macOS Node subscribed to `definitive` and `testing`;
- one Linux Node subscribed to `definitive`;
- the default Target path `.agents/skills` relative to home;
- one per-Node Target path override; and
- one deliberate duplicate Skill name used to verify deterministic precedence
  and a visible ingestion warning.

The exact YAML syntax may change during technical design. These semantics may
not disappear.

## Acceptance scenarios

### Enrollment

- [ ] A macOS Agent enrolls with a Server URL and single-use token.
- [ ] A Linux Agent enrolls through the same product flow.
- [ ] Each Agent generates its private key locally and submits a signed
      certificate request during enrollment.
- [ ] Each enrollment creates one stable Node identity and a short-lived,
      revocable client certificate.
- [ ] Normal Agent operations authenticate with mTLS and an active credential
      check.
- [ ] Neither Node exposes a Fleet listener, requires SSH, or stores Git
      credentials.

### Source ingestion

- [ ] The Server scans `main` at startup and then on a configurable interval.
- [ ] A valid new tip creates one immutable desired revision automatically.
- [ ] An invalid tip leaves the previous desired revision current and records
      diagnostics.
- [ ] A source change outside managed desired state creates no unnecessary
      Rollout.
- [ ] Group directories are discovered without listing individual Skills in
      YAML.
- [ ] Each Bundle contains the complete nested directory tree of its Skill.
- [ ] A Skill without a root `SKILL.md` is rejected.
- [ ] Changing a nested file changes the Bundle digest and updates assigned
      Nodes.
- [ ] Executable bits survive installation while timestamps and ownership do
      not affect Bundle identity.
- [ ] Case-insensitive or Unicode-normalized path collisions are rejected.
- [ ] Unsafe entry types and paths make source ingestion fail without changing
      current desired state.
- [ ] Duplicate Skill names resolve by declared group order and create a warning
      visible through the Fleet CLI.

### Desired-state resolution

- [ ] Group subscriptions resolve to the expected flat Skill set for each Node.
- [ ] The global Target path and per-Node override resolve under each Node's
      actual home directory.
- [ ] An unknown Node ID or unsafe Target descriptor makes publication fail.
- [ ] Assignments contain no group or Git repository concepts.

### Reconciliation

- [ ] Each Agent downloads only missing Bundles and verifies every digest.
- [ ] Both Nodes install their assigned Skills without root access.
- [ ] A later source revision creates, updates, and removes the expected
      Fleet-owned Skill directories.
- [ ] Unmanaged Skill directories remain untouched.
- [ ] A pre-existing unowned directory with the same Skill name produces a safe
      ownership conflict.
- [ ] Repeating an Assignment does not duplicate or unnecessarily reinstall
      content.

### Offline and failure behavior

- [ ] A stale Node does not block another Node's Rollout.
- [ ] A Node that misses several desired revisions converges directly to the
      current one after reconnecting.
- [ ] A corrupt Bundle changes no Target content.
- [ ] A superseded Assignment cannot replace newer desired state.
- [ ] Duplicate terminal reports do not change the final result.
- [ ] Restarting an Agent during mutation triggers journal recovery and leaves
      either the previous or new verified Target state.
- [ ] Revoking one Node credential blocks only that Node.

### Status

- [ ] The Server exposes `pending`, `applying`, `succeeded`, `failed`, and
      `superseded` convergence states.
- [ ] The Server reports last contact time and derives fresh or stale status
      without claiming to know whether a polling Agent is truly offline.
- [ ] Old Attempt results remain inspectable without becoming current.

## Explicit exclusions

The POC excludes:

- a web UI;
- public-internet Server exposure;
- built-in VPN or private-overlay installation and management;
- inbound Agent control, SSH, and arbitrary remote execution;
- high availability and horizontal scaling;
- message brokers and distributed queues;
- multiple regions;
- hosted control-plane operation and multiple Workspaces;
- complex multi-tenancy or RBAC;
- progressive, scheduled, or approval-gated Rollouts;
- fleet-wide automatic rollback;
- automatic Target relocation;
- Agent self-update;
- peer-to-peer Bundle transfer;
- production secret distribution;
- root-owned Targets;
- simultaneous versions of one Skill in different groups; and
- Windows.

## Suggested build sequence

### Milestone 0: repository contract

Choose the stack and record the decisions. Define the developer commands for
formatting, tests, and a local end-to-end run. Keep the domain language and
architecture documents authoritative.

### Milestone 1: local Target reconciliation

Build the deep Target reconciliation module in foreground mode. Exercise create,
update, Fleet-owned delete, unmanaged preservation, duplicate application,
drift, path containment, atomic activation, rollback, Receipt integrity, and
journal recovery on macOS and Linux.

### Milestone 2: durable Server transitions

Build enrollment, source acceptance, Bundles, desired revisions, Assignments,
Rollouts, Attempts, supersession, idempotent reports, and freshness. Restart
tests must prove that these transitions survive process restart.

### Milestone 3: source polling and resolution

Poll a fixture `main` branch, discover group directories, resolve Node Target
state, record duplicate warnings, reuse unchanged Bundles, and create Assignments
only for affected Node Targets.

### Milestone 4: one foreground Agent

Connect enrollment, polling, Bundle download, reconciliation, and reporting.
Run against a temporary Target and repeat network requests to prove idempotency.

### Milestone 5: macOS and Linux slice

Install one real macOS user Agent and one real Linux user Agent against the same
Server. Publish initial and changed group content and verify both Target paths.

### Milestone 6: failure exercises

Run the offline, corrupt Bundle, stale Assignment, credential revocation, Server
restart, Agent restart, duplicate delivery, duplicate reporting, and rapid
supersession scenarios.

Stop there. Review what the POC taught before adding excluded capabilities.

## Accepted stack

- .NET 10 and ASP.NET Core for the Server;
- PostgreSQL with EF Core 10 and Npgsql;
- PostgreSQL Bundle bytes for the POC;
- a hosted background task and installed `git` executable for source polling;
- YamlDotNet and System.Text.Json;
- xUnit, WebApplicationFactory, and PostgreSQL Testcontainers;
- Rust 2024 for separate `fleet-agent` and `fleet` binaries;
- versioned HTTPS with JSON metadata and binary Bundle responses;
- Agent-generated P-256 keys and signed certificate requests; and
- short-lived X.509 client certificates with mTLS for Agent authentication.

See [Accepted technology stack](technical-design/stack.md) for details.

## Technical decisions to make next

1. Operating and threat envelope for the first public release.
2. Operator authentication and later browser login.
3. Exact HTTP contracts, certificate lifetimes, limits, and Agent polling policy.
4. Privacy inventory, access, and retention.
5. Measurable fleet, latency, throughput, and Bundle-size budgets.
6. First Server host, issuing-key operations, TLS termination, migration,
   backup, and restore.
7. Open-source license, contribution policy, and release security process.
8. Agent installation, upgrade, uninstall, `launchd`, and `systemd --user`
   mechanics.
