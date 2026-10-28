# Client installation and updates

The Operator CLI and Node Agent are independent executables. Updating either
binary preserves enrollment, certificates, receipts, and cached state. Updating
Skills remains the Agent's normal source-driven reconciliation loop.

## Delivery choices

Use versioned binary archives for homelab machines. They avoid a Rust toolchain
on every Node and give all Nodes the same tested build. Use Cargo from Git for
development or when a matching binary is unavailable. The project is not
published to crates.io, so plain `cargo install fleet-agent` is not the project's
installation command.

Homebrew installs the same release archives on Linux amd64 and macOS. The
repository is its own tap, so a separate tap repository is not required.

[Cargo supports Git sources, tag selection, locked dependencies, and forced
reinstallation](https://doc.rust-lang.org/cargo/commands/cargo-install.html).
Pin a tested release tag rather than following the latest branch for unattended
installs.

The [CLI installation guide](cli-installation.md) contains Cargo and PATH
commands. The [Agent guide](../../deploy/agent/README.md) covers service commands.

## Manual rollout

1. Build one revision and verify its test results and archive checksums.
2. Run `scripts/smoke-agent-service.sh` when the release changes the service
   command or the install layout. It checks install, upgrade, rollback and
   uninstall under a real `systemd --user` in a container. The macOS launchd
   branch still needs a Mac.
3. Update one Node first. Preserve its private Agent state directory.
4. Get the new executable (`brew upgrade fleet-agent`, a release archive or
   Cargo) and run `fleet-agent service install` with it. The command copies it
   to `<state-dir>/versions/<version>/`, switches the `current` link the service
   runs, and restarts the service. Verify the version and successful
   contact/sync. Agents up to 0.11.0 have no managed copy: stop the service,
   install the new executable at the same absolute path, and restart it.
5. Update the remaining Nodes. The previous version stays installed;
   `fleet-agent update rollback` switches back to it. State migrations must
   explicitly document rollback compatibility.
   Attempt failure detail lives in its own file, `pending-detail.json`, and adds
   nothing to `run.json`, so an older Agent reads the run state unchanged and
   ignores the file.

For the Operator CLI, replace the binary and check `fleet --version`. For a Cargo
installation, rebuild with the chosen `--tag` plus `--locked --force`, then
restart the Agent service. If installation moves the executable to a different
path, reinstall the service definition so it references that path.

Agent self-update is not implemented yet; the
[self-update plan](../plans/agent-self-update.md) describes it. The updater will
use the signed release manifest below, validate platform and Server
compatibility, stage the executable, restart through the service manager, and
provide rollback. A checksum next to an archive detects corruption but does not
replace release signing.

## Release signing

Every tagged release also publishes `fleet-agent-release.json` and its Ed25519
signature `fleet-agent-release.json.sig`. The manifest names the release
version, the source commit, and the SHA-256 and size of the `fleet-agent`
executable inside each archive:

```json
{
  "schema": 1,
  "name": "fleet-agent",
  "version": "0.11.0",
  "gitCommit": "…",
  "binaries": [
    { "os": "linux", "arch": "amd64", "sha256": "…", "size": 9123456 }
  ]
}
```

The signature covers the exact manifest bytes. `scripts/sign-agent-release.py`
writes the manifest from the release archives after checking each archive
checksum, its `SHA256SUMS` and its `BUILD.json` version and clean commit. It
signs with OpenSSL and refuses a signature that no committed public key in
`clients/bins/fleet-agent/release-keys/` verifies.

The tag workflow's `sign` job runs in the `release-signing` environment, the
only place the private key `AGENT_RELEASE_SIGNING_KEY` is available. The job
fails, and no release is published, when the secret or a committed public key is
missing. Manual workflow runs sign with a throwaway key instead, so they test the
manifest without the real key. Creating and rotating the key is described in the
[release key guide](../../clients/bins/fleet-agent/release-keys/README.md).

## Build artifacts

The `Build and release client artifacts` GitHub Actions workflow prepares Linux
amd64 static archives and native macOS Apple silicon and Intel archives. A
manual run uploads temporary workflow artifacts for review. Pushing a semantic
version tag such as `v0.3.0` first checks that the tag matches every Cargo
package version, then creates a GitHub release containing all archives and their
adjacent SHA-256 files. Only the release job receives `contents: write` access.

After GitHub creates the release, a separate job verifies all six downloaded
archives against their checksum files and generates `Formula/fleet.rb` and
`Formula/fleet-agent.rb`. Apple silicon and Intel macOS jobs install and run the
tests from both generated formulas. After those tests pass, the publishing job
checks out the current `master`, refuses to replace a newer formula, and uses a
normal push so a concurrent branch update stops the job instead of being
overwritten. The publishing job needs `contents: write`; branch rules must allow
GitHub Actions to make this formula-only commit.

Linux uses `scripts/build-cli.sh`. macOS uses a native locked release build and
`scripts/package-native-clients.py`; each archive contains a build commit
record and checksums. The workflow selects the documented
[GitHub macOS runner architectures](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

macOS artifacts still need installation and login-startup testing on physical
Macs. Signing and notarization are future release work. Cargo and native builds
remain available in the meantime.

## Release procedure

The [Fleet release skill](../../.agents/skills/fleet-release/SKILL.md) covers
preparation, manual Server and dashboard image publication, tagging, and final
verification.
Preparing a release does not publish it; publishing does not deploy it.

1. Choose a new version and set it in `Directory.Build.props`, the version
   labels of `Dockerfile` and `dashboard/Dockerfile`, `dashboard/package.json`
   and its lockfile, `clients/Cargo.toml`, and
   `clients/crates/fleet-reconcile/Cargo.toml`. Regenerate the local package
   versions in `clients/Cargo.lock` and add `docs/releases/VERSION.md`.
2. For publication, update the documented and homelab default image pins (Server
   and dashboard) to the same version. Merge these changes after CI passes and record the exact tested
   commit. Run the artifact workflow manually if the archives need hands-on testing.
3. From a clean checkout of that commit, build
   `skorcius/fleet-manager:MAJOR.MINOR.PATCH` for `linux/amd64` using `Dockerfile`.
   Build `skorcius/fleet-manager:dashboard-MAJOR.MINOR.PATCH` for `linux/amd64`
   the same way using `dashboard/Dockerfile`. Set
   `org.opencontainers.image.revision` to the commit SHA on both. Smoke-test the
   local images together with disposable Compose configuration and volumes
   (`scripts/smoke-dashboard-image.sh`, `scripts/smoke-https.py` and
   `scripts/smoke-dashboard.py`), then manually push them to Docker Hub and verify
   their remote digests and labels. The client artifact workflow does not build or
   push Server or dashboard images.
4. Only after both images are available, create and push an annotated
   `vMAJOR.MINOR.PATCH` tag on the same tested commit. Never move a published tag
   or overwrite a version image with different content.
5. Wait for the tag workflow. It publishes the GitHub release only after all
   Linux and macOS build, lint, and test jobs pass and the Agent release manifest
   is signed. It then updates the formulas from the published archive checksums.
6. Check that the release has all six archives and six adjacent checksum files,
   `fleet-agent-release.json` and a signature that verifies with a committed key,
   both formulas name the release version, and archive provenance matches the
   tagged commit. Verify downloaded checksums and the published Server and dashboard images.
   Report partial failures rather than calling the release complete.
7. Deploy through the staged rollout above only when a rollout is requested.

Every install method runs the Agent through `fleet-agent service install`,
which runs a copy in the state directory, so the original executable can move
or be removed after an upgrade. Releases up to 0.11.0 put a `brew services`
definition in the formula; a newer `fleet-agent service install` stops and
replaces it. Never run both service definitions at once.

Do not reuse or move a published release tag. Make a new patch release for a
corrected build so Cargo installs and downloaded assets continue to identify one
source revision.
