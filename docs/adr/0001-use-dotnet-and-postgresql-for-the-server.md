---
status: accepted
date: 2026-09-02
---

# Use .NET and PostgreSQL for the Fleet Server

The Fleet Server will use .NET 10, ASP.NET Core, PostgreSQL, EF Core, and Npgsql.
This stack matches the maintainer's experience, supports the transactional state
transitions required by Agent polling and Rollouts, and can later host the admin
panel's backend-for-frontend interface. PostgreSQL was chosen over SQLite to
avoid a database migration when concurrent Agent traffic and admin queries grow.

The POC remains one Server process. Git polling runs as a hosted background task,
and Bundle bytes remain in PostgreSQL until measured size or traffic justifies
separate object storage.

## Consequences

- Server development and tests require .NET 10 and PostgreSQL.
- Integration tests use real PostgreSQL rather than an in-memory EF provider.
- Agent, Operator, and future browser routes use separate authentication policies
  and protocol models inside the same ASP.NET Core host.
- The Server does not add queues, caches, schedulers, or separate processes until
  a measured requirement needs them.
