# Rust clients

The workspace is Rust 2024 and contains the Operator `fleet` and Node `fleet-agent` binaries.
The direct dependencies are deliberately limited to the approved stack:

| Dependency | Purpose | License in the upstream crate metadata |
|---|---|---|
| `anyhow` | Contextual errors in `fleet-agent` (`fleet` uses its own JSON error type) | MIT OR Apache-2.0 |
| `clap` | Typed command-line parsing and environment configuration | MIT OR Apache-2.0 |
| `reqwest` | HTTPS transport with the rustls TLS backend | MIT OR Apache-2.0 |
| `serde`, `serde_json` | Versioned JSON request and response models | MIT OR Apache-2.0 |
| `tokio` | Async runtime used by the HTTP client and CLI entry point | MIT |
| `libc` | `fleet-agent` only, on Unix: the `statvfs` (Linux) and `statfs` (macOS) calls that measure disk usage. Already a transitive dependency; no new locked package | MIT OR Apache-2.0 |
| `uuid` | Validate credential, rollout and link identifiers before sending requests | MIT OR Apache-2.0 |

Each dependency is used directly by the current CLI and is pinned through the
workspace manifest and `Cargo.lock`. Transitive dependencies are resolved by
Cargo and should be reviewed during dependency updates. The repository's MIT
license is compatible with all direct dependencies above.

Verification commands from this directory are:

```sh
cargo fmt --all -- --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo audit --file Cargo.lock
```

The dependency audit uses `cargo-audit` 0.22.2 and the RustSec advisory
database. From the repository root, `make security` also performs the locked
.NET restore before auditing the Rust lockfile.

The audit run on 2026-09-07 completed with no reported vulnerabilities across
149 locked crate dependencies. CI pins `cargo-audit` 0.22.2; the local Nix
cache provided 0.22.1 for the recorded verification run.

The CLI reads Operator credentials from `FLEET_OPERATOR_TOKEN` and the Server
address from `FLEET_SERVER_URL`. Every command prints one JSON document on
stdout, which makes it suitable for scripts and AI agents. Failures print
`{"error": {"code", "message", "status"}}` on stderr and exit non-zero:

| Exit | Meaning |
|---|---|
| 0 | OK |
| 2 | Usage error, missing configuration, or destructive command without `--yes` |
| 3 | Authentication or authorization failed (401/403, `insufficient_scope`) |
| 4 | Not found |
| 5 | Conflict |
| 6 | Other server or transport error |
| 10 | `fleet doctor` found error-severity issues |

Start with `fleet doctor`, which lists every open issue with its explanation and
the commands that fix it. Then inspect and act:

```sh
fleet doctor
fleet nodes show studio-mini
fleet explain lock_failed
fleet retry studio-mini skills
fleet nodes revoke studio-mini --dry-run   # --yes is required to run it
fleet nodes rename <current-alias> <new-alias>
```

Destructive commands (`nodes revoke`, `nodes remove`, `credentials revoke`,
`enrollment links revoke`) require `--yes`; `--dry-run` previews them with
read-only requests. The full command list, routes and error codes are in the
[Operator protocol](../docs/technical-design/operator-protocol.md). Run `fleet
help` for examples of every command. The
[`fleet-operator` Skill](../examples/skills/fleet-operator/SKILL.md) teaches AI
clients this workflow.

`nodes rename` prints the renamed node as JSON. It reports an unknown current
alias with HTTP 404. HTTP 409 means the new alias is already in use or the node
is revoked.

`fleet --help`, `fleet -h`, and `fleet help` show the top-level help. Append
`--help` to a command or use `fleet help <command>`, for example `fleet nodes
--help` or `fleet help nodes rename`. Help works before `FLEET_SERVER_URL` or
`FLEET_OPERATOR_TOKEN` is set.

For PATH setup, binary archive installation, and pinned source installation of
both commands, see the [command-line installation guide](../docs/technical-design/cli-installation.md).

## Node Agent

The separate `fleet-agent` binary enrolls and reconciles this machine using Node
mTLS credentials. It does not use Operator bearer tokens. See the
[Agent installation guide](../deploy/agent/README.md).

Runtime additions include rcgen with ring for P-256 certificate requests, time
for renewal scheduling, dirs for user home discovery, sha2 for Bundle integrity,
and unicode-normalization for portable Bundle paths. The `fleet-reconcile`
crate isolates filesystem validation, receipts, staging, and recovery. The
release build script now writes both `fleet` and `fleet-agent` archives.
