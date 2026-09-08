using System.Data;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Fleet.Core.Coordination;
using Microsoft.EntityFrameworkCore;

namespace Fleet.Server.Persistence;

public sealed class PostgresFleetCoordinator(
    FleetDbContext db,
    TimeProvider clock,
    FleetCoordinationOptions options) : IFleetCoordinator
{
    public async Task<EnrollmentAuthorization> CreateEnrollmentAuthorizationAsync(
        CreateEnrollmentAuthorization command, CancellationToken cancellationToken = default)
    {
        var now = clock.GetUtcNow();
        if (command.ExpiresAt <= now || command.RetryWindow <= TimeSpan.Zero)
            throw Error("invalid_enrollment_lifetime", "Enrollment expiry and retry window must be in the future.");

        await EnsureWorkspace(cancellationToken);
        var token = Base64Url(RandomNumberGenerator.GetBytes(32));
        db.Enrollments.Add(new EnrollmentRow
        {
            Id = Guid.NewGuid(),
            WorkspaceId = options.WorkspaceId.Value,
            TokenSha256 = TokenDigest(token),
            CreatedBy = Required(command.CreatedBy, 200, "created_by"),
            ExpiresAt = command.ExpiresAt,
            RetryWindowTicks = command.RetryWindow.Ticks,
        });
        db.AuditEvents.Add(Audit("enrollment_authorization_created", command.CreatedBy, now));
        await db.SaveChangesAsync(cancellationToken);
        return new(token, command.ExpiresAt);
    }

    public async Task<EnrollmentResult> CompleteEnrollmentAsync(
        CompleteEnrollment command, CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        ValidateSha256(command.CertificateRequestSha256, "certificate_request_sha256");
        ValidateSha256(command.IssuedCredential.CertificateSha256, "certificate_sha256");
        if (command.IssuedCredential.DeliveryPayload.Length is 0 or > 64 * 1024)
            throw Error("invalid_delivery_payload", "Credential delivery payload must contain at most 64 KiB.");

        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var now = clock.GetUtcNow();
        var digest = TokenDigest(command.Token);
        var row = await db.Enrollments.FromSqlInterpolated($"SELECT * FROM enrollment_authorizations WHERE \"TokenSha256\" = {digest} FOR UPDATE")
            .SingleOrDefaultAsync(cancellationToken)
            ?? throw Error("invalid_enrollment", "Enrollment authorization is invalid.");

        if (row.WorkspaceId != options.WorkspaceId.Value)
            throw Error("invalid_enrollment", "Enrollment authorization is invalid.");

        if (row.ConsumedAt is not null)
        {
            if (row.CertificateRequestSha256 == command.CertificateRequestSha256 && row.RetryUntil >= now &&
                row.NodeId is Guid nodeId && row.CredentialId is Guid credentialId && row.DeliveryPayload is not null)
                return new(EnrollmentOutcome.Retry, new(nodeId), new(credentialId), row.DeliveryPayload);
            throw Error("invalid_enrollment", "Enrollment authorization is invalid.");
        }
        if (row.ExpiresAt <= now)
            throw Error("invalid_enrollment", "Enrollment authorization is invalid.");
        if (command.IssuedCredential.NotAfter <= now || command.IssuedCredential.NotBefore > now)
            throw Error("invalid_credential_lifetime", "Issued credential is not currently valid.");
        if (command.IssuedCredential.NodeId.Value == Guid.Empty || command.IssuedCredential.CredentialId.Value == Guid.Empty)
            throw Error("invalid_identifier", "Issued Node and credential identifiers are required.");

        db.Nodes.Add(new NodeRow
        {
            Id = command.IssuedCredential.NodeId.Value,
            WorkspaceId = row.WorkspaceId,
            Name = Required(command.NodeName, 200, "node_name"),
            Platform = Required(command.Platform, 100, "platform"),
            EnrolledAt = now,
        });
        db.Credentials.Add(new CredentialRow
        {
            Id = command.IssuedCredential.CredentialId.Value,
            NodeId = command.IssuedCredential.NodeId.Value,
            CertificateSha256 = command.IssuedCredential.CertificateSha256,
            NotBefore = command.IssuedCredential.NotBefore,
            NotAfter = command.IssuedCredential.NotAfter,
        });
        row.ConsumedAt = now;
        row.RetryUntil = now + TimeSpan.FromTicks(row.RetryWindowTicks);
        row.CertificateRequestSha256 = command.CertificateRequestSha256;
        row.NodeId = command.IssuedCredential.NodeId.Value;
        row.CredentialId = command.IssuedCredential.CredentialId.Value;
        row.DeliveryPayload = command.IssuedCredential.DeliveryPayload;
        db.AuditEvents.Add(Audit("node_enrolled", "enrollment", now,
            command.IssuedCredential.NodeId.Value, command.IssuedCredential.CredentialId.Value));
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(EnrollmentOutcome.Enrolled, command.IssuedCredential.NodeId,
            command.IssuedCredential.CredentialId, command.IssuedCredential.DeliveryPayload);
    }

    public async Task RenewCredentialAsync(RenewNodeCredential command, CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var now = clock.GetUtcNow();
        var nodeId = command.Authentication.NodeId.Value;
        var credentialId = command.Authentication.CredentialId.Value;
        var node = await db.Nodes.FromSqlInterpolated($"SELECT * FROM nodes WHERE \"Id\" = {nodeId} FOR UPDATE")
            .SingleOrDefaultAsync(cancellationToken);
        var credential = await db.Credentials.FromSqlInterpolated($"SELECT * FROM node_credentials WHERE \"Id\" = {credentialId} FOR UPDATE")
            .SingleOrDefaultAsync(cancellationToken);
        if (node is null || credential is null || node.WorkspaceId != options.WorkspaceId.Value || node.RevokedAt is not null ||
            credential.NodeId != node.Id || credential.RevokedAt is not null || credential.NotBefore > now || credential.NotAfter <= now ||
            credential.CertificateSha256 != command.Authentication.CertificateSha256)
            throw Error("node_unauthorized", "Node credential is not active.");
        if (command.IssuedCredential.NodeId != command.Authentication.NodeId)
            throw Error("wrong_node", "A renewed credential must belong to the authenticated Node.");
        ValidateSha256(command.IssuedCredential.CertificateSha256, "certificate_sha256");
        if (command.IssuedCredential.NotBefore > now || command.IssuedCredential.NotAfter <= now ||
            command.IssuedCredential.CredentialId.Value == Guid.Empty)
            throw Error("invalid_credential_lifetime", "Issued credential is not currently valid.");
        db.Credentials.Add(new CredentialRow
        {
            Id = command.IssuedCredential.CredentialId.Value,
            NodeId = command.IssuedCredential.NodeId.Value,
            CertificateSha256 = command.IssuedCredential.CertificateSha256,
            NotBefore = command.IssuedCredential.NotBefore,
            NotAfter = command.IssuedCredential.NotAfter,
        });
        db.AuditEvents.Add(Audit("node_credential_renewed", command.Authentication.NodeId.Value.ToString("D"), clock.GetUtcNow(),
            command.Authentication.NodeId.Value, command.IssuedCredential.CredentialId.Value));
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
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
        var row = await db.Nodes.FromSqlInterpolated($"SELECT * FROM nodes WHERE \"Id\" = {id} FOR UPDATE")
            .SingleOrDefaultAsync(cancellationToken)
            ?? throw Error("node_not_found", "Node was not found.");
        if (row.WorkspaceId != options.WorkspaceId.Value) throw Error("node_not_found", "Node was not found.");
        var now = clock.GetUtcNow();
        row.RevokedAt ??= now;
        var actor = Required(revokedBy, 200, "revoked_by");
        db.AuditEvents.Add(Audit("node_revoked", actor, now, nodeId.Value));
        await db.Credentials.Where(x => x.NodeId == nodeId.Value && x.RevokedAt == null)
            .ExecuteUpdateAsync(s => s.SetProperty(x => x.RevokedAt, now).SetProperty(x => x.RevokedBy, actor), cancellationToken);
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    public async Task<NodeAuthentication?> FindActiveNodeByCertificateAsync(string certificateSha256, CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        ValidateSha256(certificateSha256, "certificate_sha256");
        var now = clock.GetUtcNow();
        var found = await (from credential in db.Credentials
                           join node in db.Nodes on credential.NodeId equals node.Id
                           where credential.CertificateSha256 == certificateSha256 && credential.RevokedAt == null &&
                                 credential.NotBefore <= now && credential.NotAfter > now && node.RevokedAt == null &&
                                 node.WorkspaceId == options.WorkspaceId.Value
                           select new { credential.Id, NodeId = node.Id }).SingleOrDefaultAsync(cancellationToken);
        return found is null ? null : new(new(found.NodeId), new(found.Id), certificateSha256);
    }

    public async Task<PublicationResult> AcceptSourceSnapshotAsync(AcceptedSourceSnapshot snapshot, CancellationToken cancellationToken = default)
    {
        Required(snapshot.SourceRevision, 500, "source_revision");
        if (snapshot.Targets.Count > 10_000 || snapshot.Bundles.Count > 20_000 || snapshot.Warnings.Count > 1_000)
            throw Error("snapshot_too_large", "Source snapshot exceeds a collection limit.");
        ValidateSnapshot(snapshot);

        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await EnsureWorkspace(cancellationToken);
        await db.Database.ExecuteSqlRawAsync("SELECT pg_advisory_xact_lock(1179403596)", cancellationToken);
        var existing = await db.DesiredRevisions.AsNoTracking().SingleOrDefaultAsync(
            x => x.WorkspaceId == options.WorkspaceId.Value && x.SourceRevision == snapshot.SourceRevision, cancellationToken);
        if (existing is not null)
            return new(PublicationOutcome.Unchanged, snapshot.SourceRevision, new(existing.Id), null, 0);

        var nodeIds = snapshot.Targets.Select(x => x.NodeId.Value).Distinct().ToArray();
        var knownNodes = await db.Nodes.Where(x => nodeIds.Contains(x.Id) && x.WorkspaceId == options.WorkspaceId.Value)
            .Select(x => x.Id).ToListAsync(cancellationToken);
        if (knownNodes.Count != nodeIds.Length)
            throw Error("unknown_node", "Source snapshot refers to an unknown Node.");
        var suppliedDigests = snapshot.Bundles.Select(x => x.Digest).ToHashSet(StringComparer.Ordinal);
        var referencedDigests = snapshot.Targets.SelectMany(x => x.Skills).Select(x => x.BundleDigest)
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

        var revision = new DesiredRevisionRow
        {
            Id = Guid.NewGuid(),
            WorkspaceId = options.WorkspaceId.Value,
            SourceRevision = snapshot.SourceRevision,
            AcceptedAt = snapshot.ObservedAt
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

        var changed = new List<(SnapshotTarget Target, AssignmentRow? Current)>();
        foreach (var target in snapshot.Targets)
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
                db.Attempts.Add(new AttemptRow
                {
                    Id = Guid.NewGuid(),
                    AssignmentId = assignment.Id,
                    RolloutId = rollout.Id,
                    NodeId = target.NodeId.Value,
                    State = (int)ConvergenceState.Pending,
                    UpdatedAt = snapshot.ObservedAt
                });
            }
        }
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(PublicationOutcome.Accepted, snapshot.SourceRevision, new(revision.Id),
            rollout is null ? null : new RolloutId(rollout.Id), changed.Count);
    }

    public async Task RecordSourceScanAsync(RecordSourceScan scan, CancellationToken cancellationToken = default)
    {
        if (!Enum.IsDefined(scan.Outcome))
            throw Error("invalid_source_scan_outcome", "Source scan outcome is invalid.");
        if (scan.Diagnostic?.Length > options.MaximumDiagnosticLength || scan.Code?.Length > 100 || scan.SourceRevision?.Length > 500)
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

    public async Task<SourceScanStatus?> GetLatestSourceScanAsync(CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        var row = await db.SourceScans.AsNoTracking().Where(x => x.WorkspaceId == options.WorkspaceId.Value)
            .OrderByDescending(x => x.ObservedAt).ThenByDescending(x => x.Id).FirstOrDefaultAsync(cancellationToken);
        return row is null ? null : new(row.SourceRevision, (SourceScanOutcome)row.Outcome, row.Code,
            row.Diagnostic, row.ObservedAt, row.RequestedBy);
    }

    public Task<PollResult> PollAsync(NodeAuthentication authentication, DateTimeOffset contactedAt, CancellationToken cancellationToken = default) =>
        PollInternal(authentication, contactedAt, null, cancellationToken);

    public Task<PollResult> PollTargetAsync(NodeAuthentication authentication, string targetName, DateTimeOffset contactedAt,
        CancellationToken cancellationToken = default) => PollInternal(authentication, contactedAt, Required(targetName, 100, "target_name"), cancellationToken);

    private async Task<PollResult> PollInternal(NodeAuthentication authentication, DateTimeOffset contactedAt, string? targetName, CancellationToken cancellationToken)
    {
        if (contactedAt > clock.GetUtcNow() + TimeSpan.FromMinutes(5))
            throw Error("invalid_contact_time", "Node contact time is too far in the future.");
        await Authenticate(authentication, contactedAt, true, cancellationToken);
        var assignment = await db.Assignments.AsNoTracking().Where(x => x.NodeId == authentication.NodeId.Value && x.IsCurrent &&
                (x.State == (int)ConvergenceState.Pending || x.State == (int)ConvergenceState.Applying) &&
                (targetName == null || x.TargetName == targetName))
            .OrderBy(x => x.TargetName).FirstOrDefaultAsync(cancellationToken);
        if (assignment is null) return new(null);
        var attempt = await db.Attempts.AsNoTracking().SingleAsync(x => x.AssignmentId == assignment.Id, cancellationToken);
        var skills = await (from item in db.AssignmentSkills
                            join bundle in db.Bundles on item.BundleDigest equals bundle.Digest
                            where item.AssignmentId == assignment.Id
                            orderby item.Ordinal
                            select new AssignmentSkill(item.Name, item.BundleDigest, bundle.Size, bundle.Schema))
            .ToListAsync(cancellationToken);
        return new(new(new(assignment.Id), new(attempt.Id), new(assignment.RolloutId), new(assignment.DesiredRevisionId),
            assignment.TargetName, new(assignment.TargetBase, assignment.TargetPath), skills));
    }

    public async Task<BundleContent> GetBundleAsync(NodeAuthentication authentication, string digest, CancellationToken cancellationToken = default)
    {
        await Authenticate(authentication, clock.GetUtcNow(), true, cancellationToken);
        var authorized = await (from assignment in db.Assignments
                                join skill in db.AssignmentSkills on assignment.Id equals skill.AssignmentId
                                join attempt in db.Attempts on assignment.Id equals attempt.AssignmentId
                                where assignment.NodeId == authentication.NodeId.Value && skill.BundleDigest == digest &&
                                    (assignment.IsCurrent || attempt.State == (int)ConvergenceState.Pending ||
                                     attempt.State == (int)ConvergenceState.Applying)
                                select skill).AnyAsync(cancellationToken);
        if (!authorized) throw Error("bundle_not_authorized", "Bundle is not assigned to this Node.");
        var bundle = await db.Bundles.AsNoTracking().SingleAsync(x => x.Digest == digest, cancellationToken);
        return new(bundle.Digest, bundle.Schema, bundle.Size, bundle.Content);
    }

    public async Task<ReportResult> ReportAttemptAsync(NodeAuthentication authentication, AttemptReport report, CancellationToken cancellationToken = default)
    {
        if (report.Diagnostic?.Length > options.MaximumDiagnosticLength || report.ErrorCode?.Length > 100)
            throw Error("report_too_large", "Attempt report exceeds a text limit.");
        if (report.State is ConvergenceState.Pending or ConvergenceState.Superseded)
            throw Error("invalid_transition", "Agent reports may be applying, succeeded, or failed.");
        if (report.ReportedAt > clock.GetUtcNow() + TimeSpan.FromMinutes(5))
            throw Error("invalid_report_time", "Attempt report time is too far in the future.");
        await Authenticate(authentication, report.ReportedAt, true, cancellationToken);
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var attemptId = report.AttemptId.Value;
        var attemptIdentity = await db.Attempts.AsNoTracking().Where(x => x.Id == attemptId)
            .Select(x => new { x.AssignmentId, x.NodeId }).SingleOrDefaultAsync(cancellationToken);
        if (attemptIdentity is null || attemptIdentity.NodeId != authentication.NodeId.Value)
            throw Error("attempt_not_found", "Attempt was not found.");
        var assignmentId = attemptIdentity.AssignmentId;
        var assignment = await db.Assignments.FromSqlInterpolated($"SELECT * FROM assignments WHERE \"Id\" = {assignmentId} FOR UPDATE")
            .SingleAsync(cancellationToken);
        var attempt = await db.Attempts.FromSqlInterpolated($"SELECT * FROM attempts WHERE \"Id\" = {attemptId} FOR UPDATE")
            .SingleAsync(cancellationToken);
        var currentState = (ConvergenceState)attempt.State;
        if (currentState == report.State && attempt.ErrorCode == report.ErrorCode && attempt.Diagnostic == report.Diagnostic)
            return new(ReportOutcome.Duplicate, currentState);
        if (currentState is ConvergenceState.Succeeded or ConvergenceState.Failed)
            throw Error("terminal_attempt", "A terminal Attempt cannot change result.");
        var stale = !assignment.IsCurrent || (ConvergenceState)assignment.State == ConvergenceState.Superseded;
        attempt.State = (int)report.State;
        attempt.ErrorCode = report.ErrorCode;
        attempt.Diagnostic = report.Diagnostic;
        attempt.UpdatedAt = report.ReportedAt;
        if (!stale) assignment.State = (int)report.State;
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(stale ? ReportOutcome.Stale : ReportOutcome.Recorded, report.State);
    }

    public async Task<Page<NodeStatus>> GetNodesAsync(PageRequest page, DateTimeOffset now, TimeSpan staleAfter, CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        var (limit, cursor) = PageArgs(page);
        var rows = await db.Nodes.AsNoTracking().Where(x => x.WorkspaceId == options.WorkspaceId.Value && x.Id.CompareTo(cursor) > 0)
            .OrderBy(x => x.Id).Take(limit + 1).ToListAsync(cancellationToken);
        return MakePage(rows, limit, x => x.Id, x => new NodeStatus(new(x.Id), x.Name, x.RevokedAt != null, x.LastContactAt,
            x.LastContactAt is null ? FreshnessState.NeverContacted : now - x.LastContactAt <= staleAfter ? FreshnessState.Fresh : FreshnessState.Stale));
    }

    public async Task<Page<AttemptStatus>> GetAttemptsAsync(RolloutId rolloutId, PageRequest page, CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        var (limit, cursor) = PageArgs(page);
        var rows = await db.Attempts.AsNoTracking().Where(x => x.RolloutId == rolloutId.Value && x.Id.CompareTo(cursor) > 0)
            .OrderBy(x => x.Id).Take(limit + 1).ToListAsync(cancellationToken);
        return MakePage(rows, limit, x => x.Id, x => new AttemptStatus(new(x.Id), new(x.AssignmentId),
            (ConvergenceState)x.State, x.ErrorCode, x.Diagnostic, x.UpdatedAt));
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

    public async Task<Page<DesiredRevisionStatus>> GetDesiredRevisionsAsync(PageRequest page, CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        var (limit, cursor) = PageArgs(page);
        var rows = await db.DesiredRevisions.AsNoTracking().Where(x => x.Id.CompareTo(cursor) > 0).OrderBy(x => x.Id)
            .Take(limit + 1).ToListAsync(cancellationToken);
        return MakePage(rows, limit, x => x.Id, x => new DesiredRevisionStatus(new(x.Id), x.SourceRevision, x.AcceptedAt));
    }

    public async Task<Page<RolloutStatus>> GetRolloutsAsync(PageRequest page, CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        var (limit, cursor) = PageArgs(page);
        var rows = await db.Rollouts.AsNoTracking().Where(x => x.Id.CompareTo(cursor) > 0).OrderBy(x => x.Id)
            .Take(limit + 1).ToListAsync(cancellationToken);
        var ids = rows.Take(limit).Select(x => x.Id).ToArray();
        var counts = await db.Assignments.Where(x => ids.Contains(x.RolloutId)).GroupBy(x => new { x.RolloutId, x.State })
            .Select(x => new { x.Key.RolloutId, x.Key.State, Count = x.Count() }).ToListAsync(cancellationToken);
        return MakePage(rows, limit, x => x.Id, x => new RolloutStatus(new(x.Id), new(x.DesiredRevisionId), x.CreatedAt,
            Count(x.Id, ConvergenceState.Pending), Count(x.Id, ConvergenceState.Applying), Count(x.Id, ConvergenceState.Succeeded),
            Count(x.Id, ConvergenceState.Failed), Count(x.Id, ConvergenceState.Superseded)));

        int Count(Guid rollout, ConvergenceState state) => counts.FirstOrDefault(c => c.RolloutId == rollout && c.State == (int)state)?.Count ?? 0;
    }

    public async Task<Page<AuditEventStatus>> GetAuditEventsAsync(PageRequest page, CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        var (limit, cursor) = PageArgs(page);
        var rows = await db.AuditEvents.AsNoTracking().Where(x => x.WorkspaceId == options.WorkspaceId.Value && x.Id.CompareTo(cursor) > 0)
            .OrderBy(x => x.Id).Take(limit + 1).ToListAsync(cancellationToken);
        return MakePage(rows, limit, x => x.Id, x => new AuditEventStatus(x.RecordedAt, x.Action, x.Actor,
            x.NodeId is Guid node ? new NodeId(node) : null, x.CredentialId is Guid credential ? new CredentialId(credential) : null));
    }

    public async Task<PersistenceMaintenanceResult> MaintainPersistenceAsync(PersistenceMaintenancePolicy policy,
        CancellationToken cancellationToken = default)
    {
        if (policy.BatchSize is < 1 or > 10_000 || policy.AuditEventRetention <= TimeSpan.Zero ||
            policy.SourceScanRetention <= TimeSpan.Zero)
            throw Error("invalid_retention_policy", "Retention periods must be positive and batch size must be between 1 and 10,000.");
        await EnsureWorkspace(cancellationToken);
        var now = clock.GetUtcNow();
        var workspaceId = options.WorkspaceId.Value;
        var scrubbed = await db.Database.ExecuteSqlInterpolatedAsync($$"""
            WITH expired AS (
                SELECT "Id" FROM enrollment_authorizations
                WHERE "WorkspaceId" = {{workspaceId}} AND "DeliveryPayload" IS NOT NULL AND "RetryUntil" < {{now}}
                ORDER BY "RetryUntil" LIMIT {{policy.BatchSize}} FOR UPDATE SKIP LOCKED
            )
            UPDATE enrollment_authorizations e SET "DeliveryPayload" = NULL
            FROM expired WHERE e."Id" = expired."Id"
            """, cancellationToken);
        var auditDeleted = policy.AuditEventRetention is TimeSpan auditRetention
            ? await DeleteAuditEvents(workspaceId, now - auditRetention, policy.BatchSize, cancellationToken) : 0;
        var scansDeleted = policy.SourceScanRetention is TimeSpan scanRetention
            ? await DeleteSourceScans(workspaceId, now - scanRetention, policy.BatchSize, cancellationToken) : 0;
        return new(scrubbed, auditDeleted, scansDeleted);
    }

    private async Task Authenticate(NodeAuthentication authentication, DateTimeOffset contact, bool updateContact, CancellationToken cancellationToken)
    {
        await EnsureWorkspace(cancellationToken);
        var now = clock.GetUtcNow();
        var valid = await (from credential in db.Credentials
                           join node in db.Nodes on credential.NodeId equals node.Id
                           where credential.Id == authentication.CredentialId.Value && node.Id == authentication.NodeId.Value &&
                                 credential.CertificateSha256 == authentication.CertificateSha256 && credential.RevokedAt == null &&
                                 credential.NotBefore <= now && credential.NotAfter > now && node.RevokedAt == null &&
                                 node.WorkspaceId == options.WorkspaceId.Value
                           select node).SingleOrDefaultAsync(cancellationToken);
        if (valid is null) throw Error("node_unauthorized", "Node credential is not active.");
        if (updateContact)
        {
            var nodeId = authentication.NodeId.Value;
            await db.Database.ExecuteSqlInterpolatedAsync($"UPDATE nodes SET \"LastContactAt\" = GREATEST(COALESCE(\"LastContactAt\", {contact}), {contact}) WHERE \"Id\" = {nodeId}", cancellationToken);
        }
    }

    private async Task<bool> SameTarget(AssignmentRow current, SnapshotTarget target, CancellationToken cancellationToken)
    {
        if (current.TargetBase != target.Descriptor.Base || current.TargetPath != target.Descriptor.Path) return false;
        var skills = await db.AssignmentSkills.AsNoTracking().Where(x => x.AssignmentId == current.Id)
            .OrderBy(x => x.Name).Select(x => new { x.Name, x.BundleDigest }).ToListAsync(cancellationToken);
        var desired = target.Skills.OrderBy(x => x.Name).ToList();
        return skills.Count == desired.Count && skills.Zip(desired).All(x =>
            x.First.Name == x.Second.Name && x.First.BundleDigest == x.Second.BundleDigest);
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
            if (bundle.Size is < 0 or > 16 * 1024 * 1024 || bundle.Size != bundle.Content.LongLength || !DigestMatches(bundle.Digest, bundle.Content))
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
            foreach (var skill in target.Skills)
            {
                Required(skill.Name, 200, "skill_name");
                ValidateSha256(skill.BundleDigest, "bundle_digest");
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

    private async Task EnsureWorkspace(CancellationToken cancellationToken)
    {
        var workspaceId = options.WorkspaceId.Value;
        var workspaceName = options.WorkspaceName;
        await db.Database.ExecuteSqlInterpolatedAsync($"INSERT INTO workspaces (\"Id\", \"SingletonKey\", \"Name\") VALUES ({workspaceId}, 1, {workspaceName}) ON CONFLICT (\"SingletonKey\") DO NOTHING", cancellationToken);
        var actual = await db.Workspaces.AsNoTracking().Select(x => x.Id).SingleAsync(cancellationToken);
        if (actual != workspaceId) throw Error("workspace_mismatch", "The database belongs to a different Workspace.");
    }

    private async Task<int> DeleteAuditEvents(Guid workspaceId, DateTimeOffset cutoff, int batchSize, CancellationToken cancellationToken) =>
        await db.Database.ExecuteSqlInterpolatedAsync($$"""
            WITH expired AS (SELECT "Id" FROM audit_events WHERE "WorkspaceId" = {{workspaceId}} AND "RecordedAt" < {{cutoff}} ORDER BY "RecordedAt" LIMIT {{batchSize}} FOR UPDATE SKIP LOCKED)
            DELETE FROM audit_events a USING expired WHERE a."Id" = expired."Id"
            """, cancellationToken);

    private async Task<int> DeleteSourceScans(Guid workspaceId, DateTimeOffset cutoff, int batchSize, CancellationToken cancellationToken) =>
        await db.Database.ExecuteSqlInterpolatedAsync($$"""
            WITH expired AS (SELECT "Id" FROM source_scans WHERE "WorkspaceId" = {{workspaceId}} AND "ObservedAt" < {{cutoff}} ORDER BY "ObservedAt" LIMIT {{batchSize}} FOR UPDATE SKIP LOCKED)
            DELETE FROM source_scans s USING expired WHERE s."Id" = expired."Id"
            """, cancellationToken);

    private static (int Limit, Guid Cursor) PageArgs(PageRequest page)
    {
        if (page.Limit is < 1 or > PageRequest.MaximumLimit) throw Error("invalid_page", $"Page limit must be between 1 and {PageRequest.MaximumLimit}.");
        return (page.Limit, page.Cursor is null ? Guid.Empty : Guid.TryParse(page.Cursor, out var id) ? id : throw Error("invalid_cursor", "Page cursor is invalid."));
    }

    private static Page<TOut> MakePage<TRow, TOut>(List<TRow> rows, int limit, Func<TRow, Guid> id, Func<TRow, TOut> map)
    {
        var items = rows.Take(limit).Select(map).ToList();
        return new(items, rows.Count > limit ? id(rows[limit - 1]).ToString("D") : null);
    }

    private static string Required(string value, int maximum, string field)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > maximum) throw Error("invalid_" + field, $"{field} is required and bounded.");
        return value;
    }

    private static void ValidateSha256(string value, string field)
    {
        var hex = value.StartsWith("sha256:", StringComparison.Ordinal) ? value[7..] : value;
        if (hex.Length != 64 || !hex.All(Uri.IsHexDigit)) throw Error("invalid_" + field, $"{field} must be a SHA-256 digest.");
    }

    private static bool DigestMatches(string expected, byte[] content)
    {
        var hex = Convert.ToHexString(SHA256.HashData(content)).ToLowerInvariant();
        return string.Equals(expected, hex, StringComparison.OrdinalIgnoreCase) || string.Equals(expected, "sha256:" + hex, StringComparison.OrdinalIgnoreCase);
    }

    private static string TokenDigest(string token) => Convert.ToHexString(SHA256.HashData(
        Encoding.UTF8.GetBytes("fleet-enrollment-token-v1\0" + token))).ToLowerInvariant();
    private static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static CoordinationException Error(string code, string message) => new(code, message);
    private AuditEventRow Audit(string action, string actor, DateTimeOffset at, Guid? nodeId = null, Guid? credentialId = null) =>
        new()
        {
            Id = Guid.NewGuid(),
            WorkspaceId = options.WorkspaceId.Value,
            RecordedAt = at,
            Action = action,
            Actor = Required(actor, 200, "actor"),
            NodeId = nodeId,
            CredentialId = credentialId
        };
}
