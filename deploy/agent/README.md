# Run the Fleet Node Agent

`fleet-agent` installs the Skills assigned to this machine. It works with Server
`0.2.0`. The `fleet` command is the separate Operator tool used to authorize
Node enrollment and manage the Server.

## Linux amd64 installation

Download `fleet-agent-linux-amd64.tar.gz` and its adjacent `.sha256` file.
Run these commands as the user whose home will contain the Skills:

```sh
sha256sum --check fleet-agent-linux-amd64.tar.gz.sha256
tar -xzf fleet-agent-linux-amd64.tar.gz
sha256sum --check SHA256SUMS
mkdir -p ~/.local/bin
install -m 0755 fleet-agent ~/.local/bin/fleet-agent
~/.local/bin/fleet-agent --help
```

The Linux archive is a static binary. Rust and OpenSSL executables are not
required on the Node. Keep the Agent binary outside managed Skill directories.

## Enroll the machine

The upgraded Server's dashboard can generate a short-lived enrollment link.
This needs a Server build newer than the deployed `0.2.0` image. See the
[dashboard guide](../../docs/plans/enrollment-dashboard.md). On the Node, run:

```sh
~/.local/bin/fleet-agent enroll --link
```

Paste the link at the prompt. The link includes the Node alias, one-time token,
Server address, and public CA certificate. The Agent checks the link's HTTPS
origin and expiry before connecting. Treat the link as a secret until it expires
or enrollment succeeds.

For enrollment without the dashboard, create a short-lived token using the
Operator CLI. For a homelab
setup, `operator.env` and the public CA certificate come from Server setup:

```sh
umask 077
. ./operator.env
fleet --ca-cert ./ca.pem enrollment create > enrollment.json
```

Securely transfer `enrollment.json` and the public `ca.pem` to the Node. Keep the
Operator token on the Operator machine. The Node needs only the one-time token:

```sh
~/.local/bin/fleet-agent enroll \
  --server-url https://fleet.home.arpa:7443 \
  --ca-cert ./ca.pem \
  --alias homelab-mini \
  --token-file ./enrollment.json
rm ./enrollment.json
~/.local/bin/fleet-agent status
```

Use your deployed Server's actual hostname and port. The alias must be unique in
its Workspace and must match the key under `nodes` in the Skills repository's
`fleet.yml`. Enrollment prints the internal Node ID for troubleshooting. The
Agent generates a P-256 private key on the Node; it never sends that key to the
Server. If an enrollment response is lost, retry the same command and token
promptly. The Agent reuses its saved key and certificate request.

The default private state directory is `~/.local/state/fleet-agent`. Use global
`--state-dir /absolute/path` to choose another directory and supply the same
option for every command. `enroll --home /absolute/path` sets a different
installation home, useful for isolated tests. Existing state cannot silently
change its Server, trust certificate, or installation home.

## Publish and verify Skills

Configure this Node's alias in the source repository:

```yaml
schema: fleet/v1
targets:
  skills:
    base: home
    path: .agents/skills
nodes:
  homelab-mini:
    targets:
      skills:
        groups: [definitive]
```

Fleet discovers groups below `skills/`. Omit `groups` or use `groups: []` to
sync every discovered group; a nonempty array selects a subset in precedence
order.

Commit to the source repository's `main` branch. Request an immediate scan with
`fleet source rescan` on the Operator machine, or wait for the Server's source
poll. On the Node, test one Agent cycle:

```sh
~/.local/bin/fleet-agent run --once
```

The Agent downloads and verifies assigned Bundles, installs their nested Skill
trees, and reports completion. Existing unrelated Skill directories remain
untouched. A pre-existing directory with an assigned Skill's name causes an
ownership conflict. Move your own directory elsewhere before publishing a new
Assignment. The Agent never executes installed Skill scripts.

The private state contains ownership receipts, the last Assignment, a Bundle
cache, and unacknowledged reports. Preserve it across restarts and upgrades.
Deleting it does not safely uninstall Skills: without a receipt, the Agent
refuses to take ownership of existing directories.

## Run continuously

For a foreground process:

```sh
~/.local/bin/fleet-agent run
```

Install and start a background service for the current user:

```sh
~/.local/bin/fleet-agent service install
~/.local/bin/fleet-agent service start
```

The install command records the absolute executable and state-directory paths.
Run it again after moving the binary. The `status`, `stop`, `restart`, and
`uninstall` service commands handle the rest of the lifecycle. Uninstall removes
the service definition but keeps credentials and other agent state.

Linux uses a `systemd --user` unit. Distributions without a systemd user manager
are not supported. For startup during boot before login, an administrator must
enable lingering explicitly:

```sh
sudo loginctl enable-linger "$USER"
journalctl --user -u fleet-agent.service -f
```

macOS uses a LaunchAgent in `~/Library/LaunchAgents`, which starts when that user
logs in. The Agent does not install a system LaunchDaemon or elevate privileges.

The run loop follows the Server's polling delay, bounded to 5 to 3,600 seconds, and
retries transient failures after 30 seconds. It renews certificates with less
than one day remaining. If the Node stays offline past certificate expiration,
an Operator must arrange fresh enrollment with a free alias; automatic recovery
of an expired identity is not supported by Server 0.2.0.

## Change the Node alias

Using the Node's own certificate:

```sh
~/.local/bin/fleet-agent alias homelab-mini-new
```

Or use `fleet nodes rename homelab-mini homelab-mini-new` as an Operator. Then
update the YAML key, commit, and rescan the source. Operator renames do not update
the Agent's locally cached display alias; its UUID and credentials remain valid.

## Recovery and current limits

On restart the Agent recovers an interrupted filesystem transaction before
polling. It saves terminal reports before sending them and retries lost reports.
It also verifies the last successful installation on later cycles, repairing
local drift from its cached Bundles. A corrupt receipt, unsafe path, symlink, or
unowned conflict causes a safe failure rather than deleting unknown files.

Server 0.2.0 does not offer the full observed-state/recovery protocol. It stops
sending terminal Assignments. Local drift repair therefore preserves the last
successful server status; it cannot publish a separate drift condition. A failed
Attempt needs a changed source publication to receive new work. Moving an active
Target, restoring an expired Node identity, and deleting the Agent's state as an
uninstall mechanism are not supported.

Filesystem containment assumes other processes running as the same user are not
actively racing the Agent to replace directories. Observed links and special
files are rejected. Stop the service before editing or moving Agent state.

## Build from source

From the repository root, `./scripts/build-cli.sh` builds both static Linux amd64
archives and runs the Rust tests. For a native build on Linux or macOS:

```sh
cargo build --manifest-path clients/Cargo.toml --package fleet-agent --release --locked
```

macOS service installation and a macOS release binary are not included in the
Linux package. Native macOS installation and login-startup validation remain
pending; see the [client update design](../../docs/technical-design/client-updates.md).
