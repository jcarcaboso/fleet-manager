# Install the Fleet command-line tools

The repository contains two Rust commands:

- `fleet` is the Operator CLI. It reads `FLEET_SERVER_URL` and
  `FLEET_OPERATOR_TOKEN` when it calls the Server.
- `fleet-agent` enrolls and reconciles a node. It stores its configuration and
  credentials under `~/.local/state/fleet-agent` by default.

Neither package is published on crates.io. Install a release archive when one
matches the machine, or ask Cargo to build a reviewed release tag from Git.

## Install with Homebrew

The repository is also its own Homebrew tap. After a release has published its
Linux amd64 and macOS archives, install either command with:

```sh
brew tap jcarcaboso/fleet https://github.com/jcarcaboso/fleet-manager
brew install jcarcaboso/fleet/fleet
brew install jcarcaboso/fleet/fleet-agent
fleet --version
fleet-agent --version
```

Homebrew uses the prebuilt release for the current operating system and CPU.
The formulas support Linux amd64 plus macOS 13 or newer on Apple silicon and
Intel. They do not build Rust source or install credentials.

Enroll the Agent, then install its service. `fleet-agent service install`
copies the executable into the state directory (`versions/<version>/fleet-agent`
plus a `current` link), writes a launchd or systemd definition that runs
`<state-dir>/current/fleet-agent`, and starts it:

```sh
fleet-agent enroll --link
fleet-agent service install
fleet-agent service status
```

After `brew upgrade fleet-agent`, run `fleet-agent service install` again to
switch the service to the new version. The formula only supplies new
binaries; it has no `brew services` definition from the release after 0.11.0
on. From 0.12.1, once the service runs, an Operator can update the Agent from
the Server instead (`fleet nodes update <node>` or **Update Agent** in the
dashboard); the Homebrew formula then stays at the version first installed,
which does not matter because the service runs its own copy. See the
[Agent guide](../../deploy/agent/README.md#updates-from-the-server).

Agent state remains under `~/.local/state/fleet-agent` unless `--state-dir`
selects another absolute path. Give the same `--state-dir` to every command.

Releases up to 0.11.0 ran the Agent as a Homebrew service named
`sh.brew.fleet-agent` (`homebrew.mxcl.fleet-agent` or
`homebrew.fleet-agent.service` in older Homebrew versions). A newer
`fleet-agent service install` finds that service, runs
`brew services stop fleet-agent` to stop and unregister it, and installs its own
`dev.fleet.agent` launchd job or `fleet-agent.service` systemd unit. While only
the Homebrew service is installed, the other `fleet-agent service` actions stop
with an error that names `fleet-agent service install` and the matching
`brew services` command. `start` and `restart` also refuse while both are
installed, since only one Agent can run. `fleet-agent status` reports
`service.running` (an Agent holds the state lock, whoever started it) together
with `service.manager` (`homebrew` or `fleet-agent`), `service.label` and
`service.version`, the installed version the fleet-agent service runs.

## Service logs

| Service | Log |
| --- | --- |
| Homebrew, macOS and Linux | `$(brew --prefix)/var/log/fleet-agent.log` (standard output and error; `brew services info fleet-agent` shows the path) |
| `fleet-agent service install`, macOS | `<state-dir>/logs/agent.log`, by default `~/.local/state/fleet-agent/logs/agent.log`; `fleet-agent status` shows it as `service.logs` |
| `fleet-agent service install`, Linux | the user journal: `journalctl --user -u fleet-agent` |

`fleet-agent service logs` prints the last 200 lines of the fleet-agent
service's log on either system; add `--follow` to keep printing new lines.

The launchd job of `fleet-agent service install` writes both streams to
`agent.log`. The Agent starts that file again once it exceeds 10 MiB and keeps
the previous one as `agent.log.1`. Run `fleet-agent service install` again
after upgrading from 0.10.0 or earlier to add the log paths to an existing job.
The Homebrew log path takes effect after `brew upgrade fleet-agent` and
`brew services restart fleet-agent`. Homebrew does not rotate its log.

The logs name each Target that an idle cycle could not repair
(`could not repair ai-client/codex: …`). The Agent also reports these to the
Server, which shows them as `repair_failed` issues.

If an older Agent runs in a terminal, stop that process instead. An already
enrolled Node does not need enrollment again. Preserve its state directory.
If you used a custom `--state-dir`, migrate the service settings explicitly;
the Homebrew service uses the default state directory.

Earlier manual installations may leave `~/.local/bin/fleet-agent` or
`~/.cargo/bin/fleet-agent` ahead of Homebrew on PATH. Check `command -v fleet-agent`
and `fleet-agent --version`. Remove or rename only the old executable after
stopping it, or use the Homebrew binary explicitly during the transition:

```sh
"$(brew --prefix fleet-agent)/bin/fleet-agent" --version
"$(brew --prefix fleet-agent)/bin/fleet-agent" enroll --link
```

Use the enrollment command only for a new Node. The fleet-agent service runs
its own copy in the state directory, so it is not affected by which
`fleet-agent` comes first on PATH.

## Put user-installed commands on PATH

The examples below install prebuilt commands in `~/.local/bin` and commands
built by Cargo in `~/.cargo/bin`. Add both directories to PATH in Bash or Zsh:

```sh
if [ -f "$HOME/.cargo/env" ]; then
    . "$HOME/.cargo/env"
fi
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
```

Put the same lines in `~/.bashrc` for Bash or `~/.zshrc` for Zsh, then start a
new shell. The Cargo environment file exists when Rust was installed by
rustup; the guard keeps shell startup working when it is absent.

## Install a binary archive

Each release publishes separate archives on
[GitHub releases](https://github.com/jcarcaboso/fleet-manager/releases):
`fleet-<platform>.tar.gz` and `fleet-agent-<platform>.tar.gz` for
`linux-amd64`, `macos-arm64` and `macos-amd64`. Download an archive and its
adjacent `.sha256` file, then run the following commands in the download
directory. Replace `fleet` with `fleet-agent` when installing the agent
archive. On macOS, use `shasum -a 256 -c` instead of `sha256sum --check`.

```sh
sha256sum --check fleet-linux-amd64.tar.gz.sha256
work_dir=$(mktemp -d)
tar -xzf fleet-linux-amd64.tar.gz -C "$work_dir"
(
    cd "$work_dir"
    sha256sum --check SHA256SUMS
)
install -d "$HOME/.local/bin"
install -m 0755 "$work_dir/fleet" "$HOME/.local/bin/fleet"
rm -rf "$work_dir"
fleet --help
```

After installing the Agent, enroll it and run
`~/.local/bin/fleet-agent service install`, as in the
[Agent guide](../../deploy/agent/README.md).

To update a direct installation, verify a newer archive and run the same
`install` command; for the Agent, then run `fleet-agent service install` with
the new executable, unless the Server updates it. Replacing the executable does
not change shell environment variables or the agent state in
`~/.local/state/fleet-agent`, so Operator and Node credentials remain in place.
See the
[client update runbook](client-updates.md) for staged rollout and rollback
steps.

## Install with Cargo from a release tag

Install Rust 1.95.0, then replace `v0.12.1` below with an existing release tag.

```sh
cargo install --locked \
    --git https://github.com/jcarcaboso/fleet-manager \
    --tag v0.12.1 \
    fleet fleet-agent
fleet --version
fleet-agent --version
```

Cargo requires the package names because the Git repository contains several
packages. `--locked` uses the repository lockfile. The tag keeps every machine
on the same source revision.

To update, select a newer release tag (`vX.Y.Z` below) and force Cargo to
rebuild both commands:

```sh
cargo install --locked --force \
    --git https://github.com/jcarcaboso/fleet-manager \
    --tag vX.Y.Z \
    fleet fleet-agent
~/.cargo/bin/fleet-agent service install
```

Cargo replaces the installed executables under `~/.cargo/bin`. It does not
change Fleet credentials or Agent state; `service install` switches the Agent
service to the rebuilt executable. A Cargo build compiles in the release public
keys like the release archives, so an Agent from 0.12.1 on can also be updated
from the Server. `cargo update` updates dependencies in
a source checkout; it does not update commands installed by `cargo install`.

Publishing a GitHub tag does not publish these packages to crates.io. A future
crates.io release would need unique registered package names and a separate
`cargo publish` for each workspace package. It would also need a registry
version on the Agent's local `fleet-reconcile` dependency. Until that work is
done, `cargo install fleet-agent` without `--git` refers to crates.io and is not
a Fleet installation command.

## Configure and use the Operator CLI

Help is available without a Server URL or token:

```sh
fleet --help
fleet -h
fleet help
fleet nodes --help
fleet help nodes rename
```

Set the URL and token before an API command:

```sh
export FLEET_SERVER_URL=https://fleet.example.com
export FLEET_OPERATOR_TOKEN='replace-with-an-operator-token'
fleet nodes list
fleet nodes rename old-alias new-alias
```

`nodes rename` identifies the node by its current alias and assigns the second
argument as its new alias. It prints the node ID and new alias as JSON. HTTP 404
means no node has the current alias. HTTP 409 means the new alias is already in
use or the node is revoked. The rename command requires Server 0.2.0 or later.
After renaming a source-managed node, change its key in `fleet.yml`, commit the
change, and rescan the source. The old alias is then available for reuse.

Use `--ca-cert FILE` when the Server uses a private certificate authority. Plain
HTTP is accepted only for a loopback Server and requires `--allow-http`.

## Build the Linux archives

The build requires Docker with BuildKit support. From the repository root, run:

```sh
./scripts/build-cli.sh
```

The script builds locked dependencies from `clients/Cargo.lock`, runs the Rust
workspace tests, and writes both archives and their checksums under
`artifacts/`. It creates a temporary build context containing the client
workspace, the Agent's `build.rs` and release public keys, and the contract
fixtures used by its tests. A tagged build (`FLEET_RELEASE_VERSION` set) stops
when no public key is committed, because that Agent would refuse every
update. Server files and local
configuration are not sent to the builder.

## Build on macOS

Release automation builds native macOS archives. They are unsigned and have not
yet passed installation and login-startup testing on physical Macs. Developers
can build native commands from source after installing Rust 1.95.0:

```sh
cd clients
cargo test --workspace --locked
cargo build --package fleet --package fleet-agent --release --locked
./target/release/fleet --help
./target/release/fleet-agent --help
```

The resulting executables match the Mac that built them. Signing and
notarization remain future release work.
