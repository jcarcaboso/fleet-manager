namespace Fleet.Core.Coordination;

// The Operator's views of publication history: desired revisions, rollouts, Attempts, warnings and audit events.

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

public sealed record RolloutStatus(
    RolloutId RolloutId,
    DesiredRevisionId DesiredRevisionId,
    DateTimeOffset CreatedAt,
    int Pending,
    int Applying,
    int Succeeded,
    int Failed,
    int Superseded);

public sealed record AuditEventStatus(
    DateTimeOffset RecordedAt,
    string Action,
    string Actor,
    NodeId? NodeId,
    CredentialId? CredentialId,
    string? NodeName = null,
    string? Account = null,
    string? Detail = null);
