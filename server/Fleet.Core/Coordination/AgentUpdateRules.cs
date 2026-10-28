using System.Text.RegularExpressions;

namespace Fleet.Core.Coordination;

/// <summary>Optional features an Agent announces in <c>X-Fleet-Agent-Capabilities</c> on each poll.</summary>
[Flags]
public enum AgentCapabilities
{
    None = 0,
    DiskUsage = 1,
    AgentUpdate = 2,
}

/// <summary>
/// The update of one Node's Agent to <c>TargetVersion</c>, as the Operator API shows it. <c>FromVersion</c> is the version the Agent
/// reported when the update was requested, or null without a report. <c>ErrorCode</c> is set for failed updates.
/// </summary>
public sealed record AgentUpdateStatus(string? FromVersion, string TargetVersion, string State, string? ErrorCode, string RequestedBy,
    DateTimeOffset RequestedAt, DateTimeOffset UpdatedAt, DateTimeOffset? FinishedAt);

/// <summary>What an Agent reports about an update: the target version, the new state and, for <c>failed</c>, an error code.</summary>
public sealed record AgentUpdateReport(string Version, string State, string? ErrorCode);

/// <summary>States, transitions and limits of Agent updates, shared by the Server routes and the coordinator.</summary>
public static partial class AgentUpdateRules
{
    public const string Requested = "requested";
    public const string Downloading = "downloading";
    public const string Restarting = "restarting";
    public const string Succeeded = "succeeded";
    public const string Failed = "failed";
    public const string Cancelled = "cancelled";
    public const int MaximumErrorCodeLength = 64;
    public const int MaximumStateLength = 16;
    public const int MaximumVersionLength = 64;

    /// <summary>
    /// An update that is downloading or restarting for longer than this is treated as abandoned, so a new request may replace it.
    /// The Agent rolls back on its own after 10 minutes without a successful poll.
    /// </summary>
    public static readonly TimeSpan AbandonedAfter = TimeSpan.FromMinutes(30);

    /// <summary>The states an Agent may report. <c>requested</c> and <c>cancelled</c> are set by Operators only.</summary>
    public static readonly IReadOnlySet<string> ReportedStates = new HashSet<string>(StringComparer.Ordinal)
        { Downloading, Restarting, Succeeded, Failed };

    public static bool IsActive(string state) => state is Requested or Downloading or Restarting;

    public static bool IsFinished(string state) => state is Succeeded or Failed or Cancelled;

    /// <summary>
    /// Whether an Agent report moves an update from <paramref name="current"/> to <paramref name="next"/>. Repeating the current
    /// state is accepted so a retried report is harmless. A finished update never changes. An Agent that already runs the
    /// requested version reports succeeded without downloading.
    /// </summary>
    public static bool CanMove(string current, string next) => (current, next) switch
    {
        (Requested, Downloading or Succeeded or Failed) => true,
        (Downloading, Downloading or Restarting or Succeeded or Failed) => true,
        (Restarting, Restarting or Succeeded or Failed) => true,
        _ => false
    };

    [GeneratedRegex("^[a-z][a-z0-9_]*\\z", RegexOptions.CultureInvariant)]
    private static partial Regex ErrorCodePattern();

    /// <summary>Returns the validated report or throws <c>invalid_request</c>.</summary>
    public static AgentUpdateReport Validate(AgentUpdateReport? report)
    {
        if (report is null) throw Invalid("The report is required.");
        if (report.Version is null || report.Version.Length > MaximumVersionLength || !SemanticVersion.TryParse(report.Version, out _))
            throw Invalid("version must be MAJOR.MINOR.PATCH with an optional -prerelease tag.");
        if (report.State is null || !ReportedStates.Contains(report.State))
            throw Invalid("state must be downloading, restarting, succeeded or failed.");
        if (report.State == Failed)
        {
            if (report.ErrorCode is null || report.ErrorCode.Length > MaximumErrorCodeLength || !ErrorCodePattern().IsMatch(report.ErrorCode))
                throw Invalid($"A failed report needs errorCode: lowercase letters, digits and underscores, at most {MaximumErrorCodeLength} characters.");
        }
        else if (report.ErrorCode is not null)
            throw Invalid("errorCode is allowed only with state failed.");
        return report;
    }

    private static CoordinationException Invalid(string message) => new("invalid_request", message);
}
