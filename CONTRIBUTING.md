# Contributing

Fleet Manager is early POC work. The architecture documents under `docs/` and
the domain language in `CONTEXT.md` are the source of truth for terminology and
boundaries.

## Prerequisites

- .NET SDK `10.0.302` (the version in `global.json`)
- Rust with Cargo and rustfmt
- Docker for Server integration tests that use PostgreSQL Testcontainers
- Python 3 for the documentation-link check

Restore dependencies with:

```sh
make restore
```

Before submitting a change, run:

```sh
make format
make check
make test
make docs-check
make security
```

The Rust equivalents use the locked dependency graph:
`cargo fmt --manifest-path clients/Cargo.toml --all -- --check`,
`cargo clippy --manifest-path clients/Cargo.toml --workspace --all-targets
--locked -- -D warnings`, and
`cargo test --manifest-path clients/Cargo.toml --workspace --locked`.

Keep HTTP, persistence, Git, YAML, and filesystem code behind their module
interfaces. Add tests at the owning interface and document public protocol
changes. Do not log credentials, enrollment tokens, complete Skill contents,
or arbitrary local paths.

Commit-message conventions and contribution attestation are pending a project
decision. Until then, reviewers will assess changes against the engineering
standards and architecture documents.
