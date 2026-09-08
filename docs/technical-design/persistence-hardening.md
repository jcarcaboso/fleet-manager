# Persistence hardening

## Scope

Fleet coordination uses PostgreSQL transactions for identity, publication, and
Agent report transitions. The database remains the serialization point. The
Server does not need a process-local lock, so the guarantees survive restarts
and multiple requests running in parallel.

## Transaction rules

Workspace initialization inserts the configured Workspace through a unique
singleton key. Concurrent initial requests converge on one row. Once a database
contains a Workspace, every coordination operation rejects a different
configured Workspace ID.

Enrollment consumption locks the authorization row. An exact retry for the same
certificate request can retrieve the original response until `RetryUntil`.
Credential renewal locks the Node and active credential before it writes the
replacement. Node revocation takes the same Node lock before revoking every
credential. This gives renewal and revocation one database order.

Publication takes a PostgreSQL transaction advisory lock for the Workspace,
then locks each current Assignment it may supersede. Concurrent publications
therefore commit in one order and leave one current Assignment per Node Target.
Attempt reports lock the Assignment before the Attempt. Publication uses the
same order, which prevents a terminal report from restoring a superseded
Assignment.

Freshness uses one conditional SQL update with `GREATEST`. A delayed request
cannot replace a newer `LastContactAt` value.

## Retention

`MaintainPersistenceAsync` always removes enrollment delivery payloads after
their retry window. It preserves the authorization digest, consumption time,
certificate request digest, Node ID, and credential ID, so the authorization
remains consumed.

Audit event and source scan deletion is disabled unless the caller supplies a
positive retention period. Each maintenance call accepts a batch size from 1
through 10,000 and uses `FOR UPDATE SKIP LOCKED`. Bundles, desired revisions,
Assignments, Attempts, and Rollouts have no deletion policy in this phase.

The schema indexes enrollment rows by `RetryUntil` while a delivery payload is
present. It indexes audit events and source scans by Workspace and recorded
time. These indexes support maintenance without scanning unrelated history.

## Verification

`PersistenceHardeningTests` runs against PostgreSQL 17.5 in Testcontainers. It
covers concurrent Workspace initialization, mismatched Workspace rejection,
retention opt-in, enrollment payload scrubbing, monotonic freshness, renewal
against Node revocation, concurrent publication, stale reports, and input
bounds. The focused suite contains six tests and passed on 2026-09-07.
