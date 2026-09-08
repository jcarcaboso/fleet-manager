using System.ComponentModel.DataAnnotations;

namespace Fleet.Server.Security;

public sealed class FleetOptions
{
    public Guid WorkspaceId { get; set; }
    public string OperatorTokenSha256 { get; set; } = "";
    public string OperatorName { get; set; } = "operator";
    public Dictionary<string, string> Operators { get; set; } = [];
    [Required] public string IssuerCertificatePath { get; set; } = "";
    [Required] public string IssuerKeyPath { get; set; } = "";
    [Range(1, 30)] public int CertificateLifetimeDays { get; set; } = 7;
    [Range(30, 600)] public int EnrollmentDeliverySeconds { get; set; } = 120;
    [Range(10, 3600)] public int PollIntervalSeconds { get; set; } = 60;
    [Range(60, 86400)] public int StaleAfterSeconds { get; set; } = 300;
    public bool AllowLoopbackHttp { get; set; }
    // Empty disables the browser dashboard. Never derive enrollment origins from Host headers.
    public string PublicUrl { get; set; } = "";
    public string EnrollmentCaCertificatePath { get; set; } = "";

    public bool HasValidPublicUrl() => PublicUrl.Length == 0 ||
        (Uri.TryCreate(PublicUrl, UriKind.Absolute, out var uri) && uri.Scheme == "https" &&
         uri.Host.Length > 0 && uri.UserInfo.Length == 0 && uri.AbsolutePath == "/" &&
         uri.Query.Length == 0 && uri.Fragment.Length == 0);

    public IEnumerable<KeyValuePair<string, string>> OperatorCredentials()
    {
        foreach (var item in Operators) yield return item;
        if (!string.IsNullOrEmpty(OperatorTokenSha256)) yield return new(OperatorName, OperatorTokenSha256);
    }

    public bool HasValidOperators()
    {
        var credentials = OperatorCredentials().ToArray();
        return credentials.Length is > 0 and <= 100 && credentials.All(x =>
            x.Key.Length is > 0 and <= 128 && x.Key.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.') &&
            x.Value.Length == 64 && x.Value.All(Uri.IsHexDigit)) &&
            credentials.Select(x => x.Key).Distinct(StringComparer.Ordinal).Count() == credentials.Length &&
            credentials.Select(x => x.Value).Distinct(StringComparer.OrdinalIgnoreCase).Count() == credentials.Length;
    }
}
