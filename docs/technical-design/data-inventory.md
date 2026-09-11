# Development data inventory

PostgreSQL contains the records below. Only authenticated Operators can query
status. Nodes can access their own Assignments and authorized Bundles. No
telemetry leaves the installation. Logs contain bounded event names and counts,
and do not include request bodies, credentials, Skill bytes, or absolute home
paths.

| Record | Stored fields and purpose |
|---|---|
| Workspace | Stable ID and administrative name bind one database to one installation. |
| Node | ID, Workspace ID, chosen name, platform, enrollment time, revocation time, and last authenticated contact support identity, compatibility, and freshness. The Server does not collect the local home path. |
| Enrollment authorization | ID, Workspace ID, token digest, creator, expiry, retry duration, consumption time, retry deadline, CSR digest, issued Node/credential IDs, and public delivery response provide atomic enrollment and response recovery. The raw token and private key are never stored. |
| Node credential | ID, Node ID, certificate SHA-256, validity interval, revocation time and actor support per-request authorization and revocation. Certificates are public data. Issuing and Node private keys are absent. |
| Bundle | SHA-256 digest, schema, byte count, complete opaque bytes, and creation time support immutable delivery. Bytes may contain sensitive author-provided content. |
| Desired revision | ID, Workspace ID, source revision and acceptance time identify accepted source history. |
| Source warning | ID, desired revision ID, diagnostic code, bounded message, and source locations explain deterministic duplicate resolution. |
| Source scan | ID, Workspace ID, observed source revision, outcome, bounded code/diagnostic, timestamp, and requesting Operator record ingestion outcomes. |
| Rollout | ID, desired revision ID and creation time group per-Target results. |
| Assignment | ID, Node ID, Rollout/revision IDs, Target name, relative descriptor, current flag, convergence state, and creation time describe intended Target state. |
| Assignment Skill | Assignment ID, Skill name, Bundle digest and ordering describe the complete resolved map. |
| Assignment File | Assignment ID, destination filename, and optional content digest describe one Managed file or its removal. |
| Attempt | ID, Assignment/Rollout/Node IDs, convergence state, error code, bounded diagnostic and update time retain accepted reports. Public report requests currently accept stable error codes only. |
| Audit event | ID, Workspace ID, timestamp, action, actor and optional Node/credential IDs record security-relevant transitions without request bodies. |

Maintenance clears expired enrollment delivery responses in bounded batches,
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

Before release, choose retention windows, measure database growth, repeat the
backup drill on deployment hardware, and confirm that implemented fields still
match this inventory. The singleton Workspace discriminator is an invariant
enforcement field, not additional Node metadata.
