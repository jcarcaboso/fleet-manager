using System.Net;
using System.Net.Http.Json;
using System.Net.Security;
using System.Net.Sockets;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using Fleet.Server.Hosting;
using Fleet.Server.Security;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace Fleet.Tests;

[UnsupportedOSPlatform("windows")]
public sealed class TlsCertificateRenewalTests : IDisposable
{
    private static readonly string[] Names = ["fleet.example", "localhost"];
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "fleet-tls-" + Guid.NewGuid().ToString("N"));
    private readonly TestClock _clock = new();
    private readonly FleetMetrics _metrics = new();
    private readonly ECDsa _caKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
    private readonly X509Certificate2 _ca;
    private readonly NodeCertificateIssuer _issuer;

    public TlsCertificateRenewalTests()
    {
        Directory.CreateDirectory(_directory);
        (_ca, _issuer) = CreateIssuer(_caKey, TimeSpan.FromDays(365));
    }

    public void Dispose()
    {
        _issuer.Dispose();
        _ca.Dispose();
        _caKey.Dispose();
        _metrics.Dispose();
        Directory.Delete(_directory, true);
    }

    private string CertificatePath => Path.Combine(_directory, "server.pem");
    private string KeyPath => Path.Combine(_directory, "server.key");
    private string DashboardDirectory => Path.Combine(_directory, "dashboard");
    private string DashboardCertificatePath => Path.Combine(DashboardDirectory, "dashboard.pem");
    private string DashboardKeyPath => Path.Combine(DashboardDirectory, "dashboard.key");

    private (X509Certificate2 Certificate, NodeCertificateIssuer Issuer) CreateIssuer(ECDsa key, TimeSpan lifetime)
    {
        var request = new CertificateRequest("CN=Fleet renewal CA", key, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign, true));
        request.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(request.PublicKey, false));
        var certificate = request.CreateSelfSigned(_clock.Now.AddDays(-200), _clock.Now.Add(lifetime));
        var certificatePath = Path.Combine(_directory, Guid.NewGuid().ToString("N") + ".pem");
        var keyPath = certificatePath + ".key";
        File.WriteAllText(certificatePath, certificate.ExportCertificatePem());
        File.WriteAllText(keyPath, key.ExportPkcs8PrivateKeyPem());
        File.SetUnixFileMode(keyPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        var settings = new FleetOptions { IssuerCertificatePath = certificatePath, IssuerKeyPath = keyPath };
        return (certificate, new NodeCertificateIssuer(Options.Create(settings), _clock));
    }

    private X509Certificate2 Leaf(X509Certificate2 issuer, ECDsa issuerKey, int daysLeft, DateTimeOffset? now = null)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest("CN=fleet.example", key, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature, true));
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new("1.3.6.1.5.5.7.3.1") }, false));
        var names = new SubjectAlternativeNameBuilder();
        foreach (var name in Names) names.AddDnsName(name);
        request.CertificateExtensions.Add(names.Build());
        var time = now ?? _clock.Now;
        var notAfter = time.AddDays(daysLeft);
        var notBefore = notAfter.AddDays(-90);
        if (notBefore < new DateTimeOffset(issuer.NotBefore)) notBefore = new DateTimeOffset(issuer.NotBefore);
        using var certificate = request.Create(issuer.SubjectName, X509SignatureGenerator.CreateForECDsa(issuerKey), notBefore, notAfter,
            RandomNumberGenerator.GetBytes(16));
        return certificate.CopyWithPrivateKey(key);
    }

    private void WriteFiles(X509Certificate2 certificate, string certificatePath, string keyPath)
    {
        using var key = certificate.GetECDsaPrivateKey()!;
        File.WriteAllText(certificatePath, certificate.ExportCertificatePem());
        File.WriteAllText(keyPath, key.ExportPkcs8PrivateKeyPem());
    }

    private void WriteServerFiles(int daysLeft)
    {
        using var certificate = Leaf(_ca, _caKey, daysLeft);
        WriteFiles(certificate, CertificatePath, KeyPath);
    }

    private TlsCertificateRenewal Renewal(bool dashboard = false, NodeCertificateIssuer? issuer = null, bool server = true)
    {
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Kestrel:Certificates:Default:Path"] = server ? CertificatePath : null,
            ["Kestrel:Certificates:Default:KeyPath"] = server ? KeyPath : null
        }).Build();
        var settings = new FleetOptions { DashboardCertificateDirectory = dashboard ? DashboardDirectory : "" };
        return new(Options.Create(settings), configuration, issuer ?? _issuer, _metrics, _clock, NullLogger<TlsCertificateRenewal>.Instance);
    }

    private void AssertTrustedTlsCertificate(X509Certificate2 certificate, X509Certificate2? ca = null)
    {
        using var chain = new X509Chain();
        chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
        chain.ChainPolicy.CustomTrustStore.Add(ca ?? _ca);
        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        chain.ChainPolicy.VerificationTime = _clock.Now.UtcDateTime;
        chain.ChainPolicy.ApplicationPolicy.Add(new Oid("1.3.6.1.5.5.7.3.1"));
        Assert.True(chain.Build(certificate), string.Join(", ", chain.ChainStatus.Select(x => x.StatusInformation)));
        Assert.True(certificate.MatchesHostname("fleet.example"));
        Assert.True(certificate.MatchesHostname("localhost"));
        Assert.Equal("CN=fleet.example", certificate.Subject);
    }

    [Fact]
    public void A_certificate_with_time_left_is_served_as_configured()
    {
        WriteServerFiles(60);
        var renewal = Renewal();
        renewal.Initialize();
        Assert.True(renewal.ManagesServerCertificate);
        Assert.Equal(X509Certificate2.CreateFromPemFile(CertificatePath, KeyPath).Thumbprint, renewal.ServerCertificate!.Thumbprint);
        Assert.DoesNotContain("tls.server.renewal.ok", _metrics.Snapshot().Keys);
    }

    [Theory]
    [InlineData(20)]
    [InlineData(-30)]
    public void A_certificate_close_to_expiry_or_expired_is_replaced_before_anything_is_served(int daysLeft)
    {
        WriteServerFiles(daysLeft);
        var renewal = Renewal();
        renewal.Initialize();
        var renewed = renewal.ServerCertificate!;
        AssertTrustedTlsCertificate(renewed);
        Assert.True(renewed.HasPrivateKey);
        Assert.Equal(_clock.Now.AddDays(90).ToUnixTimeSeconds(), new DateTimeOffset(renewed.NotAfter).ToUnixTimeSeconds());
        Assert.Equal(1, _metrics.Snapshot()["tls.server.renewal.ok"]);
        Assert.Equal(new DateTimeOffset(renewed.NotAfter).ToUnixTimeSeconds(), _metrics.Snapshot()["tls.server.not_after_unix"]);
    }

    [Fact]
    public void A_renewed_certificate_has_the_extensions_setup_gives_its_certificates()
    {
        WriteServerFiles(1);
        var renewal = Renewal();
        renewal.Initialize();
        var renewed = renewal.ServerCertificate!;
        using var publicKey = renewed.GetECDsaPublicKey()!;
        Assert.Equal(256, publicKey.KeySize);
        Assert.Equal("1.2.840.10045.3.1.7", publicKey.ExportParameters(false).Curve.Oid.Value);
        Assert.Equal("sha256ECDSA", renewed.SignatureAlgorithm.FriendlyName);
        Assert.False(renewed.Extensions.OfType<X509BasicConstraintsExtension>().Single().CertificateAuthority);
        Assert.Equal(X509KeyUsageFlags.DigitalSignature, renewed.Extensions.OfType<X509KeyUsageExtension>().Single().KeyUsages);
        Assert.Equal("1.3.6.1.5.5.7.3.1", renewed.Extensions.OfType<X509EnhancedKeyUsageExtension>().Single().EnhancedKeyUsages[0].Value);
        Assert.NotEmpty(renewed.Extensions.OfType<X509SubjectKeyIdentifierExtension>().Single().SubjectKeyIdentifier!);
        Assert.Equal(_ca.Extensions.OfType<X509SubjectKeyIdentifierExtension>().Single().RawData[2..],
            renewed.Extensions.OfType<X509AuthorityKeyIdentifierExtension>().Single().KeyIdentifier!.Value.ToArray());
    }

    [Fact]
    public void A_running_Server_renews_when_the_window_opens_and_only_then()
    {
        WriteServerFiles(60);
        var renewal = Renewal();
        renewal.Initialize();
        var first = renewal.ServerCertificate!;
        _clock.Now = _clock.Now.AddDays(29);
        renewal.Renew();
        Assert.Same(first, renewal.ServerCertificate);
        _clock.Now = _clock.Now.AddDays(2);
        renewal.Renew();
        var second = renewal.ServerCertificate!;
        Assert.NotEqual(first.Thumbprint, second.Thumbprint);
        AssertTrustedTlsCertificate(second);
        renewal.Renew();
        Assert.Same(second, renewal.ServerCertificate);
    }

    [Fact]
    public void An_older_file_copied_back_by_a_deployment_does_not_replace_a_renewed_certificate()
    {
        WriteServerFiles(10);
        var renewal = Renewal();
        renewal.Initialize();
        var renewed = renewal.ServerCertificate!;
        WriteServerFiles(45);
        renewal.Renew();
        Assert.Same(renewed, renewal.ServerCertificate);
    }

    [Fact]
    public void A_newer_file_is_adopted_without_a_restart()
    {
        WriteServerFiles(60);
        var renewal = Renewal();
        renewal.Initialize();
        WriteServerFiles(89);
        renewal.Renew();
        Assert.Equal(X509Certificate2.CreateFromPemFile(CertificatePath, KeyPath).Thumbprint, renewal.ServerCertificate!.Thumbprint);
    }

    [Fact]
    public void A_half_copied_file_changes_nothing()
    {
        WriteServerFiles(60);
        var renewal = Renewal();
        renewal.Initialize();
        var first = renewal.ServerCertificate!;
        using var other = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        File.WriteAllText(KeyPath, other.ExportPkcs8PrivateKeyPem());
        renewal.Renew();
        File.WriteAllText(CertificatePath, "-----BEGIN CERTIFICATE-----\ngarbage");
        renewal.Renew();
        File.Delete(CertificatePath);
        renewal.Renew();
        Assert.Same(first, renewal.ServerCertificate);
    }

    [Fact]
    public void A_certificate_from_another_CA_is_left_to_Kestrel()
    {
        using var otherKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var (other, otherIssuer) = CreateIssuer(otherKey, TimeSpan.FromDays(365));
        using (other)
        using (otherIssuer)
        {
            using var certificate = Leaf(other, otherKey, 2);
            WriteFiles(certificate, CertificatePath, KeyPath);
            var renewal = Renewal();
            renewal.Initialize();
            Assert.False(renewal.ManagesServerCertificate);
            Assert.Null(renewal.ServerCertificate);
            Assert.Equal(new DateTimeOffset(certificate.NotAfter).ToUnixTimeSeconds(), _metrics.Snapshot()["tls.server.not_after_unix"]);
        }
    }

    [Fact]
    public void A_certificate_without_names_is_left_to_Kestrel()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest("CN=fleet.example", key, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new("1.3.6.1.5.5.7.3.1") }, false));
        using var signed = request.Create(_ca.SubjectName, X509SignatureGenerator.CreateForECDsa(_caKey), _clock.Now.AddDays(-1), _clock.Now.AddDays(2),
            RandomNumberGenerator.GetBytes(16));
        using var certificate = signed.CopyWithPrivateKey(key);
        WriteFiles(certificate, CertificatePath, KeyPath);
        var renewal = Renewal();
        renewal.Initialize();
        Assert.False(renewal.ManagesServerCertificate);
    }

    [Fact]
    public void Without_a_configured_certificate_nothing_is_managed()
    {
        var renewal = Renewal(server: false);
        renewal.Initialize();
        Assert.False(renewal.ManagesServerCertificate);
        Assert.Equal(_issuer.NotAfter.ToUnixTimeSeconds(), _metrics.Snapshot()["tls.ca.not_after_unix"]);
    }

    [Fact]
    public void A_renewed_certificate_stops_at_the_CA_expiry_and_is_not_reissued_every_pass()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var (ca, issuer) = CreateIssuer(key, TimeSpan.FromDays(20));
        using (ca)
        using (issuer)
        {
            using var certificate = Leaf(ca, key, 5);
            WriteFiles(certificate, CertificatePath, KeyPath);
            var renewal = Renewal(issuer: issuer);
            renewal.Initialize();
            var renewed = renewal.ServerCertificate!;
            Assert.Equal(ca.NotAfter, renewed.NotAfter);
            AssertTrustedTlsCertificate(renewed, ca);
            renewal.Renew();
            Assert.Same(renewed, renewal.ServerCertificate);
            Assert.Equal(1, _metrics.Snapshot()["tls.server.renewal.ok"]);
        }
    }

    [Fact]
    public void Extending_the_CA_with_its_key_and_subject_keeps_every_issued_certificate_valid()
    {
        WriteServerFiles(1);
        var renewal = Renewal();
        renewal.Initialize();
        using var nodeKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var nodeRequest = NodeCertificateIssuer.ValidateRequest(new CertificateRequest("CN=node", nodeKey, HashAlgorithmName.SHA256).CreateSigningRequestPem());
        using var node = X509Certificate2.CreateFromPem(_issuer.Issue(nodeRequest, Guid.NewGuid()).CertificatePem);
        // What setup.py --renew-ca does: the same key and subject, later dates, another serial number.
        var (extended, extendedIssuer) = CreateIssuer(_caKey, TimeSpan.FromDays(3650));
        using (extended)
        using (extendedIssuer)
        {
            Assert.NotEqual(_ca.SerialNumber, extended.SerialNumber);
            Assert.True(extendedIssuer.ValidateChain(node));
            Assert.True(extendedIssuer.Issued(renewal.ServerCertificate!));
            using var issuedLater = extendedIssuer.IssueTlsCertificate(renewal.ServerCertificate!, 90);
            AssertTrustedTlsCertificate(issuedLater, _ca);
        }
    }

    [Fact]
    public void A_certificate_close_to_expiry_is_served_if_a_new_one_cannot_be_issued()
    {
        WriteServerFiles(5);
        using var issuer = FailingIssuer();
        var renewal = Renewal(issuer: issuer);
        renewal.Initialize();
        Assert.Equal(X509Certificate2.CreateFromPemFile(CertificatePath, KeyPath).Thumbprint, renewal.ServerCertificate!.Thumbprint);
        Assert.Equal(1, _metrics.Snapshot()["tls.server.renewal.failed"]);
    }

    [Fact]
    public void A_failed_renewal_keeps_the_running_certificate_and_a_later_pass_retries()
    {
        WriteServerFiles(5);
        using var issuer = FailingIssuer(failures: 1);
        var renewal = Renewal(issuer: issuer);
        renewal.Initialize();
        var seed = renewal.ServerCertificate!;
        renewal.Renew();
        Assert.NotEqual(seed.Thumbprint, renewal.ServerCertificate!.Thumbprint);
        AssertTrustedTlsCertificate(renewal.ServerCertificate!);
    }

    private NodeCertificateIssuer FailingIssuer(int failures = int.MaxValue)
    {
        var path = Path.Combine(_directory, "failing.pem");
        File.WriteAllText(path, _ca.ExportCertificatePem());
        File.WriteAllText(path + ".key", _caKey.ExportPkcs8PrivateKeyPem());
        File.SetUnixFileMode(path + ".key", UnixFileMode.UserRead | UnixFileMode.UserWrite);
        var clock = new FailingClock(_clock, failures);
        var issuer = new NodeCertificateIssuer(Options.Create(new FleetOptions { IssuerCertificatePath = path, IssuerKeyPath = path + ".key" }), clock);
        clock.Armed = true;
        return issuer;
    }

    private void WriteDashboardFiles(int daysLeft, X509Certificate2? issuer = null, ECDsa? issuerKey = null)
    {
        Directory.CreateDirectory(DashboardDirectory);
        using var certificate = Leaf(issuer ?? _ca, issuerKey ?? _caKey, daysLeft);
        WriteFiles(certificate, DashboardCertificatePath, DashboardKeyPath);
    }

    [Fact]
    public void The_dashboard_certificate_is_replaced_in_its_directory_when_it_is_due()
    {
        WriteDashboardFiles(29);
        var renewal = Renewal(dashboard: true, server: false);
        renewal.Initialize();
        using var renewed = X509Certificate2.CreateFromPemFile(DashboardCertificatePath, DashboardKeyPath);
        AssertTrustedTlsCertificate(renewed);
        Assert.Equal(_clock.Now.AddDays(90).ToUnixTimeSeconds(), new DateTimeOffset(renewed.NotAfter).ToUnixTimeSeconds());
        var groupRead = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead;
        Assert.Equal(groupRead, File.GetUnixFileMode(DashboardCertificatePath));
        Assert.Equal(groupRead, File.GetUnixFileMode(DashboardKeyPath));
        Assert.Equal(["dashboard.key", "dashboard.pem"], Directory.GetFiles(DashboardDirectory).Select(Path.GetFileName).Order(StringComparer.Ordinal));
        Assert.Equal(new DateTimeOffset(renewed.NotAfter).ToUnixTimeSeconds(), _metrics.Snapshot()["tls.dashboard.not_after_unix"]);
    }

    [Fact]
    public void A_dashboard_certificate_with_time_left_is_not_touched()
    {
        WriteDashboardFiles(31);
        var before = File.ReadAllText(DashboardCertificatePath);
        Renewal(dashboard: true, server: false).Initialize();
        Assert.Equal(before, File.ReadAllText(DashboardCertificatePath));
    }

    [Fact]
    public void A_dashboard_certificate_from_another_CA_is_not_touched()
    {
        using var otherKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var (other, otherIssuer) = CreateIssuer(otherKey, TimeSpan.FromDays(365));
        using (other)
        using (otherIssuer)
        {
            WriteDashboardFiles(2, other, otherKey);
            var before = File.ReadAllText(DashboardCertificatePath);
            Renewal(dashboard: true, server: false).Initialize();
            Assert.Equal(before, File.ReadAllText(DashboardCertificatePath));
        }
    }

    [Fact]
    public void A_dashboard_failure_is_reported_and_does_not_stop_the_Server()
    {
        WriteServerFiles(60);
        WriteDashboardFiles(2);
        var before = File.ReadAllText(DashboardCertificatePath);
        // Replacing a directory fails for every user, root included.
        File.Delete(DashboardKeyPath);
        Directory.CreateDirectory(DashboardKeyPath);
        var renewal = Renewal(dashboard: true);
        renewal.Initialize();
        Assert.NotNull(renewal.ServerCertificate);
        Assert.Equal(before, File.ReadAllText(DashboardCertificatePath));
        Assert.Equal(1, _metrics.Snapshot()["tls.dashboard.renewal.failed"]);
        Assert.Equal(["dashboard.pem"], Directory.GetFiles(DashboardDirectory).Select(Path.GetFileName));
    }

    // -30 is the lasting state of a deployment whose secret store keeps the first certificate: the file is only a seed.
    [Theory]
    [InlineData(5)]
    [InlineData(-30)]
    public async Task Kestrel_serves_each_renewal_to_new_connections_without_a_restart(int seedDaysLeft)
    {
        WriteServerFiles(seedDaysLeft);
        using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.UseUrls("https://127.0.0.1:0");
            builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["urls"] = "https://127.0.0.1:0",
                ["ConnectionStrings:Fleet"] = "Host=127.0.0.1;Port=1;Database=none;Username=none;Password=none",
                ["Fleet:WorkspaceId"] = "ecf620df-4637-490d-95b3-a9f81ca4c353",
                ["Fleet:OperatorTokenSha256"] = new string('a', 64),
                ["Fleet:IssuerCertificatePath"] = WriteCa(),
                ["Fleet:IssuerKeyPath"] = Path.Combine(_directory, "ca.key"),
                ["Source:Remote"] = "",
                ["Kestrel:Certificates:Default:Path"] = CertificatePath,
                ["Kestrel:Certificates:Default:KeyPath"] = KeyPath
            }));
            builder.ConfigureServices(services => services.AddSingleton<TimeProvider>(_clock));
        });
        factory.UseKestrel();
        factory.StartServer();
        var address = new Uri(factory.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single());

        // The configured file is due, so the listener must never have shown it.
        var first = await PeerCertificateAsync(address);
        using var seed = X509Certificate2.CreateFromPemFile(CertificatePath, KeyPath);
        Assert.NotEqual(seed.Thumbprint, first.Thumbprint);
        AssertTrustedTlsCertificate(first);

        _clock.Now = _clock.Now.AddDays(70);
        factory.Services.GetRequiredService<TlsCertificateRenewal>().Renew();
        var second = await PeerCertificateAsync(address);
        Assert.NotEqual(first.Thumbprint, second.Thumbprint);
        AssertTrustedTlsCertificate(second);

        using var handler = new HttpClientHandler { ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator };
        using var client = new HttpClient(handler) { BaseAddress = address };
        Assert.Equal("live", (await client.GetFromJsonAsync<JsonElement>("/health/live")).GetProperty("status").GetString());
    }

    private string WriteCa()
    {
        var certificatePath = Path.Combine(_directory, "ca.pem");
        var keyPath = Path.Combine(_directory, "ca.key");
        File.WriteAllText(certificatePath, _ca.ExportCertificatePem());
        File.WriteAllText(keyPath, _caKey.ExportPkcs8PrivateKeyPem());
        File.SetUnixFileMode(keyPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        return certificatePath;
    }

    private static async Task<X509Certificate2> PeerCertificateAsync(Uri address)
    {
        using var client = new TcpClient();
        await client.ConnectAsync(IPAddress.Loopback, address.Port);
        await using var stream = new SslStream(client.GetStream());
        await stream.AuthenticateAsClientAsync(new SslClientAuthenticationOptions
        {
            TargetHost = "localhost",
            RemoteCertificateValidationCallback = (_, _, _, _) => true
        });
        return X509CertificateLoader.LoadCertificate(stream.RemoteCertificate!.GetRawCertData());
    }

    private sealed class TestClock : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = DateTimeOffset.UtcNow;
        public override DateTimeOffset GetUtcNow() => Now;
    }

    // Stands for a CA key that stopped working: the issuer reads the time just before it signs.
    private sealed class FailingClock(TestClock inner, int failures) : TimeProvider
    {
        public bool Armed { get; set; }
        public override DateTimeOffset GetUtcNow() => Armed && failures-- > 0 ? throw new CryptographicException("signing failed") : inner.Now;
    }
}
