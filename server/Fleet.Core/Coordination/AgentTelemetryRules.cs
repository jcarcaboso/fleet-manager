using System.Text;

namespace Fleet.Core.Coordination;

/// <summary>Sanitization, limits and the outdated rule for <see cref="AgentTelemetryReport"/>, shared by the Server route, the coordinator and the Operator views.</summary>
public static class AgentTelemetryRules
{
    public const int MaximumLength = 128;
    public const int MaximumStateDirectoryLength = 512;
    public const int MaximumEnumLength = 16;

    public static readonly IReadOnlySet<string> InstallMethods = new HashSet<string>(StringComparer.Ordinal) { "homebrew", "cargo", "binary" };
    public static readonly IReadOnlySet<string> ServiceManagers = new HashSet<string>(StringComparer.Ordinal) { "systemd", "launchd", "none" };

    /// <summary>Returns the report with control characters removed, or throws <c>invalid_request</c>. Optional strings that end up empty become null.</summary>
    public static AgentTelemetryReport Sanitize(AgentTelemetryReport? report)
    {
        if (report is null) throw Invalid("The report is required.");
        var version = Strip(report.AgentVersion);
        if (string.IsNullOrEmpty(version) || !SemanticVersion.TryParse(version, out _) || version.Length > MaximumLength)
            throw Invalid($"agentVersion must be MAJOR.MINOR.PATCH with an optional -prerelease tag, at most {MaximumLength} characters.");
        var installMethod = Strip(report.InstallMethod);
        if (installMethod is not null && !InstallMethods.Contains(installMethod))
            throw Invalid($"installMethod must be one of {string.Join(", ", InstallMethods.Order(StringComparer.Ordinal))}.");
        var serviceManager = Strip(report.ServiceManager);
        if (serviceManager is not null && !ServiceManagers.Contains(serviceManager))
            throw Invalid($"serviceManager must be one of {string.Join(", ", ServiceManagers.Order(StringComparer.Ordinal))}.");
        return new(version, Bounded(report.OsName, "os.name", MaximumLength), Bounded(report.OsVersion, "os.version", MaximumLength),
            Bounded(report.OsKernel, "os.kernel", MaximumLength), Bounded(report.Arch, "arch", MaximumLength),
            Bounded(report.Hostname, "hostname", MaximumLength), Bounded(report.User, "user", MaximumLength), installMethod, serviceManager,
            Bounded(report.StateDirectory, "stateDirectory", MaximumStateDirectoryLength));
    }

    /// <summary>True when the reported version is lower than the latest one; a prerelease of the latest version is lower than it.</summary>
    public static bool IsOutdated(string agentVersion, SemanticVersion latest) =>
        SemanticVersion.TryParse(agentVersion, out var running) && running < latest;

    private static string? Bounded(string? value, string name, int maximum)
    {
        var stripped = Strip(value);
        if (stripped is null) return null;
        if (stripped.Length > maximum) throw Invalid($"{name} must be at most {maximum} characters.");
        return stripped.Length == 0 ? null : stripped;
    }

    // Control characters (C0, DEL and C1) are removed, including line breaks and tabs.
    private static string? Strip(string? value)
    {
        if (value is null) return null;
        var builder = new StringBuilder(value.Length);
        foreach (var character in value)
            if (!char.IsControl(character)) builder.Append(character);
        return builder.ToString();
    }

    private static CoordinationException Invalid(string message) => new("invalid_request", message);
}
