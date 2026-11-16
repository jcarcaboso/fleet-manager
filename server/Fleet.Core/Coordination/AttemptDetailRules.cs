using static Fleet.Core.Coordination.RuleText;

namespace Fleet.Core.Coordination;

/// <summary>Sanitization and limits for <see cref="AttemptDetail"/>, shared by the Server route and the coordinator.</summary>
public static class AttemptDetailRules
{
    public const int MaximumDiagnosticLength = 2048;
    public const int MaximumPathLength = 512;
    public const int MaximumStepLength = 32;

    public static readonly IReadOnlySet<string> Steps = new HashSet<string>(StringComparer.Ordinal)
    {
        "lock", "download", "verify", "stage", "activate", "recover", "receipt", "configure", "validate"
    };

    /// <summary>Returns the stripped and validated detail, or throws <c>invalid_request</c>.</summary>
    public static AttemptDetail Sanitize(AttemptDetail detail)
    {
        var diagnostic = StripControl(detail.Diagnostic, keepLineBreaks: true);
        if (string.IsNullOrEmpty(diagnostic) || diagnostic.Length > MaximumDiagnosticLength)
            throw Invalid($"diagnostic is required and at most {MaximumDiagnosticLength} characters.");

        var path = StripControl(detail.Path, keepLineBreaks: false);
        if (string.IsNullOrEmpty(path)) path = null;
        else if (path.Length > MaximumPathLength || !IsRelative(path))
            throw Invalid($"path must be relative to the Target base, without '..' segments, and at most {MaximumPathLength} characters.");

        var step = detail.Step;
        if (step is not null && !Steps.Contains(step))
            throw Invalid($"step must be one of {string.Join(", ", Steps.Order(StringComparer.Ordinal))}.");
        return new(diagnostic, path, step);
    }

    private static bool IsRelative(string path) => !IsRooted(path) && !HasParentSegment(path);
}
