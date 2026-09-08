using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Fleet.Server.Security;
using Microsoft.Extensions.Options;

namespace Fleet.Tests;

public sealed class CertificateIssuerTests
{
    [Fact]
    public void Newly_valid_issuer_can_issue_without_backdating_before_its_own_validity()
    {
        using var fixture = IssuerFixture.Create(notBefore: DateTimeOffset.UtcNow);
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = NodeCertificateIssuer.ValidateRequest(new CertificateRequest("CN=node", key, HashAlgorithmName.SHA256).CreateSigningRequestPem());
        var issued = fixture.Issuer.Issue(request, Guid.NewGuid());
        using var certificate = X509Certificate2.CreateFromPem(issued.CertificatePem);
        Assert.True(certificate.NotBefore >= fixture.Certificate.NotBefore);
        Assert.True(fixture.Issuer.ValidateChain(certificate));
    }

    [Fact]
    public void Certificate_without_explicit_client_auth_usage_is_rejected()
    {
        using var fixture = IssuerFixture.Create();
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest("CN=general-purpose", key, HashAlgorithmName.SHA256);
        using var certificate = request.Create(fixture.Certificate, DateTimeOffset.UtcNow.AddMinutes(-1),
            DateTimeOffset.UtcNow.AddHours(1), RandomNumberGenerator.GetBytes(16));
        Assert.False(fixture.Issuer.ValidateChain(certificate));
    }

    [Fact]
    public void Valid_p256_csr_gets_a_client_only_certificate_ignoring_request_metadata()
    {
        using var fixture = IssuerFixture.Create();
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest("CN=requested-subject", key, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, true, 12, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign, true));
        var csr = NodeCertificateIssuer.ValidateRequest(request.CreateSigningRequestPem());

        var nodeId = Guid.NewGuid();
        var issued = fixture.Issuer.Issue(csr, nodeId);
        using var certificate = X509Certificate2.CreateFromPem(issued.CertificatePem);

        Assert.Equal($"CN={nodeId:D}", certificate.Subject);
        Assert.Equal(fixture.Certificate.Subject, certificate.Issuer);
        Assert.False(certificate.Extensions.OfType<X509BasicConstraintsExtension>().Single().CertificateAuthority);
        Assert.Equal(X509KeyUsageFlags.DigitalSignature,
            certificate.Extensions.OfType<X509KeyUsageExtension>().Single().KeyUsages);
        var eku = certificate.Extensions.OfType<X509EnhancedKeyUsageExtension>().Single();
        Assert.Contains(eku.EnhancedKeyUsages.Cast<Oid>(), oid => oid.Value == "1.3.6.1.5.5.7.3.2");
        Assert.True(fixture.Issuer.ValidateChain(certificate));
    }

    [Fact]
    public void Non_p256_and_rsa_requests_are_rejected()
    {
        using var p384 = ECDsa.Create(ECCurve.NamedCurves.nistP384);
        using var rsa = RSA.Create(2048);
        Assert.Throws<ArgumentException>(() => NodeCertificateIssuer.ValidateRequest(
            new CertificateRequest("CN=p384", p384, HashAlgorithmName.SHA256).CreateSigningRequestPem()));
        Assert.Throws<ArgumentException>(() => NodeCertificateIssuer.ValidateRequest(
            new CertificateRequest(new X500DistinguishedName("CN=rsa"), rsa, HashAlgorithmName.SHA256,
                RSASignaturePadding.Pkcs1).CreateSigningRequestPem()));
    }

    [Fact]
    public void Tampered_csr_signature_is_rejected()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var pem = new CertificateRequest("CN=valid", key, HashAlgorithmName.SHA256).CreateSigningRequestPem();
        var der = Convert.FromBase64String(string.Concat(pem.Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Where(line => !line.StartsWith("-----", StringComparison.Ordinal))));
        der[^1] ^= 0x01;
        var tampered = "-----BEGIN CERTIFICATE REQUEST-----\n" + Convert.ToBase64String(der, Base64FormattingOptions.InsertLineBreaks) +
            "\n-----END CERTIFICATE REQUEST-----\n";
        Assert.ThrowsAny<CryptographicException>(() => NodeCertificateIssuer.ValidateRequest(tampered));
    }

    [Fact]
    public void Certificate_signed_by_an_unrelated_ca_is_rejected()
    {
        using var fixture = IssuerFixture.Create();
        using var unrelatedKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var unrelatedRequest = new CertificateRequest("CN=unrelated CA", unrelatedKey, HashAlgorithmName.SHA256);
        unrelatedRequest.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        unrelatedRequest.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign, true));
        using var unrelatedCa = unrelatedRequest.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1));
        using var leafKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var leafRequest = new CertificateRequest("CN=forged", leafKey, HashAlgorithmName.SHA256);
        leafRequest.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(
            new OidCollection { new("1.3.6.1.5.5.7.3.2") }, false));
        using var forged = leafRequest.Create(unrelatedCa, DateTimeOffset.UtcNow.AddMinutes(-1),
            DateTimeOffset.UtcNow.AddMinutes(10), RandomNumberGenerator.GetBytes(16));

        Assert.False(fixture.Issuer.ValidateChain(forged));
    }

    [Fact]
    public void Group_readable_issuer_key_is_rejected_on_unix()
    {
        if (OperatingSystem.IsWindows()) return;
        using var fixture = IssuerFixture.Create(UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead);
        Assert.Throws<InvalidOperationException>(() => fixture.CreateIssuer());
    }

    private sealed class IssuerFixture : IDisposable
    {
        private readonly string directory;
        private readonly string certificatePath;
        private readonly string keyPath;
        private readonly UnixFileMode keyMode;
        public X509Certificate2 Certificate { get; }
        public NodeCertificateIssuer Issuer { get; private set; } = null!;

        private IssuerFixture(string directory, string certificatePath, string keyPath, UnixFileMode keyMode,
            X509Certificate2 certificate)
        {
            this.directory = directory;
            this.certificatePath = certificatePath;
            this.keyPath = keyPath;
            this.keyMode = keyMode;
            Certificate = certificate;
            if (OperatingSystem.IsWindows() || (keyMode & (UnixFileMode.GroupRead | UnixFileMode.GroupWrite |
                UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherWrite |
                UnixFileMode.OtherExecute)) == 0)
            {
                Issuer = CreateIssuer();
            }
        }

        public static IssuerFixture Create(UnixFileMode mode = UnixFileMode.UserRead | UnixFileMode.UserWrite, DateTimeOffset? notBefore = null)
        {
            var directory = Path.Combine(Path.GetTempPath(), "fleet-cert-test-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
            var request = new CertificateRequest("CN=Fleet issuer", key, HashAlgorithmName.SHA256);
            request.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
            request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign, true));
            var certificate = request.CreateSelfSigned(notBefore ?? DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(30));
            var certificatePath = Path.Combine(directory, "issuer.pem");
            var keyPath = Path.Combine(directory, "issuer.key");
            File.WriteAllText(certificatePath, certificate.ExportCertificatePem());
            File.WriteAllText(keyPath, key.ExportPkcs8PrivateKeyPem());
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(keyPath, mode);
            return new IssuerFixture(directory, certificatePath, keyPath, mode, certificate);
        }

        public NodeCertificateIssuer CreateIssuer() => new(Options.Create(new FleetOptions
        {
            IssuerCertificatePath = certificatePath,
            IssuerKeyPath = keyPath,
            CertificateLifetimeDays = 1
        }), TimeProvider.System);

        public void Dispose()
        {
            Issuer?.Dispose();
            Certificate.Dispose();
            Directory.Delete(directory, true);
        }
    }
}
