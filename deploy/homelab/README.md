# Fleet Manager on a homelab

This stack runs the amd64 Server and the separate dashboard with PostgreSQL,
database migrations, and direct HTTPS. Docker Compose v2, Python 3, and OpenSSL
are required for setup.

## Dashboard and enrollment links

The dashboard is a separate container, the `dashboard` service, with its own
HTTPS address: `https://FLEET_HOSTNAME:FLEET_DASHBOARD_PORT` (port 7444 by
default) next to the Server at `https://FLEET_HOSTNAME:FLEET_PORT`. Open it and
sign in with the Operator token from `operator.env`. Your browser must trust the
homelab CA; the dashboard serves the Server's certificate, so one trusted CA
covers both addresses and you must open both ports to your browser. Choose **Add
machine** to create a link for the Node's alias, then run `fleet-agent enroll
--link` on that Node and paste it. The link carries public CA trust, so the Node
needs no separate CA or JSON file. Enrollment links still point at the Server.

The browser, not the dashboard container, talks to the Server. The dashboard and
the Server must therefore be on the same site: both HTTPS, on the same host name
or registrable domain (ports and subdomains may differ). Setup uses one host
name for both, so this holds by default. A dashboard on another site cannot send
the session cookie and the dashboard says so at sign-in.

Compose supplies the Server's `Fleet__PublicUrl` from `FLEET_HOSTNAME` and
`FLEET_PORT`, and `Fleet__DashboardOrigin` (the one browser origin the Server
allows to call its dashboard API) from `FLEET_DASHBOARD_URL`, which defaults to
`https://FLEET_HOSTNAME:FLEET_DASHBOARD_PORT`. The dashboard container reads the
Server's origin from `FLEET_API_ORIGIN`, which Compose sets to the same value as
`Fleet__PublicUrl`. `FLEET_PUBLIC_URL` and `FLEET_DASHBOARD_URL` override these
origins, useful for IPv6 URLs; keep them aligned with DNS and the existing TLS
certificate. A request for `https://FLEET_HOSTNAME:FLEET_PORT/dashboard` (or `/`)
on the Server is redirected to the dashboard address, so old bookmarks keep
working once the dashboard port is reachable. If `Fleet__DashboardOrigin` is
empty the Server answers `404` with `dashboard_not_configured`.

See the [dashboard guide](../../docs/plans/enrollment-dashboard.md) for expiry,
revocation, session behavior, and custom CA settings, and the
[separate dashboard plan](../../docs/plans/separate-dashboard.md) for the CORS,
cookie and Origin rules.

## First start

Copy this directory to your homelab. From that directory:

```sh
export FLEET_HOSTNAME=fleet.home.arpa
python3 setup.py --bind-ip 0.0.0.0
docker compose pull
docker compose up -d --wait
```

Set `FLEET_HOSTNAME` to a DNS name or private IP your clients can reach. Configure
DNS separately if using a name. The setup script generates a certificate for it
and records it in `.env`. `--bind-ip` selects the host interface; it defaults to
loopback, while `0.0.0.0` exposes ports 7443 (Server) and 7444 (dashboard) on all
IPv4 interfaces. You can select a private interface instead, and change the
ports with `--port` and `--dashboard-port`. Setup records the dashboard address
in `.env` (`FLEET_DASHBOARD_URL`, `FLEET_DASHBOARD_PORT`) and in the Server's
`DashboardOrigin` setting. The Server and the dashboard both need to be reachable
from your browser, so open both ports in your firewall.

See [.env.example](.env.example) for all configurable Compose variables and their
defaults. Run setup first, then edit the generated `.env`. Setup refuses an
existing `.env`, so do not copy the example over before running it. CLI credentials
are generated separately in `operator.env`.

Setup creates a private CA, server certificate, database password, workspace ID,
and Operator bearer token. It refuses to overwrite an existing installation.
Keep `secrets/`, `operator.env`, and `.env` private and backed up. They are not
included in the image. Do not rerun setup to renew certificates or change DNS:
replace the server certificate with one signed by the existing CA and containing
the new hostname, update the client URL, then recreate the stack. Changing the
hostname environment variable alone cannot change an already issued certificate.
The initial server certificate expires after 90 days and the CA after 365 days;
certificate renewal is currently manual.

PostgreSQL data persists in a named volume and its port is not published. The
Server runs as UID 1654 with a read-only root filesystem. The dashboard container
runs the same way (UID 1654, read-only root, no capabilities, `no-new-privileges`)
and mounts the same runtime volume read-only for the certificate and key. It
serves static files only and joins neither the database network nor the Server's
network. An isolated setup
container copies configuration into a private volume with the correct ownership
for both rootful and rootless Docker. Its brief root execution does not grant the
Server root access. The Git mirror is an ephemeral cache rebuilt from the source.

## CLIProxyAPI key

Fleet can supply one Workspace CLIProxyAPI key to assigned Nodes without putting
it in Git or PostgreSQL. Set `FLEET_CLIPROXY_API_KEY` in the environment used to
start Compose:

```sh
sed -i 's|^FLEET_IMAGE=.*|FLEET_IMAGE=skorcius/fleet-manager:0.9.0|' .env
export FLEET_CLIPROXY_API_KEY='replace-with-a-dedicated-proxy-key'
docker compose up -d --wait
```

Compose maps the value to the Server's standard .NET setting
`Fleet__CliProxyApiKey`. Infisical or another secret manager can inject either
environment variable, depending on whether it launches Compose or the Server
container directly. You can also set `FLEET_CLIPROXY_API_KEY` in `.env`; protect
that file and keep it out of source control. Never put the key in `fleet.yml`.

Model catalogs refresh weekly independently of Git. Set
`FLEET_CLIPROXY_SYNC_INTERVAL_SECONDS` in `.env` to change the interval in seconds,
then recreate the Server. The dashboard's **Refresh models** action runs a refresh
immediately and shows the last result.

Read the [CLIProxyAPI operations guide](../../docs/technical-design/cliproxy-operations.md)
before publishing `fleet/v2` assignments. It covers the manifest, Agent-first
rollout, key rotation, rollback, and release checks.

## CLI

Extract `fleet-linux-amd64.tar.gz` on your Linux amd64 client and run `./fleet`
directly, or install it in your PATH. No Rust installation is needed.

On the homelab host, after extracting the binary:

```sh
. ./operator.env
./fleet --ca-cert ./secrets/tls/ca.pem nodes list
```

For a separate client machine, securely copy `operator.env` and the public
`secrets/tls/ca.pem` certificate there. Use their local paths in the command above.
The Operator token grants administrative access. Keep it private; never copy the
CA private key to clients. The CLI is the Operator tool. Install the separate `fleet-agent` binary on each
Node using the Agent deployment guide in the repository.

With Server and CLI version `0.2.0`, Operators can rename
a Node with `fleet nodes rename <current-alias> <new-alias>`. Update its key in
`fleet.yml`, commit, then run `fleet source rescan`.

When upgrading from `0.1.0`, remove each `id` field from `fleet.yml` and replace
the Node mapping key with its exact enrolled name. The Server rejects the old
manifest format. Keep your existing `secrets/`, `operator.env`, and database.

## Git source

Set `FLEET_SOURCE_REMOTE` in `.env` to an HTTPS or SSH repository URL. For a private
repository, place a read-only deploy key, `config`, and verified `known_hosts` in
`ssh/`. For example, `ssh/config` can contain:

```sshconfig
Host github.com
    User git
    IdentityFile /home/app/.ssh/id_ed25519
    IdentitiesOnly yes
    StrictHostKeyChecking yes
```

Use `chmod 700 ssh` and `chmod 600 ssh/*`. Obtain host keys through a trusted
channel and verify their fingerprints. The setup container installs these files
with permissions for the Server user. HTTPS URLs with embedded credentials are
rejected. After changing secrets, SSH configuration, or the source setting:

```sh
docker compose up -d --force-recreate --wait
```

## Operations

```sh
docker compose ps
docker compose logs --tail 100 server migrate dashboard
curl --cacert secrets/tls/ca.pem https://localhost:7443/health/ready
curl --cacert secrets/tls/ca.pem https://localhost:7444/healthz
```

Adjust the health URLs when changing the ports or binding to a specific interface.
The Server terminates HTTPS itself to validate Node client certificates. A proxy
in front must preserve TLS with TCP passthrough; ordinary HTTP termination does
not preserve this authentication.

The pinned POC image tag is `skorcius/fleet-manager:0.9.0`. To upgrade,
back up PostgreSQL and the private configuration, change `FLEET_IMAGE` in `.env`,
then run `docker compose pull` and `docker compose up -d --force-recreate --wait`.
Migrations run before the Server starts. Do not run `docker compose down -v` on
an installation whose database or configuration you want to retain.

### Upgrading to the separate dashboard

The dashboard used to be part of the Server image and open at
`https://SERVER/dashboard`. It is now its own image, container and address.
Upgrade the Server and the dashboard together; the dashboard needs a Server from
the same release, because the Server must allow its origin. To upgrade an
existing installation:

1. Back up PostgreSQL and the private configuration as described in the
   operations hardening guide.
2. Replace `compose.yaml` with this release's copy. Keep `.env`, `secrets/`,
   `operator.env`, `ssh/` and the Docker volumes, and do not rerun `setup.py`.
3. Set `FLEET_IMAGE` in `.env` to the new Server image. The dashboard image
   defaults to the release's `skorcius/fleet-manager-dashboard` tag; set
   `FLEET_DASHBOARD_IMAGE` only to pin another one. Add `FLEET_DASHBOARD_PORT` if
   7444 is taken (optionally `FLEET_DASHBOARD_URL` for a different address). An
   existing `secrets/server.json` needs no change: Compose passes
   `Fleet__DashboardOrigin` to the Server.
4. Open the dashboard port (7444 by default) on the same interface and firewall
   as the Server port. Keep the dashboard on the same site as the Server.
5. Run `docker compose pull` and `docker compose up -d --force-recreate --wait`.
   The `dashboard` service starts after the Server is healthy.
6. Open `https://FLEET_HOSTNAME:7444` and sign in. Old `https://SERVER/dashboard`
   bookmarks are redirected there. Scripts that call `/operator/v1`, enrollment
   links and the Agent are not affected.

If the dashboard shows that the Server could not be reached, check that
`FLEET_API_ORIGIN` (see `docker compose config`) is the Server's public origin
and that the browser trusts the CA. If it shows that the browser did not send the
session cookie, the two addresses are not on the same site.

When upgrading from `0.2.0`, first replace `compose.yaml` with this release's
copy so it supplies the Server's public URL. Preserve `.env`, `secrets/`,
`operator.env`, `ssh/`, and Docker volumes. Set `FLEET_IMAGE` to
`skorcius/fleet-manager:0.9.0` in `.env`. Do not rerun `setup.py` on an existing
installation. The dashboard uses the existing Operator token and CA.

Image publication is manual; the GitHub tag workflow only publishes
client archives and Homebrew formulas. A release has two images with one
version: `skorcius/fleet-manager` (Server) and
`skorcius/fleet-manager-dashboard`. From a clean checkout of the tested
release commit, build the versioned images:

```sh
VERSION=0.10.0
SHA=$(git rev-parse HEAD)
docker build --platform linux/amd64 \
  --label "org.opencontainers.image.revision=$SHA" \
  -t "skorcius/fleet-manager:$VERSION" .
docker build --platform linux/amd64 -f dashboard/Dockerfile \
  --label "org.opencontainers.image.revision=$SHA" \
  -t "skorcius/fleet-manager-dashboard:$VERSION" .
```

Smoke-test those local images together with a disposable Compose project, then
publish and verify them before pushing the matching annotated Git tag:

```sh
docker push "skorcius/fleet-manager:$VERSION"
docker push "skorcius/fleet-manager-dashboard:$VERSION"
docker buildx imagetools inspect "skorcius/fleet-manager:$VERSION"
docker buildx imagetools inspect "skorcius/fleet-manager-dashboard:$VERSION"
git tag -a "v$VERSION" "$SHA" -m "Fleet Manager $VERSION"
git push origin "refs/tags/v$VERSION"
```

Do not overwrite existing version images or move release tags. See the
[release procedure](../../docs/technical-design/client-updates.md#release-procedure)
and [Fleet release skill](../../.agents/skills/fleet-release/SKILL.md) for image
smoke tests, publication checks, and safe retry rules. These commands publish
artifacts; they do not upgrade an existing installation.

See the repository's operations hardening guide for backup and restore details.
