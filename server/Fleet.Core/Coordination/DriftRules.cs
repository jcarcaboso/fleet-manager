namespace Fleet.Core.Coordination;

/// <summary>Validation and limits for <see cref="DriftReport"/>, shared by the Server route and the coordinator.</summary>
public static class DriftRules
{
    public const int MaximumTargetLength = 100;
    public const int MaximumFiles = 20;
    public const int MaximumPathLength = 512;

    /// <summary>The Server keeps this many drift events per Node, the newest ones.</summary>
    public const int MaximumEvents = 20;

    /// <summary>Throws <c>invalid_request</c> unless the report names a Target and 1 to 20 relative paths without <c>..</c> segments or control characters.</summary>
    public static void Validate(DriftReport? report)
    {
        if (report is null) throw Invalid("The report is required.");
        if (string.IsNullOrWhiteSpace(report.Target) || report.Target.Length > MaximumTargetLength || HasControl(report.Target))
            throw Invalid($"target is required, at most {MaximumTargetLength} characters.");
        if (report.Files is null || report.Files.Count is < 1 or > MaximumFiles)
            throw Invalid($"files must hold 1 to {MaximumFiles} paths.");
        foreach (var file in report.Files)
        {
            if (string.IsNullOrWhiteSpace(file) || file.Length > MaximumPathLength)
                throw Invalid($"Each path is required, at most {MaximumPathLength} characters.");
            if (HasControl(file)) throw Invalid("Paths must not contain control characters.");
            if (file[0] is '/' or '\\' || file.Length >= 2 && file[1] == ':' && char.IsAsciiLetter(file[0]))
                throw Invalid("Paths must be relative to the Target.");
            if (file.Split('/', '\\').Contains(".."))
                throw Invalid("Paths must not contain '..' segments.");
        }
    }

    private static bool HasControl(string value) => value.Any(char.IsControl);

    private static CoordinationException Invalid(string message) => new("invalid_request", message);
}
