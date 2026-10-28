#!/usr/bin/env python3
"""Write and sign the Agent release manifest from the release archives.

The manifest lists the version, the source commit and the SHA-256 and size of
the `fleet-agent` executable for each platform. Its Ed25519 signature is what a
self-updating Agent trusts: the Server only mirrors these files. See
docs/technical-design/client-updates.md#release-signing.

The private key is a PEM file read by OpenSSL and is never printed. The
signature is checked against every `--trusted-key` and must match one of them,
so a release cannot be signed with a key that Agents do not embed.
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import tarfile
import tempfile
from pathlib import Path


SCHEMA = 1
NAME = "fleet-agent"
PLATFORMS = (("linux", "amd64"), ("macos", "arm64"), ("macos", "amd64"))
VERSION_RE = re.compile(r"^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
# The Agent refuses larger executables; fail the release instead.
MAX_BINARY_BYTES = 64 * 1024 * 1024
# Read by the Agent with a 64 KiB limit.
MAX_MANIFEST_BYTES = 64 * 1024
SIGNATURE_BYTES = 64


def release_version(value: str) -> str:
    match = VERSION_RE.fullmatch(value)
    if not match:
        raise SystemExit(f"version must be [v]MAJOR.MINOR.PATCH[-prerelease], got {value!r}")
    return match.group(1)


def checked_archive(directory: Path, os_name: str, arch: str) -> Path:
    name = f"{NAME}-{os_name}-{arch}.tar.gz"
    archive = directory / name
    sidecar = directory / f"{name}.sha256"
    if not archive.is_file() or not sidecar.is_file():
        raise SystemExit(f"release archive and checksum are required: {name}")
    fields = sidecar.read_text().strip().split()
    if len(fields) != 2 or fields[1].lstrip("*") != name:
        raise SystemExit(f"invalid checksum file: {sidecar}")
    if fields[0].lower() != hashlib.sha256(archive.read_bytes()).hexdigest():
        raise SystemExit(f"checksum mismatch for {archive}")
    return archive


def member(package: tarfile.TarFile, name: str, limit: int) -> bytes:
    try:
        info = package.getmember(name)
    except KeyError:
        info = package.getmember(f"./{name}")
    if not info.isfile() or info.size > limit:
        raise SystemExit(f"{name} in {package.name} is not a regular file of at most {limit} bytes")
    data = package.extractfile(info)
    assert data is not None
    return data.read()


def binary_entry(archive: Path, os_name: str, arch: str, version: str, commit: str) -> dict:
    with tarfile.open(archive, "r:gz") as package:
        binary = member(package, NAME, MAX_BINARY_BYTES)
        build = json.loads(member(package, "BUILD.json", 64 * 1024))
        sums = member(package, "SHA256SUMS", 64 * 1024).decode()
    digest = hashlib.sha256(binary).hexdigest()
    if f"{digest}  {NAME}" not in sums.splitlines():
        raise SystemExit(f"{archive}: {NAME} does not match its SHA256SUMS")
    if build.get("version") != f"{NAME} {version}":
        raise SystemExit(f"{archive}: BUILD.json version is {build.get('version')!r}, expected {NAME} {version}")
    if build.get("gitCommit") != commit or build.get("dirty") is not False:
        raise SystemExit(f"{archive}: BUILD.json must name clean commit {commit}")
    return {"os": os_name, "arch": arch, "sha256": digest, "size": len(binary)}


def manifest_bytes(artifacts: Path, version: str, commit: str) -> bytes:
    binaries = [
        binary_entry(checked_archive(artifacts, os_name, arch), os_name, arch, version, commit)
        for os_name, arch in PLATFORMS
    ]
    manifest = {"schema": SCHEMA, "name": NAME, "version": version, "gitCommit": commit, "binaries": binaries}
    data = (json.dumps(manifest, indent=2) + "\n").encode()
    if len(data) > MAX_MANIFEST_BYTES:
        raise SystemExit("manifest is too large")
    return data


def openssl(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["openssl", *args], capture_output=True, check=False)


def sign(manifest: Path, key: Path, signature: Path) -> None:
    result = openssl("pkeyutl", "-sign", "-rawin", "-inkey", str(key), "-in", str(manifest), "-out", str(signature))
    if result.returncode != 0:
        # OpenSSL's message names the failing step; it never contains key material.
        raise SystemExit(f"openssl could not sign with an Ed25519 key: {result.stderr.decode(errors='replace').strip()}")
    if signature.stat().st_size != SIGNATURE_BYTES:
        raise SystemExit("the signing key is not an Ed25519 key")


def verifies(manifest: Path, signature: Path, public_key: Path) -> bool:
    result = openssl("pkeyutl", "-verify", "-rawin", "-pubin", "-inkey", str(public_key),
                     "-in", str(manifest), "-sigfile", str(signature))
    return result.returncode == 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--version", required=True)
    parser.add_argument("--commit", required=True, help="the 40-character source commit of the archives")
    parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument("--key", type=Path, required=True, help="Ed25519 private key, PEM")
    parser.add_argument("--trusted-key", type=Path, action="append", required=True,
                        help="Ed25519 public key, PEM; repeat for each key Agents trust")
    parser.add_argument("--output", type=Path, help="defaults to ARTIFACTS/fleet-agent-release.json")
    args = parser.parse_args()
    version = release_version(args.version)
    if not COMMIT_RE.fullmatch(args.commit):
        raise SystemExit("commit must be a full lowercase SHA-1")
    output = args.output or args.artifacts / f"{NAME}-release.json"
    signature = output.with_name(output.name + ".sig")

    data = manifest_bytes(args.artifacts, version, args.commit)
    with tempfile.TemporaryDirectory() as scratch:
        staged = Path(scratch) / output.name
        staged_signature = Path(scratch) / signature.name
        staged.write_bytes(data)
        sign(staged, args.key, staged_signature)
        trusted = [key for key in args.trusted_key if verifies(staged, staged_signature, key)]
        if not trusted:
            raise SystemExit("the signature does not verify with any trusted key; sign with a key Agents embed")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(data)
        signature.write_bytes(staged_signature.read_bytes())
    os.chmod(output, 0o644)
    os.chmod(signature, 0o644)
    print(f"{output} signed; verified with {trusted[0]}")


if __name__ == "__main__":
    main()
