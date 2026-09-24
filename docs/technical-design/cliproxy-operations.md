# CLIProxyAPI operations

Fleet can configure Codex and OpenCode to use one Workspace CLIProxyAPI
endpoint. The source repository selects the endpoint and which Nodes receive
its model catalog. A default model is optional. The API key
stays outside Git and reaches assigned Nodes through their existing mTLS
connection to the Server.

## Server setup

The Server reads the key from the standard .NET configuration setting
`Fleet:CliProxyApiKey`. The homelab Compose file maps
`FLEET_CLIPROXY_API_KEY` from its host environment to
`Fleet__CliProxyApiKey` in the container:

```sh
sed -i 's|^FLEET_IMAGE=.*|FLEET_IMAGE=skorcius/fleet-manager:0.6.6|' .env
export FLEET_CLIPROXY_API_KEY='replace-with-a-dedicated-proxy-key'
docker compose up -d --wait
```

Use Server and Agent version 0.6.2 or later for server-side catalog discovery.
Release 0.6.1 requires an explicit model and discovers models on each Node. Upgrade the
Server and all selected Agents before removing `model` from existing YAML.

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
to `fleet.yml`, then replace its hostname and Node alias. Set `mode: cliproxy`
for each client that should receive the catalog. No model or effort list is
needed. The endpoint must use HTTPS and end at `/v1`.

The Server fetches `/v1/models?client_version=0.154.0`, which requests CLIProxy's
Codex catalog with advertised reasoning efforts. A background service discovers
endpoints assigned to active Nodes within 30 seconds and refreshes each catalog
weekly, independently of repository polling and Agent requests. It only calls
CLIProxy when a key and at least one current proxy Assignment are configured.
The catalog is cached in memory; a Server restart triggers fresh discovery.
Assigned Nodes retrieve the cached catalog from
`GET /agent/v1/cliproxy/models` over mTLS during their normal reconciliation.
Catalog changes do not require a YAML commit. The response includes the endpoint
so an Agent cannot apply a catalog from a different Assignment.

Set `Fleet__CliProxySyncIntervalSeconds` to change the refresh interval, in
seconds. The default is `604800`, or seven days; the accepted range is 10 seconds
to 30 days. In the homelab Compose deployment, set
`FLEET_CLIPROXY_SYNC_INTERVAL_SECONDS` in `.env` and recreate the Server.
This setting belongs to Server configuration, not `fleet.yml`.

The dashboard has a separate **Refresh models** action and displays model counts,
last successful refresh, next refresh, and failures. The **Model selection** panel
groups the current catalog by model family for each proxy endpoint. Operators can
turn off a family or individual models, then save the selection. Fleet persists the
selection on the Server and sends only selected models to assigned Agents on their
next poll. At least one model must remain selected; a model pinned as a client's
default in `fleet.yml` cannot be excluded while that Assignment is current.

Selections follow the live catalog rather than a fixed model list. A new model in
an existing family inherits that family's setting unless it has an individual
override. A newly discovered family follows the **Enable newly discovered families
by default** setting. Removed models no longer appear in the dashboard or Agent
catalog, but their saved override takes effect again if the same ID returns.
The selection is preserved across Server restarts and can be changed without a
repository commit. The dashboard reloads and asks for review if another operator
saved a selection first. If catalog churn leaves no selected model, the Agent
endpoint returns 503 so Nodes retain their last valid catalog until the
selection or upstream catalog is corrected.

Operators can also call
`GET /operator/v1/cliproxy/status` and `POST /operator/v1/cliproxy/refresh` with
Operator authentication. Dashboard refresh requires the normal session and CSRF
token. A manual refresh bypasses the scheduled deadline.

Failed upstream refreshes retain the previous catalog and retry after one
minute. Until initial discovery succeeds, the Agent model endpoint returns 503.
Agent polling never triggers an upstream fetch. With no repository changes,
Agents still reconcile active AI-client Assignments and update the CLI catalogs.
If initial client setup fails with `ai_client_reconcile_failed`, the Server
creates a new Attempt on a later poll after a one-minute backoff. The existing
Assignment and desired revision remain unchanged, and failed Attempts stay in
history. Pending work takes priority over retries. Fix persistent configuration
or ownership failures to stop repeated failed Attempts.

Codex receives effort choices in its catalog; OpenCode receives model variants.
Fleet updates an existing `~/.config/opencode/opencode.jsonc`, because OpenCode
loads it after `.json`. If no JSONC file exists, Fleet uses `opencode.json`.
Comments and unrelated settings are preserved. Adding a JSONC override after
Fleet has already taken ownership of a JSON config can cause an ownership
conflict; resolve the configuration change before retrying.
Older proxies that return only model identifiers still work, but Fleet does not
invent effort choices when the proxy omits them. The upstream response behavior
is defined by CLIProxy's [model handler](https://github.com/router-for-me/CLIProxyAPI/blob/main/sdk/api/handlers/openai/openai_handlers.go).

An optional `model` pins the client's default to an advertised identifier. When
omitted, Fleet keeps the locally selected proxy model if available, otherwise
selects the first advertised model. Users can change the selection without a
Fleet ownership conflict. Reasoning effort selection remains local to the client.

The first proxy reconciliation fails if the Node cannot retrieve the key or a
valid non-empty model list from the Server. A later model-fetch failure keeps
the last valid catalog for that endpoint on both the Server and Node. Codex and OpenCode read the Node-local key file at request time. Fleet
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

To disable proxy use on a Node, publish `mode: native` for each managed client,
or remove its `ai-clients` entry. A removed proxy-managed entry receives a
native restoration Assignment before Fleet stops managing its connection.
The Agent restores the original Fleet-owned configuration fields and leaves
OAuth credentials untouched. After all proxy Assignments are gone, remove the
key from its actual source. That might be the launching shell, `.env`, or a
secret manager. Then recreate the Server:

```sh
docker compose up -d --no-deps --force-recreate server
```

## Dashboard diagnostics

The dashboard's **Issues to resolve** section checks current assignments and
Server records. It identifies missing CLIProxy credentials only when active
Nodes require them, initial discovery still waiting, failed upstream refreshes,
missing or failed repository sync, stale Node check-ins, and failed current
Assignments. Each issue includes a recovery step and a link to the relevant
section. Revoked Nodes and historical assignment failures are excluded.

Use **Check again** after correcting configuration. Repository and model refresh
actions also recheck diagnostics. A failed diagnostics request leaves an explicit
warning rather than showing an all-clear result. The endpoint requires a signed-in
dashboard session and never returns secret values or raw error bodies. It cannot
inspect a remote secret manager or determine a running Agent's version; those
checks still require service logs on the affected machine.

## Diagnose a missing client configuration

- Check the actual running Agent version and service executable, not only
  `fleet-agent --version`. An upgraded Homebrew binary does not replace an
  already running process; restart its service. Older binaries earlier on
  `PATH` can also hide the installed version.
- Confirm the Node has a current `ai-client/opencode` or `ai-client/codex`
  Assignment, and inspect its latest attempt result and Agent logs.
- Check model-sync status. `credential_unavailable` means the Server has no
  `Fleet:CliProxyApiKey`; a repository assignment alone cannot supply it.
- Check `~/.config/opencode/opencode.jsonc` as well as `.json`. The JSONC file
  takes precedence. Fleet ownership conflicts leave both files intact.

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

## End-to-end verification

Run `python3 scripts/smoke-cliproxy-sync.py --image LOCAL_IMAGE --agent PATH_TO_FLEET_AGENT`
with a Server image and Agent built from the same checkout. The test uses a
disposable Docker stack, a TLS CLIProxy fixture, and a real enrolled Agent. It
checks initial failure and recovery without a source commit, scheduled refresh
while the Agent is stopped, manual
refresh, model and effort changes in Codex and OpenCode JSONC without a source
revision change, outage retention, and native restoration. It makes no inference
requests and removes its containers and volumes afterward.
