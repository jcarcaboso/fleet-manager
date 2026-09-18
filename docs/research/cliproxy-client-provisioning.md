# CLIProxy model discovery and client provisioning

Research date: 2026-09-17

Implementation note (2026-09-18): this document records the initial design
options. Fleet 0.6 uses one optional Workspace key supplied through the
Server's `Fleet:CliProxyApiKey` deployment setting; `fleet.yml` contains no
credential reference. See the [operations guide](../technical-design/cliproxy-operations.md)
for the implemented behavior.

Source snapshots:

- EasyCLIProxyAPI `e7f96e12d724ae3f541f65e4c32da78f9ef3003b`
- CLIProxyAPI `8c664b2fede5c83b919be1df9b01057ec4e4c950`
- Codex `fcf05456bb27e6c3d5677550f54011db6a2a0817`
- OpenCode `5a8335857b0ebec44ef6aa1d52b339cf25c329ca`

## Conclusion

The integration is viable, but the EasyCLIProxyAPI agent feature is not a practical cherry-pick. Its reusable core is small: call the proxy's authenticated model endpoint, write one custom provider for each client, and reconcile the selected model. The surrounding Easy implementation is tied to its local managed core, Tauri commands, recovery state, backup transactions, catalog templates, and UI.

OpenCode support is straightforward. Codex support is also feasible, but its catalog strategy needs a versioned compatibility decision. Current Codex contains a provider-owned `/models` client, while API-key model discovery is narrowly gated and remains an under-development, default-off feature. A production implementation should first prove native discovery with the exact emitted provider and auth configuration against the minimum supported Codex version. If that is not reliable, Fleet should generate the static Codex catalog as a compatibility fallback rather than port Easy's entire catalog subsystem.

The API key should not be placed in `fleet.yml`. The file should select a mode, endpoint, and server-side secret reference. Direct OAuth should remain client-owned. Fleet should never collect or distribute Codex OAuth credentials.

## What EasyCLIProxyAPI does

### Model retrieval

The generic path builds the managed core origin, tries `GET /v1/models`, falls back to `GET /models` only after a 404 or 405, sends `Authorization: Bearer <key>`, and uses 3-second connect and 15-second total timeouts. Its Codex path adds `client_version=<Easy version>` and parses the richer response separately. Both paths explicitly accept invalid certificates when managed TLS is enabled, which should not be copied for a remote homelab endpoint. [Generic and Codex fetch paths](https://github.com/router-for-me/EasyCLIProxyAPI/blob/e7f96e12d724ae3f541f65e4c32da78f9ef3003b/src-tauri/src/agents/commands.rs#L701-L806)

The generic parser accepts a root array, `data` array, `models` array, or keyed `models` object. It recognizes `id`, `name`, `model`, and `value`, plus display names, aliases, fork semantics, context-window variants, and input modalities. [Generic model parser](https://github.com/router-for-me/EasyCLIProxyAPI/blob/e7f96e12d724ae3f541f65e4c32da78f9ef3003b/src-tauri/src/agents/commands.rs#L1235-L1305)

For Codex, Easy fetches the model list and management YAML concurrently, applies configured context limits, then produces a Codex-specific catalog. Other clients, including OpenCode, use the generic list. [Client-specific preparation](https://github.com/router-for-me/EasyCLIProxyAPI/blob/e7f96e12d724ae3f541f65e4c32da78f9ef3003b/src-tauri/src/agents/commands.rs#L808-L857)

This code assumes Easy's own managed core. The host is derived from the installed core settings and wildcard listen addresses are rewritten to loopback. It is not a general remote proxy URL abstraction. [Managed core origin construction](https://github.com/router-for-me/EasyCLIProxyAPI/blob/e7f96e12d724ae3f541f65e4c32da78f9ef3003b/src-tauri/src/core_config/settings.rs#L189-L210) The key is the first non-empty configured core key, with Easy's built-in default as fallback. [Effective key selection](https://github.com/router-for-me/EasyCLIProxyAPI/blob/e7f96e12d724ae3f541f65e4c32da78f9ef3003b/src-tauri/src/core_config/settings.rs#L1374-L1380)

### Codex configuration

Easy modifies the user's existing TOML and sets:

```toml
model_provider = "cpa-gui"
model = "<selected>"
model_catalog_json = "cpa-gui-model-catalog.json"

[model_providers.cpa-gui]
name = "EasyCLIProxyAPI"
base_url = "<proxy>/v1"
wire_api = "responses"
experimental_bearer_token = "<proxy key>"
```

Its OAuth-flavored proxy mode additionally sets `requires_openai_auth = true`. [Codex config builder](https://github.com/router-for-me/EasyCLIProxyAPI/blob/e7f96e12d724ae3f541f65e4c32da78f9ef3003b/src-tauri/src/agents/configuration.rs#L2590-L2649) In API-key mode, it also rewrites `auth.json` to `auth_mode: "apikey"` with `OPENAI_API_KEY`, removing OAuth token fields. In OAuth-flavored mode it preserves an existing native OAuth file. [Codex auth update](https://github.com/router-for-me/EasyCLIProxyAPI/blob/e7f96e12d724ae3f541f65e4c32da78f9ef3003b/src-tauri/src/agents/configuration.rs#L2652-L2683)

The explicit provider key is what authenticates proxy requests. Current Codex resolves a provider `env_key` first, then `experimental_bearer_token`, before it considers first-party auth; Codex also documents the inline bearer token as discouraged in favor of `env_key`. [Codex provider auth precedence](https://github.com/openai/codex/blob/fcf05456bb27e6c3d5677550f54011db6a2a0817/codex-rs/model-provider/src/auth.rs#L292-L303) [Codex provider fields and security guidance](https://github.com/openai/codex/blob/fcf05456bb27e6c3d5677550f54011db6a2a0817/codex-rs/model-provider-info/src/lib.rs#L127-L178) Therefore, Easy's OAuth-flavored proxy configuration does not make the ChatGPT OAuth token the proxy credential. It preserves first-party login state while the configured proxy bearer remains authoritative.

Easy's native OAuth switch is a recovery workflow, not just a provider toggle. It creates snapshots, a recovery record, authentication updates, a catalog, routing config, and transaction validation. [Native OAuth switch preparation](https://github.com/router-for-me/EasyCLIProxyAPI/blob/e7f96e12d724ae3f541f65e4c32da78f9ef3003b/src-tauri/src/agents/native_oauth.rs#L311-L412) [Proxy configuration transaction](https://github.com/router-for-me/EasyCLIProxyAPI/blob/e7f96e12d724ae3f541f65e4c32da78f9ef3003b/src-tauri/src/agents/native_oauth.rs#L417-L515) Fleet should not copy this credential switching behavior for direct OAuth mode.

### OpenCode configuration

Easy preserves the existing JSON5 object and adds a `cpa-gui` provider using `@ai-sdk/openai-compatible`. It writes `options.baseURL`, plaintext `options.apiKey`, a model map generated from discovery, and root `model: "cpa-gui/<selected>"`. [OpenCode config builder](https://github.com/router-for-me/EasyCLIProxyAPI/blob/e7f96e12d724ae3f541f65e4c32da78f9ef3003b/src-tauri/src/agents/configuration.rs#L2904-L2942)

That structure matches OpenCode's documented custom OpenAI-compatible provider. OpenCode requires an explicit model map whose IDs match `GET /v1/models`; the documented flow asks the user to query that endpoint. [OpenCode custom-provider example](https://github.com/anomalyco/opencode/blob/5a8335857b0ebec44ef6aa1d52b339cf25c329ca/packages/web/src/content/docs/providers.mdx#L373-L403) The provider lowering code turns `options.apiKey` into `Authorization: Bearer <key>`. [OpenCode bearer header](https://github.com/anomalyco/opencode/blob/5a8335857b0ebec44ef6aa1d52b339cf25c329ca/packages/core/src/v1/config/provider-options.ts#L29-L40)

OpenCode merges configuration from several locations. A project `opencode.json` can override a global file, while managed configuration has higher precedence. [OpenCode config precedence](https://github.com/anomalyco/opencode/blob/5a8335857b0ebec44ef6aa1d52b339cf25c329ca/packages/web/src/content/docs/config.mdx#L27-L55) Fleet must choose whether it is supplying a default or enforcing the provider, then write at the matching precedence level.

## CLIProxyAPI compatibility

CLIProxyAPI exposes authenticated OpenAI-compatible `/v1/models`, `/v1/chat/completions`, and `/v1/responses` routes. It also has `/backend-api/codex` response aliases for direct Codex-style routing. [CLIProxyAPI routes](https://github.com/router-for-me/CLIProxyAPI/blob/8c664b2fede5c83b919be1df9b01057ec4e4c950/internal/api/server_routes.go#L61-L83) [Codex route aliases](https://github.com/router-for-me/CLIProxyAPI/blob/8c664b2fede5c83b919be1df9b01057ec4e4c950/internal/api/server_routes.go#L110-L118)

Without `client_version`, the OpenAI model handler returns the conventional `{ "object": "list", "data": [...] }` shape with IDs and standard metadata. With `client_version`, it returns the richer Codex client model response. [OpenAI model response selection](https://github.com/router-for-me/CLIProxyAPI/blob/8c664b2fede5c83b919be1df9b01057ec4e4c950/sdk/api/handlers/openai/openai_handlers.go#L51-L95) The unified router preserves that behavior except for its optional Home mode. [Unified model routing](https://github.com/router-for-me/CLIProxyAPI/blob/8c664b2fede5c83b919be1df9b01057ec4e4c950/internal/api/server_routes.go#L587-L619)

The built-in access provider validates keys from top-level `api-keys`. It accepts bearer authentication, `X-Goog-Api-Key`, `X-Api-Key`, and two query parameter forms. Fleet clients should use the bearer form because both Codex and OpenCode support it directly. [CLIProxyAPI access-provider documentation](https://github.com/router-for-me/CLIProxyAPI/blob/8c664b2fede5c83b919be1df9b01057ec4e4c950/docs/sdk-access.md#L56-L69)

Compatibility summary:

| Client | Request API | Model discovery | Key placement | Assessment |
| --- | --- | --- | --- | --- |
| OpenCode | OpenAI-compatible provider | Fleet fetches `/v1/models` and renders `models` | `options.apiKey`, unless Fleet supplies runtime config another way | High viability |
| Codex with static catalog | Responses API | Fleet fetches the Codex-shaped endpoint and renders `model_catalog_json` | Prefer provider `env_key`; inline bearer is supported but discouraged | Medium-high viability |
| Codex native discovery | Responses API | Codex calls provider `/models?client_version=...` | Provider must satisfy Codex's narrow refresh gates | Experimental; do not make it the only implementation yet |
| Direct Codex OAuth | First-party Codex API | Codex owns its catalog and refresh | Codex owns `auth.json` and refresh tokens | Keep outside Fleet secret management |

## Refresh behavior and the Codex decision

Easy refreshes an applied Codex catalog every 30 seconds and after an event notification with a 500 ms debounce. It only does this when its config inspection says the installation is still managed by Easy. [Easy catalog synchronization loop](https://github.com/router-for-me/EasyCLIProxyAPI/blob/e7f96e12d724ae3f541f65e4c32da78f9ef3003b/src-tauri/src/agents/commands.rs#L895-L942) This desktop polling loop is not a good fit for Fleet. Model discovery should be part of agent reconciliation, with a bounded cache or refresh interval and last-known-good behavior when the proxy is unavailable.

Current Codex already has a provider-owned `/models` client. It appends `client_version`, uses provider authentication, and has a five-second request timeout. [Codex models endpoint](https://github.com/openai/codex/blob/fcf05456bb27e6c3d5677550f54011db6a2a0817/codex-rs/model-provider/src/models_endpoint.rs#L39-L128) Constructing that client does not mean every custom provider will refresh. The API-key path requires all of the following: the endpoint must report API-key model support, the auth manager must be in API-key mode, and the feature flag must be enabled. The current endpoint reports API-key model support only when the provider's display `name` is exactly `OpenAI`; Easy configures the name as `EasyCLIProxyAPI`, so its emitted provider would not take this path. [Codex refresh and discovery gates](https://github.com/openai/codex/blob/fcf05456bb27e6c3d5677550f54011db6a2a0817/codex-rs/models-manager/src/manager.rs#L434-L515) [Codex OpenAI identity check](https://github.com/openai/codex/blob/fcf05456bb27e6c3d5677550f54011db6a2a0817/codex-rs/model-provider-info/src/lib.rs#L583-L592) The `api_key_model_discovery` feature is under development and disabled by default at this snapshot. [Codex feature status](https://github.com/openai/codex/blob/fcf05456bb27e6c3d5677550f54011db6a2a0817/codex-rs/features/src/lib.rs#L1254-L1259)

The first Codex task should therefore be a compatibility spike using the exact provider/auth configuration Fleet intends to emit, the minimum Codex version Fleet supports, and CLIProxyAPI's enriched response. The spike must confirm that naming a custom endpoint `OpenAI`, enabling `api_key_model_discovery`, and using Codex API-key auth has no unacceptable side effects. It should also test upgrades and offline startup. If it works reliably, Fleet can omit `model_catalog_json`. Otherwise, use a narrow static-catalog adapter. Given the current gates, static catalog generation is the safer initial production plan.

A static fallback must retain the last known non-empty catalog. Easy validates a non-empty catalog when applying a configuration. [Easy catalog validation](https://github.com/router-for-me/EasyCLIProxyAPI/blob/e7f96e12d724ae3f541f65e4c32da78f9ef3003b/src-tauri/src/agents/configuration.rs#L2885-L2901) Fleet should not replace a working catalog with an empty result after a transient proxy failure.

## Configuration and secret design

Use an explicit mode union, not a `use_cliproxy` boolean. It leaves room for more OpenAI-compatible providers and makes direct OAuth ownership clear.

```yaml
providers:
  homelab-cliproxy:
    kind: openai-compatible
    baseUrl: https://cliproxy.example/v1
    credentialRef: cliproxy/homelab

nodes:
  worker-1:
    ai:
      mode: proxy
      provider: homelab-cliproxy
      clients: [codex, opencode]
  worker-2:
    ai:
      mode: native
```

Recommended ownership rules:

1. `fleet.yml` contains only provider identity, endpoint, client selection, optional default model, and a secret reference.
2. The server resolves the secret reference and sends only the credential required by the target node over the existing authenticated control channel. Prefer one CLIProxy key per node so a compromised node does not expose a fleet-wide key.
3. The agent queries the node-reachable proxy URL. A server-side query would add an SSRF boundary and could produce a catalog that the node itself cannot reach.
4. Require valid TLS for a remote endpoint. Support a configured CA if the homelab uses a private PKI. Do not copy Easy's invalid-certificate bypass.
5. Redact the key from logs, status, diffs, and API responses. Write any necessary credential-bearing file with owner-only permissions.
6. In `native` mode, leave OAuth token files untouched. The user runs the client's normal login flow on that node, and the client owns token refresh.
7. On transition from `proxy` to `native`, remove only Fleet-owned provider/catalog keys or restore a recorded pre-Fleet config. Do not delete `auth.json` or log the user out.

Codex prefers `env_key` over an inline bearer, but Fleet currently needs a way to inject that environment variable into every Codex launch. If Fleet cannot control the process environment, an owner-only generated config containing `experimental_bearer_token` is a workable first version with a known plaintext-at-rest tradeoff. OpenCode's documented custom-provider configuration also places the API key in its JSON, so eliminating plaintext there requires runtime `OPENCODE_CONFIG_CONTENT`, a wrapper, or another OpenCode-supported secret source.

## Cherry-pick and licensing assessment

Direct cherry-picking is not viable. The initial agent integration commit, [`41efeeb`](https://github.com/router-for-me/EasyCLIProxyAPI/commit/41efeebcbb41b3c520a0e174596db18e39d93646), mixes 8,345 insertions across a large Rust `main.rs`, React UI, styles, icons, and tests. The runtime Codex catalog commit, [`8d8f619`](https://github.com/router-for-me/EasyCLIProxyAPI/commit/8d8f619), adds a bundled 1,017-line catalog and nearly 900 lines of Rust plus more unrelated changes. The later native OAuth workflow, [`433182f`](https://github.com/router-for-me/EasyCLIProxyAPI/commit/433182f), adds about 1,500 lines across recovery logic, UI, tests, and configuration. These commits do not share Fleet's architecture or config ownership model.

Port behavior, not commits:

- reuse the endpoint and response contracts;
- implement a small model parser for the standard OpenAI list;
- render the documented OpenCode provider;
- use Codex native discovery if the spike passes, otherwise implement only the catalog conversion required by supported Codex versions;
- build backup, ownership, and rollback behavior around Fleet's existing reconciler.

EasyCLIProxyAPI and CLIProxyAPI are MIT licensed. The license permits use and modification but requires preservation of the copyright and permission notice in copies or substantial portions. [EasyCLIProxyAPI license](https://github.com/router-for-me/EasyCLIProxyAPI/blob/e7f96e12d724ae3f541f65e4c32da78f9ef3003b/LICENSE#L1-L20) [CLIProxyAPI license](https://github.com/router-for-me/CLIProxyAPI/blob/8c664b2fede5c83b919be1df9b01057ec4e4c950/LICENSE#L1-L21) A clean implementation of protocol behavior and documented configuration avoids importing a substantial body of code. If catalog templates, parser code, or other substantial source is copied, retain the MIT notice and add source attribution in Fleet's third-party notices.

## Suggested delivery order

1. Add the typed `native | proxy` configuration and validation, with secret references but no literal credentials.
2. Add a node-side CLIProxy client for authenticated `/v1/models`, strict TLS, timeouts, redaction, and last-known-good cache behavior.
3. Add OpenCode rendering and ownership-aware restore. This is the lowest-risk end-to-end slice.
4. Add the smallest static Codex catalog adapter and last-known-good handling.
5. Run the Codex native-discovery compatibility spike. If it passes, use it as a version-gated optimization and record supported Codex and CLIProxyAPI versions in tests.
6. Add server-to-agent secret delivery, preferably with per-node proxy keys and rotation. Until that exists, allow an out-of-band node-local secret reference rather than putting the key in `fleet.yml`.
7. Test mode transitions, unavailable proxy behavior, empty model responses, model removal, key rotation, OAuth preservation, file permissions, and project-level OpenCode overrides.
