namespace Fleet.Core.Coordination;

// The Operator's views of Nodes: the Node list, Node detail and its parts.

public enum FreshnessState
{
    Fresh,
    Stale,
    NeverContacted,
}

public sealed record TargetStateCounts(int Pending, int Applying, int Succeeded, int Failed, int Superseded);

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
    NodeAgentSummary? Agent = null,
    AgentUpdateStatus? AgentUpdate = null);

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
    IReadOnlyList<NodeDriftEvent>? Drift = null,
    AgentUpdateStatus? AgentUpdate = null);

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

public sealed record NodeDiskVolume(string Label, long TotalBytes, long UsedBytes, long AvailableBytes, double UsedPercent);

/// <summary>The fullest volume of a Node, shown in the Node list.</summary>
public sealed record NodeDiskSummary(string Label, double UsedPercent, long UsedBytes, long AvailableBytes, long TotalBytes,
    DateTimeOffset MeasuredAt);

/// <summary>Latest disk report and pending refresh request of a Node. <c>MeasuredAt</c> is null until the Agent reports.</summary>
public sealed record NodeDisk(DateTimeOffset? MeasuredAt, DateTimeOffset? RefreshRequestedAt, IReadOnlyList<NodeDiskVolume> Volumes);

public sealed record NodeAgentOs(string? Name, string? Version);

public sealed record NodeAgentOsDetail(string? Name, string? Version, string? Kernel);

/// <summary>The Agent information shown in the Node list. <c>SelfUpdate</c> is true when the Agent announced on its latest poll that it can update itself.</summary>
public sealed record NodeAgentSummary(string Version, bool Outdated, NodeAgentOs Os, string? Arch, string? Hostname, bool SelfUpdate);

/// <summary>
/// The latest telemetry report of a Node. <c>ReportedAt</c> is when the Server received it; <c>LatestVersion</c> is the Server's own version.
/// <c>SelfUpdate</c> is true when the Agent announced on its latest poll that it can update itself.
/// </summary>
public sealed record NodeAgent(string Version, string LatestVersion, bool Outdated, NodeAgentOsDetail Os, string? Arch, string? Hostname,
    string? User, string? InstallMethod, string? ServiceManager, string? StateDirectory, DateTimeOffset ReportedAt, bool SelfUpdate);

/// <summary>
/// The update of one Node's Agent to <c>TargetVersion</c>, as the Operator API shows it. <c>FromVersion</c> is the version the Agent
/// reported when the update was requested, or null without a report. <c>ErrorCode</c> is set for failed updates.
/// </summary>
public sealed record AgentUpdateStatus(string? FromVersion, string TargetVersion, string State, string? ErrorCode, string RequestedBy,
    DateTimeOffset RequestedAt, DateTimeOffset UpdatedAt, DateTimeOffset? FinishedAt);

/// <summary>Files an Agent repaired in one Target because they were changed outside Fleet. <c>DetectedAt</c> is when the Server received the report.</summary>
public sealed record NodeDriftEvent(string Target, IReadOnlyList<string> Files, DateTimeOffset DetectedAt);

public sealed record CheckinBucket(DateTimeOffset Hour, int Polls);

public sealed record NodeCheckins(int Hours, IReadOnlyList<CheckinBucket> Buckets);
