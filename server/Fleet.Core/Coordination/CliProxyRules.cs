namespace Fleet.Core.Coordination;

/// <summary>
/// AI client connection rules shared by the source scanner and publishers, the coordinator and the CLIProxy catalog and selection.
/// </summary>
public static class CliProxyRules
{
    /// <summary>The schema of every AI client connection Assignment.</summary>
    public const string AiClientSchema = "fleet.ai-client/v1";

    /// <summary>The AI clients Fleet can configure; <c>ai-client/{name}</c> is the Target name.</summary>
    public static readonly IReadOnlySet<string> AiClients = new HashSet<string>(StringComparer.Ordinal) { "codex", "opencode", "claude" };

    /// <summary>A model ID is 1 to 200 printable ASCII characters, without spaces.</summary>
    public static bool IsValidModelId(string value) => value.Length is > 0 and <= 200 &&
        value.All(character => character is >= '!' and <= '~');

    /// <summary>
    /// Accepts an <c>https</c> URL with a host and without user info, query or fragment whose path is empty, <c>/</c> or <c>/v1</c>
    /// (trailing slashes allowed), and returns it with the path <c>/v1</c> and no trailing slash. For URLs from the manifest and the catalog.
    /// </summary>
    public static bool TryNormalizeBaseUrl(string? value, out string? normalized)
    {
        normalized = null;
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps ||
            string.IsNullOrEmpty(uri.Host) || !string.IsNullOrEmpty(uri.UserInfo) ||
            !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment) ||
            uri.AbsolutePath.TrimEnd('/') is not ("" or "/v1"))
            return false;
        normalized = new UriBuilder(uri) { Path = "/v1", Query = "", Fragment = "" }.Uri.AbsoluteUri.TrimEnd('/');
        return true;
    }

    /// <summary>
    /// Stricter than <see cref="TryNormalizeBaseUrl"/> and does not rewrite: the path must already be <c>/v1</c> (trailing slashes
    /// allowed). The coordinator re-checks published Assignments with it.
    /// </summary>
    public static bool IsValidBaseUrl(string? value) =>
        Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps &&
        !string.IsNullOrEmpty(uri.Host) && string.IsNullOrEmpty(uri.UserInfo) &&
        string.IsNullOrEmpty(uri.Query) && string.IsNullOrEmpty(uri.Fragment) &&
        uri.AbsolutePath.TrimEnd('/') == "/v1";
}
