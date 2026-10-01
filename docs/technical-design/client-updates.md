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
2. Update one Node first. Preserve its private Agent state directory.
3. Stop its Agent service, install the new executable at the same absolute path,
   and restart the service. Verify the version and successful contact/sync.
4. Update the remaining Nodes. Keep the previous executable available for
   rollback; state migrations must explicitly document rollback compatibility.

For the Operator CLI, replace the binary and check `fleet --version`. For a Cargo
installation, rebuild with the chosen `--tag` plus `--locked --force`, then
restart the Agent service. If installation moves the executable to a different
path, reinstall the service definition so it references that path.

Agent self-update is not implemented. A later updater should use signed release
metadata, validate platform and Server compatibility, stage the executable,
restart through the service manager, and provide rollback. A checksum next to an
archive detects corruption but does not replace release signing.

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
preparation, manual Server image publication, tagging, and final verification.
Preparing a release does not publish it; publishing does not deploy it.

1. Choose a new version and set it in `Directory.Build.props`, the Dockerfile's
   version label, `clients/Cargo.toml`, and
   `clients/crates/fleet-reconcile/Cargo.toml`. Regenerate the local package
   versions in `clients/Cargo.lock` and add `docs/releases/VERSION.md`.
2. For publication, update the documented and homelab default image pins to the
   same version. Merge these changes after CI passes and record the exact tested
   commit. Run the artifact workflow manually if the archives need hands-on testing.
3. From a clean checkout of that commit, build
   `skorcius/fleet-manager:MAJOR.MINOR.PATCH` for `linux/amd64` using `Dockerfile`.
   Set `org.opencontainers.image.revision` to the commit SHA. Smoke-test the
   local image with disposable Compose configuration and volumes, then
   manually push it to Docker Hub and verify its remote digest and labels.
   The client artifact workflow does not build or push Server images.
4. Only after the Server image is available, create and push an annotated
   `vMAJOR.MINOR.PATCH` tag on the same tested commit. Never move a published tag
   or overwrite a version image with different content.
5. Wait for the tag workflow. It publishes the GitHub release only after all
   Linux and macOS build, lint, and test jobs pass. It then updates the formulas
   from the published archive checksums.
6. Check that the release has all six archives and six adjacent checksum files,
   both formulas name the release version, and archive provenance matches the
   tagged commit. Verify downloaded checksums and the published Server image.
   Report partial failures rather than calling the release complete.
7. Deploy through the staged rollout above only when a rollout is requested.

The Homebrew formula uses `opt_bin` for the Agent service command. This symlink
tracks the active Cellar version across upgrades. Direct and Cargo installs use
`fleet-agent service`; if their executable path changes, reinstall that service
definition as described above. Never run both service definitions at once.

Do not reuse or move a published release tag. Make a new patch release for a
corrected build so Cargo installs and downloaded assets continue to identify one
source revision.
