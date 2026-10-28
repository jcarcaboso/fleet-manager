namespace Fleet.Core.Coordination;

/// <summary>Validation and limits for <see cref="RepairFailureReport"/>, shared by the Server route and the coordinator.</summary>
public static class RepairFailureRules
{
    public const int MaximumFailures = 50;
    public const int MaximumTargetLength = 100;
    public const int MaximumErrorCodeLength = 100;

    /// <summary>
    /// Returns the report with each diagnostic, path and step sanitized by <see cref="AttemptDetailRules"/>, or throws
    /// <c>invalid_request</c> unless it holds 0 to 50 failures with distinct Targets, each with a Target and an error code.
    /// </summary>
    public static RepairFailureReport Sanitize(RepairFailureReport? report)
    {
        if (report?.Failures is null) throw Invalid("failures is required.");
        if (report.Failures.Count > MaximumFailures) throw Invalid($"failures must hold at most {MaximumFailures} entries.");
        var targets = new HashSet<string>(StringComparer.Ordinal);
        var clean = new List<RepairFailure>(report.Failures.Count);
        foreach (var failure in report.Failures)
        {
            if (failure is null) throw Invalid("Each failure is required.");
            if (!IsName(failure.Target, MaximumTargetLength))
                throw Invalid($"target is required, at most {MaximumTargetLength} characters, without control characters.");
            if (!targets.Add(failure.Target)) throw Invalid("Each target may be listed once.");
            if (!IsName(failure.ErrorCode, MaximumErrorCodeLength))
                throw Invalid($"errorCode is required, at most {MaximumErrorCodeLength} characters, without control characters.");
            var detail = AttemptDetailRules.Sanitize(new(failure.Diagnostic, failure.Path, failure.Step));
            clean.Add(failure with { Diagnostic = detail.Diagnostic!, Path = detail.Path, Step = detail.Step });
        }
        return new(clean);
    }

    private static bool IsName(string? value, int maximumLength) =>
        !string.IsNullOrWhiteSpace(value) && value.Length <= maximumLength && !value.Any(char.IsControl);

    private static CoordinationException Invalid(string message) => new("invalid_request", message);
}
