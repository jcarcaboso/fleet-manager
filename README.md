# Fleet Manager

Fleet Manager distributes reviewable Skill directories from Git to user-owned
macOS and Linux machines. Operators declare assignments in `fleet.yml`. Each
Node runs an Agent that polls the Server over mutual TLS and reconciles its own
filesystem. Nodes need no inbound listener, SSH access, Git checkout, or source
repository credentials.

Fleet Manager contains three parts:

- The .NET Server scans the canonical Git source, validates desired state,
  publishes immutable assignments, serves the Operator dashboard and API, and
  coordinates Node enrollment and polling through PostgreSQL.
- `fleet` is the Operator CLI. It creates enrollment authorizations, lists and
  renames Nodes, revokes credentials, rescans the source, and reads rollout
  status and diagnostics.
- `fleet-agent` enrolls one Node, installs its assigned Skills, repairs managed
  files from verified cached bundles, and reports results. Its private key and
  state stay on the Node.

The Server trusts configured Operator bearer tokens. Enrolled Agents use their
own P-256 keys and client certificates. A local network or private overlay
supplies reachability; it does not replace HTTPS or Fleet authentication. See
the [architecture overview](docs/architecture/overview.md) and
[threat model](docs/technical-design/threat-model.md) for the boundaries.

## Run the Server and dashboard

The homelab deployment runs the Server, dashboard, PostgreSQL, and database
migrations with Docker Compose. The dashboard is part of the Server image, so
it does not need a separate container. Follow the
[homelab setup](deploy/homelab/README.md) for a first installation.

The amd64 Server image is `skorcius/fleet-manager:0.4.1`.
For an existing installation, back up PostgreSQL and private configuration,
replace `compose.yaml` with the current release copy, and preserve `.env`, `secrets/`,
`operator.env`, `ssh/`, and Docker volumes. Set the image in `.env`, then run:

```sh
docker compose pull
docker compose up -d --force-recreate --wait
```

The migration container updates the database before the Server starts. Do not
rerun setup or remove volumes during an upgrade. Compose derives the dashboard
origin from `FLEET_HOSTNAME` and `FLEET_PORT`; set `FLEET_PUBLIC_URL` when the
public HTTPS origin differs. The browser must trust the Server CA.

Open `https://YOUR_SERVER/dashboard` and sign in with an Operator token. The
dashboard lists Nodes, changes aliases, creates enrollment links, and revokes
those links. Each link is bound to its chosen alias, includes the public CA, and
expires after 15 minutes by default, with a maximum lifetime of one hour. It can be revoked
before use. Treat it as a secret until it expires or enrollment succeeds. The
[dashboard enrollment guide](docs/plans/enrollment-dashboard.md) explains its
trust checks and session behavior.

The dashboard's Node actions distinguish revocation from removal. **Revoke**
blocks all of the Node's certificates and keeps its record visible. **Remove**
asks for its exact alias, then permanently deletes the server record,
credentials, assignments, attempts, and enrollment delivery data. The alias
becomes available again. Audit history and shared release data remain.
Neither action deletes files on the machine. Stop its Agent and remove the
`fleet.yml` entry unless you intend to enroll a replacement for that alias.
These Node actions are available in Server `0.4.0`.

## Install the clients with Homebrew

This repository is also the Homebrew tap. The v0.3 release automation publishes
formulas only after all Linux and native macOS archives exist and both formulas
pass Apple silicon and Intel Homebrew tests.

```sh
brew tap jcarcaboso/fleet https://github.com/jcarcaboso/fleet-manager
brew install jcarcaboso/fleet/fleet
brew install jcarcaboso/fleet/fleet-agent
fleet --version
fleet-agent --version
```

The formulas install prebuilt clients for Linux amd64 and macOS 13 or newer on
Apple silicon or Intel. Homebrew verifies the selected archive checksum. The
[CLI installation guide](docs/technical-design/cli-installation.md) also covers
direct archives and Cargo builds from a release tag.

To enroll a Node, create a link for its alias in the dashboard, then run:

```sh
agent_bin="$(brew --prefix jcarcaboso/fleet/fleet-agent)/bin/fleet-agent"
"$agent_bin" enroll --link
brew services start jcarcaboso/fleet/fleet-agent
```

Paste the link at the prompt. The Agent generates its private key locally and
stores state under `~/.local/state/fleet-agent` by default. Homebrew services use
the stable `opt` path across upgrades. Do not run this service alongside one
created by `fleet-agent service install`. To migrate an existing service, stop
it, run `fleet-agent service uninstall`, then start the Homebrew service.

An already enrolled Node does not need another enrollment. If the old Agent
runs in a terminal, stop that process instead. A custom `--state-dir` requires
corresponding service configuration; Homebrew defaults to the usual state path.

An older direct installation may still take precedence because earlier guides
put `~/.local/bin` first on `PATH`. Check before enrolling or upgrading:

```sh
command -v fleet-agent
fleet-agent --version
"$(brew --prefix jcarcaboso/fleet/fleet-agent)/bin/fleet-agent" --version
```

After stopping the old process and uninstalling its service definition, rename
or remove only the old `~/.local/bin/fleet-agent` executable. Keep
`~/.local/state/fleet-agent`; it contains the Node identity, credentials, and
reconciliation state.

On macOS the user service starts at login. Linux uses `systemd --user`; an
administrator must enable lingering if the Agent needs to start during boot
before that user logs in:

```sh
sudo loginctl enable-linger "$USER"
```

Install and run the Agent as the user whose home contains the managed Skills.
The [Agent guide](deploy/agent/README.md) covers enrollment without the dashboard,
custom state paths, foreground operation, service commands, and recovery limits.

## Publish Skills from Git

After pushing your Skill changes, click **Sync repository** in the dashboard to
fetch and validate the latest commit and publish changed assignments. The same
operation is already available in the Operator CLI:

```sh
fleet source rescan
```

Configure `FLEET_SERVER_URL` and `FLEET_OPERATOR_TOKEN` for the CLI, plus
`--ca-cert /path/to/ca.pem` when using a private CA. Running Agents fetch the
published assignments on their next poll, normally within 60 seconds. Offline
Nodes catch up after reconnecting. The sync result confirms server publication,
not that every Agent has finished applying it. Invalid source changes leave the
current assignments active.

The Server reads the `main` branch of one canonical repository. It discovers
Skill groups from `skills/<group>/<skill>/`; `fleet.yml` maps stable Node
aliases to optional group selections and target paths. Skill content stays
reviewable in Git; credentials and mutable Node metadata do not belong there.
The [desired-state design](docs/architecture/desired-state.md) defines the
manifest and repository layout.

Put Skills under `skills/<group>/<skill>/`. Fleet discovers both levels from
the directories, so `fleet.yml` has no top-level group catalog. For each Node,
omit `targets.skills.groups` or set it to `[]` to sync every discovered group.
A nonempty array selects those groups and defines their duplicate-Skill
precedence. A source revision must contain both `skills/` and `agents/`. Since
Git does not track empty directories, each root must contain at least one valid
Skill or agent instruction source.

Repositories using the earlier layout must move `groups/<group>/<skill>/` to
`skills/<group>/<skill>/` and remove the top-level `groups` field from
`fleet.yml` in the same commit. The Server rejects the legacy layout to prevent
an accidental empty rollout.

Put each named agent instruction source in `agents/<source>/AGENTS.md`, then map
sources to AI clients under a Node's `targets.agents`. Fleet discovers source
directories directly, so `fleet.yml` has no separate source catalog. Omit
`clients` to select every supported client:

```yaml
nodes:
  node-1:
    targets:
      skills:
        groups: []
      agents:
        - source: personal
          clients:
            - codex
            - opencode
```

The Server writes the selected content to `.codex/AGENTS.md`,
`.config/opencode/AGENTS.md`, or `.claude/CLAUDE.md` relative to the Node user's
home. Omit `targets.agents` to leave agent files unmanaged. Use `agents: []` to
remove files already owned by Fleet.

Upgrade `fleet-agent` on managed Nodes before committing instruction sources;
older Agents do not understand Managed-file Assignments.

For a private source, use SSH with a dedicated read-only deploy key, a verified
`known_hosts`, and an explicit SSH configuration under the homelab deployment's
`ssh/` directory. Fleet rejects credentials embedded in HTTPS URLs. See the
[homelab Git source instructions](deploy/homelab/README.md#git-source) and
[source hardening notes](docs/technical-design/source-hardening.md).

An alias is the exact, case-sensitive Node name used by `fleet.yml`. Rename one
through the dashboard, from its Agent, or with the Operator CLI:

```sh
fleet nodes rename old-alias new-alias
```

Then change the key in `fleet.yml`, commit it, and run `fleet source rescan`.
The Node keeps its internal identity and credentials.

## Roll out updates

Preserve the Agent state directory across upgrades. Update one Node first,
confirm the new version and successful contact and sync in the dashboard, then
continue in stages:

```sh
brew services stop jcarcaboso/fleet/fleet-agent
brew update
brew upgrade jcarcaboso/fleet/fleet-agent
brew services start jcarcaboso/fleet/fleet-agent
```

Agent self-update is not implemented. Keep the previous executable available
for rollback and read the [client update runbook](docs/technical-design/client-updates.md)
before a larger rollout. The macOS binaries are not signed or notarized, and
login-startup behavior still needs validation on the target Macs.

## Develop and inspect the design

Run `make restore`, `make format`, `make check`, and `make test` for the shared
development checks. PostgreSQL integration tests require Docker. Start local
Server work with the [HTTPS development setup](docs/technical-design/server-development.md).

The main design references are:

- [Domain language](CONTEXT.md)
- [Architecture overview](docs/architecture/overview.md)
- [Desired state](docs/architecture/desired-state.md)
- [Agent reconciliation](docs/architecture/agent-reconciliation.md)
- [Implementation status](docs/implementation-status.md)
- [Operations hardening](docs/technical-design/operations-hardening.md)
- [Engineering standards](docs/engineering-standards.md)
- [Server 0.4.1 release notes](docs/releases/0.4.1.md)
- [Fleet Manager 0.4.0 release notes](docs/releases/0.4.0.md)
- [Fleet Manager 0.3.0 release notes](docs/releases/0.3.0.md)

The [original handoff](successor-poc-handoff.md) remains as historical input.
Later architecture and technical design documents take precedence. Fleet
Manager is licensed under the [MIT license](LICENSE). Full Agent recovery
reporting, measured release performance budgets, signing and notarization,
automated certificate recovery, and final public release policies remain open.
