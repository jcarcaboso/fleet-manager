using System.Text.RegularExpressions;

namespace Fleet.Core.Coordination;

/// <summary>
/// A semantic version without build metadata: <c>MAJOR.MINOR.PATCH</c> with an optional <c>-prerelease</c> tag.
/// Ordering follows semver precedence: the numeric parts first, a prerelease below its release, and prerelease identifiers
/// compared one by one (numeric ones by value and below alphanumeric ones, alphanumeric ones in ASCII order, fewer identifiers first).
/// </summary>
public sealed partial class SemanticVersion : IComparable<SemanticVersion>, IEquatable<SemanticVersion>
{
    // Numeric parts have no leading zeros. Their size is not limited here; they are compared by length and then by digits, so no overflow exists.
    [GeneratedRegex(@"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?\z",
        RegexOptions.CultureInvariant)]
    private static partial Regex Pattern();

    private readonly string[] numbers;
    private readonly string[] prerelease;

    private SemanticVersion(string text, string[] numbers, string[] prerelease)
    {
        Text = text;
        this.numbers = numbers;
        this.prerelease = prerelease;
    }

    /// <summary>The version as written.</summary>
    public string Text { get; }

    public bool IsPrerelease => prerelease.Length > 0;

    /// <summary>True for <c>MAJOR.MINOR.PATCH</c> with an optional <c>-prerelease</c> tag and nothing else, such as no <c>+build</c> part or leading <c>v</c>.</summary>
    public static bool TryParse(string? text, out SemanticVersion version)
    {
        version = null!;
        if (text is null || text.Length > 256) return false;
        var match = Pattern().Match(text);
        if (!match.Success) return false;
        version = new(text, [match.Groups[1].Value, match.Groups[2].Value, match.Groups[3].Value],
            match.Groups[4].Success ? match.Groups[4].Value.Split('.') : []);
        return true;
    }

    public static SemanticVersion Parse(string text) =>
        TryParse(text, out var version) ? version : throw new FormatException($"'{text}' is not a semantic version.");

    public int CompareTo(SemanticVersion? other)
    {
        if (other is null) return 1;
        for (var i = 0; i < numbers.Length; i++)
        {
            var result = CompareNumbers(numbers[i], other.numbers[i]);
            if (result != 0) return result;
        }
        // A release is above any prerelease of the same numbers.
        if (prerelease.Length == 0 || other.prerelease.Length == 0)
            return prerelease.Length == other.prerelease.Length ? 0 : prerelease.Length == 0 ? 1 : -1;
        for (var i = 0; i < Math.Min(prerelease.Length, other.prerelease.Length); i++)
        {
            var result = CompareIdentifiers(prerelease[i], other.prerelease[i]);
            if (result != 0) return result;
        }
        return prerelease.Length.CompareTo(other.prerelease.Length);
    }

    private static int CompareIdentifiers(string left, string right)
    {
        var leftNumeric = left.All(char.IsAsciiDigit);
        var rightNumeric = right.All(char.IsAsciiDigit);
        if (leftNumeric && rightNumeric) return CompareNumbers(left, right);
        if (leftNumeric != rightNumeric) return leftNumeric ? -1 : 1;
        return Math.Sign(string.CompareOrdinal(left, right));
    }

    // Digit strings without leading zeros (or "0"): the longer one is larger, equal lengths compare digit by digit.
    private static int CompareNumbers(string left, string right) =>
        left.Length != right.Length ? left.Length.CompareTo(right.Length) : Math.Sign(string.CompareOrdinal(left, right));

    public bool Equals(SemanticVersion? other) => other is not null && CompareTo(other) == 0;

    public override bool Equals(object? obj) => obj is SemanticVersion other && Equals(other);

    public override int GetHashCode() => HashCode.Combine(string.Join('.', numbers), string.Join('.', prerelease));

    public override string ToString() => Text;

    public static bool operator <(SemanticVersion left, SemanticVersion right) => left.CompareTo(right) < 0;
    public static bool operator >(SemanticVersion left, SemanticVersion right) => left.CompareTo(right) > 0;
    public static bool operator <=(SemanticVersion left, SemanticVersion right) => left.CompareTo(right) <= 0;
    public static bool operator >=(SemanticVersion left, SemanticVersion right) => left.CompareTo(right) >= 0;
}
