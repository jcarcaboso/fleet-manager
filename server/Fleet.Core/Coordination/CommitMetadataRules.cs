using System.Globalization;
using System.Text;

namespace Fleet.Core.Coordination;

/// <summary>Limits and sanitization for the commit metadata stored with a desired revision, shared by the scanner and the coordinator.</summary>
public static class CommitMetadataRules
{
    public const int MaximumSubjectLength = 200;
    public const int MaximumAuthorLength = 128;

    /// <summary>
    /// Returns the metadata with control characters removed and the text cut to its limit, or null when nothing is left. Never throws:
    /// commit metadata is informational and must not fail a scan.
    /// </summary>
    public static CommitMetadata? Sanitize(CommitMetadata? metadata)
    {
        if (metadata is null) return null;
        var subject = Clean(metadata.Subject, MaximumSubjectLength);
        var author = Clean(metadata.Author, MaximumAuthorLength);
        return subject is null && author is null && metadata.CommittedAt is null ? null : new(subject, author, metadata.CommittedAt?.ToUniversalTime());
    }

    private static string? Clean(string? value, int maximum)
    {
        if (value is null) return null;
        var builder = new StringBuilder(Math.Min(value.Length, maximum + 1));
        foreach (var character in value)
        {
            // Control characters (C0, DEL, C1) and Unicode line and paragraph separators cannot appear in a one-line value.
            if (char.IsControl(character) || CharUnicodeInfo.GetUnicodeCategory(character) is UnicodeCategory.LineSeparator or UnicodeCategory.ParagraphSeparator)
                continue;
            builder.Append(character);
        }
        var text = builder.ToString().Trim();
        if (text.Length > maximum)
        {
            // Do not cut a surrogate pair in half.
            var end = char.IsHighSurrogate(text[maximum - 1]) ? maximum - 1 : maximum;
            text = text[..end].TrimEnd();
        }
        return text.Length == 0 ? null : text;
    }
}
