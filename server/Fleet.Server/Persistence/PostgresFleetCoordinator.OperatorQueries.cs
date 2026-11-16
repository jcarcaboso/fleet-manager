using System.Text.Json;
using Fleet.Core.Coordination;
using Microsoft.EntityFrameworkCore;

namespace Fleet.Server.Persistence;

// Operator read models (IOperatorQueries) other than Nodes: desired revisions, rollouts, Attempts, warnings, source scans,
// enrollment links, audit events and issue states. Lists added for the device dashboard page newest first with an opaque
// (time, id) cursor and accept 1 to 100 items.
public sealed partial class PostgresFleetCoordinator
{
    /// <summary>The most Nodes <c>GET rollouts/{id}</c> lists.</summary>
    public const int MaximumRolloutNodes = 500;

    /// <summary>The most Skill names each of the added, changed and removed lists of a revision holds.</summary>
    public const int MaximumSkillChanges = 200;

    public async Task<Page<DesiredRevisionSummary>> GetDesiredRevisionsAsync(PageRequest page, CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        if (page.Order == PageOrder.Newest)
        {
            var (newestLimit, after) = OperatorPageArgs(page);
            var query = db.DesiredRevisions.AsNoTracking().Where(x => x.WorkspaceId == options.WorkspaceId.Value);
            if (after is var (at, cursorId))
                query = query.Where(x => x.AcceptedAt < at || x.AcceptedAt == at && x.Id.CompareTo(cursorId) < 0);
            var newest = await query.OrderByDescending(x => x.AcceptedAt).ThenByDescending(x => x.Id).Take(newestLimit + 1)
                .ToListAsync(cancellationToken);
            return MakeTimePage(newest, newestLimit, x => x.AcceptedAt, x => x.Id,
                x => new DesiredRevisionSummary(new(x.Id), x.SourceRevision, x.AcceptedAt, CommitOf(x)));
        }
        var (limit, cursor) = PageArgs(page);
        var rows = await db.DesiredRevisions.AsNoTracking().Where(x => x.Id.CompareTo(cursor) > 0).OrderBy(x => x.Id)
            .Take(limit + 1).ToListAsync(cancellationToken);
        return MakePage(rows, limit, x => x.Id, x => new DesiredRevisionSummary(new(x.Id), x.SourceRevision, x.AcceptedAt, CommitOf(x)));
    }

    private static CommitMetadata? CommitOf(DesiredRevisionRow row) =>
        row.CommitSubject is null && row.CommitAuthor is null && row.CommittedAt is null
            ? null : new(row.CommitSubject, row.CommitAuthor, row.CommittedAt);

    private sealed record SkillPair(string Name, string BundleDigest);

    private sealed record TargetChangeRow(Guid NodeId, bool Added, bool Changed);

    // An Assignment exists only for a Target whose content changed in its revision, so a revision's own Assignments are not its whole
    // state. The state "as of" a revision is, for every (Node, Target), the Assignment of the newest revision up to it. The
    // comparison below therefore works on that state: three set-based statements, none of them per Node or per Assignment.
    public async Task<DesiredRevisionDetail> GetDesiredRevisionAsync(DesiredRevisionId id, CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        var workspaceId = options.WorkspaceId.Value;
        var revisionId = id.Value;
        var revision = await db.DesiredRevisions.AsNoTracking().SingleOrDefaultAsync(x => x.Id == revisionId && x.WorkspaceId == workspaceId,
            cancellationToken) ?? throw Error("revision_not_found", "Desired revision was not found.");
        var at = revision.AcceptedAt;
        var previous = await db.DesiredRevisions.AsNoTracking()
            .Where(x => x.WorkspaceId == workspaceId && (x.AcceptedAt < at || x.AcceptedAt == at && x.Id.CompareTo(revisionId) < 0))
            .OrderByDescending(x => x.AcceptedAt).ThenByDescending(x => x.Id).Select(x => new { x.Id, x.SourceRevision, x.AcceptedAt })
            .FirstOrDefaultAsync(cancellationToken);
        var rolloutId = await db.Rollouts.AsNoTracking().Where(x => x.DesiredRevisionId == revisionId)
            .OrderBy(x => x.CreatedAt).ThenBy(x => x.Id).Select(x => (Guid?)x.Id).FirstOrDefaultAsync(cancellationToken);

        // Distinct (name, digest) pairs of the Assignments that are the state at the revision, and at the previous one.
        var after = await EffectiveSkillsAsync(workspaceId, at, revisionId, cancellationToken);
        var before = previous is null ? [] : await EffectiveSkillsAsync(workspaceId, previous.AcceptedAt, previous.Id, cancellationToken);
        var skills = DiffSkills(before, after);

        // The Assignments created by this revision against the newest earlier Assignment of the same Target and Node. The content
        // signature covers the Skills (name and digest), the managed file and the AI-client settings.
        var rows = await db.Database.SqlQueryRaw<TargetChangeRow>(TargetChangesSql, workspaceId, at, revisionId).ToListAsync(cancellationToken);
        // A Target that leaves the manifest keeps its current Assignment, so nothing is ever removed: the count is 0 by construction.
        var targets = new TargetChanges(rows.Count(x => x.Added), rows.Count(x => x.Changed && !x.Added), 0,
            rows.Where(x => x.Added || x.Changed).Select(x => x.NodeId).Distinct().Count());
        return new(new(revision.Id), revision.SourceRevision, revision.AcceptedAt, CommitOf(revision),
            previous is null ? null : new(new(previous.Id), previous.SourceRevision),
            rolloutId is Guid rollout ? new RolloutId(rollout) : null, skills, targets);
    }

    // Built once from constants only; the values travel as parameters {0} (Workspace), {1} (accepted time) and {2} (revision).
    private static readonly string TargetChangesSql = $$"""
            SELECT c."NodeId" AS "NodeId", p."PreviousId" IS NULL AS "Added",
                   p."PreviousId" IS NOT NULL AND {{Signature("c.\"Id\"")}} IS DISTINCT FROM {{Signature("p.\"PreviousId\"")}} AS "Changed"
            FROM assignments c
            LEFT JOIN LATERAL (
                SELECT x."Id" AS "PreviousId" FROM assignments x JOIN desired_revisions r ON r."Id" = x."DesiredRevisionId"
                WHERE x."NodeId" = c."NodeId" AND x."TargetName" = c."TargetName" AND r."WorkspaceId" = {0}
                  AND (r."AcceptedAt" < {1} OR r."AcceptedAt" = {1} AND r."Id" < {2})
                ORDER BY r."AcceptedAt" DESC, r."Id" DESC LIMIT 1) p ON true
            WHERE c."DesiredRevisionId" = {2}
            """;

    private static string Signature(string assignmentId) => $$"""
        concat_ws(chr(29),
            (SELECT COALESCE(string_agg(s."Name" || chr(31) || s."BundleDigest", chr(30) ORDER BY s."Name"), '') FROM assignment_skills s WHERE s."AssignmentId" = {{assignmentId}}),
            (SELECT COALESCE(string_agg(f."Name" || chr(31) || COALESCE(f."BundleDigest", chr(2)), chr(30)), chr(1)) FROM assignment_files f WHERE f."AssignmentId" = {{assignmentId}}),
            (SELECT COALESCE(string_agg(a."Schema" || chr(31) || a."Client" || chr(31) || a."Mode" || chr(31) || COALESCE(a."BaseUrl", chr(2)) || chr(31) || COALESCE(a."Model", chr(2)), chr(30)), chr(1)) FROM assignment_ai_clients a WHERE a."AssignmentId" = {{assignmentId}}))
        """;

    private async Task<List<SkillPair>> EffectiveSkillsAsync(Guid workspaceId, DateTimeOffset at, Guid revisionId,
        CancellationToken cancellationToken) =>
        await db.Database.SqlQueryRaw<SkillPair>("""
            SELECT DISTINCT s."Name" AS "Name", s."BundleDigest" AS "BundleDigest" FROM assignment_skills s
            WHERE s."AssignmentId" IN (
                SELECT DISTINCT ON (a."NodeId", a."TargetName") a."Id"
                FROM assignments a JOIN desired_revisions r ON r."Id" = a."DesiredRevisionId"
                WHERE r."WorkspaceId" = {0} AND (r."AcceptedAt" < {1} OR r."AcceptedAt" = {1} AND r."Id" <= {2})
                ORDER BY a."NodeId", a."TargetName", r."AcceptedAt" DESC, r."Id" DESC)
            """, workspaceId, at, revisionId).ToListAsync(cancellationToken);

    // A name is added when only the newer state has it, removed when only the older one has it and changed when both have it with
    // different sets of digests (one name can carry several digests in different Targets).
    private static SkillChanges DiffSkills(List<SkillPair> before, List<SkillPair> after)
    {
        static Dictionary<string, HashSet<string>> ByName(List<SkillPair> pairs) => pairs.GroupBy(x => x.Name, StringComparer.Ordinal)
            .ToDictionary(x => x.Key, x => x.Select(pair => pair.BundleDigest).ToHashSet(StringComparer.Ordinal), StringComparer.Ordinal);
        var older = ByName(before);
        var newer = ByName(after);
        List<string> Bounded(IEnumerable<string> names) => names.Order(StringComparer.Ordinal).Take(MaximumSkillChanges).ToList();
        return new(Bounded(newer.Keys.Where(x => !older.ContainsKey(x))),
            Bounded(newer.Where(x => older.TryGetValue(x.Key, out var digests) && !digests.SetEquals(x.Value)).Select(x => x.Key)),
            Bounded(older.Keys.Where(x => !newer.ContainsKey(x))));
    }

    public async Task<Page<RolloutStatus>> GetRolloutsAsync(PageRequest page, CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        var newest = page.Order == PageOrder.Newest;
        int limit;
        List<RolloutRow> rows;
        if (newest)
        {
            var (newestLimit, after) = OperatorPageArgs(page);
            limit = newestLimit;
            var query = db.Rollouts.AsNoTracking();
            if (after is var (at, cursorId))
                query = query.Where(x => x.CreatedAt < at || x.CreatedAt == at && x.Id.CompareTo(cursorId) < 0);
            rows = await query.OrderByDescending(x => x.CreatedAt).ThenByDescending(x => x.Id).Take(limit + 1).ToListAsync(cancellationToken);
        }
        else
        {
            var (idLimit, cursor) = PageArgs(page);
            limit = idLimit;
            rows = await db.Rollouts.AsNoTracking().Where(x => x.Id.CompareTo(cursor) > 0).OrderBy(x => x.Id)
                .Take(limit + 1).ToListAsync(cancellationToken);
        }
        var ids = rows.Take(limit).Select(x => x.Id).ToArray();
        var counts = await db.Assignments.Where(x => ids.Contains(x.RolloutId)).GroupBy(x => new { x.RolloutId, x.State })
            .Select(x => new { x.Key.RolloutId, x.Key.State, Count = x.Count() }).ToListAsync(cancellationToken);
        RolloutStatus Map(RolloutRow x)
        {
            var count = StateCounts(counts.Where(c => c.RolloutId == x.Id).Select(c => (c.State, c.Count)));
            return new(new(x.Id), new(x.DesiredRevisionId), x.CreatedAt, count.Pending, count.Applying, count.Succeeded, count.Failed,
                count.Superseded);
        }
        return newest ? MakeTimePage(rows, limit, x => x.CreatedAt, x => x.Id, Map) : MakePage(rows, limit, x => x.Id, Map);
    }

    private sealed record RolloutTargetRow(Guid NodeId, string TargetName, int State, DateTimeOffset CreatedAt, RolloutLatestAttempt? Latest);

    private sealed record RolloutLatestAttempt(string? ErrorCode, DateTimeOffset UpdatedAt);

    private sealed record NodeAttemptTimes(Guid NodeId, DateTimeOffset First, DateTimeOffset Last);

    // The worst state of a Node's Targets decides the Node's state.
    private static readonly ConvergenceState[] WorstFirst =
        [ConvergenceState.Failed, ConvergenceState.Applying, ConvergenceState.Pending, ConvergenceState.Succeeded, ConvergenceState.Superseded];

    public async Task<RolloutDetail> GetRolloutAsync(RolloutId id, CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        var workspaceId = options.WorkspaceId.Value;
        var rolloutId = id.Value;
        var rollout = await (from r in db.Rollouts.AsNoTracking()
                             join revision in db.DesiredRevisions.AsNoTracking() on r.DesiredRevisionId equals revision.Id
                             where r.Id == rolloutId && revision.WorkspaceId == workspaceId
                             select new { r.Id, r.DesiredRevisionId, revision.SourceRevision, r.CreatedAt }).SingleOrDefaultAsync(cancellationToken)
            ?? throw Error("rollout_not_found", "Rollout was not found.");
        var counts = await db.Assignments.AsNoTracking().Where(x => x.RolloutId == rolloutId).GroupBy(x => x.State)
            .Select(x => new { State = x.Key, Count = x.Count() }).ToListAsync(cancellationToken);
        var nodes = await db.Nodes.AsNoTracking()
            .Where(x => x.WorkspaceId == workspaceId && db.Assignments.Any(a => a.RolloutId == rolloutId && a.NodeId == x.Id))
            .OrderBy(x => x.Name).ThenBy(x => x.Id).Take(MaximumRolloutNodes).Select(x => new { x.Id, x.Name }).ToListAsync(cancellationToken);
        var nodeIds = nodes.Select(x => x.Id).ToArray();
        // One bounded row per Assignment: its latest Attempt is a projection in PostgreSQL, because an Assignment can hold thousands.
        var assignments = await db.Assignments.AsNoTracking().Where(a => a.RolloutId == rolloutId && nodeIds.Contains(a.NodeId))
            .Select(a => new RolloutTargetRow(a.NodeId, a.TargetName, a.State, a.CreatedAt,
                db.Attempts.Where(x => x.AssignmentId == a.Id).OrderByDescending(x => x.UpdatedAt).ThenByDescending(x => x.Id)
                    .Select(x => new RolloutLatestAttempt(x.ErrorCode, x.UpdatedAt)).FirstOrDefault()))
            .ToListAsync(cancellationToken);
        var times = (await db.Attempts.AsNoTracking().Where(x => x.RolloutId == rolloutId && nodeIds.Contains(x.NodeId)).GroupBy(x => x.NodeId)
            .Select(x => new NodeAttemptTimes(x.Key, x.Min(a => a.UpdatedAt), x.Max(a => a.UpdatedAt))).ToListAsync(cancellationToken))
            .ToDictionary(x => x.NodeId);
        var byNode = assignments.ToLookup(x => x.NodeId);
        var items = nodes.Select(node =>
        {
            var targets = byNode[node.Id].OrderBy(x => x.TargetName, StringComparer.Ordinal)
                .Select(x => new RolloutTargetProgress(x.TargetName, (ConvergenceState)x.State, x.Latest?.ErrorCode, x.Latest?.UpdatedAt ?? x.CreatedAt))
                .ToList();
            var state = targets.Select(x => Array.IndexOf(WorstFirst, x.State)).DefaultIfEmpty(WorstFirst.Length - 1).Min();
            var seen = times.GetValueOrDefault(node.Id);
            return new RolloutNodeProgress(new(node.Id), node.Name, WorstFirst[state], seen?.First, seen?.Last, targets);
        }).ToList();
        return new(new(rollout.Id), new(rollout.DesiredRevisionId), rollout.SourceRevision, rollout.CreatedAt,
            StateCounts(counts.Select(x => (x.State, x.Count))), items);
    }

    public async Task<Page<AttemptStatus>> GetAttemptsAsync(RolloutId rolloutId, PageRequest page, CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        var (limit, cursor) = PageArgs(page);
        var rows = await db.Attempts.AsNoTracking().Where(x => x.RolloutId == rolloutId.Value && x.Id.CompareTo(cursor) > 0)
            .OrderBy(x => x.Id).Take(limit + 1).ToListAsync(cancellationToken);
        return MakePage(rows, limit, x => x.Id, x => new AttemptStatus(new(x.Id), new(x.AssignmentId),
            (ConvergenceState)x.State, x.ErrorCode, x.Diagnostic, x.FailurePath, x.FailureStep, x.UpdatedAt));
    }

    public async Task<Page<WarningStatus>> GetWarningsAsync(PageRequest page, CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        var (limit, cursor) = PageArgs(page);
        var rows = await db.Warnings.AsNoTracking().Where(x => x.Id.CompareTo(cursor) > 0).OrderBy(x => x.Id)
            .Take(limit + 1).ToListAsync(cancellationToken);
        return MakePage(rows, limit, x => x.Id, x => new WarningStatus(new(x.DesiredRevisionId), x.Code, x.Message,
            JsonSerializer.Deserialize<string[]>(x.SourceLocations) ?? []));
    }

    public async Task<SourceScanStatus?> GetLatestSourceScanAsync(CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        var row = await db.SourceScans.AsNoTracking().Where(x => x.WorkspaceId == options.WorkspaceId.Value)
            .OrderByDescending(x => x.ObservedAt).ThenByDescending(x => x.Id).FirstOrDefaultAsync(cancellationToken);
        return row is null ? null : new(row.SourceRevision, (SourceScanOutcome)row.Outcome, row.Code,
            row.Diagnostic, row.ObservedAt, row.RequestedBy);
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
        x.Event.CredentialId is Guid credential ? new CredentialId(credential) : null, x.NodeName, x.Event.Account, x.Event.Detail);

    public async Task<IReadOnlyDictionary<string, IssueStateEntry>> GetIssueStatesAsync(IReadOnlyCollection<string> issueIds,
        CancellationToken cancellationToken = default)
    {
        if (issueIds.Count == 0) return new Dictionary<string, IssueStateEntry>();
        await EnsureWorkspace(cancellationToken);
        var workspaceId = options.WorkspaceId.Value;
        var ids = issueIds.ToArray();
        return (await db.IssueStates.AsNoTracking().Where(x => x.WorkspaceId == workspaceId && ids.Contains(x.IssueId)).ToListAsync(cancellationToken))
            .ToDictionary(x => x.IssueId, x => new IssueStateEntry(x.IssueId, x.State, x.Since, x.SnoozedUntil, x.Actor, x.At), StringComparer.Ordinal);
    }
}
