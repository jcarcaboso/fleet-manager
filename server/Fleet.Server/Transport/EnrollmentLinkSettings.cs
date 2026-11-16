using System.Security.Cryptography.X509Certificates;
using Fleet.Server.Security;

namespace Fleet.Server.Transport;

/// <summary>Public origin and enrollment CA used to build enrollment links. Empty when Fleet:PublicUrl is not set.</summary>
public sealed class EnrollmentLinkSettings
{
    public string? Origin { get; private init; }
    public string? CaPem { get; private init; }

    public static EnrollmentLinkSettings Load(FleetOptions settings)
    {
        if (string.IsNullOrEmpty(settings.PublicUrl)) return new();
        var caPath = string.IsNullOrEmpty(settings.EnrollmentCaCertificatePath)
            ? settings.IssuerCertificatePath : settings.EnrollmentCaCertificatePath;
        var caText = File.ReadAllText(caPath);
        if (caText.Length > 8192 || caText.Contains("PRIVATE KEY", StringComparison.Ordinal))
            throw new InvalidOperationException("Enrollment CA must contain only a bounded public certificate.");
        using var ca = X509Certificate2.CreateFromPem(caText);
        if (!ca.Extensions.OfType<X509BasicConstraintsExtension>().Any(x => x.CertificateAuthority))
            throw new InvalidOperationException("Enrollment trust must be a CA certificate.");
        return new() { Origin = new Uri(settings.PublicUrl).GetLeftPart(UriPartial.Authority), CaPem = ca.ExportCertificatePem() };
    }
}
