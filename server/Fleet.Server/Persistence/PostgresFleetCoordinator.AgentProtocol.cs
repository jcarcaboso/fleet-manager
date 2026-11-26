using System.Data;
using Fleet.Core.Coordination;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Npgsql;

namespace Fleet.Server.Persistence;

// The Agent protocol (IAgentProtocol): enrollment, credential renewal, the Node's own alias, polls with their check-in,
// Bundles, the CLIProxy credential and Attempt reports. Agent reports about the Node are in AgentReports, update reports in AgentUpdates.
public sealed partial class PostgresFleetCoordinator
{
    public async Task<EnrollmentResult> CompleteEnrollmentAsync(
        CompleteEnrollment command, CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        ValidateSha256(command.CertificateRequestSha256, "certificate_request_sha256");
        ValidateSha256(command.IssuedCredential.CertificateSha256, "certificate_sha256");
        var nodeAlias = Required(command.NodeName, 200, "node_alias");
        if (command.IssuedCredential.DeliveryPayload.Length is 0 or > 64 * 1024)
            throw Error("invalid_delivery_payload", "Credential delivery payload must contain at most 64 KiB.");

        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var now = clock.GetUtcNow();
        var digest = TokenDigest(command.Token);
        var row = await db.Enrollments.FromSqlInterpolated($"SELECT * FROM enrollment_authorizations WHERE \"TokenSha256\" = {digest} FOR UPDATE")
            .SingleOrDefaultAsync(cancellationToken)
            ?? throw Error("invalid_enrollment", "Enrollment authorization is invalid.");

        if (row.WorkspaceId != options.WorkspaceId.Value || row.RevokedAt is not null ||
            row.BoundAlias is not null && !string.Equals(row.BoundAlias, nodeAlias, StringComparison.Ordinal))
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
            Name = nodeAlias,
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
        try
        {
            await db.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateException exception) when (exception.InnerException is PostgresException
        { SqlState: PostgresErrorCodes.UniqueViolation, ConstraintName: "IX_nodes_WorkspaceId_Name" })
        {
            throw Error("node_alias_in_use", "The Node alias is already registered in this Workspace.");
        }
        await transaction.CommitAsync(cancellationToken);
        return new(EnrollmentOutcome.Enrolled, command.IssuedCredential.NodeId,
            command.IssuedCredential.CredentialId, command.IssuedCredential.DeliveryPayload);
    }

    public async Task RenewCredentialAsync(RenewNodeCredential command, CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var now = clock.GetUtcNow();
        await LockActiveCredentialAsync(command.Authentication, now, allowExpired: true, cancellationToken);
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

    public async Task<NodeAliasResult> RenameNodeAliasAsync(
        RenameNodeAlias command, CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        var alias = Required(command.Alias, 200, "node_alias");
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var (node, credential) = await LockActiveCredentialAsync(command.Authentication, clock.GetUtcNow(), allowExpired: false,
            cancellationToken);
        await ChangeNodeAlias(node, alias, node.Id.ToString("D"), credential.Id, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(command.Authentication.NodeId, alias);
    }

    public Task<PollResult> PollAsync(NodeAuthentication authentication, DateTimeOffset contactedAt, CancellationToken cancellationToken = default) =>
        PollInternal(authentication, contactedAt, null, null, cancellationToken);

    public Task<PollResult> PollAsync(NodeAuthentication authentication, DateTimeOffset contactedAt, AgentCapabilities capabilities,
        CancellationToken cancellationToken = default) =>
        PollInternal(authentication, contactedAt, null, capabilities, cancellationToken);

    public Task<PollResult> PollTargetAsync(NodeAuthentication authentication, string targetName, DateTimeOffset contactedAt,
        CancellationToken cancellationToken = default) =>
        PollInternal(authentication, contactedAt, Required(targetName, 100, "target_name"), null, cancellationToken);

    // Capabilities are recorded only when the caller passes them (the poll route always does).
    private async Task<PollResult> PollInternal(NodeAuthentication authentication, DateTimeOffset contactedAt, string? targetName,
        AgentCapabilities? capabilities, CancellationToken cancellationToken)
    {
        if (contactedAt > clock.GetUtcNow() + TimeSpan.FromMinutes(5))
            throw Error("invalid_contact_time", "Node contact time is too far in the future.");
        var selfUpdate = capabilities?.HasFlag(AgentCapabilities.AgentUpdate);
        var node = await Authenticate(authentication, contactedAt, true, cancellationToken, selfUpdate);
        var result = await FindPollAssignment(authentication, targetName, capabilities ?? AgentCapabilities.None, cancellationToken) with
        {
            DiskUsageRequested = node.DiskUsageRefreshRequestedAt is not null,
            AgentUpdate = selfUpdate == true ? await RequestedAgentUpdate(authentication.NodeId.Value, cancellationToken) : null
        };
        // After the Assignment is found and never part of it: the check-in is telemetry and cannot fail or hold up the poll.
        await RecordCheckin(authentication.NodeId.Value, contactedAt, cancellationToken);
        return result;
    }

    private async Task<PollResult> FindPollAssignment(NodeAuthentication authentication, string? targetName,
        AgentCapabilities capabilities, CancellationToken cancellationToken)
    {
        await RetryFailedAiAssignment(authentication.NodeId.Value, targetName, cancellationToken);
        var claudeSkills = capabilities.HasFlag(AgentCapabilities.ClaudeSkills);
        var antigravity = capabilities.HasFlag(AgentCapabilities.Antigravity);
        var assignment = await db.Assignments.AsNoTracking().Where(x => x.NodeId == authentication.NodeId.Value && x.IsCurrent &&
                (x.State == (int)ConvergenceState.Pending || x.State == (int)ConvergenceState.Applying) &&
                (claudeSkills || x.TargetName != "skills/claude") &&
                (antigravity || (x.TargetName != "skills/antigravity" && x.TargetName != "ai-client/antigravity" && x.TargetName != "agent-file/antigravity")) &&
                (targetName == null || x.TargetName == targetName))
            .OrderBy(x => x.TargetName).FirstOrDefaultAsync(cancellationToken);
        if (assignment is null) return new(null);
        var attempt = await db.Attempts.AsNoTracking().SingleAsync(x => x.AssignmentId == assignment.Id &&
            (x.State == (int)ConvergenceState.Pending || x.State == (int)ConvergenceState.Applying), cancellationToken);
        var skills = await (from item in db.AssignmentSkills
                            join bundle in db.Bundles on item.BundleDigest equals bundle.Digest
                            where item.AssignmentId == assignment.Id
                            orderby item.Ordinal
                            select new AssignmentSkill(item.Name, item.BundleDigest, bundle.Size, bundle.Schema))
            .ToListAsync(cancellationToken);
        var file = await (from item in db.AssignmentFiles
                          join bundle in db.Bundles on item.BundleDigest equals bundle.Digest into available
                          from bundle in available.DefaultIfEmpty()
                          where item.AssignmentId == assignment.Id
                          select new AssignmentFile(item.Name, item.BundleDigest,
                              bundle == null ? null : bundle.Size, bundle == null ? null : bundle.Schema))
            .SingleOrDefaultAsync(cancellationToken);
        var aiClient = await db.AssignmentAiClients.AsNoTracking()
            .Where(item => item.AssignmentId == assignment.Id)
            .Select(item => new AiClientAssignment(item.Schema, item.Client, item.Mode, item.BaseUrl, item.Model))
            .SingleOrDefaultAsync(cancellationToken);
        return new(new(new(assignment.Id), new(attempt.Id), new(assignment.RolloutId), new(assignment.DesiredRevisionId),
            assignment.TargetName, new(assignment.TargetBase, assignment.TargetPath), skills, file, aiClient));
    }

    private async Task RetryFailedAiAssignment(Guid nodeId, string? targetName, CancellationToken ct)
    {
        if (await db.Assignments.AnyAsync(x => x.NodeId == nodeId && x.IsCurrent &&
            (targetName == null || x.TargetName == targetName) &&
            (x.State == (int)ConvergenceState.Pending || x.State == (int)ConvergenceState.Applying), ct)) return;
        var cutoff = clock.GetUtcNow().AddMinutes(-1);
        var candidate = await db.Assignments.AsNoTracking()
            .Where(x => x.NodeId == nodeId && x.IsCurrent && x.State == (int)ConvergenceState.Failed &&
                (targetName == null || x.TargetName == targetName) &&
                db.AssignmentAiClients.Any(client => client.AssignmentId == x.Id) &&
                db.Attempts.Where(attempt => attempt.AssignmentId == x.Id).OrderByDescending(attempt => attempt.UpdatedAt)
                    .Select(attempt => attempt.ErrorCode).First() == "ai_client_reconcile_failed" &&
                !db.Attempts.Any(attempt => attempt.AssignmentId == x.Id && attempt.UpdatedAt > cutoff))
            .OrderBy(x => x.TargetName).Select(x => (Guid?)x.Id).FirstOrDefaultAsync(ct);
        if (candidate is not { } assignmentId) return;
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        var assignment = await db.Assignments.FromSqlInterpolated($"SELECT * FROM assignments WHERE \"Id\" = {assignmentId} FOR UPDATE")
            .SingleAsync(ct);
        // A concurrent poll or publication may already have changed the assignment.
        await db.Entry(assignment).ReloadAsync(ct);
        if (!assignment.IsCurrent || assignment.State != (int)ConvergenceState.Failed) return;
        var last = await db.Attempts.AsNoTracking().Where(x => x.AssignmentId == assignmentId)
            .OrderByDescending(x => x.UpdatedAt).FirstAsync(ct);
        if (last.State != (int)ConvergenceState.Failed || last.ErrorCode != "ai_client_reconcile_failed" ||
            last.UpdatedAt > cutoff) return;
        assignment.State = (int)ConvergenceState.Pending;
        db.Attempts.Add(NewPendingAttempt(assignment.Id, assignment.RolloutId, nodeId, clock.GetUtcNow()));
        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
    }

    // A check-in waits at most this long for a lock and runs at most this long, so it can delay a poll only briefly.
    private const string CheckinTimeouts = "SET LOCAL lock_timeout = '500ms'; SET LOCAL statement_timeout = '1500ms'";

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
        authorized = authorized || await (from assignment in db.Assignments
                                          join file in db.AssignmentFiles on assignment.Id equals file.AssignmentId
                                          join attempt in db.Attempts on assignment.Id equals attempt.AssignmentId
                                          where assignment.NodeId == authentication.NodeId.Value && file.BundleDigest == digest &&
                                              (assignment.IsCurrent || attempt.State == (int)ConvergenceState.Pending ||
                                               attempt.State == (int)ConvergenceState.Applying)
                                          select file).AnyAsync(cancellationToken);
        if (!authorized) throw Error("bundle_not_authorized", "Bundle is not assigned to this Node.");
        var bundle = await db.Bundles.AsNoTracking().SingleAsync(x => x.Digest == digest, cancellationToken);
        return new(bundle.Digest, bundle.Schema, bundle.Size, bundle.Content);
    }

    public async Task<string> AuthorizeCliProxyCredentialAsync(NodeAuthentication authentication, CancellationToken cancellationToken = default)
    {
        await Authenticate(authentication, clock.GetUtcNow(), false, cancellationToken);
        var baseUrl = await (from assignment in db.Assignments.AsNoTracking()
                             join aiClient in db.AssignmentAiClients.AsNoTracking() on assignment.Id equals aiClient.AssignmentId
                             where assignment.NodeId == authentication.NodeId.Value && assignment.IsCurrent &&
                                   aiClient.Mode == "cliproxy"
                             select aiClient.BaseUrl).FirstOrDefaultAsync(cancellationToken);
        if (baseUrl is null)
            throw Error("cliproxy_credential_not_authorized", "CLIProxy credential is not assigned to this Node.");
        return baseUrl;
    }

    public async Task<ReportResult> ReportAttemptAsync(NodeAuthentication authentication, AttemptReport report, CancellationToken cancellationToken = default)
    {
        if (report.Diagnostic?.Length > AttemptDetailRules.MaximumDiagnosticLength || report.ErrorCode?.Length > 100)
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
        // Agents send no diagnostic with the report; the detail route may have stored one since, which must not turn a repeat into an error.
        if (currentState == report.State && attempt.ErrorCode == report.ErrorCode &&
            (report.Diagnostic is null && currentState == ConvergenceState.Failed || attempt.Diagnostic == report.Diagnostic))
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

    public async Task RecordAttemptDetailAsync(NodeAuthentication authentication, AttemptId attemptId, AttemptDetail detail,
        CancellationToken cancellationToken = default)
    {
        var clean = AttemptDetailRules.Sanitize(detail);
        await Authenticate(authentication, clock.GetUtcNow(), false, cancellationToken);
        var id = attemptId.Value;
        var nodeId = authentication.NodeId.Value;
        var failed = (int)ConvergenceState.Failed;
        // One conditional UPDATE by Attempt, Node and state: no read-modify-write, and the latest accepted detail wins.
        // The IS DISTINCT FROM test skips the physical write (row version, WAL) when a repeat carries the stored values.
        var updated = await db.Database.ExecuteSqlInterpolatedAsync($$"""
            UPDATE attempts SET "Diagnostic" = {{clean.Diagnostic}}, "FailurePath" = {{clean.Path}}, "FailureStep" = {{clean.Step}}
            WHERE "Id" = {{id}} AND "NodeId" = {{nodeId}} AND "State" = {{failed}}
              AND ("Diagnostic" IS DISTINCT FROM {{clean.Diagnostic}} OR "FailurePath" IS DISTINCT FROM {{clean.Path}}
                OR "FailureStep" IS DISTINCT FROM {{clean.Step}})
            """, cancellationToken);
        if (updated > 0) return;
        // Zero rows is either a refusal or an unchanged repeat of an owned failed Attempt, which is still accepted.
        var state = await db.Attempts.AsNoTracking().Where(x => x.Id == id && x.NodeId == nodeId)
            .Select(x => (int?)x.State).SingleOrDefaultAsync(cancellationToken);
        if (state == failed) return;
        throw state is null ? Error("attempt_not_found", "Attempt was not found.")
            : Error("attempt_not_failed", "Detail can only be added to a failed Attempt.");
    }
}
