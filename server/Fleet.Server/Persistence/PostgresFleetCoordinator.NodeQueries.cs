using Fleet.Core.Coordination;
using Microsoft.EntityFrameworkCore;

namespace Fleet.Server.Persistence;

// Operator read models of Nodes (IOperatorQueries): resolving a Node, the Node list, Node detail, its Attempts and check-ins.
public sealed partial class PostgresFleetCoordinator
{
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
            .ToDictionary(x => x.NodeId);
        var updates = (await db.AgentUpdates.AsNoTracking().Where(x => ids.Contains(x.NodeId)).ToListAsync(cancellationToken))
            .ToDictionary(x => x.NodeId, Status);
        return MakePage(rows, limit, x => x.Node.Id, x => new NodeStatus(new(x.Node.Id), x.Node.Name, x.Node.RevokedAt != null,
            x.Node.LastContactAt, Freshness(x.Node.LastContactAt, now, staleAfter), x.Node.Platform, x.Node.EnrolledAt,
            x.Node.RevokedAt, x.CredentialNotAfter, StateCounts(counts.Where(c => c.NodeId == x.Node.Id).Select(c => (c.State, c.Count))),
            x.CurrentRevision, disks.GetValueOrDefault(x.Node.Id),
            agents.TryGetValue(x.Node.Id, out var agent) ? new NodeAgentSummary(agent.AgentVersion,
                AgentTelemetryRules.IsOutdated(agent.AgentVersion, options.LatestAgentVersion), new(agent.OsName, agent.OsVersion), agent.Arch,
                agent.Hostname, x.Node.AgentSelfUpdate) : null,
            updates.GetValueOrDefault(x.Node.Id)));
    }

    private static NodeDiskSummary FullestVolume(IEnumerable<NodeDiskUsageRow> rows)
    {
        var (row, percent) = DiskUsageRules.Fullest(rows, x => x.Label, x => x.UsedBytes, x => x.AvailableBytes);
        return new(row.Label, percent, row.UsedBytes, row.AvailableBytes, row.TotalBytes, row.MeasuredAt);
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
        var drift = (await db.NodeDriftEvents.AsNoTracking().Where(x => x.NodeId == id)
                .OrderByDescending(x => x.DetectedAt).ThenByDescending(x => x.Id).Take(DriftRules.MaximumEvents).ToListAsync(cancellationToken))
            .Select(x => new NodeDriftEvent(x.Target, x.Files, x.DetectedAt)).ToList();
        var telemetry = await db.NodeTelemetries.AsNoTracking().SingleOrDefaultAsync(x => x.NodeId == id, cancellationToken);
        var agent = telemetry is null ? null : new NodeAgent(telemetry.AgentVersion, options.LatestAgentVersion.Text,
            AgentTelemetryRules.IsOutdated(telemetry.AgentVersion, options.LatestAgentVersion),
            new(telemetry.OsName, telemetry.OsVersion, telemetry.OsKernel), telemetry.Arch, telemetry.Hostname, telemetry.User,
            telemetry.InstallMethod, telemetry.ServiceManager, telemetry.StateDirectory, telemetry.ReportedAt, node.AgentSelfUpdate);
        var update = await db.AgentUpdates.AsNoTracking().SingleOrDefaultAsync(x => x.NodeId == id, cancellationToken);
        return new(new(node.Id), node.Name, node.Platform, node.EnrolledAt, node.LastContactAt,
            Freshness(node.LastContactAt, now, staleAfter), node.RevokedAt != null, node.RevokedAt,
            newest is null ? null : new(new(newest.Id), newest.NotBefore, newest.NotAfter, newest.RevokedAt, newest.RevokedBy,
                credentialCount - 1),
            targets, StateCounts(current.Select(x => (x.Assignment.State, 1))), disk, agent, drift, update is null ? null : Status(update));
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

    private const int MaximumCheckinHours = 168;

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

    private static FreshnessState Freshness(DateTimeOffset? lastContactAt, DateTimeOffset now, TimeSpan staleAfter) =>
        lastContactAt is null ? FreshnessState.NeverContacted : now - lastContactAt <= staleAfter ? FreshnessState.Fresh : FreshnessState.Stale;

    private static TargetStateCounts StateCounts(IEnumerable<(int State, int Count)> counts)
    {
        var byState = counts.GroupBy(x => x.State).ToDictionary(x => x.Key, x => x.Sum(item => item.Count));
        int Count(ConvergenceState state) => byState.GetValueOrDefault((int)state);
        return new(Count(ConvergenceState.Pending), Count(ConvergenceState.Applying), Count(ConvergenceState.Succeeded),
            Count(ConvergenceState.Failed), Count(ConvergenceState.Superseded));
    }
}
