using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http.Features;

namespace Fleet.Server.Transport;

public static partial class OperatorApi
{
    /// <summary>
    /// The decoded <c>{node}</c> path segment. ASP.NET leaves <c>%2F</c> encoded in route values and decodes the rest, so the
    /// route value cannot tell <c>rack%2FA</c> from <c>rack%252FA</c> reliably. The segment is read from the raw request
    /// target and decoded exactly once: <c>rack%2FA</c> is the alias <c>rack/A</c> and <c>a%252Fb</c> is <c>a%2Fb</c>.
    /// The raw target must decode to the path the router matched; otherwise (dot segments, for example) the request is
    /// rejected, so the resolved Node can never differ from the matched route.
    /// </summary>
    public static string NodeSegment(HttpContext http, string routeValue)
    {
        var target = http.Features.Get<IHttpRequestFeature>()?.RawTarget;
        if (string.IsNullOrEmpty(target)) return routeValue;
        if (target[0] != '/')
        {
            // Absolute form: scheme://authority/path.
            var authority = target.IndexOf("://", StringComparison.Ordinal);
            var slash = authority < 0 ? -1 : target.IndexOf('/', authority + 3);
            if (slash < 0) throw AmbiguousPath();
            target = target[slash..];
        }
        var end = target.IndexOfAny(['?', '#']);
        var raw = (end < 0 ? target : target[..end]).Split('/');
        // Decode the way the server builds Request.Path (everything except %2F), then require an exact match.
        var matched = (http.Request.PathBase + http.Request.Path).Value ?? "";
        if (!string.Equals(string.Join('/', raw.Select(PathDecode)), matched, StringComparison.Ordinal)) throw AmbiguousPath();
        // "", "operator" | "dashboard", "v1" | "api", "nodes", "{node}" after any path base.
        var index = (http.Request.PathBase.Value?.Split('/', StringSplitOptions.RemoveEmptyEntries).Length ?? 0) + 4;
        return index < raw.Length && PathDecode(raw[index - 1]) == "nodes" ? Uri.UnescapeDataString(raw[index]) : throw AmbiguousPath();
    }

    private static string PathDecode(string segment) => string.Concat(EncodedSlash().Split(segment)
        .Select(part => EncodedSlash().IsMatch(part) ? part : Uri.UnescapeDataString(part)));

    [GeneratedRegex("(%2[Ff])")]
    private static partial Regex EncodedSlash();

    private static OperatorApiException AmbiguousPath() =>
        new(400, "invalid_request", "The request path is not in canonical form.");
}
