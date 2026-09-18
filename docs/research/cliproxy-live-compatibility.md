# CLIProxy live compatibility probe

Probe window: 2026-09-17T19:22:18Z to 2026-09-17T19:28:34Z

Target: [`https://proxy.hlab.alpetxino.com/`](https://proxy.hlab.alpetxino.com/)

## Conclusion

CP-0 passes. The deployed CLIProxyAPI supports the standard and Codex-shaped
model catalogs, Responses, Chat Completions, streaming, and tool use. Installed
Codex and OpenCode clients both completed a shell-tool round trip through the
proxy with the configured model.

The implementation can proceed with these choices:

- store `https://proxy.hlab.alpetxino.com/v1` as the normalized API base URL;
- discover models only at `/v1/models` for this deployment;
- generate a static Codex catalog from the enriched model response;
- use `@ai-sdk/openai-compatible` for the first OpenCode adapter;
- retain a 4 MiB model-response limit because the current enriched response is
  already about 548 KB for 11 models.

## Credential handling during the probe

The designated test credential already existed in the local Codex provider
configuration. The probe extracted it without printing it and passed the
Authorization header to `curl` through standard input rather than a command-line
argument. It did not copy the key into the repository.

The OpenCode test used a mode `0600` temporary key file and OpenCode's file
substitution. The complete temporary client homes and response files were
deleted after inspection. Credential-value scans found no key in captured
client output or error logs.

This only describes the compatibility test. Fleet's production design still
uses the deployment-managed Server secret file and Agent-private key file.

## Environment

| Component | Observed value |
| --- | --- |
| Codex | `codex-cli 0.154.0` |
| OpenCode | `1.18.31` |
| Selected model | `gpt-6-astra` |
| DNS result | private RFC 1918 IPv4 address |
| HTTP protocol | HTTP/2 |

## DNS and TLS

`proxy.hlab.alpetxino.com` resolves through `hlab.alpetxino.com` to a private
RFC 1918 IPv4 address from this Node. This proves reachability from the
compatibility environment, not from every Fleet Node.

TLS verification succeeds without a bypass:

| Property | Observed value |
| --- | --- |
| Certificate subject | `CN=proxy.hlab.alpetxino.com` |
| Subject alternative name | `DNS:proxy.hlab.alpetxino.com` |
| Issuer | Let's Encrypt `YR2` |
| Valid from | 2026-08-31 09:38:39 UTC |
| Valid until | 2026-11-29 09:38:38 UTC |
| Verification result | `0`, success |

These values came directly from the target's
[`TLS endpoint`](https://proxy.hlab.alpetxino.com/).

## Route behavior

No tested request redirected.

| Request | Without key | With key | Result |
| --- | ---: | ---: | --- |
| `GET /` | 200 | not needed | Identifies itself as CLI Proxy API Server. |
| `GET /v1/models` | 401 | 200 | Preferred discovery route works. |
| `GET /models` | 404 | not needed | Unversioned fallback is absent. |
| `POST /v1/responses` | 401 | 200 | Responses inference works. |
| `POST /v1/chat/completions` | 401 | 200 | Chat Completions inference works. |

The public root advertises Chat Completions, Completions, and Models. Responses
is not listed there, but authenticated Responses requests work. The live routes
are the primary evidence for this deployment:
[`models`](https://proxy.hlab.alpetxino.com/v1/models),
[`responses`](https://proxy.hlab.alpetxino.com/v1/responses), and
[`chat completions`](https://proxy.hlab.alpetxino.com/v1/chat/completions).

## Model discovery

| Request | Status | Shape | Models | Bytes | Selected model present |
| --- | ---: | --- | ---: | ---: | --- |
| `/v1/models` | 200 | top-level `data` array | 11 | 923 | yes |
| `/v1/models?client_version=0.154.0` | 200 | top-level `models` array | 11 | 547,541 | yes |

The standard response is sufficient for OpenCode. The enriched response is the
right source for a generated Codex catalog. The model identifiers and metadata
were inspected in temporary files but were not copied into this public research
note.

## Inference and streaming

| API test | Status | Observed result |
| --- | ---: | --- |
| Responses text | 200 | Returned exactly `fleet-compat-ok`. |
| Chat Completions text | 200 | Returned exactly `fleet-compat-ok`. |
| Responses stream | 200 | Emitted text deltas and one `response.completed` event. |
| Chat Completions stream | 200 | Emitted four JSON chunks and one `[DONE]` marker. |

A hand-written Responses request using `tool_choice: "required"` did not finish
within the 90-second test timeout. This does not block client compatibility:
Codex's own tool payload completed successfully in about eight seconds. Keep the
timeout case as a regression fixture when the Agent adapters are implemented.

## Client checks

### Codex

Codex used its existing custom provider, the Responses wire API, and the
configured model. An ephemeral, read-only `codex exec` run asked Codex to invoke
the shell tool:

```text
printf fleet-codex-tool-ok
```

The event stream contained a `command_execution` item and the final message was
exactly `fleet-codex-tool-ok`. The run completed with exit code 0 in about 8.3
seconds. This matches the custom provider layout in the
[official Codex sample configuration](https://learn.chatgpt.com/docs/config-file/config-sample).

### OpenCode

OpenCode ran in an isolated temporary XDG home with this provider behavior:

- package: `@ai-sdk/openai-compatible`;
- base URL: `https://proxy.hlab.alpetxino.com/v1`;
- credential: `{file:<temporary-mode-0600-path>}`;
- model: `fleet-cliproxy/gpt-6-astra`.

An `opencode run --pure --auto --format json` invocation executed the shell tool
and returned exactly `fleet-opencode-tool-ok`. It completed with exit code 0 in
about 9.5 seconds. The captured stream included one `tool_use` event and the
final text event. This follows OpenCode's documented
[custom provider configuration](https://opencode.ai/docs/providers).

## Remaining release checks

CP-0 validates this Node and the current client versions. Later tasks still need
to cover:

- reachability and certificate trust from each managed Node;
- automatic catalog rendering rather than the temporary hand-built configs;
- Server-to-Agent key delivery and rotation;
- proxy outage and last-known-good behavior;
- semantic restoration when switching to `native` mode.

OAuth was not read, copied, changed, or tested. It remains client-owned and
outside this integration.
