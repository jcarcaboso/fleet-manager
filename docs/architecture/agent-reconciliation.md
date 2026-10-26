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

The failed report carries only the stable error code. After the Server accepts
it, the Agent sends a separate, best-effort failure detail for that Attempt: a
diagnostic, the Target-relative path of the offending file or entry when the
failure has one, and the step in which it failed (`lock`, `download`, `verify`,
`stage`, `activate`, `recover`, `receipt`, `configure` or `validate`). The detail
never delays the report or the next reconciliation, and a failed delivery never
fails a cycle. The [Operator API](../technical-design/operator-api.md#phase-2-attempt-detail)
defines the route.

The error code decides the Attempt's identity; step and path only locate it, and
each reconciliation error carries them as optional context. The diagnostic is
the error message and its causes. Before it leaves the Node the Agent removes
control characters other than newline and tab, replaces the user's home
directory with `~`, and cuts it to 2048 UTF-16 code units. Error messages
describe a failure and never quote file contents, credentials, tokens, CLIProxy
keys or environment values. In particular, parser errors for AI-client
configuration report a line and column, not the offending text. A path is
omitted unless it is relative and free of `..`.

Before sending, the Agent removes control characters other than newline and
tab and hides where things live on the machine, then truncates to 2048 UTF-16
code units (so truncation measures the redacted text). The home directory
becomes `~` and the Agent state directory becomes `<state-dir>`, including
their absolute and canonical spellings (such as `/private/var` on macOS). A
home or state directory matches only a whole path component: it must start a
path token and end at the end of the text, a `/` or `\`, whitespace, a quote or
closing bracket, a comma or semicolon, a colon before whitespace, or a
sentence-ending dot. So `/home/joan+backup/x` and `/private/Users/joan/x` are
not under `/home/joan` and `/Users/joan`. Every other absolute path (`/x/y`,
`\\server\share`, `C:\x`) becomes `<path>/<last component>`, or `<path>` when
that component is `.` or `..`. Reconcile errors also describe locations
relative to the Target (`~/.claude/link`) or by their last components
(`.../state/targets`) at the source.

The Agent keeps only the newest unsent detail, with its Attempt and creation
time, in its own state file `pending-detail.json` and not in the run state.
Older Agents reject unknown run-state fields, so this keeps downgrades safe. The
detail is retried on later cycles until the Server accepts it, answers with a
client error other than 408 or 429 (a 404 also covers a Server that predates
the route), or 24 hours have passed. Expiry is checked before waiting for the
terminal report to be accepted, so detail whose report is never accepted still
expires. An unreadable file is discarded.

## Disk usage

The Agent also reports how full its disk is, so Operators can see a machine
filling up before reconciliation fails. After reconciliation in a cycle, and
never able to fail it, the Agent makes one `statvfs` (Linux) or `statfs`
(macOS) call for the volume holding the home directory and, if the state
directory is on another device, one for that volume. It does not walk
directories or run `df`. A volume that cannot be measured is left out, and
nothing is sent if none can be.

Those calls can block indefinitely in the kernel when the home is on a hung
NFS, SMB or FUSE mount, so they never run on the Agent loop. One dedicated
thread named `fleet-disk` is started the first time a measurement is due, with
a small stack, and is detached: it is never joined, so it cannot delay exit. It
takes one request at a time through a single-slot channel, so at most one
measurement is ever outstanding. The loop waits at most 2 seconds for its
result; a measurement that is slower is collected without blocking in a later
cycle. If one is still unfinished after 60 seconds the worker is considered
stuck: the Agent logs once, measures no more until it restarts, and never
starts a second thread. Polling and reconciliation carry on, and a worker that
ever returns is simply ignored. Tokio's blocking pool is not used because it
would block runtime shutdown. The report is sent from a spawned side task with
the existing 10-second request timeout, with at most one in flight, so it never
delays the next poll; a report that finds the previous one still running is
dropped. `fleet-agent run --once` waits for its report to finish before it
exits.

The Agent reports after its first successful poll, then 4 hours after the last
attempt (successful or not), and when a poll response sets
`diskUsageRequested`. The request is edge-triggered: the Server keeps the flag
set until a report is stored, so only the start of a run of `true` counts, and
a later `true` counts again only after a poll that returned `false`. A failed
report, including 404 from an older Server or 429, is therefore logged and
tried again only at the next 4-hour slot or a new request, not on every poll.
The schedule lives in memory and uses a monotonic clock, so a restart reports
again. Every poll request carries `X-Fleet-Agent-Capabilities: disk-usage`,
which is what allows the Server to set that flag. The
[Operator API](../technical-design/operator-api.md#disk-usage) defines the route.

`fleet-agent status` does not measure disk usage: it is a separate short-lived
process with no cached value, and a live call could hang on a stuck mount.
Operators read the last report from the Server. `fleet-agent disk` measures on
demand instead, with the same worker and 2-second wait: a measurement that does
not finish prints `{"diskUsage": null, "timedOut": true}` and the process exits
without joining the stuck thread.

Measuring the home path can trigger an automount, but the Agent already
accesses the home for its Targets, so this adds no new access. The Agent does
not parse the mount table to avoid such mounts.

## Machine information

The Agent also tells the Server what it runs on and as, so the dashboard can
show the operating system, the Agent version and how it was installed, and flag
outdated Agents. `telemetry.rs` builds the report from cheap local sources
only: its crate version, `NAME` and `VERSION_ID` from `/etc/os-release` (or
`/usr/lib/os-release`) on Linux, `ProductName` and `ProductVersion` from
`SystemVersion.plist` on macOS, `uname`, the compile-time architecture,
`gethostname`, `getpwuid_r` for the effective user (null if it cannot be
resolved; `$USER` may name another account), the executable path (Homebrew prefix, `~/.cargo/bin` or other),
`INVOCATION_ID` and `XPC_SERVICE_NAME` for the service manager, and the state
directory with the home replaced by `~`. It starts no process and walks no
directory. The two files are read with a 16 KiB bound and a cut-off last line
is ignored; control characters are removed and strings are capped to the
Server's limits before sending. A field that cannot be read is `null`, as are
all fields on other platforms.

The reads run on a second detached worker thread named `fleet-telemetry`, built
from the disk usage worker with the same single-slot channel, 2-second wait and
60-second stuck rule, because `getpwuid_r` can block on a hung directory
service. The report is a side task with the 10-second request timeout and at
most one in flight, so it never delays a poll or fails a cycle.

It is sent after the first successful poll. At each following 4-hour slot, the
disk usage schedule's, the Agent collects again and sends only if the report
differs from the last one the Server accepted. A failed report, including 404
from an older Server or 429, is not remembered, so the next slot sends it again.
The schedule is in memory, so a restart reports again. The route does not need a
capability header. The
[Operator API](../technical-design/operator-api.md#phase-3-agent-and-machine-information)
defines `PUT /agent/v1/telemetry`.

## State lock and read-only commands

One Agent process owns a state directory. `enroll`, `alias` and `run` (the
service runs `run`) create the directory if needed, then take an exclusive
non-blocking `flock` on `agent.lock`; a second one fails with "another
fleet-agent process is using this state directory". Taking the lock retries up
to 10 times, 50 ms apart, to tolerate a read-only command briefly probing it
while the service starts.

`status`, `targets`, `check` and `disk` are read-only and run while the service
holds the lock. They take no exclusive lock, create no directory or file, change
no permission and make no Server request; the Agent protocol has no read-only
Server call, since polling is a mutating exchange. A missing state directory is
reported as "Agent is not configured" (a failed JSON check for `check`) and stays
missing. A state or credentials
directory that is a link, belongs to another user or is readable by others is
refused, never repaired.

They read `config.json`, `credentials/identity.json`, `run.json` and
`pending-detail.json`. Each is written by a temporary file in the same
directory that is flushed and renamed over the old file (`state::write_bytes`,
the credential store's `atomic_write`), so a lock-free reader sees the old or
the new file, never a partial one. Different files are read one after another,
so they can come from either side of an update, and each is consistent by
itself.

`status` reports `service.running` by opening `agent.lock` read-only (a missing
file means not running) and trying a non-blocking shared lock, released at once.
A conflict means a process holds the state lock: the service, but also a
foreground `run`, `enroll` or `alias`.

## Drift reports

Reconciliation already repairs owned content that someone changed outside
Fleet. The Agent now also says which files it repaired, so the dashboard can
show drift. `fleet-reconcile` returns `repaired` in its outcomes using the ownership
Receipt and observed digests.

- A managed file counts when it had a Receipt, the Assignment still wants it
  and the observed digest differs from the Receipt's (the file was edited or
  deleted). Its path is the Target path joined with the file name.
- A Skill counts when it is in the Receipt, the Assignment still contains it
  and its observed tree digest differs from the Receipt's. If the Assignment
  carries the content the Receipt recorded, the Agent lists the files that
  differ (modified, missing or added in the owned directory) by comparing the
  tree with the Bundle in an additional bounded read, which happens only on drift.
  If the Skill is updated in the same Assignment, there is no known baseline,
  so the Skill directory is named.
- A new Assignment revision over clean content, removals, and the first
  installation are not drift. AI-client settings are out of scope.

`repaired` holds Home-relative paths, sorted, unique, at most 20 per Target and
passed through `report_path` (relative, no `..`, no control characters, at most
512 UTF-16 units); an unsafe path is omitted. The Agent applies the same rules
again before sending.

After the cycle, the Agent sends `POST /agent/v1/drift` with
`{ "target", "files" }` for each Target that repaired something (the drift of
an Attempt that failed is rolled back and not reported). The reports are one
side task with the 10-second request timeout, at most one task in flight: if
the previous one is still running, the new reports are dropped. The response is
ignored, and nothing is persisted or retried, so a 404 from an older Server or
any other error drops the report. The route does not need a capability header.
The [Operator API](../technical-design/operator-api.md#drift-reports) defines
the request.

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
