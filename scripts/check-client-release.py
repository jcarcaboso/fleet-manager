#!/usr/bin/env python3
"""Check release formulas and the signed manifest with all supported platforms."""

import hashlib
import io
import json
import runpy
import tarfile
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HOMEBREW = runpy.run_path(str(ROOT / "scripts/update-homebrew.py"))
SIGNING = runpy.run_path(str(ROOT / "scripts/sign-agent-release.py"))
PLATFORMS = ("linux-amd64", "linux-arm64", "macos-amd64", "macos-arm64")
VERSION = "1.2.3"
COMMIT = "a" * 40


class ClientReleaseTests(unittest.TestCase):
    def test_archives_feed_formulas_and_manifest(self):
        with tempfile.TemporaryDirectory() as scratch:
            artifacts = Path(scratch)
            for binary in ("fleet", "fleet-agent"):
                sums = {}
                for platform in PLATFORMS:
                    executable = f"{binary} {platform}".encode()
                    payloads = {
                        binary: executable,
                        "BUILD.json": json.dumps({
                            "version": f"{binary} {VERSION}",
                            "gitCommit": COMMIT,
                            "dirty": False,
                            "platform": platform,
                        }).encode(),
                        "SHA256SUMS": f"{hashlib.sha256(executable).hexdigest()}  {binary}\n".encode(),
                    }
                    archive = artifacts / f"{binary}-{platform}.tar.gz"
                    with tarfile.open(archive, "w:gz") as package:
                        for name, data in payloads.items():
                            member = tarfile.TarInfo(name)
                            member.size = len(data)
                            package.addfile(member, io.BytesIO(data))
                    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
                    archive.with_name(archive.name + ".sha256").write_text(f"{digest}  {archive.name}\n")
                    sums[platform] = digest

                checked = {
                    platform: HOMEBREW["archive_sha256"](artifacts, binary, platform)
                    for platform in HOMEBREW["PLATFORMS"]
                }
                self.assertEqual(checked, sums)
                formula = HOMEBREW["formula"](binary, VERSION, "test/fleet", checked)
                linux = formula.split("  on_linux do\n", 1)[1].split("  def install", 1)[0]
                self.assertIn("if Hardware::CPU.arm?", linux)
                self.assertNotIn("depends_on arch: :x86_64", linux)
                for arch in ("arm64", "amd64"):
                    self.assertIn(f"/{binary}-linux-{arch}.tar.gz", linux)
                    self.assertIn(f'sha256 "{sums[f"linux-{arch}"]}"', linux)

            manifest = json.loads(SIGNING["manifest_bytes"](artifacts, VERSION, COMMIT))
            self.assertEqual(
                {f'{entry["os"]}-{entry["arch"]}' for entry in manifest["binaries"]},
                set(PLATFORMS),
            )
            arm = next(entry for entry in manifest["binaries"] if entry["os"] == "linux" and entry["arch"] == "arm64")
            self.assertEqual(arm["sha256"], hashlib.sha256(b"fleet-agent linux-arm64").hexdigest())
            self.assertEqual(arm["size"], len(b"fleet-agent linux-arm64"))

            checksum = artifacts / "fleet-agent-linux-arm64.tar.gz.sha256"
            checksum.write_text(f'{"0" * 64}  fleet-agent-linux-arm64.tar.gz\n')
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                HOMEBREW["archive_sha256"](artifacts, "fleet-agent", "linux-arm64")
            with self.assertRaisesRegex(SystemExit, "checksum mismatch"):
                SIGNING["manifest_bytes"](artifacts, VERSION, COMMIT)
            checksum.unlink()
            with self.assertRaises(FileNotFoundError):
                HOMEBREW["archive_sha256"](artifacts, "fleet-agent", "linux-arm64")
            with self.assertRaisesRegex(SystemExit, "archive and checksum are required"):
                SIGNING["manifest_bytes"](artifacts, VERSION, COMMIT)


if __name__ == "__main__":
    unittest.main()
