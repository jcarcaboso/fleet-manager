using System.Text.Json.Serialization;

namespace Fleet.Core.Coordination;

// The Agent protocol: poll, Assignment, Bundle download and Attempt reports.

/// <summary>Optional features an Agent announces in <c>X-Fleet-Agent-Capabilities</c> on each poll.</summary>
[Flags]
public enum AgentCapabilities
{
    None = 0,
    DiskUsage = 1,
    AgentUpdate = 2,
    ClaudeSkills = 4,
}

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
/// the route only tells Agents that sent the <c>disk-usage</c> capability. <paramref name="AgentUpdate"/> is a requested
/// Agent update; it is looked up only for Agents that sent the <c>agent-update</c> capability.
/// </summary>
public sealed record PollResult(AgentAssignment? Assignment, bool DiskUsageRequested = false, AgentUpdateInstruction? AgentUpdate = null);

/// <summary>The update a poll asks the Agent to apply. <c>UpdateId</c> identifies this request in the Agent's reports.</summary>
public sealed record AgentUpdateInstruction(string Version, Guid UpdateId);

public sealed record BundleContent(string Digest, string Schema, long Size, byte[] Content);

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
