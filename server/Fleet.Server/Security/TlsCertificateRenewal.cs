using System.Security.Cryptography.X509Certificates;
using Fleet.Server.Hosting;
using Microsoft.Extensions.Options;

namespace Fleet.Server.Security;

/// <summary>
/// Keeps the TLS certificates the issuing CA signed valid. The Server's own certificate is renewed in memory: its files are
/// read-only, Agents trust the CA and pin nothing, and the CA key is already here, so a restart can simply issue another. The
/// configured files only seed it, which is why a deployment that copies an older file back changes nothing. The dashboard has
/// no CA key, so the Server replaces the files in their shared directory and the dashboard reloads them.
/// See docs/technical-design/tls-certificates.md.
/// </summary>
public sealed class TlsCertificateRenewal(IOptions<FleetOptions> options, IConfiguration configuration, NodeCertificateIssuer issuer,
    FleetMetrics metrics, TimeProvider time, ILogger<TlsCertificateRenewal> logger) : BackgroundService
{
    private static readonly TimeSpan CaWarning = TimeSpan.FromDays(90);
    private const UnixFileMode SharedFileMode = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead;

    private readonly FleetOptions _settings = options.Value;
    private readonly string? _certificatePath = configuration["Kestrel:Certificates:Default:Path"];
    private readonly string? _keyPath = configuration["Kestrel:Certificates:Default:KeyPath"];
    private X509Certificate2? _template;
    private volatile X509Certificate2? _server;

    /// <summary>False when Kestrel keeps using its configured certificate: there is none, or another CA signed it.</summary>
    public bool ManagesServerCertificate { get; private set; }

    /// <summary>The certificate for new TLS handshakes. Set before the listener binds whenever the certificate is managed.</summary>
    public X509Certificate2? ServerCertificate => _server;

    /// <summary>Chooses the first certificate. Throws when a managed Server would otherwise have none to serve.</summary>
    public void Initialize()
    {
        if (!string.IsNullOrEmpty(_certificatePath))
        {
            _template = X509Certificate2.CreateFromPem(File.ReadAllText(_certificatePath));
            ManagesServerCertificate = issuer.Issued(_template) && _template.Extensions["2.5.29.17"] is not null;
            if (!ManagesServerCertificate)
                logger.LogWarning("The Server certificate was not issued by the issuing CA, so Fleet cannot renew it. It expires at {NotAfter}", NotAfter(_template));
        }
        Renew();
        if (ManagesServerCertificate && _server is null)
            throw new InvalidOperationException("The Server has no usable TLS certificate.");
    }

    /// <summary>One pass over every certificate. A failure leaves that certificate as it is until the next pass.</summary>
    public void Renew()
    {
        metrics.RecordTlsExpiry("ca", issuer.NotAfter);
        if (issuer.NotAfter - time.GetUtcNow() < CaWarning)
            logger.LogWarning("The issuing CA certificate expires at {NotAfter}. Extend it with setup.py --renew-ca; Agents need no change", issuer.NotAfter);
        if (ManagesServerCertificate) RenewServerCertificate();
        else if (_template is not null) metrics.RecordTlsExpiry("server", NotAfter(_template));
        if (_settings.DashboardCertificateDirectory.Length > 0) RenewDashboardCertificate();
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(_settings.TlsCertificateCheckSeconds), time);
        while (await timer.WaitForNextTickAsync(stoppingToken)) Renew();
    }

    private void RenewServerCertificate()
    {
        var current = _server;
        var file = LoadServerFile();
        var now = time.GetUtcNow();
        try
        {
            // A newer file wins, so an Operator can still replace the certificate.
            if (file is not null && !IsDue(file, now) && (current is null || file.NotAfter > current.NotAfter))
            {
                _server = file;
                file = null;
            }
            else if (current is null || IsDue(current, now))
            {
                _server = issuer.IssueTlsCertificate(current ?? _template!, _settings.TlsCertificateLifetimeDays);
                metrics.RecordTlsRenewal("server", true);
                logger.LogInformation("Renewed the Server certificate until {NotAfter}", NotAfter(_server));
            }
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            metrics.RecordTlsRenewal("server", false);
            logger.LogError("Could not renew the Server certificate, which expires at {NotAfter}: {ErrorType}",
                current is null ? null : NotAfter(current), exception.GetType().FullName);
            // Starting up: better a certificate close to expiry than none.
            if (current is null)
            {
                _server = file;
                file = null;
            }
        }
        // Not those already handed to Kestrel: a handshake may be using them.
        file?.Dispose();
        if (_server is { } server) metrics.RecordTlsExpiry("server", NotAfter(server));
    }

    private X509Certificate2? LoadServerFile()
    {
        try
        {
            return X509Certificate2.CreateFromPemFile(_certificatePath!, _keyPath);
        }
        // The files may be half copied, in which case the next pass reads them. The running certificate does not depend on them,
        // and an exception here would stop the Server.
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            logger.LogWarning("Could not read the configured Server certificate: {ErrorType}", exception.GetType().FullName);
            return null;
        }
    }

    private void RenewDashboardCertificate()
    {
        try
        {
            var certificatePath = Path.Combine(_settings.DashboardCertificateDirectory, "dashboard.pem");
            using var current = X509Certificate2.CreateFromPem(File.ReadAllText(certificatePath));
            metrics.RecordTlsExpiry("dashboard", NotAfter(current));
            var now = time.GetUtcNow();
            if (!IsDue(current, now)) return;
            if (!issuer.Issued(current))
            {
                logger.LogWarning("The dashboard certificate was not issued by the issuing CA, so Fleet cannot renew it. It expires at {NotAfter}", NotAfter(current));
                return;
            }
            using var renewed = issuer.IssueTlsCertificate(current, _settings.TlsCertificateLifetimeDays);
            using var key = renewed.GetECDsaPrivateKey()!;
            // The key first: the dashboard reloads when the certificate changes.
            ReplaceFile(Path.Combine(_settings.DashboardCertificateDirectory, "dashboard.key"), key.ExportPkcs8PrivateKeyPem());
            ReplaceFile(certificatePath, renewed.ExportCertificatePem());
            metrics.RecordTlsRenewal("dashboard", true);
            metrics.RecordTlsExpiry("dashboard", NotAfter(renewed));
            logger.LogInformation("Renewed the dashboard certificate until {NotAfter}", NotAfter(renewed));
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            metrics.RecordTlsRenewal("dashboard", false);
            logger.LogError("Could not renew the dashboard certificate: {ErrorType}", exception.GetType().FullName);
        }
    }

    private bool IsDue(X509Certificate2 certificate, DateTimeOffset now) =>
        NotAfter(certificate) - now < TimeSpan.FromDays(_settings.TlsCertificateRenewBeforeDays) &&
        // Close to the CA's own expiry a new certificate could not last longer.
        NotAfter(certificate) < issuer.NotAfter;

    private static DateTimeOffset NotAfter(X509Certificate2 certificate) => certificate.NotAfter.ToUniversalTime();

    private static void ReplaceFile(string path, string contents)
    {
        var temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            var stream = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write };
            if (!OperatingSystem.IsWindows()) stream.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
            using (var file = new StreamWriter(temporary, System.Text.Encoding.ASCII, stream))
            {
                file.Write(contents);
                file.Flush();
                ((FileStream)file.BaseStream).Flush(true);
            }
            // Set after creating, because the process umask limits the mode at creation and the dashboard reads through the group.
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(temporary, SharedFileMode);
            File.Move(temporary, path, true);
        }
        catch
        {
            File.Delete(temporary);
            throw;
        }
    }
}
