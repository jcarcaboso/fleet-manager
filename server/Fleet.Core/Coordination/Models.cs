using System.Text.Json.Serialization;

namespace Fleet.Core.Coordination;

/// <summary>How a list is ordered: by ID (the default, cursor is the last ID) or newest first by its timestamp, then ID.</summary>
public enum PageOrder { Id, Newest }

public sealed record PageRequest(int Limit, string? Cursor = null, PageOrder Order = PageOrder.Id)
{
    public const int MaximumLimit = 100;
}

public sealed record Page<T>(IReadOnlyList<T> Items, string? NextCursor);

public sealed record TargetDescriptor(string Base, string Path);

public sealed record SnapshotBundle(string Digest, string Schema, long Size, byte[] Content);

public sealed record SnapshotSkill(string Name, string BundleDigest);

public sealed record SnapshotFile(string Name, string? BundleDigest);

public sealed record AiClientAssignment(
    string Schema,
    string Client,
    string Mode,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? BaseUrl = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Model = null);

public sealed record SnapshotTarget(
    NodeId NodeId,
    string TargetName,
    TargetDescriptor Descriptor,
    IReadOnlyList<SnapshotSkill> Skills,
    SnapshotFile? File = null,
    AiClientAssignment? AiClient = null);

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
    TimeSpan RetryWindow,
    string? BoundAlias = null);

public sealed record EnrollmentAuthorization(
    string Token,
    DateTimeOffset ExpiresAt,
    Guid Id = default,
    string? BoundAlias = null);

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

public sealed record AssignmentFile(string Name, string? BundleDigest, long? Size, string? Schema);

public sealed record AgentAssignment(
    AssignmentId AssignmentId,
    AttemptId AttemptId,
    RolloutId RolloutId,
    DesiredRevisionId DesiredRevisionId,
    string TargetName,
    TargetDescriptor Target,
    IReadOnlyList<AssignmentSkill> Skills,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] AssignmentFile? File = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] AiClientAssignment? AiClient = null);

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

public sealed record TargetStateCounts(int Pending, int Applying, int Succeeded, int Failed, int Superseded)
{
    public static TargetStateCounts None { get; } = new(0, 0, 0, 0, 0);
}

public sealed record NodeStatus(
    NodeId NodeId,
    string Name,
    bool Revoked,
    DateTimeOffset? LastContactAt,
    FreshnessState Freshness,
    string Platform,
    DateTimeOffset EnrolledAt,
    DateTimeOffset? RevokedAt,
    DateTimeOffset? CredentialNotAfter,
    TargetStateCounts Targets,
    string? CurrentRevision);

public sealed record NodeCredentialStatus(
    CredentialId CredentialId,
    DateTimeOffset NotBefore,
    DateTimeOffset NotAfter,
    DateTimeOffset? RevokedAt,
    string? RevokedBy,
    int Renewals);

public sealed record NodeLatestAttempt(
    AttemptId AttemptId,
    ConvergenceState State,
    string? ErrorCode,
    string? Diagnostic,
    DateTimeOffset UpdatedAt);

public sealed record NodeAiClientStatus(string Client, string Mode, string? BaseUrl, string? Model);

public sealed record NodeTargetStatus(
    string Name,
    string Kind,
    string Base,
    string Path,
    AssignmentId AssignmentId,
    ConvergenceState State,
    DateTimeOffset AssignedAt,
    DesiredRevisionStatus DesiredRevision,
    string? LastSucceededRevision,
    NodeLatestAttempt? LatestAttempt,
    int FailedAttempts,
    DateTimeOffset? FirstFailedAt,
    IReadOnlyList<SnapshotSkill> Skills,
    SnapshotFile? File,
    NodeAiClientStatus? AiClient);

public sealed record NodeDetail(
    NodeId NodeId,
    string Name,
    string Platform,
    DateTimeOffset EnrolledAt,
    DateTimeOffset? LastContactAt,
    FreshnessState Freshness,
    bool Revoked,
    DateTimeOffset? RevokedAt,
    NodeCredentialStatus? Credential,
    IReadOnlyList<NodeTargetStatus> Targets,
    TargetStateCounts Summary);

public sealed record NodeAttemptStatus(
    AttemptId AttemptId,
    AssignmentId AssignmentId,
    RolloutId RolloutId,
    string TargetName,
    string SourceRevision,
    ConvergenceState State,
    string? ErrorCode,
    string? Diagnostic,
    DateTimeOffset UpdatedAt);

public sealed record CheckinBucket(DateTimeOffset Hour, int Polls);

public sealed record NodeCheckins(int Hours, IReadOnlyList<CheckinBucket> Buckets);

public sealed record RetryAssignment(NodeId NodeId, string Target, string RequestedBy);

public sealed record RetryResult(AssignmentId AssignmentId, AttemptId AttemptId, ConvergenceState State);

public sealed record SourceScanEntry(
    Guid ScanId,
    string? SourceRevision,
    SourceScanOutcome Outcome,
    string? Code,
    string? Diagnostic,
    DateTimeOffset ObservedAt,
    string? RequestedBy);

public enum EnrollmentLinkState { Active, Consumed, Expired, Revoked }

public sealed record EnrollmentLinkStatus(
    Guid Id,
    string? Alias,
    DateTimeOffset ExpiresAt,
    DateTimeOffset? ConsumedAt,
    DateTimeOffset? RevokedAt,
    string? RevokedBy,
    NodeId? NodeId,
    EnrollmentLinkState State);

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
    CredentialId? CredentialId,
    string? NodeName = null);

public sealed record PersistenceMaintenancePolicy(
    TimeSpan? AuditEventRetention,
    TimeSpan? SourceScanRetention,
    int BatchSize = 500);

public sealed record PersistenceMaintenanceResult(
    int EnrollmentPayloadsScrubbed,
    int AuditEventsDeleted,
    int SourceScansDeleted,
    int CheckinsDeleted = 0);

public sealed record BundleContent(string Digest, string Schema, long Size, byte[] Content);
