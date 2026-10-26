# Development data inventory

PostgreSQL contains the records below. Only authenticated Operators can query
status. Nodes can access their own Assignments and authorized Bundles. No
telemetry leaves the installation. Logs contain bounded event names and counts,
and do not include request bodies, credentials, Skill bytes, or absolute home
paths.

| Record | Stored fields and purpose |
|---|---|
| Workspace | Stable ID and administrative name bind one database to one installation. |
| Node | ID, Workspace ID, chosen name, platform, enrollment time, revocation time, and last authenticated contact support identity, compatibility, and freshness. The Server does not collect the local home path. A nullable disk refresh request time records that an Operator asked for a fresh disk report; the Node's next disk report clears it. |
| Enrollment authorization | ID, Workspace ID, token digest, creator, expiry, retry duration, consumption time, retry deadline, CSR digest, issued Node/credential IDs, and public delivery response provide atomic enrollment and response recovery. The raw token and private key are never stored. |
| Node credential | ID, Node ID, certificate SHA-256, validity interval, revocation time and actor support per-request authorization and revocation. Certificates are public data. Issuing and Node private keys are absent. |
| Bundle | SHA-256 digest, schema, byte count, complete opaque bytes, and creation time support immutable delivery. Bytes may contain sensitive author-provided content. |
| Desired revision | ID, Workspace ID, source revision and acceptance time identify accepted source history. |
| Source warning | ID, desired revision ID, diagnostic code, bounded message, and source locations explain deterministic duplicate resolution. |
| Source scan | ID, Workspace ID, observed source revision, outcome, bounded code/diagnostic, timestamp, and requesting Operator record ingestion outcomes. |
| Rollout | ID, desired revision ID and creation time group per-Target results. |
| Assignment | ID, Node ID, Rollout/revision IDs, Target name, relative descriptor, current flag, convergence state, creation time, and optional AI-client mode, client, endpoint, and model describe intended Target state. The CLIProxyAPI key is absent. |
| Assignment Skill | Assignment ID, Skill name, Bundle digest and ordering describe the complete resolved map. |
| Assignment File | Assignment ID, destination filename, and optional content digest describe one Managed file or its removal. |
| Attempt | ID, Assignment/Rollout/Node IDs, convergence state, error code, bounded diagnostic and update time retain accepted reports. Report requests accept stable error codes only. A failed Attempt can also hold failure detail sent by its own Node on `POST /agent/v1/attempts/{attemptId}/detail`: a control-character-free diagnostic of at most 2048 characters (in `Diagnostic`), an optional relative path of at most 512 characters (`FailurePath`) and an optional step name of at most 32 characters from a fixed list (`FailureStep`). The Agent keeps file contents, credentials and environment values out of the detail and replaces its home directory with `~`; the Server only enforces the limits, so treat the diagnostic as Node-supplied text. The detail follows the Attempt's retention and backups, and a newer detail replaces the earlier one. |
| Node check-in | Node ID, UTC hour and the number of successful polls in that hour. Maintenance deletes rows older than seven days; they feed the Node activity chart. |
| Node disk usage | Node ID, volume label (`home` or `state`), total, used and available bytes, and the time the Server received the report, from `PUT /agent/v1/disk-usage`. At most two rows per Node, only the latest report: each report replaces all volumes of the Node and nothing keeps history. Rows are deleted with the Node. Byte counts describe the filesystem as a whole; no file names or directory sizes are collected. Backups contain them. |
| Node telemetry | Node ID, Agent version, OS name, version and kernel, CPU architecture, hostname, login user name, install method (`homebrew`, `cargo` or `binary`), service manager (`systemd`, `launchd` or `none`), state directory with the home directory shown as `~`, and the time the Server received the report, from `PUT /agent/v1/telemetry`. Strings have control characters removed and are limited to 128 characters (state directory: 512). One row per Node, only the latest report: each report replaces the row and nothing keeps history. The row is deleted with the Node. **Hostname and user name identify a machine and a person**, so treat the table as identifying data: Operators see them in the Node views, and backups contain them. The Agent reads them from local sources only and never collects the home path, environment values, file names or process lists. |
| Audit event | ID, Workspace ID, timestamp, action, actor and optional Node/credential IDs record security-relevant transitions without request bodies. |

Maintenance clears expired enrollment delivery responses and prunes check-in counters in bounded batches,
while retaining token digests and consumption metadata. Audit and source-scan
history can be deleted after explicitly configured retention periods. Those
deletions are disabled by default. Other records remain retained; historical
Bundle garbage collection is not implemented. See
[operations hardening](operations-hardening.md) for configuration and limits.

Backups contain all database records, including Bundle bytes. Operators must
restrict database and backup access. The issuing key and Server TLS key require
separate protected backups. The [backup tool](backup-restore.md) supports a manual
dump/restore drill. The local Compose environment does not implement encryption
or an automatic backup policy.

The Server reads the CLIProxyAPI key from deployment configuration. It does not
write the key to PostgreSQL, a Bundle, an audit event, or an Assignment. Each
assigned Agent stores a private key copy and a model cache below its local state
directory, plus ownership receipts and recovery journals for client
configuration. After a failed Attempt the Agent also keeps `pending-detail.json`:
the newest unsent failure detail with its Attempt ID, creation time, a diagnostic
of at most 2048 UTF-16 code units, an optional Target-relative path and an
optional step. The diagnostic has control characters removed and the home
directory replaced by `~`, and never contains file contents or credentials. The
file is removed once the Server accepts the detail, rejects it with a client
error other than 408 or 429, or 24 hours after creation, and it is kept outside
the run state so that older Agents can still read the run state. These
Node-local files are outside the Server backup tool. Treat an Agent-state backup
as credential material.

Before release, choose retention windows, measure database growth, repeat the
backup drill on deployment hardware, and confirm that implemented fields still
match this inventory. The singleton Workspace discriminator is an invariant
enforcement field, not additional Node metadata.
