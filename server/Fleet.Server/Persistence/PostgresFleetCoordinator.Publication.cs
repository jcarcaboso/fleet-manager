using System.Data;
using System.Text.Json;
using Fleet.Core.Coordination;
using Microsoft.EntityFrameworkCore;

namespace Fleet.Server.Persistence;

// Source publication (ISourcePublication): accepting a snapshot as a desired revision, and source scan records.
public sealed partial class PostgresFleetCoordinator
{
    // Bump when source resolution changes so a Server upgrade can publish new Targets
    // from the same Git commit. Version 2 adds the default skills/claude Target.
    private const int PublicationVersion = 2;

    public async Task<PublicationResult> AcceptSourceSnapshotAsync(AcceptedSourceSnapshot snapshot, CancellationToken cancellationToken = default)
    {
        Required(snapshot.SourceRevision, 500, "source_revision");
        if (snapshot.Targets.Count > 40_000 || snapshot.Bundles.Count > 20_000 || snapshot.Warnings.Count > 1_000)
            throw Error("snapshot_too_large", "Source snapshot exceeds a collection limit.");
        ValidateSnapshot(snapshot);

        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await EnsureWorkspace(cancellationToken);
        await db.Database.ExecuteSqlRawAsync(PublicationLockSql, cancellationToken);
        var existing = await db.DesiredRevisions.AsNoTracking().SingleOrDefaultAsync(
            x => x.WorkspaceId == options.WorkspaceId.Value && x.SourceRevision == snapshot.SourceRevision &&
                 x.PublicationVersion == PublicationVersion, cancellationToken);
        if (existing is not null)
            return new(PublicationOutcome.Unchanged, snapshot.SourceRevision, new(existing.Id), null, 0);

        var nodeIds = snapshot.Targets.Select(x => x.NodeId.Value).Distinct().ToArray();
        var knownNodes = await db.Nodes.Where(x => nodeIds.Contains(x.Id) && x.WorkspaceId == options.WorkspaceId.Value)
            .Select(x => x.Id).ToListAsync(cancellationToken);
        if (knownNodes.Count != nodeIds.Length)
            throw Error("unknown_node", "Source snapshot refers to an unknown Node.");
        var suppliedDigests = snapshot.Bundles.Select(x => x.Digest).ToHashSet(StringComparer.Ordinal);
        var referencedDigests = snapshot.Targets.SelectMany(x => x.Skills).Select(x => x.BundleDigest)
            .Concat(snapshot.Targets.Select(x => x.File?.BundleDigest).OfType<string>())
            .Where(x => !suppliedDigests.Contains(x)).Distinct().ToArray();
        var storedDigestCount = await db.Bundles.CountAsync(x => referencedDigests.Contains(x.Digest), cancellationToken);
        if (storedDigestCount != referencedDigests.Length)
            throw Error("unknown_bundle", "Target refers to an unknown Bundle.");

        foreach (var bundle in snapshot.Bundles)
        {
            if (!await db.Bundles.AnyAsync(x => x.Digest == bundle.Digest, cancellationToken))
                db.Bundles.Add(new BundleRow
                {
                    Digest = bundle.Digest,
                    Schema = bundle.Schema,
                    Size = bundle.Size,
                    Content = bundle.Content,
                    CreatedAt = snapshot.ObservedAt
                });
        }

        // Informational: sanitized again here, so whatever supplied the snapshot cannot store control characters or long text.
        var commit = CommitMetadataRules.Sanitize(snapshot.Commit);
        var revision = new DesiredRevisionRow
        {
            Id = Guid.NewGuid(),
            WorkspaceId = options.WorkspaceId.Value,
            SourceRevision = snapshot.SourceRevision,
            PublicationVersion = PublicationVersion,
            AcceptedAt = snapshot.ObservedAt,
            CommitSubject = commit?.Subject,
            CommitAuthor = commit?.Author,
            CommittedAt = commit?.CommittedAt
        };
        db.DesiredRevisions.Add(revision);
        db.SourceScans.Add(new SourceScanRow
        {
            Id = Guid.NewGuid(),
            WorkspaceId = options.WorkspaceId.Value,
            SourceRevision = snapshot.SourceRevision,
            Outcome = (int)SourceScanOutcome.Accepted,
            ObservedAt = snapshot.ObservedAt
        });
        foreach (var warning in snapshot.Warnings)
            db.Warnings.Add(new WarningRow
            {
                Id = Guid.NewGuid(),
                DesiredRevisionId = revision.Id,
                Code = warning.Code,
                Message = warning.Message,
                SourceLocations = JsonSerializer.Serialize(warning.SourceLocations)
            });

        var targets = snapshot.Targets.ToList();
        var desired = targets.Select(target => (target.NodeId.Value, target.TargetName)).ToHashSet();
        var previouslyManaged = await (from assignment in db.Assignments.AsNoTracking()
                                       join client in db.AssignmentAiClients.AsNoTracking() on assignment.Id equals client.AssignmentId
                                       where assignment.IsCurrent && client.Mode == "cliproxy"
                                       select new { assignment.NodeId, assignment.TargetName, assignment.TargetBase, assignment.TargetPath, client.Client })
            .ToListAsync(cancellationToken);
        foreach (var previous in previouslyManaged.Where(previous => !desired.Contains((previous.NodeId, previous.TargetName))))
            targets.Add(new SnapshotTarget(new(previous.NodeId), previous.TargetName,
                new(previous.TargetBase, previous.TargetPath), [],
                AiClient: new(CliProxyRules.AiClientSchema, previous.Client, "native")));

        var changed = new List<(SnapshotTarget Target, AssignmentRow? Current)>();
        foreach (var target in targets)
        {
            var targetNodeId = target.NodeId.Value;
            var targetName = target.TargetName;
            var current = await db.Assignments.FromSqlInterpolated($"SELECT * FROM assignments WHERE \"NodeId\" = {targetNodeId} AND \"TargetName\" = {targetName} AND \"IsCurrent\" FOR UPDATE")
                .SingleOrDefaultAsync(cancellationToken);
            if (current is not null && (current.TargetBase != target.Descriptor.Base || current.TargetPath != target.Descriptor.Path))
                throw Error("target_relocation_not_supported", "An active Target descriptor cannot be changed.");
            if (current is null || !await SameTarget(current, target, cancellationToken)) changed.Add((target, current));
        }

        RolloutRow? rollout = null;
        if (changed.Count > 0)
        {
            rollout = new() { Id = Guid.NewGuid(), DesiredRevisionId = revision.Id, CreatedAt = snapshot.ObservedAt };
            db.Rollouts.Add(rollout);
            foreach (var (target, current) in changed)
            {
                if (current is not null)
                {
                    current.IsCurrent = false;
                    current.State = (int)ConvergenceState.Superseded;
                    await db.Attempts.Where(x => x.AssignmentId == current.Id &&
                            (x.State == (int)ConvergenceState.Pending || x.State == (int)ConvergenceState.Applying))
                        .ExecuteUpdateAsync(s => s.SetProperty(x => x.State, (int)ConvergenceState.Superseded)
                            .SetProperty(x => x.UpdatedAt, snapshot.ObservedAt), cancellationToken);
                }
                var assignment = new AssignmentRow
                {
                    Id = Guid.NewGuid(),
                    RolloutId = rollout.Id,
                    DesiredRevisionId = revision.Id,
                    NodeId = target.NodeId.Value,
                    TargetName = target.TargetName,
                    TargetBase = target.Descriptor.Base,
                    TargetPath = target.Descriptor.Path,
                    IsCurrent = true,
                    State = (int)ConvergenceState.Pending,
                    CreatedAt = snapshot.ObservedAt
                };
                db.Assignments.Add(assignment);
                var ordinal = 0;
                foreach (var skill in target.Skills)
                    db.AssignmentSkills.Add(new AssignmentSkillRow
                    {
                        AssignmentId = assignment.Id,
                        Name = skill.Name,
                        BundleDigest = skill.BundleDigest,
                        Ordinal = ordinal++
                    });
                if (target.File is not null)
                    db.AssignmentFiles.Add(new AssignmentFileRow
                    {
                        AssignmentId = assignment.Id,
                        Name = target.File.Name,
                        BundleDigest = target.File.BundleDigest,
                    });
                if (target.AiClient is not null)
                    db.AssignmentAiClients.Add(new AssignmentAiClientRow
                    {
                        AssignmentId = assignment.Id,
                        Schema = target.AiClient.Schema,
                        Client = target.AiClient.Client,
                        Mode = target.AiClient.Mode,
                        BaseUrl = target.AiClient.BaseUrl,
                        Model = target.AiClient.Model,
                    });
                db.Attempts.Add(NewPendingAttempt(assignment.Id, rollout.Id, target.NodeId.Value, snapshot.ObservedAt));
            }
        }
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(PublicationOutcome.Accepted, snapshot.SourceRevision, new(revision.Id),
            rollout is null ? null : new RolloutId(rollout.Id), changed.Count);
    }

    private async Task<bool> SameTarget(AssignmentRow current, SnapshotTarget target, CancellationToken cancellationToken)
    {
        if (current.TargetBase != target.Descriptor.Base || current.TargetPath != target.Descriptor.Path) return false;
        var skills = await db.AssignmentSkills.AsNoTracking().Where(x => x.AssignmentId == current.Id)
            .OrderBy(x => x.Name).Select(x => new { x.Name, x.BundleDigest }).ToListAsync(cancellationToken);
        var desired = target.Skills.OrderBy(x => x.Name).ToList();
        if (skills.Count != desired.Count || !skills.Zip(desired).All(x =>
            x.First.Name == x.Second.Name && x.First.BundleDigest == x.Second.BundleDigest)) return false;
        var file = await db.AssignmentFiles.AsNoTracking().Where(x => x.AssignmentId == current.Id)
            .Select(x => new { x.Name, x.BundleDigest }).SingleOrDefaultAsync(cancellationToken);
        var sameFile = file is null
            ? target.File is null
            : target.File is not null && file.Name == target.File.Name && file.BundleDigest == target.File.BundleDigest;
        if (!sameFile) return false;
        var aiClient = await db.AssignmentAiClients.AsNoTracking().Where(x => x.AssignmentId == current.Id)
            .Select(x => new { x.Schema, x.Client, x.Mode, x.BaseUrl, x.Model }).SingleOrDefaultAsync(cancellationToken);
        return aiClient is null
            ? target.AiClient is null
            : target.AiClient is not null && aiClient.Schema == target.AiClient.Schema &&
              aiClient.Client == target.AiClient.Client && aiClient.Mode == target.AiClient.Mode &&
              aiClient.BaseUrl == target.AiClient.BaseUrl && aiClient.Model == target.AiClient.Model;
    }

    private static void ValidateSnapshot(AcceptedSourceSnapshot snapshot)
    {
        if (snapshot.Targets.GroupBy(x => (x.NodeId, x.TargetName)).Any(x => x.Count() > 1))
            throw Error("duplicate_target", "Snapshot contains a duplicate Node Target.");
        if (snapshot.Bundles.Select(x => x.Digest).Distinct(StringComparer.Ordinal).Count() != snapshot.Bundles.Count)
            throw Error("duplicate_bundle", "Snapshot contains a duplicate Bundle digest.");
        if (snapshot.Bundles.Aggregate(0L, (total, bundle) => checked(total + bundle.Content.LongLength)) > 256L * 1024 * 1024)
            throw Error("snapshot_too_large", "Bundle content exceeds the 256 MiB snapshot limit.");
        var bundles = snapshot.Bundles.ToDictionary(x => x.Digest, StringComparer.Ordinal);
        foreach (var bundle in snapshot.Bundles)
        {
            ValidateSha256(bundle.Digest, "bundle_digest");
            if (bundle.Size is < 0 or > 16 * 1024 * 1024 || bundle.Size != bundle.Content.LongLength || !BundleDigests.Matches(bundle.Digest, bundle.Schema, bundle.Content))
                throw Error("invalid_bundle_digest", "Bundle size or digest does not match its content.");
            Required(bundle.Schema, 100, "bundle_schema");
        }
        foreach (var target in snapshot.Targets)
        {
            Required(target.TargetName, 100, "target_name"); Required(target.Descriptor.Base, 50, "target_base");
            Required(target.Descriptor.Path, 1_024, "target_path");
            if (target.Descriptor.Base != "home" || target.Descriptor.Path.StartsWith('/') || target.Descriptor.Path.StartsWith('\\') ||
                target.Descriptor.Path.Split(['/', '\\']).Any(x => x is "" or "." or ".."))
                throw Error("invalid_target_descriptor", "Target must be a non-empty relative path below home.");
            if (target.Skills.Count > 10_000 || target.Skills.Select(x => x.Name).Distinct(StringComparer.Ordinal).Count() != target.Skills.Count)
                throw Error("invalid_skills", "Target Skills exceed the limit or contain duplicate names.");
            var isSkills = target.TargetName is "skills" or "skills/claude";
            var isFile = target.TargetName.StartsWith("agent-file/", StringComparison.Ordinal);
            var isAiClient = target.TargetName.StartsWith("ai-client/", StringComparison.Ordinal);
            if ((isSkills ? 1 : 0) + (isFile ? 1 : 0) + (isAiClient ? 1 : 0) != 1 ||
                isSkills && (target.File is not null || target.AiClient is not null) ||
                isFile && (target.File is null || target.AiClient is not null || target.Skills.Count != 0) ||
                isAiClient && (target.AiClient is null || target.File is not null || target.Skills.Count != 0))
                throw Error("invalid_target_content", "Target content does not match its Target type.");
            foreach (var skill in target.Skills)
            {
                Required(skill.Name, 200, "skill_name");
                ValidateSha256(skill.BundleDigest, "bundle_digest");
            }
            if (target.File is not null)
            {
                Required(target.File.Name, 255, "file_name");
                if (target.File.Name.Contains('/') || target.File.Name.Contains('\\') || target.File.Name is "." or "..")
                    throw Error("invalid_file_name", "Managed file name must be one portable path segment.");
                if (target.File.BundleDigest is not null) ValidateSha256(target.File.BundleDigest, "bundle_digest");
            }
            if (target.AiClient is not null)
            {
                Required(target.AiClient.Schema, 100, "ai_client_schema");
                Required(target.AiClient.Client, 100, "ai_client");
                Required(target.AiClient.Mode, 20, "ai_client_mode");
                if (target.AiClient.Schema != CliProxyRules.AiClientSchema ||
                    target.TargetName != $"ai-client/{target.AiClient.Client}" ||
                    !CliProxyRules.AiClients.Contains(target.AiClient.Client) ||
                    target.AiClient.Mode is not ("native" or "cliproxy") ||
                    target.AiClient.Mode == "native" && (target.AiClient.BaseUrl is not null || target.AiClient.Model is not null) ||
                    target.AiClient.Mode == "cliproxy" && (!CliProxyRules.IsValidBaseUrl(target.AiClient.BaseUrl) ||
                        target.AiClient.Model is not null && !CliProxyRules.IsValidModelId(target.AiClient.Model)))
                    throw Error("invalid_ai_client", "AI client assignment is invalid.");
                if (target.AiClient.BaseUrl?.Length > 2_048 || target.AiClient.Model?.Length > 200)
                    throw Error("invalid_ai_client", "AI client assignment exceeds a text limit.");
            }
        }
        foreach (var warning in snapshot.Warnings)
        {
            Required(warning.Code, 100, "warning_code");
            Required(warning.Message, 2_048, "warning_message");
            if (warning.SourceLocations.Count > 100 || warning.SourceLocations.Any(x => string.IsNullOrWhiteSpace(x) || x.Length > 1_024))
                throw Error("invalid_warning_locations", "Warning source locations exceed a count or text limit.");
        }
    }

    public async Task RecordSourceScanAsync(RecordSourceScan scan, CancellationToken cancellationToken = default)
    {
        if (!Enum.IsDefined(scan.Outcome))
            throw Error("invalid_source_scan_outcome", "Source scan outcome is invalid.");
        if (scan.Diagnostic?.Length > AttemptDetailRules.MaximumDiagnosticLength || scan.Code?.Length > 100 || scan.SourceRevision?.Length > 500)
            throw Error("source_scan_too_large", "Source scan metadata exceeds a text limit.");
        await EnsureWorkspace(cancellationToken);
        db.SourceScans.Add(new SourceScanRow
        {
            Id = Guid.NewGuid(),
            WorkspaceId = options.WorkspaceId.Value,
            SourceRevision = scan.SourceRevision,
            Outcome = (int)scan.Outcome,
            Code = scan.Code,
            Diagnostic = scan.Diagnostic,
            ObservedAt = scan.ObservedAt,
            RequestedBy = scan.RequestedBy is null ? null : Required(scan.RequestedBy, 200, "requested_by")
        });
        await db.SaveChangesAsync(cancellationToken);
    }
}
