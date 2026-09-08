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
brew tap jcarcaboso/fleet-manager https://github.com/jcarcaboso/fleet-manager
brew install fleet
brew install fleet-agent
fleet --version
fleet-agent --version
```

Homebrew uses the prebuilt release for the current operating system and CPU.
The formulas support Linux amd64 plus macOS 13 or newer on Apple silicon and
Intel. They do not build Rust source or install credentials.

Enroll the Agent before starting its Homebrew service. Homebrew generates the
launchd or systemd definition with the stable `opt` path, so upgrades keep the
same service command:

```sh
fleet-agent enroll --help
brew services start fleet-agent
brew services info fleet-agent
```

Agent state remains under `~/.local/state/fleet-agent` unless `--state-dir`
selects another absolute path. Do not run the Homebrew service and the service
installed by `fleet-agent service install` at the same time. To migrate an
existing Agent after stopping it, run `fleet-agent service uninstall` and then
`brew services start fleet-agent`.

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

The prepared release workflow publishes separate archives on
[GitHub releases](https://github.com/jcarcaboso/fleet-manager/releases), such as `fleet-linux-amd64.tar.gz` and
`fleet-agent-linux-amd64.tar.gz`. Download an archive and its adjacent
`.sha256` file, then run the following commands in the download directory.
Replace `fleet` with `fleet-agent` when installing the agent archive.

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

To update a direct installation, verify a newer archive and run the same
`install` command. Replacing the executable does not change shell environment
variables or the agent state in `~/.local/state/fleet-agent`, so Operator and
Node credentials remain in place. See the
[client update runbook](client-updates.md) for staged rollout and rollback
steps.

## Install with Cargo from a release tag

Install Rust 1.95.0, then replace `v0.3.0` below with an existing release tag.

```sh
cargo install --locked \
    --git https://github.com/jcarcaboso/fleet-manager \
    --tag v0.3.0 \
    fleet fleet-agent
fleet --version
fleet-agent --version
```

Cargo requires the package names because the Git repository contains several
packages. `--locked` uses the repository lockfile. The tag keeps every machine
on the same source revision.

To update, select a newer release tag and force Cargo to rebuild both commands:

```sh
cargo install --locked --force \
    --git https://github.com/jcarcaboso/fleet-manager \
    --tag v0.4.0 \
    fleet fleet-agent
```

Cargo replaces the installed executables under `~/.cargo/bin`. It does not
change Fleet credentials or Agent state. `cargo update` updates dependencies in
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
workspace and the contract fixtures used by its tests. Server files and local
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
