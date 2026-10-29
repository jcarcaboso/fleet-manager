# Agent self-update and service command plan

Status: SU-1 to SU-6 are implemented and unreleased. Self-update works with the
first release that commits a release public key in
`clients/bins/fleet-agent/release-keys/`; until then Servers and Agents refuse
every update. See [Implementation notes](#implementation-notes).

## Goal

An Operator can update the Agent on one Node, several Nodes, or every outdated
Node from the dashboard or `fleet`, without logging in to those machines. One
`fleet-agent service` command installs, starts, stops, restarts, inspects and
updates the Agent on Linux and macOS, whatever was used to install it first.

Decisions:

| Question | Decision |
|---|---|
| Where the running Agent lives | A Fleet-owned versioned directory under the state directory. Homebrew, Cargo and archives only supply the first binary. |
| Where Nodes download releases | The Server mirrors the signed release for its own version and serves it over the existing mTLS connection. |
| Who starts an update | An Operator, per Node or for all outdated Nodes. Nothing updates on its own. |
| Which version | Always the Server's own version (`ServerVersion.Current`), which is already the "latest Agent version". |
| What proves a binary is genuine | An Ed25519 signature made by the release workflow over a release manifest. The Agent embeds the public keys. Neither the Server nor GitHub alone can make an Agent run a new binary. |

The [client update design](../technical-design/client-updates.md) already
requires signed release metadata, platform and Server compatibility checks,
staging, restart through the service manager, and rollback. This plan fills
that in.

## What exists today

- The Agent reports `agentVersion`, `installMethod` (`homebrew`, `cargo`,
  `binary`) and `serviceManager` in telemetry. The Server raises
  `agent_outdated` with a manual upgrade hint per install method
  (`server/Fleet.Server/Transport/OperatorIssues.cs`).
- `fleet-agent service install|start|stop|restart|status|uninstall` writes a
  `systemd --user` unit or a launchd agent, but refuses every action when
  `brew services` owns the service.
- The systemd unit uses `Restart=on-failure`; the launchd agent and the
  Homebrew service restart always.
- Poll responses use `deny_unknown_fields` on the Agent. New poll fields are
  sent only to Agents that announce a capability in
  `x-fleet-agent-capabilities`, as `disk-usage` does. The Operator disk refresh
  (`POST nodes/{node}/disk-usage/refresh` → pending flag → poll field) is the
  model for an Operator-requested update.
- Release archives contain the binary, `LICENSE`, `BUILD.json` and
  `SHA256SUMS`, with an adjacent archive `.sha256`. Nothing is signed.
- `ring` is already a dependency of `fleet-agent` (through `rcgen`) and
  verifies Ed25519. `sha2` is already a direct dependency. The updater needs no
  new Rust crate.

## Managed install layout

```text
<state-dir>/                    default ~/.local/state/fleet-agent, mode 0700
  versions/
    0.11.0/fleet-agent          mode 0755, never modified after staging
    0.12.0/fleet-agent
  current -> versions/0.12.0    the only path a service definition names
  update.json                   trial or last result of an update
```

The binaries live in the state directory so a custom `--state-dir` keeps one
self-contained Agent, and backups already cover it. At most two versions are
kept: the active one and the previous one for rollback.

`current` is switched by creating a temporary symlink and renaming it over the
old one, so it always names a complete version. Service managers resolve the
path at each start.

## One service command

`fleet-agent service` becomes the only way to manage the background Agent:

| Command | Behavior |
|---|---|
| `install` | Copies the running executable to `versions/<own version>/` (verifying the copy), points `current` at it, writes the unit or plist that runs `<state-dir>/current/fleet-agent`, then enables and **starts** it. Running it again is safe. |
| `start`, `stop`, `restart`, `status` | Unchanged. |
| `logs [--follow]` | `journalctl --user -u fleet-agent.service` on Linux; the tail of `<state-dir>/logs/agent.log` on macOS. |
| `uninstall` | Stops and removes the definition. `--purge-binaries` also removes `versions/` and `current`, never identity or credentials. |

`fleet-agent update` is added for the local side of updates:

| Command | Behavior |
|---|---|
| `update status` | Active and previous versions, and the last update result. Read-only. |
| `update rollback` | Points `current` at the previous version (the one a trial replaced) and restarts the service. |

Migration from `brew services`: `service install` detects the Homebrew
definition, runs `brew services stop fleet-agent`, says so, and installs the
Fleet definition. The state lock already stops a second Agent from running if
someone starts the Homebrew service again later. The Homebrew formula drops its
`service do` block. Its caveats say to run `fleet-agent service install` after
enrollment, and that `brew upgrade` no longer changes the running Agent. The
same applies to Cargo and archive installs.

The systemd unit changes to `Restart=always` so a clean exit after an update
restarts the Agent. Reinstalling the service applies the change.

Telemetry reports a new `installMethod` value, `managed`, when the executable
is under `<state-dir>/versions/`. The Server must accept it before Agents send
it (Server first, as for every protocol change).

## Release signing

1. An Operator generates an Ed25519 key pair offline. The private key becomes
   the GitHub Actions secret `AGENT_RELEASE_SIGNING_KEY`, available only to a
   `release-signing` environment. The public key is committed in
   `clients/bins/fleet-agent/release-keys/` and compiled into the Agent with
   `include_bytes!`. Up to two keys are trusted at once so a key can be
   rotated over one release.
2. A new `sign` job runs after the Linux and macOS jobs and before the
   GitHub release. It extracts each `fleet-agent` binary and writes
   `fleet-agent-release.json`:

   ```json
   {
     "schema": 1,
     "version": "0.12.0",
     "gitCommit": "…",
     "binaries": [
       { "os": "linux", "arch": "amd64", "sha256": "…", "size": 9123456 },
       { "os": "macos", "arch": "arm64", "sha256": "…", "size": 8123456 },
       { "os": "macos", "arch": "amd64", "sha256": "…", "size": 8423456 }
     ]
   }
   ```

   It signs the exact bytes with `openssl pkeyutl -sign -rawin` into
   `fleet-agent-release.json.sig`, verifies the signature with the committed
   public key, and passes both files to the release job.
3. The release job uploads both files with the archives. The release skill and
   `client-updates.md` check that they exist.

The signature covers the binary digests and the version, so an Agent can tell
a genuine binary from any other and cannot be sent an older release under a
newer name.

## Server

Configuration (`Fleet:AgentReleases`):

- `BaseUrl`, default
  `https://github.com/jcarcaboso/fleet-manager/releases/download`.
- `CacheDirectory`, a directory on the Server volume.
- `PublicKeys`, the same trusted keys as the Agent, so the Server never caches
  or serves a release that Agents would reject.

Release mirror: on the first update request for its version, the Server
downloads `v<version>/fleet-agent-release.json`, its signature, and the three
`fleet-agent-*.tar.gz` archives. It uses bounded sizes, a timeout, no redirects
except GitHub's release-asset redirect, and HTTPS only. It verifies the
signature, extracts each binary with `System.Formats.Tar`, checks its digest
and size against the manifest, and caches the result. An Operator can instead
place the same files in the cache directory for an offline Server. If the
release is not published yet, which is the normal state between pushing the
images and pushing the tag, the request fails with `agent_release_unavailable`.

Data: one row per Node in `AgentUpdates` with `NodeId`, `FromVersion`,
`TargetVersion`, `State` (`requested`, `downloading`, `restarting`, `succeeded`, `failed`,
`cancelled`), `ErrorCode`, `RequestedBy`, `RequestedAt`, `FinishedAt`.
Requesting again replaces a finished row. Each request, cancellation and result
is written to the audit log.

Operator routes, defined once and mapped into `/operator/v1` and
`/dashboard/api` like the existing Node actions:

| Route | Scope | Behavior |
|---|---|---|
| `POST nodes/{node}/agent-update` | admin | Requests an update of one Node to the Server version. Rejects revoked Nodes, Nodes already on that version, and Agents that did not announce `agent-update`. |
| `POST agent-updates` `{ "nodes": [...] }` or `{ "allOutdated": true }` | admin | The same for several Nodes. Returns per-Node results. |
| `POST nodes/{node}/agent-update/cancel` | admin | Cancels a request the Agent has not picked up. |

Node detail and the Node list gain an `agentUpdate` object with the fields
above. A new `agent_update_failed` issue replaces `agent_outdated` for a Node
whose last update failed.

Agent routes (Node mTLS, same authorization as Bundles):

| Route | Behavior |
|---|---|
| `POST poll` | With capability `agent-update` and a pending request, the response includes `"agentUpdate": { "version": "0.12.0", "updateId": "<uuid>" }`. |
| `GET agent-releases/{version}/manifest`, `…/signature` | The cached signed manifest. Only the Server version is served. |
| `GET agent-releases/{version}/binaries/{os}-{arch}` | The cached binary, streamed. |
| `POST agent-update/report` | `{ "updateId", "version", "state", "errorCode" }` from the Agent; ignored without a matching request. |

## Agent updater

When a poll returns `agentUpdate`, the Agent finishes the current cycle and
reports, then:

1. Rejects the request if it is not running from the managed layout
   (`agent_update_unmanaged`). The fix is `fleet-agent service install`.
2. Downloads the manifest and signature with a 64 KiB limit and verifies the
   signature against the embedded keys. Rejects a manifest whose version is not
   the requested one or is not newer than its own version
   (`agent_update_downgrade`).
3. Finds the entry for its own `os` and `arch`, then streams the binary to
   `versions/<v>/fleet-agent.partial` with a 64 MiB limit, checking size and
   SHA-256. It sets 0755, fsyncs, and renames the file into place.
4. Runs `<new> --version` with a 10-second timeout and expects
   `fleet-agent <v>`. This catches binaries that cannot load on this machine.
5. Writes `update.json`
   `{ "from": "0.11.0", "to": "0.12.0", "state": "trial", "starts": 0 }`,
   switches `current`, reports `restarting`, releases the state
   lock and exits with code 75. The service manager starts `current`.

Trial and rollback: at startup, before anything else, an Agent that finds a
`trial` for its own version increments `starts`. After the first successful
poll it marks the update `succeeded`, reports it, and removes versions other
than itself and the previous one. If `starts` exceeds 3, or no successful poll
happens within 10 minutes, it switches `current` back to `from`, records
`failed` with the reason, and exits. The restored old Agent reports the failure.

Remaining risk: a new binary that passes `--version` but crashes before it can
update `update.json` loops under the service manager without rolling back.
`fleet-agent update rollback`, run with the old binary, recovers it. The
dashboard shows the Node as stale and the update as `restarting`.

## Compatibility and the first rollout

- Agents up to 0.11.x cannot update themselves. Each Node needs one manual
  upgrade to the first release with this feature, then
  `fleet-agent service install` to move to the managed layout. After that,
  every update can be started from the dashboard.
- Upgrade the Server before the Agents. A Server without the feature never
  sends `agentUpdate`, and an old Server rejects the `managed` install method.
  The telemetry report already fails safely in that case.
- `update.json` and `versions/` are new files. An older Agent ignores them,
  which keeps a manual downgrade possible.

## Implementation tasks

### SU-1: sign releases

Key generation instructions, committed public key, `sign` job, manifest
script with tests, release upload, release skill and `client-updates.md`
checks. Verify with a manual workflow run that the manifest matches the
archives and that the signature verifies.

### SU-2: managed layout and service command

Agent: managed layout, `service install` copy and switch, start on install,
`Restart=always`, Homebrew migration, `service logs`, `service uninstall
--purge-binaries`, `update status`, `update rollback`, `managed` install
method. Server: accept `managed`. Formula: remove `service do`, new caveats.
Tests for symlink switching, an interrupted copy, migration detection, and
unit and plist contents. Release this on its own so Nodes can migrate before
self-update exists.

### SU-3: Server mirror and update requests

Options, mirror and verification, cache, migration for `AgentUpdates`,
Operator routes, audit, issues, capability-gated poll field, Agent release
routes, `contracts/operator` fixtures. Tests: bad signature, wrong digest,
unpublished release, revoked Node, Agent without the capability, cancel, and
poll fields for old Agents.

### SU-4: Agent updater

Capability, download and verification, staging, smoke test, switch, exit,
trial, commit, rollback and pruning, report. Tests against a fake Server:
tampered manifest, wrong key, downgrade, wrong digest, oversized binary, failed
smoke test, crash-loop rollback and pruning.

### SU-5: Operator surfaces

`fleet nodes update <node>…`, `fleet nodes update --all-outdated`,
`fleet nodes update --cancel <node>`, and update state in `fleet nodes show`.
Dashboard: an **Update Agent** action on the Node's Agent tab, a bulk action on
outdated machines, update state and failures, and issue actions.

### SU-6: documentation

`client-updates.md`, the threat model (rows below), the Agent guide, the
README install section, release notes and the release skill.

## Threat model additions

| Threat | Control |
|---|---|
| Compromised Server pushes its own binary | Agents run only binaries listed in a manifest signed by the release key. The Server has no signing key. |
| Compromised GitHub release assets | Same signature check, on both the Server and the Agent. |
| Replay of an older signed release | The Agent rejects versions that are not newer than its own. Rollback is local only. |
| Leaked signing key | Two trusted keys allow rotation in one release; Nodes that never receive the new release keep trusting the old key. Store the key only in a protected environment. |
| Oversized or slow download | Size limits from the signed manifest, absolute caps and timeouts. |
| Same-user attacker replaces `current` | Out of scope, as for every other state file. |

## Implementation notes

What the implementation added to or decided beyond the design above. The
[Operator API](../technical-design/operator-api.md#agent-self-update) documents
the wire contract.

- **Capability record.** The Server stores on each poll whether the Agent sent
  `agent-update` (`nodes.AgentSelfUpdate`, shown as `agent.selfUpdate`), so a
  request can be refused before the Agent sees it. The poll writes it with the
  contact time, in the same statement.
- **Request order.** The Operator routes check the Node, then mirror the release,
  then record the request, so a release that cannot be mirrored never leaves a
  request behind. A request for a version other than the Server's (left from
  before a Server upgrade) is not sent to Agents; a new request replaces it.
- **Pickup.** The Agent reports `downloading` first and starts only on a 204; a
  409 means the request was cancelled after the poll. An Agent that already runs
  the requested version reports `succeeded` from `requested`.
- **Abandoned updates.** `agent_updates` also has `UpdatedAt`. An update that
  has been `downloading` or `restarting` for 30 minutes without progress can be
  replaced by a new request; before that the request is `agent_update_in_progress`.
- **Failure codes.** The Agent reports `agent_update_unmanaged`, `_untrusted`,
  `_invalid_manifest`, `_downgrade`, `_platform`, `_download`, `_too_large`,
  `_digest`, `_smoke_test`, `_install`, `_crash_loop`, `_no_contact` and
  `_rolled_back` (switched back by hand with `update rollback` during the trial).
  The error catalog explains each, and a Server test checks that the catalog
  covers every code in `updater.rs`.
- **`update.json`** also holds `updateId`, `since` (when `current` was
  switched, for the ten-minute limit), `errorCode` and `reported` (the result
  was delivered). `update status` shows it as `lastUpdate`.
- **Update IDs.** Each request gets a new `updateId`, sent in the poll and
  required in every report, so a late result about an earlier request of the
  same version cannot end a new one. The check before mirroring reads without
  tracking, and the write after it locks the update row again.
- **Lost reports.** When the start report gets no answer, the Agent tries the
  same request again after up to three polls, even if the poll no longer
  carries it (the Server may have recorded the start). A failure it could not
  report is written to `update.json` and delivered later. A result the Server
  refuses with a 4xx is not repeated.
- **Rollback target.** `update rollback` switches to the version a trial
  replaced; outside a trial to the newest version older than the active one,
  compared by semver.
- **Keys.** A build script embeds every `release-keys/*.pem` (none, one or two)
  in the Agent; the Server embeds the same files as resources, and
  `Fleet:AgentReleases:PublicKeys` overrides them for tests. .NET has no Ed25519
  API, so the Server verifies with a small RFC 8032 implementation, tested with
  the RFC vector and OpenSSL signatures.
- **Mirror.** The Server keeps only the verified binaries of archives it
  downloaded, and keeps archives an Operator placed. A failed mirror run is
  remembered for a minute, and its downloads are deleted. `DownloadTimeoutSeconds`
  (300) bounds one run. Archives are read by a small bounded tar reader instead
  of `TarReader`, which allocates what a PAX or GNU long-name header claims
  before reading it: at most 64 KiB per metadata header and 128 MiB unpacked.
- **Dashboard.** The machine page has no Agent tab, so **Update Agent** and the
  update state are in the Machine panel on Overview. **Update outdated Agents**
  on the machines list asks for confirmation, lets the Operator untick machines
  and sends the ticked Node IDs (`{"nodes": [...]}`; never `allOutdated`, which
  would also replace abandoned updates the dialog did not offer) and shows a
  result per machine. An update the Server would replace (a request for an
  older Server version, or no progress for 30 minutes) can be requested again,
  and the dashboard keeps reading a machine after `succeeded` until its
  telemetry reports the new version. The Problems pages offer the action for
  `agent_update_failed`, and for `agent_outdated` when the issue's commands
  include `fleet nodes update`.
- **End-to-end test.** `scripts/smoke-agent-update.sh` builds a Server and two
  Agent versions with a throwaway key, signs the release with
  `scripts/sign-agent-release.py`, and checks a crash-loop rollback and a
  successful update under `systemd --user`.

## Effort

SU-1 and SU-2 are small and useful on their own: signed releases and one service
command on every OS. SU-3 and SU-4 are the core and need a Server and Agent
release together. SU-5 is mostly UI. The work fits about three releases:
SU-1 and SU-2, then SU-3 and SU-4, then SU-5 and the remaining documentation
if they are not done earlier.
