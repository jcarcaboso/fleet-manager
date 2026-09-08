namespace Fleet.Core.Coordination;

public sealed record PageRequest(int Limit, string? Cursor = null)
{
    public const int MaximumLimit = 200;
}

public sealed record Page<T>(IReadOnlyList<T> Items, string? NextCursor);

public sealed record TargetDescriptor(string Base, string Path);

public sealed record SnapshotBundle(string Digest, string Schema, long Size, byte[] Content);

public sealed record SnapshotSkill(string Name, string BundleDigest);

public sealed record SnapshotTarget(
    NodeId NodeId,
    string TargetName,
    TargetDescriptor Descriptor,
    IReadOnlyList<SnapshotSkill> Skills);

public sealed record SourceWarning(
    string Code,
    string Message,
    IReadOnlyList<string> SourceLocations);

public sealed record AcceptedSourceSnapshot(
    string SourceRevision,
    IReadOnlyList<SnapshotBundle> Bundles,
    IReadOnlyList<SnapshotTarget> Targets,
    IReadOnlyList<SourceWarning> Warnings,
    DateTimeOffset ObservedAt);

public enum PublicationOutcome
{
    Accepted,
    Unchanged,
}

public sealed record PublicationResult(
    PublicationOutcome Outcome,
    string SourceRevision,
    DesiredRevisionId? DesiredRevisionId,
    RolloutId? RolloutId,
    int ChangedAssignmentCount);

public sealed record CreateEnrollmentAuthorization(
    string CreatedBy,
    DateTimeOffset ExpiresAt,
    TimeSpan RetryWindow);

public sealed record EnrollmentAuthorization(
    string Token,
    DateTimeOffset ExpiresAt);

public sealed record IssuedNodeCredential(
    NodeId NodeId,
    CredentialId CredentialId,
    string CertificateSha256,
    DateTimeOffset NotBefore,
    DateTimeOffset NotAfter,
    byte[] DeliveryPayload);

public sealed record CompleteEnrollment(
    string Token,
    string CertificateRequestSha256,
    string NodeName,
    string Platform,
    IssuedNodeCredential IssuedCredential);

public enum EnrollmentOutcome
{
    Enrolled,
    Retry,
}

public sealed record EnrollmentResult(
    EnrollmentOutcome Outcome,
    NodeId NodeId,
    CredentialId CredentialId,
    byte[] DeliveryPayload);

public sealed record NodeAuthentication(
    NodeId NodeId,
    CredentialId CredentialId,
    string CertificateSha256);

public sealed record RenewNodeCredential(
    NodeAuthentication Authentication,
    IssuedNodeCredential IssuedCredential);

public sealed record RenameNodeAlias(
    NodeAuthentication Authentication,
    string Alias);

public sealed record NodeAliasResult(
    NodeId NodeId,
    string Alias);

public sealed record OperatorRenameNodeAlias(
    string CurrentAlias,
    string Alias,
    string RequestedBy);

public enum ConvergenceState
{
    Pending,
    Applying,
    Succeeded,
    Failed,
    Superseded,
}

public sealed record AssignmentSkill(string Name, string BundleDigest, long Size, string Schema);

public sealed record AgentAssignment(
    AssignmentId AssignmentId,
    AttemptId AttemptId,
    RolloutId RolloutId,
    DesiredRevisionId DesiredRevisionId,
    string TargetName,
    TargetDescriptor Target,
    IReadOnlyList<AssignmentSkill> Skills);

public sealed record PollResult(AgentAssignment? Assignment);

public sealed record AttemptReport(
    AttemptId AttemptId,
    ConvergenceState State,
    string? ErrorCode,
    string? Diagnostic,
    DateTimeOffset ReportedAt);

public enum ReportOutcome
{
    Recorded,
    Duplicate,
    Stale,
}

public sealed record ReportResult(ReportOutcome Outcome, ConvergenceState State);

public enum FreshnessState
{
    Fresh,
    Stale,
    NeverContacted,
}

public sealed record NodeStatus(
    NodeId NodeId,
    string Name,
    bool Revoked,
    DateTimeOffset? LastContactAt,
    FreshnessState Freshness);

public sealed record AttemptStatus(
    AttemptId AttemptId,
    AssignmentId AssignmentId,
    ConvergenceState State,
    string? ErrorCode,
    string? Diagnostic,
    DateTimeOffset UpdatedAt);

public sealed record WarningStatus(
    DesiredRevisionId DesiredRevisionId,
    string Code,
    string Message,
    IReadOnlyList<string> SourceLocations);

public sealed record DesiredRevisionStatus(
    DesiredRevisionId DesiredRevisionId,
    string SourceRevision,
    DateTimeOffset AcceptedAt);

public sealed record RolloutStatus(
    RolloutId RolloutId,
    DesiredRevisionId DesiredRevisionId,
    DateTimeOffset CreatedAt,
    int Pending,
    int Applying,
    int Succeeded,
    int Failed,
    int Superseded);

public enum SourceScanOutcome { Accepted, Unchanged, Invalid, Failed }

public sealed record RecordSourceScan(
    string? SourceRevision,
    SourceScanOutcome Outcome,
    string? Code,
    string? Diagnostic,
    DateTimeOffset ObservedAt,
    string? RequestedBy = null);

public sealed record SourceScanStatus(
    string? SourceRevision,
    SourceScanOutcome Outcome,
    string? Code,
    string? Diagnostic,
    DateTimeOffset ObservedAt,
    string? RequestedBy);

public sealed record AuditEventStatus(
    DateTimeOffset RecordedAt,
    string Action,
    string Actor,
    NodeId? NodeId,
    CredentialId? CredentialId);

public sealed record PersistenceMaintenancePolicy(
    TimeSpan? AuditEventRetention,
    TimeSpan? SourceScanRetention,
    int BatchSize = 500);

public sealed record PersistenceMaintenanceResult(
    int EnrollmentPayloadsScrubbed,
    int AuditEventsDeleted,
    int SourceScansDeleted);

public sealed record BundleContent(string Digest, string Schema, long Size, byte[] Content);
