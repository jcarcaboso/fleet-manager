#!/usr/bin/env python3
"""Back up or restore Fleet PostgreSQL through an Operator-owned Docker container."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from datetime import datetime, timezone


def run(command, **kwargs):
    return subprocess.run(command, check=True, stderr=subprocess.DEVNULL, timeout=300, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['backup', 'restore'])
    parser.add_argument('--container', required=True)
    parser.add_argument('--database', default='fleet')
    parser.add_argument('--username', default='fleet')
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    if any(value.startswith('-') or not value or '\x00' in value for value in [args.container, args.database, args.username]):
        parser.error('container, database, and username must be non-empty names, not options')
    os.umask(0o077)
    directory = args.directory.absolute()
    base = ['docker', 'exec', '-i', args.container]
    connection = ['--username', args.username, '--dbname', args.database]
    dump = directory / 'database.dump'
    manifest = directory / 'manifest.json'
    if args.operation == 'backup':
        # Exclusive creation prevents overwriting any previous backup, including an incomplete one.
        directory.mkdir(mode=0o700)
        with dump.open('xb') as output:
            run(base + ['pg_dump', '--format=custom', '--no-owner', '--no-acl'] + connection, stdout=output)
            output.flush()
            os.fsync(output.fileno())
        with dump.open('rb') as source:
            digest = hashlib.file_digest(source, 'sha256').hexdigest()
        data = {'schema': 'fleet.backup/v1', 'createdAt': datetime.now(timezone.utc).isoformat(),
                'sha256': digest, 'bytes': dump.stat().st_size}
        temporary = directory / 'manifest.pending'
        with temporary.open('x') as output:
            json.dump(data, output)
            output.flush()
            os.fsync(output.fileno())
        temporary.rename(manifest)
        print('Backup completed. Keep this directory private; it contains Skill content and credential metadata.')
    else:
        if directory.is_symlink() or dump.is_symlink() or manifest.is_symlink():
            raise ValueError('backup paths must not be symbolic links')
        data = json.loads(manifest.read_text())
        if data['schema'] != 'fleet.backup/v1':
            raise ValueError('unsupported backup schema')
        with dump.open('rb') as source:
            if dump.stat().st_size != data['bytes'] or hashlib.file_digest(source, 'sha256').hexdigest() != data['sha256']:
                raise ValueError('backup checksum or size does not match')
            # A separate empty database is mandatory. pg_restore never receives --clean or --create.
            query = "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'"
            count = run(base + ['psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1'] + connection + ['-c', query], stdout=subprocess.PIPE).stdout.strip()
            if count != b'0':
                raise ValueError('restore requires an empty target database')
            source.seek(0)
            run(base + ['pg_restore', '--single-transaction', '--exit-on-error', '--no-owner', '--no-acl'] + connection, stdin=source, stdout=subprocess.DEVNULL)
        print('Restore completed. Verify readiness and credential state before admitting Node traffic.')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        print('Backup operation failed. Check the private artifact, container access, PostgreSQL compatibility, and target database state.', file=sys.stderr)
        sys.exit(1)
