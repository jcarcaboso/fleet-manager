#!/usr/bin/env python3
"""Package native macOS client binaries after a locked release build."""
import argparse
import gzip
import hashlib
import io
import json
import os
import platform
from pathlib import Path
import subprocess
import tarfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--binary-directory', type=Path, default=Path('clients/target/release'))
parser.add_argument('--output-directory', type=Path, default=Path('artifacts'))
args = parser.parse_args()
if platform.system() != 'Darwin':
    parser.error('native packaging is for macOS; use scripts/build-cli.sh for portable Linux archives')
architecture = {'arm64': 'arm64', 'x86_64': 'amd64'}.get(platform.machine())
if architecture is None:
    parser.error('unsupported macOS architecture')
root = Path(__file__).resolve().parents[1]
commit = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
dirty = bool(subprocess.check_output(['git', '-C', str(root), 'status', '--porcelain']))
args.output_directory.mkdir(parents=True, exist_ok=True)
for name in ['fleet', 'fleet-agent']:
    binary = (args.binary_directory / name).resolve()
    version = subprocess.check_output([str(binary), '--version'], text=True).strip()
    release_version = os.environ.get('FLEET_RELEASE_VERSION', '').removeprefix('v')
    if release_version and version != f'{name} {release_version}':
        raise SystemExit(f'expected {name} {release_version}, got {version}')
    subprocess.run([str(binary), '--help'], check=True, stdout=subprocess.DEVNULL)
    payloads = {name: binary.read_bytes(), 'LICENSE': (root / 'LICENSE').read_bytes()}
    payloads['BUILD.json'] = (json.dumps({'version': version, 'gitCommit': commit, 'dirty': dirty,
        'platform': 'macos-' + architecture}, indent=2) + '\n').encode()
    payloads['SHA256SUMS'] = ''.join(hashlib.sha256(data).hexdigest() + '  ' + filename + '\n'
        for filename, data in sorted(payloads.items())).encode()
    archive = args.output_directory / f'{name}-macos-{architecture}.tar.gz'
    with archive.open('wb') as output:
        with gzip.GzipFile(filename='', mode='wb', fileobj=output, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w') as tar:
                for filename, data in sorted(payloads.items()):
                    entry = tarfile.TarInfo(filename)
                    entry.size = len(data)
                    entry.mode = 0o755 if filename == name else 0o644
                    tar.addfile(entry, io.BytesIO(data))
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix(archive.suffix + '.sha256').write_text(checksum + '  ' + archive.name + '\n')
    print(archive)
