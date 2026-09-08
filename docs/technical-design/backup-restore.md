# PostgreSQL backup and restore

The backup tool uses PostgreSQL utilities inside an Operator-owned Docker
container. It requires Python 3.11 or later and Docker access. The selected
database user must be able to connect through the container's local PostgreSQL
socket. Passwords are not accepted as command arguments or stored in the manifest.

For the local Compose installation:

```sh
docker compose up -d --wait
mkdir -p .local/backups
python3 scripts/postgres-backup.py backup --container fleet-postgres-1 .local/backups/first
```

The final directory must not exist. The tool creates it with mode 0700 and files
with mode 0600. It streams a consistent `pg_dump --format=custom` snapshot to
`database.dump`, flushes the file, and writes `manifest.json` last. The manifest
records format, timestamp, byte count, and SHA-256. A directory without a
complete manifest is an incomplete backup and cannot be restored.

The dump includes migrations, Workspace identity, desired state, Bundle bytes,
Assignments, reports, enrollment consumption, credential metadata, revocations,
and audit records. It excludes Server configuration, issuing and TLS private
keys, and Operator token configuration. Preserve those separately in protected
storage, with the same stable Workspace ID.

## Restore drill

Create a separate empty database in a separate PostgreSQL container. Keep it
isolated from Agents and application writers. Use the same PostgreSQL major
version and Server release for the first restoration.

```sh
python3 scripts/postgres-backup.py restore --container fleet-restore-test .local/backups/first
```

Use `--database` and `--username` if the defaults of `fleet` do not match the
target. Restore verifies the checksum before querying PostgreSQL, rejects
symbolic-link backup paths, and refuses targets containing user relations.
It runs `pg_restore --single-transaction --exit-on-error --no-owner --no-acl`.
It never passes `--clean` or drops the target. Restore only trusted backup
artifacts because archive SQL is executable database input.

Before admitting traffic, check readiness, Workspace identity, current desired
state, Bundle digests, enrollment consumption, and revocation. Restore matching
issuing-key configuration before certificate renewal. A stale backup may predate
revocations or token consumption. Resolve those missing transitions before
reopening traffic.

`BackupRestoreTests` backs up a migrated PostgreSQL container and restores into
another. It checks polling, Bundle content, active/revoked credentials, exact
enrollment retry, and migration state. It also checks refusal to overwrite a
backup, restore into a populated database, or use a modified dump.

## Limits

The subprocess deadline is five minutes. The tool does not encrypt, schedule,
rotate, or copy backups off-host, and it does not manage CA keys. The checksum
detects changes but does not authenticate an archive's author. Backups retain
data present at snapshot time even after database cleanup. Storage encryption,
access control, cadence, and archive retention remain deployment decisions.
Repeat the drill on deployment hardware before setting recovery objectives.
