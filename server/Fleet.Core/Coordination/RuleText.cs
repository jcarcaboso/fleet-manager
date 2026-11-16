using System.Text;

namespace Fleet.Core.Coordination;

/// <summary>Text checks shared by the <c>*Rules</c> classes. Each class keeps its own messages.</summary>
internal static class RuleText
{
    public static CoordinationException Invalid(string message) => new("invalid_request", message);

    public static bool HasControl(string value) => value.Any(char.IsControl);

    // Control characters (C0, DEL and C1) are removed; only \n and \t survive, and only where the field allows them.
    public static string? StripControl(string? value, bool keepLineBreaks = false)
    {
        if (value is null) return null;
        var builder = new StringBuilder(value.Length);
        foreach (var character in value)
            if (!char.IsControl(character) || keepLineBreaks && character is '\n' or '\t') builder.Append(character);
        return builder.ToString();
    }

    /// <summary>True for a path that starts at a root: <c>/</c>, <c>\</c> or a drive letter. <paramref name="path"/> must not be empty.</summary>
    public static bool IsRooted(string path) =>
        path[0] is '/' or '\\' || path.Length >= 2 && path[1] == ':' && char.IsAsciiLetter(path[0]);

    /// <summary>True when a <c>/</c> or <c>\</c> separated segment is <c>..</c>.</summary>
    public static bool HasParentSegment(string path) => path.Split('/', '\\').Contains("..", StringComparer.Ordinal);
}
