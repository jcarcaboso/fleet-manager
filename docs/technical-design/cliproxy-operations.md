# CLIProxyAPI operations

Fleet can configure Codex and OpenCode to use one Workspace CLIProxyAPI
endpoint. The source repository selects the endpoint and model. The API key
stays outside Git and reaches assigned Nodes through their existing mTLS
connection to the Server.

## Server setup

The Server reads the key from the standard .NET configuration setting
`Fleet:CliProxyApiKey`. The homelab Compose file maps
`FLEET_CLIPROXY_API_KEY` from its host environment to
`Fleet__CliProxyApiKey` in the container:

```sh
sed -i 's|^FLEET_IMAGE=.*|FLEET_IMAGE=skorcius/fleet-manager:0.6.1|' .env
export FLEET_CLIPROXY_API_KEY='replace-with-a-dedicated-proxy-key'
docker compose up -d --wait
```

Use the released 0.6.1 image or an immutable tag built from this change. The
older image in an existing `.env` does not implement the key endpoint or
`fleet/v2`.

This is ordinary .NET configuration. A deployment outside the homelab Compose
stack can supply `Fleet__CliProxyApiKey` directly through an environment
variable or another configuration provider. Infisical and other secret managers
can inject either variable. Fleet does not require or call a particular secret
manager API.

Compose also reads variables from `.env`, so storing the key there works. Keep
that file private and out of source control. Container environment variables
are visible to users with access to Docker metadata, so restrict Docker access
and use a dedicated proxy key.

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
2. Update `FLEET_CLIPROXY_API_KEY` in the environment that starts Compose, or
   update `Fleet__CliProxyApiKey` in the Server's configuration source.
3. Recreate the Server so it reads the new setting:

   ```sh
   docker compose up -d --no-deps --force-recreate server
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
key from its actual source. That might be the launching shell, `.env`, or a
secret manager. Then recreate the Server:

```sh
docker compose up -d --no-deps --force-recreate server
```

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
  test PostgreSQL restore separately. A database dump does not contain the
  proxy key.
