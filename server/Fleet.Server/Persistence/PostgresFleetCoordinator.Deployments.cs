using System.Data;
using Fleet.Core.Coordination;
using Microsoft.EntityFrameworkCore;

namespace Fleet.Server.Persistence;

// Phase 4 of the device dashboard: what a revision changes, rollout progress per Node, drift reports and issue states.
public sealed partial class PostgresFleetCoordinator
{
    /// <summary>The most Nodes <c>GET rollouts/{id}</c> lists.</summary>
    public const int MaximumRolloutNodes = 500;

    /// <summary>The most Skill names each of the added, changed and removed lists of a revision holds.</summary>
    public const int MaximumSkillChanges = 200;

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
        int Count(ConvergenceState state) => counts.FirstOrDefault(x => x.State == (int)state)?.Count ?? 0;
        return new(new(rollout.Id), new(rollout.DesiredRevisionId), rollout.SourceRevision, rollout.CreatedAt,
            new(Count(ConvergenceState.Pending), Count(ConvergenceState.Applying), Count(ConvergenceState.Succeeded),
                Count(ConvergenceState.Failed), Count(ConvergenceState.Superseded)), items);
    }

    public async Task RecordDriftAsync(NodeAuthentication authentication, DriftReport report, CancellationToken cancellationToken = default)
    {
        DriftRules.Validate(report);
        await Authenticate(authentication, clock.GetUtcNow(), false, cancellationToken);
        var nodeId = authentication.NodeId.Value;
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        // The Node row lock serializes the reports of one Node, so the pruning below always sees all earlier events, and a Node
        // removed in the meantime cannot violate the foreign key.
        var node = await db.Nodes.FromSqlInterpolated($"SELECT * FROM nodes WHERE \"Id\" = {nodeId} FOR UPDATE").AsNoTracking()
            .SingleOrDefaultAsync(cancellationToken);
        if (node is null || node.RevokedAt is not null) throw Error("node_unauthorized", "Node credential is not active.");
        var target = report.Target;
        if (!await db.Assignments.AnyAsync(x => x.NodeId == nodeId && x.IsCurrent && x.TargetName == target, cancellationToken))
            throw Error("invalid_request", "target is not an assigned Target of this Node.");
        db.NodeDriftEvents.Add(new NodeDriftEventRow
        {
            Id = Guid.CreateVersion7(),
            NodeId = nodeId,
            Target = target,
            Files = [.. report.Files],
            DetectedAt = TruncateToMicroseconds(clock.GetUtcNow())
        });
        await db.SaveChangesAsync(cancellationToken);
        var keep = DriftRules.MaximumEvents;
        await db.Database.ExecuteSqlInterpolatedAsync($$"""
            DELETE FROM node_drift_events WHERE "NodeId" = {{nodeId}} AND "Id" IN (
                SELECT "Id" FROM node_drift_events WHERE "NodeId" = {{nodeId}} ORDER BY "DetectedAt" DESC, "Id" DESC OFFSET {{keep}})
            """, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    public async Task RecordRepairFailuresAsync(NodeAuthentication authentication, RepairFailureReport report,
        CancellationToken cancellationToken = default)
    {
        var clean = RepairFailureRules.Sanitize(report);
        await Authenticate(authentication, clock.GetUtcNow(), false, cancellationToken);
        var nodeId = authentication.NodeId.Value;
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        // The Node row lock serializes the reports of one Node, so the replacement below always starts from the latest stored set,
        // and a Node removed in the meantime cannot violate the foreign key.
        var node = await db.Nodes.FromSqlInterpolated($"SELECT * FROM nodes WHERE \"Id\" = {nodeId} FOR UPDATE").AsNoTracking()
            .SingleOrDefaultAsync(cancellationToken);
        if (node is null || node.RevokedAt is not null) throw Error("node_unauthorized", "Node credential is not active.");
        var targets = clean.Failures.Select(x => x.Target).ToArray();
        var current = targets.Length == 0 ? new Dictionary<string, Guid>() : await db.Assignments.AsNoTracking()
            .Where(x => x.NodeId == nodeId && x.IsCurrent && targets.Contains(x.TargetName))
            .ToDictionaryAsync(x => x.TargetName, x => x.Id, StringComparer.Ordinal, cancellationToken);
        // A failure of an Assignment that is no longer current is a normal race with a new Assignment and is skipped.
        var accepted = clean.Failures.Where(x => current.GetValueOrDefault(x.Target) == x.AssignmentId.Value)
            .ToDictionary(x => x.Target, StringComparer.Ordinal);
        var stored = await db.NodeRepairFailures.Where(x => x.NodeId == nodeId).ToListAsync(cancellationToken);
        var now = TruncateToMicroseconds(clock.GetUtcNow());
        foreach (var row in stored.Where(x => !accepted.ContainsKey(x.Target))) db.NodeRepairFailures.Remove(row);
        foreach (var failure in accepted.Values)
        {
            var row = stored.SingleOrDefault(x => x.Target == failure.Target);
            if (row is null)
            {
                row = new NodeRepairFailureRow { NodeId = nodeId, Target = failure.Target, ErrorCode = failure.ErrorCode, Diagnostic = failure.Diagnostic };
                db.NodeRepairFailures.Add(row);
            }
            // The same failure of the same Assignment keeps the time it started; anything else is a new failure.
            if (row.FailedSince == default || row.AssignmentId != failure.AssignmentId.Value || row.ErrorCode != failure.ErrorCode)
                row.FailedSince = now;
            row.AssignmentId = failure.AssignmentId.Value;
            row.ErrorCode = failure.ErrorCode;
            row.Diagnostic = failure.Diagnostic;
            row.Path = failure.Path;
            row.Step = failure.Step;
            row.ReportedAt = now;
        }
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

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
