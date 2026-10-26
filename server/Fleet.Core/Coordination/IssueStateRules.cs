namespace Fleet.Core.Coordination;

/// <summary>Limits of the Operator issue state, shared by the Operator route and the coordinator.</summary>
public static class IssueStateRules
{
    public const int MaximumIdLength = 300;
    public const int MinimumSnoozeHours = 1;
    public const int MaximumSnoozeHours = 168;

    /// <summary>Throws <c>invalid_request</c> unless <paramref name="hours"/> is given exactly for a snooze, in 1 to 168.</summary>
    public static void ValidateHours(IssueStateAction action, int? hours)
    {
        if (action == IssueStateAction.Snooze)
        {
            if (hours is not { } value || value < MinimumSnoozeHours || value > MaximumSnoozeHours)
                throw new CoordinationException("invalid_request", $"hours is required for snooze, between {MinimumSnoozeHours} and {MaximumSnoozeHours}.");
        }
        else if (hours is not null)
            throw new CoordinationException("invalid_request", "hours is only allowed for snooze.");
    }
}
