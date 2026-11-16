namespace Fleet.Core.Coordination;

// Operator commands and their results: retry, disk refresh and issue states.

public sealed record RetryAssignment(NodeId NodeId, string Target, string RequestedBy);

public sealed record RetryResult(AssignmentId AssignmentId, AttemptId AttemptId, ConvergenceState State);

public sealed record DiskRefreshRequested(DateTimeOffset RefreshRequestedAt);

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
