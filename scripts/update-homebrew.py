#!/usr/bin/env python3
"""Generate the same-repository Homebrew formulas from release archives."""

import argparse
import hashlib
import re
import tarfile
from pathlib import Path


PLATFORMS = ("linux-amd64", "macos-arm64", "macos-amd64")
VERSION_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")


def version_tuple(value: str) -> tuple[int, int, int]:
    match = VERSION_RE.fullmatch(value)
    if not match:
        raise ValueError(f"version must be vMAJOR.MINOR.PATCH, got {value!r}")
    return tuple(map(int, match.groups()))


def archive_sha256(directory: Path, binary: str, platform: str) -> str:
    name = f"{binary}-{platform}.tar.gz"
    archive = directory / name
    sidecar = directory / f"{name}.sha256"
    if not archive.is_file() or not sidecar.is_file():
        raise FileNotFoundError(f"release archive and checksum are required: {name}")
    fields = sidecar.read_text().strip().split()
    if len(fields) != 2 or fields[1].lstrip("*") != name:
        raise ValueError(f"invalid checksum file: {sidecar}")
    actual = hashlib.sha256(archive.read_bytes()).hexdigest()
    if fields[0].lower() != actual:
        raise ValueError(f"checksum mismatch for {archive}")
    with tarfile.open(archive, "r:gz") as package:
        members = {member.name.removeprefix("./") for member in package.getmembers()}
    if binary not in members or "SHA256SUMS" not in members:
        raise ValueError(f"{archive} does not contain {binary} and SHA256SUMS")
    return actual


def formula(binary: str, version: str, repository: str, sums: dict[str, str]) -> str:
    class_name = "FleetAgent" if binary == "fleet-agent" else "Fleet"
    description = (
        "Node agent for Fleet Manager"
        if binary == "fleet-agent"
        else "Operator CLI for Fleet Manager"
    )
    service = ""
    caveats = ""
    if binary == "fleet-agent":
        service = '''
  service do
    run [opt_bin/"fleet-agent", "run"]
    keep_alive true
    restart_delay 15
  end
'''
        caveats = '''
  def caveats
    <<~EOS
      Enroll the Agent before starting its Homebrew service. Then run:

        brew services start fleet-agent

      Do not run the Homebrew service and `fleet-agent service` at the same time.
    EOS
  end
'''
    base = f"https://github.com/{repository}/releases/download/v{version}"
    return f'''class {class_name} < Formula
  desc "{description}"
  homepage "https://github.com/{repository}"
  version "{version}"
  license "MIT"

  on_macos do
    depends_on macos: :ventura

    if Hardware::CPU.arm?
      url "{base}/{binary}-macos-arm64.tar.gz"
      sha256 "{sums['macos-arm64']}"
    else
      url "{base}/{binary}-macos-amd64.tar.gz"
      sha256 "{sums['macos-amd64']}"
    end
  end

  on_linux do
    depends_on arch: :x86_64

    url "{base}/{binary}-linux-amd64.tar.gz"
    sha256 "{sums['linux-amd64']}"
  end

  def install
    bin.install "{binary}"
  end
{service}{caveats}
  test do
    assert_match "{binary} {version}", shell_output("#{{bin}}/{binary} --version")
    system "#{{bin}}/{binary}", "--help"
  end
end
'''


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path("Formula"))
    parser.add_argument("--repository", default="jcarcaboso/fleet-manager")
    args = parser.parse_args()
    requested = version_tuple(args.version)
    version = ".".join(map(str, requested))
    args.output.mkdir(parents=True, exist_ok=True)

    for binary in ("fleet", "fleet-agent"):
        destination = args.output / f"{binary}.rb"
        if destination.exists():
            match = re.search(r'^  version "([^"]+)"$', destination.read_text(), re.MULTILINE)
            if match and version_tuple(match.group(1)) > requested:
                raise SystemExit(
                    f"refusing to replace {destination} version {match.group(1)} with {version}"
                )
        sums = {
            platform: archive_sha256(args.artifacts, binary, platform)
            for platform in PLATFORMS
        }
        destination.write_text(formula(binary, version, args.repository, sums))
        print(destination)


if __name__ == "__main__":
    main()
