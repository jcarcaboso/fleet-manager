# Fleet Manager on a homelab

This stack runs the amd64 Server with PostgreSQL, database migrations, and direct
HTTPS. Docker Compose v2, Python 3, and OpenSSL are required for setup.

## Dashboard and enrollment links

After upgrading to Server `0.3.0`, open
`https://FLEET_HOSTNAME:FLEET_PORT/dashboard` and sign in with the Operator token
from `operator.env`. Your browser must trust the homelab CA. Create a link for
the Node's alias, then run `fleet-agent enroll --link` on that Node and paste it.
The link carries public CA trust, so the Node needs no separate CA or JSON file.

Compose supplies `Fleet__PublicUrl` from `FLEET_HOSTNAME` and `FLEET_PORT`.
`FLEET_PUBLIC_URL` overrides that origin, useful for an IPv6 URL. Keep it aligned
with DNS and the existing TLS certificate. Upgrading from `0.2.0` requires the
new Compose file, image, and database migration. Keep your existing secrets.
See the [dashboard guide](../../docs/plans/enrollment-dashboard.md) for expiry,
revocation, session behavior, and custom CA settings.

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
loopback, while `0.0.0.0` exposes port 7443 on all IPv4 interfaces. You can select
a private interface instead, and change the port with `--port`.

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
Server runs as UID 1654 with a read-only root filesystem. An isolated setup
container copies configuration into a private volume with the correct ownership
for both rootful and rootless Docker. Its brief root execution does not grant the
Server root access. The Git mirror is an ephemeral cache rebuilt from the source.

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
docker compose logs --tail 100 server migrate
curl --cacert secrets/tls/ca.pem https://localhost:7443/health/ready
```

Adjust the health URL when changing the port or binding to a specific interface.
The Server terminates HTTPS itself to validate Node client certificates. A proxy
in front must preserve TLS with TCP passthrough; ordinary HTTP termination does
not preserve this authentication.

The pinned POC image tag is `skorcius/fleet-manager:0.5.1`. To upgrade,
back up PostgreSQL and the private configuration, change `FLEET_IMAGE` in `.env`,
then run `docker compose pull` and `docker compose up -d --force-recreate --wait`.
Migrations run before the Server starts. Do not run `docker compose down -v` on
an installation whose database or configuration you want to retain.

When upgrading from `0.2.0`, first replace `compose.yaml` with this release's
copy so it supplies the dashboard's public URL. Preserve `.env`, `secrets/`,
`operator.env`, `ssh/`, and Docker volumes. Set `FLEET_IMAGE` to
`skorcius/fleet-manager:0.5.1` in `.env`. Do not rerun `setup.py` on an existing
installation. The dashboard uses the existing Operator token and CA.

From the source repository, build and publish a new server tag with:

```sh
docker build --platform linux/amd64 -t skorcius/fleet-manager:YOUR_TAG .
docker push skorcius/fleet-manager:YOUR_TAG
```

See the repository's operations hardening guide for backup and restore details.
