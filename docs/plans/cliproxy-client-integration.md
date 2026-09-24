# CLIProxyAPI client integration plan

Status: CP-0 through CP-6 implemented and verified; CP-7 release assets prepared,
2026-09-18. Production rollout remains an operator step.

The original Node-side discovery and mandatory-model design below is historical.
Server-side catalog discovery and optional defaults supersede it; current behavior
is documented in the [operations guide](../technical-design/cliproxy-operations.md).

## Verdict

This is viable. The model lookup and client rendering logic can be ported from
EasyCLIProxyAPI, but its commits cannot be cherry-picked into Fleet as a useful
unit. EasyCLIProxyAPI is a Tauri desktop application whose model lookup, local
configuration, backup, and UI state are coupled. Fleet should port the small
Rust algorithms and their test cases into a new Agent reconciliation path.

The client configuration work is medium-sized. Server-provided API keys add a
separate security feature because Fleet currently excludes production secret
distribution. Keep those two concerns separate in the implementation and in
review.

## Required behavior

- A Node can leave Codex and OpenCode configuration unmanaged, route either
  client through CLIProxyAPI, or restore the client's native connection mode.
- The Agent obtains the available models from CLIProxyAPI. Operators do not list
  every model in `fleet.yml`.
- `fleet.yml` contains no API key.
- Native mode never automates OAuth. The user signs in with Codex or OpenCode on
  the Node.
- Fleet changes only the configuration fields it owns. It does not replace an
  existing `config.toml` or `opencode.json` wholesale.
- A proxy outage or invalid response never erases a working cached model catalog.
- Switching back to native mode restores the pre-Fleet values for managed fields
  and leaves locally owned OAuth credentials alone.

## Proposed manifest

Use an explicit three-state contract. An omitted client remains unmanaged,
`cliproxy` enables the integration, and `native` removes Fleet's CLIProxyAPI
integration while preserving local authentication.

```yaml
schema: fleet/v2

cliproxy:
  base-url: https://cliproxy.home.arpa:8317/v1

targets:
  skills:
    base: home
    path: .agents/skills

nodes:
  homelab-mini:
    targets:
      skills:
        groups: []
      ai-clients:
        codex:
          mode: cliproxy
          model: gpt-5.6-sol
        opencode:
          mode: cliproxy
          model: gpt-5.6-sol

  laptop:
    targets:
      skills:
        groups: []
      ai-clients:
        codex:
          mode: native
```

The first version should support one Workspace-wide CLIProxyAPI endpoint. Do not
add a profile catalog until a second endpoint is required. Require an explicit
default model in `cliproxy` mode so a changing model-list order cannot change a
Node's default silently.

The base URL is reviewable, non-secret desired state. Accept an HTTPS origin or
one ending in `/v1`, normalize it to `/v1`, and reject credentials, a query, or a fragment. Supporting
remote plain HTTP would send the proxy key and prompts in cleartext. A local-only
development exception can follow Fleet's existing loopback HTTP policy.

## Assignment and reconciliation model

Add one structured Target per configured AI client:

```text
ai-client/codex
ai-client/opencode
```

Each Assignment carries a `fleet.ai-client/v1` intent containing the client,
mode, base URL, default model, and a fixed `cliproxy` credential reference. It
does not carry the credential. This needs a new optional Assignment payload and
a one-to-one persistence row. A Managed file is the wrong abstraction because
Codex needs several coordinated files and both clients may already have user
configuration that Fleet must preserve.

The Agent adds a client-configuration reconciler with the same safety properties
as Skill reconciliation:

1. Recover any interrupted transaction.
2. Load and validate the existing client configuration.
3. Fetch or reuse the CLIProxyAPI credential.
4. Fetch and validate the current model list.
5. Render the client-specific managed fields.
6. Atomically commit all affected files and a receipt containing the original
   managed values.
7. On later cycles, compare only Fleet-owned fields and repair their drift.
8. In `native` mode, restore the original managed values and remove Fleet-created
   catalog files.

Invalid TOML, JSON, JSONC, links, special files, concurrent changes, or changes
to a Fleet-owned field fail closed. Unrelated valid settings and comments remain.

## CLIProxyAPI credential delivery

Configure the key through the Server's ordinary .NET configuration sources:

```json
{
  "Fleet": {
    "CliProxyApiKey": "replace-with-a-dedicated-proxy-key"
  }
}
```

Add a narrow Node endpoint such as
`GET /agent/v1/cliproxy/credential`. Do not build a generic secret store for one
credential. The endpoint must:

- require the existing Node mTLS authentication;
- authorize only a Node with a current `cliproxy` AI-client Assignment;
- require a configured non-empty key and return it with `Cache-Control: no-store`;
- omit the value from logs, errors, metrics, audit records, PostgreSQL, Bundles,
  and backups.

The deployment owns storage and injection. Infisical or any other secret
manager can set `Fleet__CliProxyApiKey` directly. The homelab Compose file also
maps the host variable `FLEET_CLIPROXY_API_KEY` to that setting. Fleet does not
need a secret-manager-specific adapter and must not copy the key into its
database or desired-state model.

The Agent fetches the key at the same bounded interval as the model catalog and
stores it under its existing private state directory with mode `0600`. Reading
the small secret each time keeps rotation simple and avoids inventing a secret
version protocol. Codex uses command-backed provider authentication with
`cat` resolved from `PATH` and the Agent-resolved absolute key path.
OpenCode can use its documented
`{file:/absolute/path}` substitution. This keeps the key out of
`~/.codex/config.toml`, `~/.codex/auth.json`, and
`~/.config/opencode/opencode.json`.

One shared key is acceptable for the stated private homelab scope, but a
compromised Node can copy it. Revoking the Node certificate then blocks Fleet,
not CLIProxyAPI. Rotate the shared key after a Node compromise. Per-Node proxy
keys should wait until CLIProxyAPI key creation and revocation can be automated
or operated reliably.

This feature changes the current threat model. It requires a short ADR and
updates to the threat model, data inventory, backup notes, deployment setup, and
secret-rotation runbook before release.

## Model discovery and caching

Run discovery on the Node because the Node must reach CLIProxyAPI for inference
anyway. This avoids making an external model catalog part of an immutable Server
desired revision. Keep the clean-room fetch, parsing, catalog, and
client-configuration code in the Agent. The Server needs only manifest
validation, Assignment publication, and the authorized credential endpoint.

The request should use Bearer authentication, no redirects, bounded connect and
request timeouts, and a 4 MiB response limit. Try `GET /v1/models` first and only
retain the upstream legacy `/models` fallback if a supported CLIProxyAPI release
still needs it. Accept the response shapes used upstream: a top-level array,
`data`, or `models`, with model identifiers in `id`, `slug`, `name`, `model`, or
`value`. Deduplicate identifiers case-insensitively and reject a non-empty
response that yields no valid model IDs.

Cache normalized model metadata and its source URL in Agent state, never the
credential. On first setup, an unavailable proxy fails the Assignment. After a
successful setup, refresh on a bounded interval from the existing run loop. A
failed refresh keeps the previous catalog and records a local warning. A changed
catalog updates client configuration atomically without requiring a Git commit.

The current Agent protocol cannot report a separate post-success refresh or
drift condition. Keep the first release's warning local and add observed-state
reporting only as part of the broader Agent recovery protocol.

## Client adapters

### Codex

Generate a minimal private model catalog from the discovered identifiers using
Codex's documented catalog contract. No EasyCLIProxyAPI code, templates, or
catalog data are copied. Set only these managed values:

- `model_provider`
- `model`
- `model_catalog_json`
- the Fleet-owned provider table under `model_providers`

Set the provider base URL and Responses wire protocol. Use Codex's documented
command-backed bearer authentication to read the private Agent key file. Do not
write or delete `auth.json`. In native mode, restore the original managed values
and let Codex prompt the user to sign in if its local OAuth state is absent.

The official Codex configuration reference documents custom providers,
Responses as the supported wire API, command-backed bearer authentication, and
the optional model catalog file. It discourages embedding a bearer token directly
in `config.toml`.

Do not rely on Codex's native custom-provider model discovery in the first
release. At the reviewed Codex revision, API-key discovery is narrowly gated,
identifies eligible providers by display name, and is disabled by default. Test
it during the compatibility spike against Fleet's exact provider and minimum
supported Codex version. If it becomes stable, use it later as a version-gated
optimization; the generated catalog remains the compatibility path.

### OpenCode

Implement the model-list renderer and JSONC-aware merge behavior. Add one Fleet-owned
custom provider, its model map, and the selected `provider/model` default. Keep
the API key in the separate Agent file through OpenCode's file substitution.

Use EasyCLIProxyAPI's `@ai-sdk/openai-compatible` adapter. The live CP-0 test
passed text, streaming, and a shell-tool call through the deployed CLIProxyAPI
with OpenCode 1.18.31. Keep that test as the release gate. Revisit
`@ai-sdk/openai` only if a supported model stops working through Chat
Completions.

Do not modify OpenCode's OAuth credential store. Native mode removes or restores
only the Fleet-owned provider and default-model values. The user runs OpenCode's
normal connection flow locally.

## Upstream behavior reviewed

The review snapshot is EasyCLIProxyAPI commit
`e7f96e12d724ae3f541f65e4c32da78f9ef3003b`.

| Upstream area | Fleet destination | Treatment |
|---|---|---|
| `agents/commands.rs`: model fetch and response shapes | `fleet-agent` protocol/client module | Reimplement the documented protocol behavior with Fleet limits, errors, and URL policy. |
| `codex_catalog.rs` and `resources/codex_models/*` | Agent Codex adapter | Do not copy templates or catalog data; emit the minimum version-tested Codex schema from discovered IDs. |
| `agents/configuration.rs`: Codex and OpenCode output shapes | client-specific adapters | Reimplement the public config contracts; do not copy Tauri state or `auth.json` mutation. |
| `agents/transactions.rs` and tests | reconciliation transaction tests | Cover the same failure classes using Fleet's receipt and journal design. |

Fleet uses `toml_edit` and `jsonc-parser`. Both solve required
format-preserving parsers; hand-written TOML or JSONC rewriting would be less
safe and not smaller once edge cases are covered.

EasyCLIProxyAPI is MIT licensed, as is Fleet. This implementation copies no
substantial upstream code or data; add the upstream notice if that changes.

The main Fleet touch points are deliberately narrow:

| Fleet area | Change |
|---|---|
| `server/Fleet.Server/Source` | Parse and validate the new manifest fields and build AI-client Targets. |
| `server/Fleet.Core/Coordination` and persistence | Add the structured Assignment payload and its one-to-one persisted row. |
| `server/Fleet.Server/Transport` and security options | Expose the authorized credential endpoint and API-key setting. |
| `clients/bins/fleet-agent` | Fetch the key and models, dispatch the new Target type, and maintain its refresh interval. |
| `clients/crates/fleet-reconcile` | Apply and restore semantic Codex and OpenCode configuration transactions. |
| homelab deployment and technical design docs | Inject the setting and record the changed security boundary. |

## Implementation tasks

These are intended as reviewable task or pull-request boundaries. CP-2 and CP-4
can run in parallel. CP-5 and CP-6 can run in parallel after the shared Agent
work lands.

```text
CP-0 -> CP-1 -> CP-2 -> CP-3 -> CP-4 -> CP-4A -> CP-5/CP-6 -> CP-7
```

### CP-0: prove compatibility against the deployed proxy

Status: complete on 2026-09-17. See the
[live compatibility report](../research/cliproxy-live-compatibility.md).

Scope:

- Capture sanitized standard and Codex-shaped model responses from the deployed
  CLIProxyAPI.
- Create temporary Codex and OpenCode homes with hand-built versions of the
  intended Fleet configuration.
- Exercise a request, streaming, and a tool call in both clients.
- Select the OpenCode SDK package from the observed protocol behavior.
- Confirm the pinned EasyCLIProxyAPI source revision and record the live
  response shapes needed for later fixtures.

Acceptance:

- Both clients work through the homelab proxy without a manually maintained
  model list.
- No real key or OAuth credential enters the repository or captured fixtures.

Estimate: 0.5 to 1 day.

### CP-1: add desired state and Assignment payloads

Status: implemented on 2026-09-17.

`fleet/v1` and `fleet/v2` are separate strict parser plug-ins that normalize to
one internal desired-state model. Future schemas can be added by implementing
and registering another parser; an old version can be retired without changing
publication or persistence code.

Scope:

- Parse the Workspace-level `cliproxy.base-url` and per-Node `ai-clients` map.
- Implement the omitted, `cliproxy`, and `native` states.
- Require a valid default model in `cliproxy` mode and apply the URL rules in
  this plan.
- Publish `ai-client/codex` and `ai-client/opencode` Targets with a
  `fleet.ai-client/v1` payload.
- Persist the structured Assignment payload without a credential field.
- Add manifest, wire-format, persistence, and unsupported-Agent tests.

Acceptance:

- Publishing the example manifest produces deterministic, non-secret
  Assignments for the selected Nodes.
- Invalid modes, URLs, client names, and missing models fail publication.

Estimate: 1 to 1.5 days.

### CP-2: deliver the CLIProxy credential

Status: implemented on 2026-09-17.

Scope:

- Add the Server's `Fleet:CliProxyApiKey` configuration setting.
- Add `GET /agent/v1/cliproxy/credential` behind existing Node mTLS.
- Authorize only Nodes with a current `cliproxy` AI-client Assignment.
- Return the configured key with `Cache-Control: no-store` and redact the value
  from every diagnostic path.
- Test missing and empty settings, unauthorized Nodes, revoked Nodes, size
  limits, and accidental persistence or logging.

Acceptance:

- An assigned Node can retrieve the exact configured key.
- Other Nodes cannot retrieve it.
- The key does not appear in PostgreSQL, Bundles, logs, audit records, or test
  snapshots.

Estimate: 1 day.

### CP-3: add the Agent CLIProxy client

Status: implemented on 2026-09-17.

Scope:

- Fetch the credential over the existing mTLS connection and store it as a
  mode `0600` Agent state file.
- Fetch `/v1/models` with Bearer authentication, strict TLS, bounded timeouts,
  no redirects, and a response-size limit.
- Normalize and validate the supported upstream response shapes.
- Cache the last known non-empty model list and refresh it from the existing
  reconciliation loop.
- Fail initial setup when discovery fails. Preserve the working cache on later
  failures.

Acceptance:

- Rotation reaches the Agent without changing `fleet.yml`.
- A malformed, empty, oversized, or unavailable response cannot erase a valid
  cached catalog.
- Tests never print the credential.

Estimate: 1 to 1.5 days.

### CP-4: add safe client-configuration transactions

Status: implemented on 2026-09-17. The first adapters set the minimum usable
Codex and OpenCode provider fields so the transaction path can be tested as a
whole. Codex 0.154.0 was exercised from a clean Docker container against the
deployed proxy using command-backed authentication. CP-5 and CP-6 retain the
catalog-specific compatibility and release-polish work.

Scope:

- Add only the TOML and JSONC editing support needed by Codex and OpenCode.
- Record the original values of Fleet-owned fields in an Agent receipt.
- Commit coordinated file changes atomically and recover interrupted writes.
- Detect links, special files, invalid input, concurrent edits, and unexpected
  changes to Fleet-owned fields.
- Restore original fields in `native` mode while leaving OAuth stores untouched.

Acceptance:

- Apply, restart, catalog refresh, interrupted-write recovery, and native
  restoration pass against temporary client homes; unexpected edits to owned
  fields fail closed.
- Unrelated settings and comments survive reconciliation.
- `auth.json` and OpenCode's credential store remain unchanged.

Estimate: 1.5 to 2 days.

### CP-4A: make Agent actions plug-in modules

Status: implemented on 2026-09-18.

The Agent dispatches Skill, Managed-file, and AI-client work through an explicit
registry and common lifecycle. The polling cycle, wire contract, and durable run
state remain stable. Server Target publication uses a matching ordered registry.

Scope:

- Define one action lifecycle: validate, recover, prepare, apply or refresh,
  and map a stable error code.
- Move Skill, Managed-file, and AI-client behavior into separate handlers.
- Register handlers explicitly so a future action is added without another
  branch through the Agent work loop.
- Keep polling, certificate renewal, report delivery, and assignment durability
  in the orchestration layer.
- Add contract tests that run every handler through restart, stale Assignment,
  and recovery paths.

Acceptance:

- Adding a fixture action requires a new handler and registry entry, with no
  changes to the polling cycle.
- Existing Assignment JSON and on-disk run state remain compatible.
- The current Skill, Managed-file, and AI-client tests pass unchanged at the
  behavioral boundary.

Estimate: 1 to 1.5 days.

### CP-5: manage OpenCode

Status: implemented and verified on 2026-09-18 with OpenCode 1.18.31 in a fresh
Docker container, including a shell-tool round trip through the deployed proxy.

Scope:

- Add the Fleet-owned OpenCode provider and explicit discovered model map.
- Set the selected `provider/model` default.
- Reference the Agent key file with OpenCode's file substitution.
- Remove or restore only Fleet-owned values in `native` mode.

Acceptance:

- OpenCode works through CLIProxyAPI with streaming and tools.
- Model refresh changes the managed model map without overwriting unrelated
  JSONC content.
- Switching to `native` preserves the user's OpenCode credentials.

Estimate: 1 day.

### CP-6: manage Codex

Status: implemented and verified on 2026-09-18 with Codex 0.154.0 in a fresh
Docker container. The exact generated catalog, command-backed authentication,
Responses streaming, and a shell-tool round trip passed against the deployed
proxy.

Scope:

- Build the minimum clean-room runtime-model parser and catalog generator.
- Generate the catalog from discovered IDs without vendored upstream data.
- Add the Fleet-owned Responses provider, selected model, and generated catalog.
- Use command-backed authentication to read the Agent key file.
- Remove or restore only Fleet-owned values in `native` mode.

Acceptance:

- Codex works through CLIProxyAPI with streaming and tools using the generated
  catalog.
- Offline startup retains the last known working catalog.
- Fleet never reads or changes Codex `auth.json`.

Estimate: 1.5 to 2 days.

### CP-7: deploy and release the integration

Status: release assets prepared on 2026-09-18. The generic configuration path,
operations guidance, security documentation, example manifest, release notes,
and pinned container compatibility check are complete. The environment-specific
rollout, transition, rotation, outage, and revocation drills remain operator
steps.

Scope:

- Map an optional Compose host variable to the standard .NET setting. Document
  that Infisical or another secret manager can inject either variable.
- Update the threat model, data inventory, backup notes, setup guide, and
  rotation runbook. Add MIT attribution only if upstream code or data is copied.
- Exercise `unmanaged -> cliproxy -> native -> cliproxy` for both clients.
- Test key rotation, proxy outage, malformed catalogs, concurrent edits,
  interrupted writes, and revoked Nodes.
- Roll out compatible Agents before publishing AI-client Assignments.

Acceptance:

- The complete flow converges on a clean Node and a Node with existing client
  configuration.
- Rotating the configured key requires no Git change and causes no OAuth changes.
- The release checklist confirms the raw key is absent from Git, durable Server
  state, Bundles, diagnostics, and backups.

Estimate: 1 to 1.5 days.

## Main risks

| Risk | Plan response |
|---|---|
| Whole-file ownership overwrites personal client settings | Add semantic adapters and field-level receipts. Do not reuse Managed files. |
| Shared proxy key leaks from durable Server state | Read it from deployment configuration and never put it in an Assignment or Bundle. |
| Model metadata changes independently of Git | Refresh and cache on the Node's active reconciliation loop. |
| OAuth state is destroyed when changing modes | Never manage OAuth credential files; restore only Fleet-owned config fields. |
| Upstream Codex catalog format changes | Pin the supported Codex version in the live compatibility gate and update the clean-room schema deliberately. |
| OpenCode protocol choice differs by model | Gate the adapter choice with real CLIProxyAPI integration tests. |
| Older Agents reject the new Assignment | Require Agent-first rollout and retain strict target/schema checks. |

## Effort and recommendation

The model fetch itself is small. Safe configuration merging, restoration, and
secret delivery are most of the work. CP-0 through CP-7 total roughly 9 to 11.5
engineering days. One engineer should budget about two weeks for the complete
path, including tests and security documentation, assuming the deployed proxy
matches the current upstream API. Two engineers can overlap CP-2 with CP-4 and
CP-5 with CP-6 after their shared dependencies land.

Proceed in the dependency order above. Do not ship an interim implementation
that writes the API key into `fleet.yml`, a Bundle, or a complete replacement
`config.toml` or `opencode.json`.

## Primary references

- [EasyCLIProxyAPI source and MIT license](https://github.com/router-for-me/EasyCLIProxyAPI)
- [CLIProxyAPI Codex client configuration](https://help.router-for.me/agent-client/codex)
- [CLIProxyAPI OpenCode client configuration](https://help.router-for.me/agent-client/opencode)
- [Official Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [OpenCode provider configuration](https://opencode.ai/docs/providers)
- [OpenCode config file variables](https://dev.opencode.ai/docs/config/)
