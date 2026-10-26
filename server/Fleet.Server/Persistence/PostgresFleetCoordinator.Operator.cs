using System.Data;
using System.Globalization;
using System.Text;
using Fleet.Core.Coordination;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Npgsql;

namespace Fleet.Server.Persistence;

// Operator read models and the Operator retry action. Lists added for the device dashboard page newest first
// with an opaque (time, id) cursor and accept 1 to 100 items.
public sealed partial class PostgresFleetCoordinator
{
    private const int CheckinRetentionDays = 7;
    private const int MaximumCheckinHours = 168;
    // A check-in waits at most this long for a lock and runs at most this long, so it can delay a poll only briefly.
    private const string CheckinTimeouts = "SET LOCAL lock_timeout = '500ms'; SET LOCAL statement_timeout = '1500ms'";

    public async Task<NodeId> ResolveNodeAsync(string nodeOrAlias, bool allowRemovedId = false, CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        if (string.IsNullOrWhiteSpace(nodeOrAlias) || nodeOrAlias.Length > 200) throw Error("node_not_found", "Node was not found.");
        var workspaceId = options.WorkspaceId.Value;
        var isId = Guid.TryParse(nodeOrAlias, out var id);
        if (isId && await db.Nodes.AnyAsync(x => x.Id == id && x.WorkspaceId == workspaceId, cancellationToken)) return new(id);
        var byAlias = await db.Nodes.AsNoTracking().Where(x => x.WorkspaceId == workspaceId && x.Name == nodeOrAlias)
            .Select(x => (Guid?)x.Id).FirstOrDefaultAsync(cancellationToken);
        if (byAlias is Guid found) return new(found);
        if (isId && allowRemovedId) return new(id);
        throw Error("node_not_found", "Node was not found.");
    }

    public async Task<Page<NodeStatus>> GetNodesAsync(PageRequest page, DateTimeOffset now, TimeSpan staleAfter, CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        var (limit, cursor) = PageArgs(page);
        var workspaceId = options.WorkspaceId.Value;
        var rows = await (from node in db.Nodes.AsNoTracking()
                          where node.WorkspaceId == workspaceId && node.Id.CompareTo(cursor) > 0
                          orderby node.Id
                          select new
                          {
                              Node = node,
                              CredentialNotAfter = db.Credentials.Where(c => c.NodeId == node.Id && c.RevokedAt == null)
                                  .OrderByDescending(c => c.NotBefore).ThenByDescending(c => c.NotAfter)
                                  .Select(c => (DateTimeOffset?)c.NotAfter).FirstOrDefault(),
                              CurrentRevision = (from a in db.Assignments
                                                 join r in db.DesiredRevisions on a.DesiredRevisionId equals r.Id
                                                 where a.NodeId == node.Id && a.IsCurrent
                                                 orderby r.AcceptedAt descending, r.Id
                                                 select r.SourceRevision).FirstOrDefault()
                          }).Take(limit + 1).ToListAsync(cancellationToken);
        var ids = rows.Take(limit).Select(x => x.Node.Id).ToArray();
        var counts = await db.Assignments.AsNoTracking().Where(x => x.IsCurrent && ids.Contains(x.NodeId))
            .GroupBy(x => new { x.NodeId, x.State }).Select(x => new { x.Key.NodeId, x.Key.State, Count = x.Count() })
            .ToListAsync(cancellationToken);
        // At most two rows per Node; the fullest volume is picked here because used + available can be 0.
        var disks = (await db.NodeDiskUsages.AsNoTracking().Where(x => ids.Contains(x.NodeId)).ToListAsync(cancellationToken))
            .GroupBy(x => x.NodeId).ToDictionary(x => x.Key, x => FullestVolume(x));
        // One row per Node, read for the page only.
        var agents = (await db.NodeTelemetries.AsNoTracking().Where(x => ids.Contains(x.NodeId)).ToListAsync(cancellationToken))
            .ToDictionary(x => x.NodeId, x => new NodeAgentSummary(x.AgentVersion,
                AgentTelemetryRules.IsOutdated(x.AgentVersion, options.LatestAgentVersion), new(x.OsName, x.OsVersion), x.Arch, x.Hostname));
        return MakePage(rows, limit, x => x.Node.Id, x => new NodeStatus(new(x.Node.Id), x.Node.Name, x.Node.RevokedAt != null,
            x.Node.LastContactAt, Freshness(x.Node.LastContactAt, now, staleAfter), x.Node.Platform, x.Node.EnrolledAt,
            x.Node.RevokedAt, x.CredentialNotAfter, StateCounts(counts.Where(c => c.NodeId == x.Node.Id).Select(c => (c.State, c.Count))),
            x.CurrentRevision, disks.GetValueOrDefault(x.Node.Id), agents.GetValueOrDefault(x.Node.Id)));
    }

    private static NodeDiskSummary FullestVolume(IEnumerable<NodeDiskUsageRow> rows)
    {
        var fullest = rows.Select(x => (Row: x, Percent: DiskUsageRules.UsedPercent(x.UsedBytes, x.AvailableBytes)))
            .OrderByDescending(x => x.Percent).ThenBy(x => x.Row.Label, StringComparer.Ordinal).First();
        return new(fullest.Row.Label, fullest.Percent, fullest.Row.UsedBytes, fullest.Row.AvailableBytes, fullest.Row.TotalBytes,
            fullest.Row.MeasuredAt);
    }

    public async Task<NodeDetail> GetNodeDetailAsync(NodeId nodeId, DateTimeOffset now, TimeSpan staleAfter,
        CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        var id = nodeId.Value;
        var workspaceId = options.WorkspaceId.Value;
        var node = await db.Nodes.AsNoTracking().SingleOrDefaultAsync(x => x.Id == id && x.WorkspaceId == workspaceId, cancellationToken)
            ?? throw Error("node_not_found", "Node was not found.");
        var credentials = db.Credentials.AsNoTracking().Where(x => x.NodeId == id);
        var newest = await credentials.OrderByDescending(x => x.NotBefore).ThenByDescending(x => x.NotAfter).ThenBy(x => x.Id)
            .FirstOrDefaultAsync(cancellationToken);
        var credentialCount = await credentials.CountAsync(cancellationToken);

        var current = (await (from assignment in db.Assignments.AsNoTracking()
                              join revision in db.DesiredRevisions.AsNoTracking() on assignment.DesiredRevisionId equals revision.Id
                              where assignment.NodeId == id && assignment.IsCurrent
                              select new { Assignment = assignment, Revision = revision }).ToListAsync(cancellationToken))
            .OrderBy(x => x.Assignment.TargetName, StringComparer.Ordinal).ToList();
        var assignmentIds = current.Select(x => x.Assignment.Id).ToArray();
        var names = current.Select(x => x.Assignment.TargetName).ToArray();

        var skills = (await db.AssignmentSkills.AsNoTracking().Where(x => assignmentIds.Contains(x.AssignmentId))
                .OrderBy(x => x.Ordinal).ToListAsync(cancellationToken))
            .ToLookup(x => x.AssignmentId);
        var files = (await db.AssignmentFiles.AsNoTracking().Where(x => assignmentIds.Contains(x.AssignmentId))
            .ToListAsync(cancellationToken)).ToDictionary(x => x.AssignmentId);
        var aiClients = (await db.AssignmentAiClients.AsNoTracking().Where(x => assignmentIds.Contains(x.AssignmentId))
            .ToListAsync(cancellationToken)).ToDictionary(x => x.AssignmentId);
        // One bounded row per Assignment, computed in PostgreSQL: Assignments can hold thousands of failed Attempts.
        var failed = (int)ConvergenceState.Failed;
        var attempts = (await db.Assignments.AsNoTracking().Where(a => assignmentIds.Contains(a.Id))
            .Select(a => new AssignmentAttempts(a.Id,
                db.Attempts.Count(x => x.AssignmentId == a.Id && x.State == failed),
                db.Attempts.Where(x => x.AssignmentId == a.Id && x.State == failed).Min(x => (DateTimeOffset?)x.UpdatedAt),
                db.Attempts.Where(x => x.AssignmentId == a.Id).OrderByDescending(x => x.UpdatedAt).ThenByDescending(x => x.Id)
                    .Select(x => new LatestAttemptRow(x.Id, x.State, x.ErrorCode, x.Diagnostic, x.FailurePath, x.FailureStep, x.UpdatedAt)).FirstOrDefault()))
            .ToListAsync(cancellationToken)).ToDictionary(x => x.AssignmentId);
        // The newest Assignment of this Target with a succeeded Attempt. A succeeded Assignment becomes superseded when
        // a newer revision replaces it, so its Attempts are the durable record of what the Node last applied.
        var lastSucceeded = (await (from past in db.Assignments.AsNoTracking()
                                    join revision in db.DesiredRevisions.AsNoTracking() on past.DesiredRevisionId equals revision.Id
                                    where past.NodeId == id && names.Contains(past.TargetName) &&
                                          db.Attempts.Any(a => a.AssignmentId == past.Id && a.State == (int)ConvergenceState.Succeeded) &&
                                          !db.Assignments.Any(newer => newer.NodeId == id && newer.TargetName == past.TargetName &&
                                              (newer.CreatedAt > past.CreatedAt || newer.CreatedAt == past.CreatedAt && newer.Id.CompareTo(past.Id) > 0) &&
                                              db.Attempts.Any(a => a.AssignmentId == newer.Id && a.State == (int)ConvergenceState.Succeeded))
                                    select new { past.TargetName, revision.SourceRevision }).ToListAsync(cancellationToken))
            .GroupBy(x => x.TargetName).ToDictionary(x => x.Key, x => x.First().SourceRevision);

        var targets = current.Select(item =>
        {
            var a = item.Assignment;
            attempts.TryGetValue(a.Id, out var summary);
            var attempt = summary?.Latest;
            files.TryGetValue(a.Id, out var file);
            aiClients.TryGetValue(a.Id, out var aiClient);
            lastSucceeded.TryGetValue(a.TargetName, out var lastRevision);
            return new NodeTargetStatus(a.TargetName, a.TargetName.Split('/')[0], a.TargetBase, a.TargetPath, new(a.Id),
                (ConvergenceState)a.State, a.CreatedAt, new(new(item.Revision.Id), item.Revision.SourceRevision, item.Revision.AcceptedAt),
                lastRevision,
                attempt is null ? null : new(new(attempt.Id), (ConvergenceState)attempt.State, attempt.ErrorCode, attempt.Diagnostic, attempt.FailurePath, attempt.FailureStep, attempt.UpdatedAt),
                summary?.FailedCount ?? 0, summary?.FirstFailedAt,
                skills[a.Id].Select(x => new SnapshotSkill(x.Name, x.BundleDigest)).ToList(),
                file is null ? null : new SnapshotFile(file.Name, file.BundleDigest),
                aiClient is null ? null : new NodeAiClientStatus(aiClient.Client, aiClient.Mode, aiClient.BaseUrl, aiClient.Model));
        }).ToList();
        var stored = (await db.NodeDiskUsages.AsNoTracking().Where(x => x.NodeId == id).ToListAsync(cancellationToken))
            .OrderBy(x => x.Label, StringComparer.Ordinal).ToList();
        var disk = stored.Count == 0 && node.DiskUsageRefreshRequestedAt is null ? null
            : new NodeDisk(stored.Count == 0 ? null : stored.Max(x => x.MeasuredAt), node.DiskUsageRefreshRequestedAt,
                stored.Select(x => new NodeDiskVolume(x.Label, x.TotalBytes, x.UsedBytes, x.AvailableBytes,
                    DiskUsageRules.UsedPercent(x.UsedBytes, x.AvailableBytes))).ToList());
        var telemetry = await db.NodeTelemetries.AsNoTracking().SingleOrDefaultAsync(x => x.NodeId == id, cancellationToken);
        var agent = telemetry is null ? null : new NodeAgent(telemetry.AgentVersion, options.LatestAgentVersion.Text,
            AgentTelemetryRules.IsOutdated(telemetry.AgentVersion, options.LatestAgentVersion),
            new(telemetry.OsName, telemetry.OsVersion, telemetry.OsKernel), telemetry.Arch, telemetry.Hostname, telemetry.User,
            telemetry.InstallMethod, telemetry.ServiceManager, telemetry.StateDirectory, telemetry.ReportedAt);
        return new(new(node.Id), node.Name, node.Platform, node.EnrolledAt, node.LastContactAt,
            Freshness(node.LastContactAt, now, staleAfter), node.RevokedAt != null, node.RevokedAt,
            newest is null ? null : new(new(newest.Id), newest.NotBefore, newest.NotAfter, newest.RevokedAt, newest.RevokedBy,
                credentialCount - 1),
            targets, StateCounts(current.Select(x => (x.Assignment.State, 1))), disk, agent);
    }

    private sealed record LatestAttemptRow(Guid Id, int State, string? ErrorCode, string? Diagnostic, string? FailurePath, string? FailureStep,
        DateTimeOffset UpdatedAt);

    private sealed record AssignmentAttempts(Guid AssignmentId, int FailedCount, DateTimeOffset? FirstFailedAt, LatestAttemptRow? Latest);

    public async Task<Page<NodeAttemptStatus>> GetNodeAttemptsAsync(NodeId nodeId, string? targetName, PageRequest page,
        CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        var (limit, after) = OperatorPageArgs(page);
        var id = nodeId.Value;
        var query = from attempt in db.Attempts.AsNoTracking()
                    join assignment in db.Assignments.AsNoTracking() on attempt.AssignmentId equals assignment.Id
                    join revision in db.DesiredRevisions.AsNoTracking() on assignment.DesiredRevisionId equals revision.Id
                    where attempt.NodeId == id
                    select new { Attempt = attempt, assignment.TargetName, revision.SourceRevision };
        if (targetName is not null) query = query.Where(x => x.TargetName == targetName);
        if (after is var (at, cursorId))
            query = query.Where(x => x.Attempt.UpdatedAt < at || x.Attempt.UpdatedAt == at && x.Attempt.Id.CompareTo(cursorId) < 0);
        var rows = await query.OrderByDescending(x => x.Attempt.UpdatedAt).ThenByDescending(x => x.Attempt.Id)
            .Take(limit + 1).ToListAsync(cancellationToken);
        return MakeTimePage(rows, limit, x => x.Attempt.UpdatedAt, x => x.Attempt.Id, x => new NodeAttemptStatus(new(x.Attempt.Id),
            new(x.Attempt.AssignmentId), new(x.Attempt.RolloutId), x.TargetName, x.SourceRevision, (ConvergenceState)x.Attempt.State,
            x.Attempt.ErrorCode, x.Attempt.Diagnostic, x.Attempt.FailurePath, x.Attempt.FailureStep, x.Attempt.UpdatedAt));
    }

    public async Task<NodeCheckins> GetNodeCheckinsAsync(NodeId nodeId, int hours, CancellationToken cancellationToken = default)
    {
        if (hours is < 1 or > MaximumCheckinHours)
            throw Error("invalid_request", $"hours must be between 1 and {MaximumCheckinHours}.");
        await EnsureWorkspace(cancellationToken);
        var id = nodeId.Value;
        if (!await db.Nodes.AnyAsync(x => x.Id == id && x.WorkspaceId == options.WorkspaceId.Value, cancellationToken))
            throw Error("node_not_found", "Node was not found.");
        var last = TruncateToHour(clock.GetUtcNow());
        var first = last.AddHours(-(hours - 1));
        var polls = (await db.NodeCheckins.AsNoTracking().Where(x => x.NodeId == id && x.Hour >= first && x.Hour <= last)
            .ToListAsync(cancellationToken)).ToDictionary(x => x.Hour.UtcTicks, x => x.Polls);
        var buckets = Enumerable.Range(0, hours).Select(offset => first.AddHours(offset))
            .Select(hour => new CheckinBucket(hour, polls.GetValueOrDefault(hour.UtcTicks))).ToList();
        return new(hours, buckets);
    }

    public async Task<RetryResult> RetryAssignmentAsync(RetryAssignment command, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(command.Target) || command.Target.Length > 100)
            throw Error("invalid_request", "target is required and bounded.");
        var actor = Required(command.RequestedBy, 200, "requested_by");
        await EnsureWorkspace(cancellationToken);
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var nodeId = command.NodeId.Value;
        var node = await db.Nodes.FromSqlInterpolated($"SELECT * FROM nodes WHERE \"Id\" = {nodeId} FOR UPDATE")
            .SingleOrDefaultAsync(cancellationToken);
        if (node is null || node.WorkspaceId != options.WorkspaceId.Value) throw Error("node_not_found", "Node was not found.");
        if (node.RevokedAt is not null) throw Error("node_revoked", "A revoked Node cannot retry Assignments.");
        var target = command.Target;
        var assignment = await db.Assignments.FromSqlInterpolated($"SELECT * FROM assignments WHERE \"NodeId\" = {nodeId} AND \"TargetName\" = {target} AND \"IsCurrent\" FOR UPDATE")
            .SingleOrDefaultAsync(cancellationToken)
            ?? throw Error("target_not_found", "The Node has no current Assignment for that Target.");
        if (assignment.State != (int)ConvergenceState.Failed)
            throw Error("target_not_failed", "Only a failed current Assignment can be retried.");
        var now = clock.GetUtcNow();
        assignment.State = (int)ConvergenceState.Pending;
        var attempt = new AttemptRow
        {
            Id = Guid.NewGuid(),
            AssignmentId = assignment.Id,
            RolloutId = assignment.RolloutId,
            NodeId = nodeId,
            State = (int)ConvergenceState.Pending,
            UpdatedAt = now
        };
        db.Attempts.Add(attempt);
        db.AuditEvents.Add(Audit("assignment.retry_requested", actor, now, nodeId));
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(new(assignment.Id), new(attempt.Id), ConvergenceState.Pending);
    }

    public async Task RecordDiskUsageAsync(NodeAuthentication authentication, DiskUsageReport report,
        CancellationToken cancellationToken = default)
    {
        DiskUsageRules.Validate(report);
        await Authenticate(authentication, clock.GetUtcNow(), false, cancellationToken);
        var nodeId = authentication.NodeId.Value;
        var labels = report.Volumes.Select(x => x.Label).ToArray();
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        // The Node row lock serializes reports of one Node with each other and with refresh requests: two concurrent reports with
        // different volumes cannot both survive, and a Node removed in the meantime cannot violate the foreign key.
        var node = await db.Nodes.FromSqlInterpolated($"SELECT * FROM nodes WHERE \"Id\" = {nodeId} FOR UPDATE").AsNoTracking()
            .SingleOrDefaultAsync(cancellationToken);
        if (node is null || node.RevokedAt is not null) throw Error("node_unauthorized", "Node credential is not active.");
        // Taken under the lock: a refresh request that committed before the lock was acquired is older than this receipt, and one that
        // is made later waits for the lock, so a report never clears a request that arrived after it.
        var now = TruncateToMicroseconds(clock.GetUtcNow());
        foreach (var volume in report.Volumes)
            await db.Database.ExecuteSqlInterpolatedAsync($$"""
                INSERT INTO node_disk_usage ("NodeId", "Label", "TotalBytes", "UsedBytes", "AvailableBytes", "MeasuredAt")
                VALUES ({{nodeId}}, {{volume.Label}}, {{volume.TotalBytes}}, {{volume.UsedBytes}}, {{volume.AvailableBytes}}, {{now}})
                ON CONFLICT ("NodeId", "Label") DO UPDATE SET "TotalBytes" = EXCLUDED."TotalBytes", "UsedBytes" = EXCLUDED."UsedBytes",
                    "AvailableBytes" = EXCLUDED."AvailableBytes", "MeasuredAt" = EXCLUDED."MeasuredAt"
                """, cancellationToken);
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"DELETE FROM node_disk_usage WHERE \"NodeId\" = {nodeId} AND \"Label\" <> ALL({labels})", cancellationToken);
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"UPDATE nodes SET \"DiskUsageRefreshRequestedAt\" = NULL WHERE \"Id\" = {nodeId} AND \"DiskUsageRefreshRequestedAt\" <= {now}",
            cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    public async Task RecordAgentTelemetryAsync(NodeAuthentication authentication, AgentTelemetryReport report,
        CancellationToken cancellationToken = default)
    {
        var sanitized = AgentTelemetryRules.Sanitize(report);
        await Authenticate(authentication, clock.GetUtcNow(), false, cancellationToken);
        var nodeId = authentication.NodeId.Value;
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        // The Node row lock serializes reports of one Node, and a Node removed in the meantime cannot violate the foreign key.
        var node = await db.Nodes.FromSqlInterpolated($"SELECT * FROM nodes WHERE \"Id\" = {nodeId} FOR UPDATE").AsNoTracking()
            .SingleOrDefaultAsync(cancellationToken);
        if (node is null || node.RevokedAt is not null) throw Error("node_unauthorized", "Node credential is not active.");
        var now = TruncateToMicroseconds(clock.GetUtcNow());
        await db.Database.ExecuteSqlInterpolatedAsync($$"""
            INSERT INTO node_telemetry ("NodeId", "AgentVersion", "OsName", "OsVersion", "OsKernel", "Arch", "Hostname", "User",
                "InstallMethod", "ServiceManager", "StateDirectory", "ReportedAt")
            VALUES ({{nodeId}}, {{sanitized.AgentVersion}}, {{sanitized.OsName}}, {{sanitized.OsVersion}}, {{sanitized.OsKernel}},
                {{sanitized.Arch}}, {{sanitized.Hostname}}, {{sanitized.User}}, {{sanitized.InstallMethod}}, {{sanitized.ServiceManager}},
                {{sanitized.StateDirectory}}, {{now}})
            ON CONFLICT ("NodeId") DO UPDATE SET "AgentVersion" = EXCLUDED."AgentVersion", "OsName" = EXCLUDED."OsName",
                "OsVersion" = EXCLUDED."OsVersion", "OsKernel" = EXCLUDED."OsKernel", "Arch" = EXCLUDED."Arch",
                "Hostname" = EXCLUDED."Hostname", "User" = EXCLUDED."User", "InstallMethod" = EXCLUDED."InstallMethod",
                "ServiceManager" = EXCLUDED."ServiceManager", "StateDirectory" = EXCLUDED."StateDirectory",
                "ReportedAt" = EXCLUDED."ReportedAt"
            """, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    public async Task<DiskRefreshRequested> RequestDiskUsageRefreshAsync(NodeId nodeId, string requestedBy,
        CancellationToken cancellationToken = default)
    {
        var actor = Required(requestedBy, 200, "requested_by");
        await EnsureWorkspace(cancellationToken);
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var id = nodeId.Value;
        var node = await db.Nodes.FromSqlInterpolated($"SELECT * FROM nodes WHERE \"Id\" = {id} FOR UPDATE")
            .SingleOrDefaultAsync(cancellationToken);
        if (node is null || node.WorkspaceId != options.WorkspaceId.Value) throw Error("node_not_found", "Node was not found.");
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

    public async Task<Page<SourceScanEntry>> GetSourceScansAsync(PageRequest page, CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        var (limit, after) = OperatorPageArgs(page);
        var query = db.SourceScans.AsNoTracking().Where(x => x.WorkspaceId == options.WorkspaceId.Value);
        if (after is var (at, cursorId))
            query = query.Where(x => x.ObservedAt < at || x.ObservedAt == at && x.Id.CompareTo(cursorId) < 0);
        var rows = await query.OrderByDescending(x => x.ObservedAt).ThenByDescending(x => x.Id).Take(limit + 1).ToListAsync(cancellationToken);
        return MakeTimePage(rows, limit, x => x.ObservedAt, x => x.Id, x => new SourceScanEntry(x.Id, x.SourceRevision,
            (SourceScanOutcome)x.Outcome, x.Code, x.Diagnostic, x.ObservedAt, x.RequestedBy));
    }

    public async Task<Page<EnrollmentLinkStatus>> GetEnrollmentLinksAsync(PageRequest page, DateTimeOffset now,
        CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        var (limit, after) = OperatorPageArgs(page);
        var query = db.Enrollments.AsNoTracking().Where(x => x.WorkspaceId == options.WorkspaceId.Value);
        if (after is var (at, cursorId))
            query = query.Where(x => x.ExpiresAt < at || x.ExpiresAt == at && x.Id.CompareTo(cursorId) < 0);
        var rows = await EnrollmentLinkRows(query.OrderByDescending(x => x.ExpiresAt).ThenByDescending(x => x.Id).Take(limit + 1))
            .ToListAsync(cancellationToken);
        return MakeTimePage(rows, limit, x => x.ExpiresAt, x => x.Id, x => ToLink(x, now));
    }

    public async Task<EnrollmentLinkStatus> GetEnrollmentLinkAsync(Guid id, DateTimeOffset now, CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        var row = await EnrollmentLinkRows(db.Enrollments.AsNoTracking().Where(x => x.WorkspaceId == options.WorkspaceId.Value && x.Id == id))
            .FirstOrDefaultAsync(cancellationToken);
        return row is null ? throw Error("enrollment_link_not_found", "Enrollment link was not found.") : ToLink(row, now);
    }

    // The token digest and delivery payload are never selected.
    private static IQueryable<EnrollmentLinkRow> EnrollmentLinkRows(IQueryable<EnrollmentRow> query) => query
        .Select(x => new EnrollmentLinkRow(x.Id, x.BoundAlias, x.ExpiresAt, x.ConsumedAt, x.RevokedAt, x.RevokedBy, x.NodeId));

    private sealed record EnrollmentLinkRow(Guid Id, string? BoundAlias, DateTimeOffset ExpiresAt, DateTimeOffset? ConsumedAt,
        DateTimeOffset? RevokedAt, string? RevokedBy, Guid? NodeId);

    private static EnrollmentLinkStatus ToLink(EnrollmentLinkRow x, DateTimeOffset now) => new(x.Id, x.BoundAlias, x.ExpiresAt,
        x.ConsumedAt, x.RevokedAt, x.RevokedBy, x.NodeId is Guid node ? new NodeId(node) : null,
        x.ConsumedAt is not null ? EnrollmentLinkState.Consumed : x.RevokedAt is not null ? EnrollmentLinkState.Revoked :
        x.ExpiresAt <= now ? EnrollmentLinkState.Expired : EnrollmentLinkState.Active);

    public async Task<Page<AuditEventStatus>> GetAuditEventsAsync(PageRequest page, NodeId? node = null,
        CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        var newest = page.Order == PageOrder.Newest;
        var query = db.AuditEvents.AsNoTracking().Where(x => x.WorkspaceId == options.WorkspaceId.Value);
        if (node is { } filter)
        {
            var nodeId = filter.Value;
            query = query.Where(x => x.NodeId == nodeId);
        }
        int limit;
        if (newest)
        {
            var (newestLimit, after) = OperatorPageArgs(page);
            limit = newestLimit;
            if (after is var (at, cursorId))
                query = query.Where(x => x.RecordedAt < at || x.RecordedAt == at && x.Id.CompareTo(cursorId) < 0);
            query = query.OrderByDescending(x => x.RecordedAt).ThenByDescending(x => x.Id);
        }
        else
        {
            var (idLimit, cursor) = PageArgs(page);
            limit = idLimit;
            query = query.Where(x => x.Id.CompareTo(cursor) > 0).OrderBy(x => x.Id);
        }
        var rows = await query.Take(limit + 1)
            .Select(x => new AuditRowWithName(x, db.Nodes.Where(n => n.Id == x.NodeId).Select(n => n.Name).FirstOrDefault()))
            .ToListAsync(cancellationToken);
        return newest
            ? MakeTimePage(rows, limit, x => x.Event.RecordedAt, x => x.Event.Id, ToAuditStatus)
            : MakePage(rows, limit, x => x.Event.Id, ToAuditStatus);
    }

    private sealed record AuditRowWithName(AuditEventRow Event, string? NodeName);

    private static AuditEventStatus ToAuditStatus(AuditRowWithName x) => new(x.Event.RecordedAt, x.Event.Action, x.Event.Actor,
        x.Event.NodeId is Guid nodeId ? new NodeId(nodeId) : null,
        x.Event.CredentialId is Guid credential ? new CredentialId(credential) : null, x.NodeName);

    // One row per Node and UTC hour. The Node row is selected so a concurrently removed Node cannot violate the foreign key.
    // This is telemetry: it runs in its own short transaction with a lock and statement timeout, and a failure is logged and
    // swallowed, so it can never fail a poll or hold up the Assignment for more than the timeout. Only cancellation propagates.
    private async Task RecordCheckin(Guid nodeId, DateTimeOffset at, CancellationToken cancellationToken)
    {
        try
        {
            var hour = TruncateToHour(at);
            await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
            await db.Database.ExecuteSqlRawAsync(CheckinTimeouts, cancellationToken);
            await db.Database.ExecuteSqlInterpolatedAsync($$"""
                INSERT INTO node_checkins ("NodeId", "Hour", "Polls") SELECT "Id", {{hour}}, 1 FROM nodes WHERE "Id" = {{nodeId}}
                ON CONFLICT ("NodeId", "Hour") DO UPDATE SET "Polls" = node_checkins."Polls" + 1
                """, cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            logger?.LogWarning("Check-in was not recorded: {ErrorType} {SqlState}", exception.GetType().Name,
                (exception as PostgresException)?.SqlState ?? (exception.InnerException as PostgresException)?.SqlState);
        }
    }

    private async Task<int> DeleteCheckins(DateTimeOffset cutoff, int batchSize, CancellationToken cancellationToken) =>
        await db.Database.ExecuteSqlInterpolatedAsync($$"""
            WITH expired AS (SELECT "NodeId", "Hour" FROM node_checkins WHERE "Hour" < {{cutoff}} ORDER BY "Hour" LIMIT {{batchSize}} FOR UPDATE SKIP LOCKED)
            DELETE FROM node_checkins c USING expired WHERE c."NodeId" = expired."NodeId" AND c."Hour" = expired."Hour"
            """, cancellationToken);

    private static DateTimeOffset TruncateToMicroseconds(DateTimeOffset value) => new(value.UtcTicks / 10 * 10, TimeSpan.Zero);

    private static DateTimeOffset TruncateToHour(DateTimeOffset value)
    {
        var utc = value.UtcDateTime;
        return new(utc.Year, utc.Month, utc.Day, utc.Hour, 0, 0, TimeSpan.Zero);
    }

    private static FreshnessState Freshness(DateTimeOffset? lastContactAt, DateTimeOffset now, TimeSpan staleAfter) =>
        lastContactAt is null ? FreshnessState.NeverContacted : now - lastContactAt <= staleAfter ? FreshnessState.Fresh : FreshnessState.Stale;

    private static TargetStateCounts StateCounts(IEnumerable<(int State, int Count)> counts)
    {
        var byState = counts.GroupBy(x => x.State).ToDictionary(x => x.Key, x => x.Sum(item => item.Count));
        int Count(ConvergenceState state) => byState.GetValueOrDefault((int)state);
        return new(Count(ConvergenceState.Pending), Count(ConvergenceState.Applying), Count(ConvergenceState.Succeeded),
            Count(ConvergenceState.Failed), Count(ConvergenceState.Superseded));
    }

    private static (int Limit, (DateTimeOffset At, Guid Id)? After) OperatorPageArgs(PageRequest page)
    {
        if (page.Limit is < 1 or > PageRequest.MaximumLimit)
            throw Error("invalid_request", $"limit must be between 1 and {PageRequest.MaximumLimit}.");
        if (page.Cursor is null) return (page.Limit, null);
        try
        {
            var text = Encoding.UTF8.GetString(Microsoft.AspNetCore.WebUtilities.WebEncoders.Base64UrlDecode(page.Cursor));
            var parts = text.Split(':');
            if (parts.Length == 2 && long.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out var ticks) &&
                ticks <= DateTime.MaxValue.Ticks && Guid.TryParseExact(parts[1], "N", out var id))
                return (page.Limit, (new DateTimeOffset(ticks, TimeSpan.Zero), id));
        }
        catch (FormatException) { }
        throw Error("invalid_request", "after is not a valid cursor for this order.");
    }

    private static Page<TOut> MakeTimePage<TRow, TOut>(List<TRow> rows, int limit, Func<TRow, DateTimeOffset> at, Func<TRow, Guid> id,
        Func<TRow, TOut> map)
    {
        var items = rows.Take(limit).Select(map).ToList();
        if (rows.Count <= limit) return new(items, null);
        var last = rows[limit - 1];
        return new(items, Base64Url(Encoding.UTF8.GetBytes(
            at(last).UtcTicks.ToString(CultureInfo.InvariantCulture) + ":" + id(last).ToString("N"))));
    }
}
