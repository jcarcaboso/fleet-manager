# Rust clients

The workspace is Rust 2024 and currently contains the Operator `fleet` binary.
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
