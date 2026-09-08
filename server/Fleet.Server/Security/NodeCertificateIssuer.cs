using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Microsoft.Extensions.Options;

namespace Fleet.Server.Security;

public sealed class NodeCertificateIssuer : IDisposable
{
    private readonly X509Certificate2 _issuer;
    private readonly FleetOptions _options;
    private readonly TimeProvider _time;

    public NodeCertificateIssuer(IOptions<FleetOptions> options, TimeProvider time)
    {
        _options = options.Value;
        _time = time;
        if (!OperatingSystem.IsWindows())
        {
            var mode = File.GetUnixFileMode(_options.IssuerKeyPath);
            if ((mode & (UnixFileMode.GroupRead | UnixFileMode.GroupWrite | UnixFileMode.GroupExecute |
                UnixFileMode.OtherRead | UnixFileMode.OtherWrite | UnixFileMode.OtherExecute)) != 0)
            {
                throw new InvalidOperationException("The issuing key must have user-only permissions.");
            }
        }
        _issuer = X509Certificate2.CreateFromPemFile(_options.IssuerCertificatePath, _options.IssuerKeyPath);
        if (!_issuer.HasPrivateKey || !_issuer.Extensions.OfType<X509BasicConstraintsExtension>().Any(x => x.CertificateAuthority) ||
            !_issuer.Extensions.OfType<X509KeyUsageExtension>().Any(x => x.KeyUsages.HasFlag(X509KeyUsageFlags.KeyCertSign)))
        {
            throw new InvalidOperationException("The configured issuer must be a CA certificate with a private key.");
        }
        var now = _time.GetUtcNow();
        if (now < _issuer.NotBefore.ToUniversalTime() || now.AddDays(_options.CertificateLifetimeDays) > _issuer.NotAfter.ToUniversalTime())
        {
            _issuer.Dispose();
            throw new InvalidOperationException("The issuing certificate cannot cover the configured credential lifetime.");
        }
    }

    public static CertificateRequest ValidateRequest(string pem)
    {
        if (string.IsNullOrWhiteSpace(pem) || pem.Length > 8192)
        {
            throw new ArgumentException("invalid_certificate_request");
        }
        // Default load options verify the PKCS #10 signature. Never copy requested extensions.
        var request = CertificateRequest.LoadSigningRequestPem(pem, HashAlgorithmName.SHA256);
        using var key = request.PublicKey.GetECDsaPublicKey();
        if (key is null || key.KeySize != 256 || key.ExportParameters(false).Curve.Oid.Value != "1.2.840.10045.3.1.7")
        {
            throw new ArgumentException("invalid_certificate_request");
        }
        return request;
    }

    public IssuedNodeCertificate Issue(CertificateRequest verified, Guid nodeId)
    {
        var request = new CertificateRequest(new X500DistinguishedName($"CN={nodeId:D}"), verified.PublicKey, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature, true));
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new("1.3.6.1.5.5.7.3.2") }, true));
        var now = _time.GetUtcNow();
        var expires = now.AddDays(_options.CertificateLifetimeDays);
        if (expires > _issuer.NotAfter.ToUniversalTime() || now < _issuer.NotBefore.ToUniversalTime())
        {
            throw new InvalidOperationException("The issuing certificate is outside its usable lifetime.");
        }
        var notBefore = now.AddMinutes(-1);
        if (notBefore < _issuer.NotBefore.ToUniversalTime()) notBefore = _issuer.NotBefore.ToUniversalTime();
        using var certificate = request.Create(_issuer, notBefore, expires, RandomNumberGenerator.GetBytes(16));
        return new(certificate.ExportCertificatePem(), certificate.GetCertHashString(HashAlgorithmName.SHA256).ToLowerInvariant(), expires);
    }

    public bool ValidateChain(X509Certificate2 certificate)
    {
        using var chain = new X509Chain();
        chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
        chain.ChainPolicy.CustomTrustStore.Add(_issuer);
        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        chain.ChainPolicy.DisableCertificateDownloads = true;
        chain.ChainPolicy.VerificationTime = _time.GetUtcNow().UtcDateTime;
        chain.ChainPolicy.ApplicationPolicy.Add(new Oid("1.3.6.1.5.5.7.3.2"));
        return certificate.Extensions.OfType<X509EnhancedKeyUsageExtension>().Any(x =>
                x.EnhancedKeyUsages.Cast<Oid>().Any(oid => oid.Value == "1.3.6.1.5.5.7.3.2"))
            && !certificate.Extensions.OfType<X509BasicConstraintsExtension>().Any(x => x.CertificateAuthority)
            && chain.Build(certificate);
    }

    public void Dispose() => _issuer.Dispose();
}

public sealed record IssuedNodeCertificate(string CertificatePem, string Sha256, DateTimeOffset ExpiresAt);
