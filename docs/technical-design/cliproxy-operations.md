# CLIProxyAPI operations

Fleet can configure Codex and OpenCode to use one Workspace CLIProxyAPI
endpoint. The source repository selects the endpoint and model. The API key
stays outside Git and reaches assigned Nodes through their existing mTLS
connection to the Server.

## Server setup

Create a regular file containing only the CLIProxyAPI bearer key. A trailing
newline is allowed. Keep the file outside the repository, make it readable only
by its owner, and set its absolute path in the homelab environment:

```sh
install -m 0600 /path/from/your/secret/store ./secrets/cliproxy-api-key
sed -i 's|^FLEET_IMAGE=.*|FLEET_IMAGE=skorcius/fleet-manager:0.6.0|' .env
printf '\nFLEET_CLIPROXY_API_KEY_FILE=%s\n' "$PWD/secrets/cliproxy-api-key" >> .env
docker compose -f compose.yaml -f compose.cliproxy.yaml up -d --wait
```

Use the released 0.6.0 image or an immutable tag built from this change. The
older image in an existing `.env` does not implement the key endpoint or
`fleet/v2`.

The optional Compose file mounts the source file read-only into a networkless
one-shot container. That container copies it to the existing private runtime
volume with an atomic rename, changes ownership to the Server user, and applies
mode `0600`. The Server reads the copied file from
`/run/fleet/cliproxy-api-key`. It rejects an empty file, a file larger than 4
KiB, a link, a directory, non-printable bytes, or group and other permissions.

The materialization method is deployment-specific. A password manager, Docker
or Kubernetes secret controller, systemd credential, configuration manager, or
manual installation can produce the owner-only source file. For example,
Infisical can write the secret to that path before Compose starts. Fleet does
not require Infisical and does not call a secret manager API.

Use `fleet/v2` only after compatible Agents are running on every selected Node.
Copy [the CLIProxyAPI manifest example](../../examples/source/fleet-cliproxy.yml)
to `fleet.yml`, then replace its hostname, Node alias, and model. The endpoint
must use HTTPS and end at `/v1`. Each selected model must appear in the
endpoint's authenticated `/v1/models` response.

The first proxy reconciliation fails if the Node cannot retrieve the key or a
valid non-empty model list. A later model-fetch failure keeps the last valid
catalog. Codex and OpenCode read the Node-local key file at request time. Fleet
does not read or change either client's OAuth store.

## Rotate the key

CLIProxyAPI should accept the old and new keys during rotation. This avoids an
inference outage while Nodes wait for their next Fleet poll.

1. Add the new key to CLIProxyAPI while the old key remains valid.
2. Materialize the new value at `FLEET_CLIPROXY_API_KEY_FILE` with an atomic
   file replacement and mode `0600`.
3. Re-run the one-shot copy and restart the Server:

   ```sh
   docker compose -f compose.yaml -f compose.cliproxy.yaml up --no-deps --force-recreate cliproxy-configure
   docker compose -f compose.yaml -f compose.cliproxy.yaml restart server
   ```

4. Wait at least one Agent poll interval. Confirm that every proxy-assigned Node
   reports successful reconciliation and can make a client request.
5. Remove the old key from CLIProxyAPI.

No `fleet.yml` change is needed. Do not remove the old proxy key before all
Nodes have refreshed. An offline Node keeps its previous owner-only key and
model cache until it reconnects.

To disable proxy use on a Node, publish `mode: native` for each managed client.
The Agent restores the original Fleet-owned configuration fields and leaves
OAuth credentials untouched. After all proxy Assignments are gone, remove the
Server key configuration. Stop the Server, remove only
`/runtime/cliproxy-api-key` from the `runtime-config` volume through a one-shot
container, then restart without the optional Compose file:

```sh
docker compose stop server
docker compose run --rm --no-deps --entrypoint /bin/sh configure \
  -ec 'test ! -e /runtime/cliproxy-api-key || unlink /runtime/cliproxy-api-key'
docker compose up -d --wait
```

Removing the source file alone does not erase the private runtime copy.

## Failure and recovery checks

- A revoked Node cannot poll or retrieve the shared proxy key. Revoke the proxy
  key too if that Node may have copied it while authorized.
- A malformed, empty, oversized, redirected, or unavailable model response
  cannot replace a valid cached catalog. Initial setup still fails closed.
- Fleet refuses unexpected changes to fields it owns. Resolve that ownership
  conflict explicitly instead of deleting its receipt.
- Journals complete a configuration write interrupted between the client file
  and receipt update. Links, hard-linked state, and special files fail closed.
- A compromised Server OS, assigned Node account, or proxy key can expose the
  shared key. Use a dedicated key with only the proxy permissions Fleet Nodes
  need.

The opt-in [container compatibility check](../../scripts/check-cliproxy-clients.sh)
runs pinned Codex and OpenCode clients against an endpoint without copying the
key into either generated config. Run it after proxy upgrades and before a Fleet
release. It makes real model requests and may incur provider cost.

## Release checklist

- Roll out the compatible Agent before publishing any `ai-clients` entry.
- Exercise `unmanaged -> cliproxy -> native -> cliproxy` for both clients on a
  clean home and a home with unrelated TOML or JSONC settings.
- Exercise key overlap and rotation, proxy outage, malformed model data,
  concurrent edits, interrupted writes, and Node revocation.
- Search the source tree, generated Assignments, Bundles, PostgreSQL dump,
  diagnostics, and logs for a unique test-key marker. It must be absent.
- Confirm that native restoration leaves Codex `auth.json` and OpenCode's
  credential store byte-for-byte unchanged.
- Back up the deployment's private configuration according to local policy and
  test PostgreSQL restore separately. Do not treat the database dump as a
  backup of the proxy key.
