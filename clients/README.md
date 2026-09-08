# Rust clients

The workspace is Rust 2024 and contains the Operator `fleet` and Node `fleet-agent` binaries.
The direct dependencies are deliberately limited to the approved stack:

| Dependency | Purpose | License in the upstream crate metadata |
|---|---|---|
| `anyhow` | Contextual errors at the binary boundary | MIT OR Apache-2.0 |
| `clap` | Typed command-line parsing and environment configuration | MIT OR Apache-2.0 |
| `reqwest` | HTTPS transport with the rustls TLS backend | MIT OR Apache-2.0 |
| `serde`, `serde_json` | Versioned JSON request and response models | MIT OR Apache-2.0 |
| `tokio` | Async runtime used by the HTTP client and CLI entry point | MIT |
| `uuid` | Validate credential identifiers before sending mutations | MIT OR Apache-2.0 |

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

The CLI reads Operator credentials from `FLEET_OPERATOR_TOKEN`. Node aliases can
be changed with:

```sh
fleet nodes rename <current-alias> <new-alias>
```

The command prints the renamed node as JSON. It reports an unknown current alias
with HTTP 404. HTTP 409 means the new alias is already in use or the node is
revoked.

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
