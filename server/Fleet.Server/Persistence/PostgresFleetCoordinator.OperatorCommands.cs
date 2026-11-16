using System.Data;
using System.Security.Cryptography;
using Fleet.Core.Coordination;
using Microsoft.EntityFrameworkCore;

namespace Fleet.Server.Persistence;

// Operator commands (IOperatorCommands): enrollment links, Node alias, revocation and removal, retry, disk refresh and issue
// states. Agent update requests are in AgentUpdates.
public sealed partial class PostgresFleetCoordinator
{
    public async Task<EnrollmentAuthorization> CreateEnrollmentAuthorizationAsync(
        CreateEnrollmentAuthorization command, CancellationToken cancellationToken = default)
    {
        var now = clock.GetUtcNow();
        if (command.ExpiresAt <= now || command.RetryWindow <= TimeSpan.Zero)
            throw Error("invalid_enrollment_lifetime", "Enrollment expiry and retry window must be in the future.");

        await EnsureWorkspace(cancellationToken);
        var token = Base64Url(RandomNumberGenerator.GetBytes(32));
        var id = Guid.NewGuid();
        var boundAlias = command.BoundAlias is null ? null : Required(command.BoundAlias, 200, "node_alias");
        db.Enrollments.Add(new EnrollmentRow
        {
            Id = id,
            WorkspaceId = options.WorkspaceId.Value,
            TokenSha256 = TokenDigest(token),
            CreatedBy = Required(command.CreatedBy, 200, "created_by"),
            BoundAlias = boundAlias,
            ExpiresAt = command.ExpiresAt,
            RetryWindowTicks = command.RetryWindow.Ticks,
        });
        db.AuditEvents.Add(Audit("enrollment_authorization_created", command.CreatedBy, now));
        await db.SaveChangesAsync(cancellationToken);
        return new(token, command.ExpiresAt, id, boundAlias);
    }

    public async Task RevokeEnrollmentAuthorizationAsync(
        Guid id, string actor, CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        var validatedActor = Required(actor, 200, "actor");
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var row = await db.Enrollments.FromSqlInterpolated($"SELECT * FROM enrollment_authorizations WHERE \"Id\" = {id} FOR UPDATE")
            .SingleOrDefaultAsync(cancellationToken);
        if (row is null || row.WorkspaceId != options.WorkspaceId.Value)
            throw Error("enrollment_not_found", "Enrollment authorization was not found.");
        if (row.RevokedAt is null)
        {
            row.RevokedAt = clock.GetUtcNow();
            row.RevokedBy = validatedActor;
            db.AuditEvents.Add(Audit("enrollment_authorization_revoked", validatedActor, row.RevokedAt.Value));
            await db.SaveChangesAsync(cancellationToken);
        }
        await transaction.CommitAsync(cancellationToken);
    }

    public async Task<NodeAliasResult> RenameNodeAliasAsOperatorAsync(
        OperatorRenameNodeAlias command, CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        var currentAlias = Required(command.CurrentAlias, 200, "node_alias");
        var alias = Required(command.Alias, 200, "node_alias");
        var actor = Required(command.RequestedBy, 200, "requested_by");
        var workspaceId = options.WorkspaceId.Value;
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var node = await db.Nodes.FromSqlInterpolated($"SELECT * FROM nodes WHERE \"WorkspaceId\" = {workspaceId} AND \"Name\" = {currentAlias} FOR UPDATE")
            .SingleOrDefaultAsync(cancellationToken)
            ?? throw Error("node_not_found", "The Node alias is not registered in this Workspace.");
        if (node.RevokedAt is not null)
            throw Error("node_revoked", "A revoked Node cannot change its alias.");
        await ChangeNodeAlias(node, alias, actor, null, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(new(node.Id), alias);
    }

    public async Task RevokeCredentialAsync(CredentialId credentialId, string revokedBy, CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var id = credentialId.Value;
        var row = await db.Credentials.FromSqlInterpolated($"SELECT * FROM node_credentials WHERE \"Id\" = {id} FOR UPDATE")
            .SingleOrDefaultAsync(cancellationToken)
            ?? throw Error("credential_not_found", "Credential was not found.");
        var belongs = await db.Nodes.AnyAsync(x => x.Id == row.NodeId && x.WorkspaceId == options.WorkspaceId.Value, cancellationToken);
        if (!belongs) throw Error("credential_not_found", "Credential was not found.");
        row.RevokedAt ??= clock.GetUtcNow();
        row.RevokedBy ??= Required(revokedBy, 200, "revoked_by");
        db.AuditEvents.Add(Audit("node_credential_revoked", revokedBy, clock.GetUtcNow(), row.NodeId, row.Id));
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    public async Task RevokeNodeAsync(NodeId nodeId, string revokedBy, CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var id = nodeId.Value;
        var row = await LockNodeAsync(id, cancellationToken);
        var now = clock.GetUtcNow();
        row.RevokedAt ??= now;
        var actor = Required(revokedBy, 200, "revoked_by");
        db.AuditEvents.Add(Audit("node_revoked", actor, now, nodeId.Value));
        await db.Credentials.Where(x => x.NodeId == nodeId.Value && x.RevokedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(x => x.RevokedAt, now).SetProperty(x => x.RevokedBy, actor), cancellationToken);
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    public async Task RemoveNodeAsync(NodeId nodeId, string expectedAlias, string removedBy, CancellationToken cancellationToken = default)
    {
        var alias = Required(expectedAlias, 200, "node_alias");
        var actor = Required(removedBy, 200, "removed_by");
        await EnsureWorkspace(cancellationToken);
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        // Serialize with source publication so it cannot assign work to a disappearing Node.
        await db.Database.ExecuteSqlRawAsync(PublicationLockSql, cancellationToken);
        var id = nodeId.Value;
        var row = await LockNodeAsync(id, cancellationToken);
        if (!string.Equals(row.Name, alias, StringComparison.Ordinal))
            throw Error("node_alias_changed", "Node alias changed; refresh before removing it.");
        // Enrollment delivery is not a foreign key and must not replay deleted credentials.
        await db.Enrollments.Where(x => x.WorkspaceId == row.WorkspaceId && x.NodeId == id)
            .ExecuteDeleteAsync(cancellationToken);
        db.Nodes.Remove(row); // FK cascades remove credentials, assignments, Skills, and attempts.
        db.AuditEvents.Add(Audit("node_removed", actor, clock.GetUtcNow(), id));
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    public async Task<RetryResult> RetryAssignmentAsync(RetryAssignment command, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(command.Target) || command.Target.Length > 100)
            throw Error("invalid_request", "target is required and bounded.");
        var actor = Required(command.RequestedBy, 200, "requested_by");
        await EnsureWorkspace(cancellationToken);
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var nodeId = command.NodeId.Value;
        var node = await LockNodeAsync(nodeId, cancellationToken);
        if (node.RevokedAt is not null) throw Error("node_revoked", "A revoked Node cannot retry Assignments.");
        var target = command.Target;
        var assignment = await db.Assignments.FromSqlInterpolated($"SELECT * FROM assignments WHERE \"NodeId\" = {nodeId} AND \"TargetName\" = {target} AND \"IsCurrent\" FOR UPDATE")
            .SingleOrDefaultAsync(cancellationToken)
            ?? throw Error("target_not_found", "The Node has no current Assignment for that Target.");
        if (assignment.State != (int)ConvergenceState.Failed)
            throw Error("target_not_failed", "Only a failed current Assignment can be retried.");
        var now = clock.GetUtcNow();
        assignment.State = (int)ConvergenceState.Pending;
        var attempt = NewPendingAttempt(assignment.Id, assignment.RolloutId, nodeId, now);
        db.Attempts.Add(attempt);
        db.AuditEvents.Add(Audit("assignment.retry_requested", actor, now, nodeId));
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(new(assignment.Id), new(attempt.Id), ConvergenceState.Pending);
    }

    public async Task<DiskRefreshRequested> RequestDiskUsageRefreshAsync(NodeId nodeId, string requestedBy,
        CancellationToken cancellationToken = default)
    {
        var actor = Required(requestedBy, 200, "requested_by");
        await EnsureWorkspace(cancellationToken);
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var id = nodeId.Value;
        var node = await LockNodeAsync(id, cancellationToken);
        if (node.RevokedAt is not null) throw Error("node_revoked", "A revoked Node cannot report disk usage.");
        if (node.DiskUsageRefreshRequestedAt is { } pending) return new(pending);
        // PostgreSQL keeps microseconds; the first answer must equal what a repeat reads back.
        var now = TruncateToMicroseconds(clock.GetUtcNow());
        node.DiskUsageRefreshRequestedAt = now;
        db.AuditEvents.Add(Audit("node.disk_refresh_requested", actor, now, id));
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(now);
    }

    public async Task<IssueStateEntry?> ChangeIssueStateAsync(ChangeIssueState command, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(command.IssueId) || command.IssueId.Length > IssueStateRules.MaximumIdLength)
            throw Error("invalid_request", $"id is required, at most {IssueStateRules.MaximumIdLength} characters.");
        IssueStateRules.ValidateHours(command.Action, command.Hours);
        var actor = Required(command.Actor, 200, "actor");
        await EnsureWorkspace(cancellationToken);
        var workspaceId = options.WorkspaceId.Value;
        var issueId = command.IssueId;
        var current = command.CurrentIssueIds.ToArray();
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var now = TruncateToMicroseconds(clock.GetUtcNow());
        // Lazy cleanup: snoozes that ran out, and acknowledgements of issues that are no longer current (their occurrence is over).
        await db.Database.ExecuteSqlInterpolatedAsync($$"""
            DELETE FROM issue_states WHERE "WorkspaceId" = {{workspaceId}} AND "IssueId" <> {{issueId}} AND (
                ("State" = 'snoozed' AND "SnoozedUntil" <= {{now}}) OR ("State" = 'acknowledged' AND "IssueId" <> ALL({{current}})))
            """, cancellationToken);
        IssueStateEntry? entry = null;
        DateTimeOffset? since = command.Since is { } value ? TruncateToMicroseconds(value) : null;
        if (command.Action == IssueStateAction.Reopen)
            await db.Database.ExecuteSqlInterpolatedAsync(
                $"DELETE FROM issue_states WHERE \"WorkspaceId\" = {workspaceId} AND \"IssueId\" = {issueId}", cancellationToken);
        else
        {
            var snooze = command.Action == IssueStateAction.Snooze;
            var state = snooze ? IssueStateNames.Snoozed : IssueStateNames.Acknowledged;
            DateTimeOffset? until = snooze ? now.AddHours(command.Hours!.Value) : null;
            await db.Database.ExecuteSqlInterpolatedAsync($$"""
                INSERT INTO issue_states ("WorkspaceId", "IssueId", "State", "Since", "SnoozedUntil", "Actor", "At")
                VALUES ({{workspaceId}}, {{issueId}}, {{state}}, {{since}}, {{until}}, {{actor}}, {{now}})
                ON CONFLICT ("WorkspaceId", "IssueId") DO UPDATE SET "State" = EXCLUDED."State", "Since" = EXCLUDED."Since",
                    "SnoozedUntil" = EXCLUDED."SnoozedUntil", "Actor" = EXCLUDED."Actor", "At" = EXCLUDED."At"
                """, cancellationToken);
            entry = new(issueId, state, since, until, actor, now);
        }
        db.AuditEvents.Add(Audit(command.Action switch
        {
            IssueStateAction.Acknowledge => "issue.acknowledged",
            IssueStateAction.Snooze => "issue.snoozed",
            _ => "issue.reopened"
        }, actor, now, command.NodeId));
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return entry;
    }
}
