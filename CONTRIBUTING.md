# Contributing

Fleet Manager is early POC work. The architecture documents under `docs/` and
the domain language in `CONTEXT.md` are the source of truth for terminology and
boundaries.

## Prerequisites

- .NET SDK `10.0.302` (the version in `global.json`)
- Rust with Cargo and rustfmt
- Node.js 24 with npm, for the dashboard in `dashboard/`
- Docker for Server integration tests that use PostgreSQL Testcontainers, and for
  `make dashboard-image`
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

`make restore`, `make check`, `make test` and `make security` include the
dashboard (`npm ci`, `npm run typecheck` and `npm run build`, `npm test`,
`npm audit --omit=dev --audit-level=high`). To work on the dashboard alone,
use `npm run dev:mock` in `dashboard/`; it needs no Server. When you change
`dashboard/Dockerfile` or `dashboard/nginx/`, also run `make dashboard-image`,
which builds the image and starts it read-only with a throwaway certificate.

Keep HTTP, persistence, Git, YAML, and filesystem code behind their module
interfaces. Add tests at the owning interface and document public protocol
changes. Do not log credentials, enrollment tokens, complete Skill contents,
or arbitrary local paths.

Commit-message conventions and contribution attestation are pending a project
decision. Until then, reviewers will assess changes against the engineering
standards and architecture documents.
