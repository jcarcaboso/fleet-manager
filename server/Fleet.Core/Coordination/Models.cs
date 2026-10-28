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

/// <summary>The tip commit of an accepted source revision: first message line, author name (never the email) and committer date.</summary>
public sealed record CommitMetadata(string? Subject, string? Author, DateTimeOffset? CommittedAt);

public sealed record AcceptedSourceSnapshot(
    string SourceRevision,
    IReadOnlyList<SnapshotBundle> Bundles,
    IReadOnlyList<SnapshotTarget> Targets,
    IReadOnlyList<SourceWarning> Warnings,
    DateTimeOffset ObservedAt,
    CommitMetadata? Commit = null);

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

/// <summary>
/// What a poll found. <paramref name="DiskUsageRequested"/> is true while an Operator's disk refresh request is pending;
/// the route only tells Agents that sent the <c>disk-usage</c> capability.
/// </summary>
public sealed record PollResult(AgentAssignment? Assignment, bool DiskUsageRequested = false);

public sealed record AttemptReport(
    AttemptId AttemptId,
    ConvergenceState State,
    string? ErrorCode,
    string? Diagnostic,
    DateTimeOffset ReportedAt);

/// <summary>Bounded description of why an Attempt failed, sent by the Agent after its terminal report.</summary>
public sealed record AttemptDetail(string? Diagnostic, string? Path, string? Step);

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
    string? CurrentRevision,
    NodeDiskSummary? Disk = null,
    NodeAgentSummary? Agent = null);

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
    string? Path,
    string? Step,
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
    TargetStateCounts Summary,
    NodeDisk? Disk = null,
    NodeAgent? Agent = null,
    IReadOnlyList<NodeDriftEvent>? Drift = null);

public sealed record NodeAttemptStatus(
    AttemptId AttemptId,
    AssignmentId AssignmentId,
    RolloutId RolloutId,
    string TargetName,
    string SourceRevision,
    ConvergenceState State,
    string? ErrorCode,
    string? Diagnostic,
    string? Path,
    string? Step,
    DateTimeOffset UpdatedAt);

/// <summary>One measured volume as an Agent reports it. <c>Label</c> is <c>home</c> or <c>state</c>.</summary>
public sealed record DiskVolume(string Label, long TotalBytes, long UsedBytes, long AvailableBytes);

public sealed record DiskUsageReport(IReadOnlyList<DiskVolume> Volumes);

public sealed record NodeDiskVolume(string Label, long TotalBytes, long UsedBytes, long AvailableBytes, double UsedPercent);

/// <summary>The fullest volume of a Node, shown in the Node list.</summary>
public sealed record NodeDiskSummary(string Label, double UsedPercent, long UsedBytes, long AvailableBytes, long TotalBytes,
    DateTimeOffset MeasuredAt);

/// <summary>Latest disk report and pending refresh request of a Node. <c>MeasuredAt</c> is null until the Agent reports.</summary>
public sealed record NodeDisk(DateTimeOffset? MeasuredAt, DateTimeOffset? RefreshRequestedAt, IReadOnlyList<NodeDiskVolume> Volumes);

public sealed record DiskRefreshRequested(DateTimeOffset RefreshRequestedAt);

/// <summary>What an Agent reports about itself and its machine. Only <c>AgentVersion</c> is required; the other fields are null when the Agent could not read them.</summary>
public sealed record AgentTelemetryReport(string AgentVersion, string? OsName, string? OsVersion, string? OsKernel, string? Arch,
    string? Hostname, string? User, string? InstallMethod, string? ServiceManager, string? StateDirectory);

public sealed record NodeAgentOs(string? Name, string? Version);

public sealed record NodeAgentOsDetail(string? Name, string? Version, string? Kernel);

/// <summary>The Agent information shown in the Node list.</summary>
public sealed record NodeAgentSummary(string Version, bool Outdated, NodeAgentOs Os, string? Arch, string? Hostname);

/// <summary>The latest telemetry report of a Node. <c>ReportedAt</c> is when the Server received it; <c>LatestVersion</c> is the Server's own version.</summary>
public sealed record NodeAgent(string Version, string LatestVersion, bool Outdated, NodeAgentOsDetail Os, string? Arch, string? Hostname,
    string? User, string? InstallMethod, string? ServiceManager, string? StateDirectory, DateTimeOffset ReportedAt);

/// <summary>Files an Agent repaired in one Target because they were changed outside Fleet. <c>DetectedAt</c> is when the Server received the report.</summary>
public sealed record NodeDriftEvent(string Target, IReadOnlyList<string> Files, DateTimeOffset DetectedAt);

/// <summary>What an Agent reports after repairing drift: the assigned Target and its Target-relative file paths.</summary>
public sealed record DriftReport(string Target, IReadOnlyList<string> Files);

/// <summary>
/// An idle repair of a current Assignment that failed after the Assignment's own Attempt succeeded. <c>Diagnostic</c>, <c>Path</c> and
/// <c>Step</c> follow <see cref="AttemptDetailRules"/>.
/// </summary>
public sealed record RepairFailure(string Target, AssignmentId AssignmentId, string ErrorCode, string Diagnostic, string? Path, string? Step);

/// <summary>Every repair that currently fails on a Node. The Server stores exactly these; an empty list clears them.</summary>
public sealed record RepairFailureReport(IReadOnlyList<RepairFailure> Failures);

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
    string? Path,
    string? Step,
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

/// <summary>An item of <c>GET desired-revisions</c>: a revision with the commit it was read from, or <c>null</c> for revisions accepted before commit metadata.</summary>
public sealed record DesiredRevisionSummary(
    DesiredRevisionId DesiredRevisionId,
    string SourceRevision,
    DateTimeOffset AcceptedAt,
    CommitMetadata? Commit);

public sealed record DesiredRevisionRef(DesiredRevisionId DesiredRevisionId, string SourceRevision);

public sealed record SkillChanges(IReadOnlyList<string> Added, IReadOnlyList<string> Changed, IReadOnlyList<string> Removed);

public sealed record TargetChanges(int Added, int Changed, int Removed, int Nodes);

public sealed record DesiredRevisionDetail(
    DesiredRevisionId DesiredRevisionId,
    string SourceRevision,
    DateTimeOffset AcceptedAt,
    CommitMetadata? Commit,
    DesiredRevisionRef? Previous,
    RolloutId? RolloutId,
    SkillChanges Skills,
    TargetChanges Targets);

public sealed record RolloutTargetProgress(string Name, ConvergenceState State, string? ErrorCode, DateTimeOffset UpdatedAt);

public sealed record RolloutNodeProgress(
    NodeId NodeId,
    string NodeName,
    ConvergenceState State,
    DateTimeOffset? FirstAttemptAt,
    DateTimeOffset? LastAttemptAt,
    IReadOnlyList<RolloutTargetProgress> Targets);

public sealed record RolloutDetail(
    RolloutId RolloutId,
    DesiredRevisionId DesiredRevisionId,
    string SourceRevision,
    DateTimeOffset CreatedAt,
    TargetStateCounts Summary,
    IReadOnlyList<RolloutNodeProgress> Nodes);

public enum IssueStateAction { Acknowledge, Snooze, Reopen }

public static class IssueStateNames
{
    public const string Open = "open";
    public const string Acknowledged = "acknowledged";
    public const string Snoozed = "snoozed";
}

/// <summary>The stored state of one issue. <c>Since</c> is the issue's <c>since</c> when it was acknowledged or snoozed.</summary>
public sealed record IssueStateEntry(string IssueId, string State, DateTimeOffset? Since, DateTimeOffset? SnoozedUntil, string Actor, DateTimeOffset At);

/// <summary>
/// An Operator's change of an issue's state. <paramref name="Since"/> and <paramref name="NodeId"/> come from the current issue.
/// <paramref name="CurrentIssueIds"/> lets the write drop stored states of issues that are gone.
/// </summary>
public sealed record ChangeIssueState(
    string IssueId,
    IssueStateAction Action,
    int? Hours,
    DateTimeOffset? Since,
    Guid? NodeId,
    string Actor,
    IReadOnlyCollection<string> CurrentIssueIds);

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
    string? NodeName = null,
    string? Account = null,
    string? Detail = null);

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
