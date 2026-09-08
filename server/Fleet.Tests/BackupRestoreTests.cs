using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using Fleet.Core.Coordination;
using Fleet.Server.Persistence;
using Microsoft.EntityFrameworkCore;
using Testcontainers.PostgreSql;

namespace Fleet.Tests;

public sealed class BackupRestoreTests : IAsyncLifetime
{
    private readonly PostgreSqlContainer _source = new PostgreSqlBuilder("postgres:17.5-alpine").Build();
    private readonly PostgreSqlContainer _target = new PostgreSqlBuilder("postgres:17.5-alpine").Build();
    private readonly FleetCoordinationOptions _options = new() { WorkspaceId = new(Guid.NewGuid()) };
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "fleet-backup-test-" + Guid.NewGuid().ToString("N"));

    public async Task InitializeAsync()
    {
        await Task.WhenAll(_source.StartAsync(), _target.StartAsync());
        await using var database = Database(_source);
        await database.Database.MigrateAsync();
    }

    [Fact]
    public async Task Backup_restores_desired_content_credentials_revocation_and_enrollment_consumption()
    {
        var content = "opaque content for backup restoration"u8.ToArray();
        var digest = Convert.ToHexStringLower(SHA256.HashData(content));
        CompleteEnrollment enrollment;
        NodeAuthentication active;
        NodeAuthentication revoked;
        await using (var database = Database(_source))
        {
            var coordinator = Coordinator(database);
            enrollment = await PrepareEnrollment(coordinator, "active");
            await coordinator.CompleteEnrollmentAsync(enrollment);
            active = new(enrollment.IssuedCredential.NodeId, enrollment.IssuedCredential.CredentialId, enrollment.IssuedCredential.CertificateSha256);
            var other = await PrepareEnrollment(coordinator, "revoked");
            await coordinator.CompleteEnrollmentAsync(other);
            revoked = new(other.IssuedCredential.NodeId, other.IssuedCredential.CredentialId, other.IssuedCredential.CertificateSha256);
            await coordinator.RevokeCredentialAsync(revoked.CredentialId, "backup-test");
            await coordinator.AcceptSourceSnapshotAsync(new("backup-source", [new(digest, "fleet.bundle/v1", content.Length, content)],
                [new(active.NodeId, "skills", new("home", ".agents/skills"), [new("review", digest)])], [], DateTimeOffset.UtcNow));
        }

        Assert.Equal(0, await BackupCommand("backup", _source));
        Assert.NotEqual(0, await BackupCommand("backup", _source));
        Assert.Equal(0, await BackupCommand("restore", _target));
        Assert.NotEqual(0, await BackupCommand("restore", _target));
        await using (var restored = Database(_target))
        {
            var coordinator = Coordinator(restored);
            Assert.Equal(active, await coordinator.FindActiveNodeByCertificateAsync(active.CertificateSha256));
            Assert.Null(await coordinator.FindActiveNodeByCertificateAsync(revoked.CertificateSha256));
            Assert.Equal(EnrollmentOutcome.Retry, (await coordinator.CompleteEnrollmentAsync(enrollment)).Outcome);
            var assignment = Assert.IsType<AgentAssignment>((await coordinator.PollAsync(active, DateTimeOffset.UtcNow)).Assignment);
            Assert.Equal(digest, Assert.Single(assignment.Skills).BundleDigest);
            Assert.Equal(content, (await coordinator.GetBundleAsync(active, digest)).Content);
            Assert.Empty(await restored.Database.GetPendingMigrationsAsync());
        }
        var dump = Path.Combine(_directory, "database.dump");
        await using (var file = new FileStream(dump, FileMode.Append)) await file.WriteAsync(new byte[] { 42 });
        Assert.NotEqual(0, await BackupCommand("restore", _target));
    }

    private async Task<CompleteEnrollment> PrepareEnrollment(IFleetCoordinator coordinator, string name)
    {
        var now = DateTimeOffset.UtcNow;
        var token = await coordinator.CreateEnrollmentAuthorizationAsync(new("backup-test", now.AddMinutes(15), TimeSpan.FromMinutes(5)));
        var digest = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(name)));
        return new(token.Token, digest, name, "linux", new(new(Guid.NewGuid()), new(Guid.NewGuid()), digest,
            now.AddMinutes(-1), now.AddDays(1), "public-certificate-response"u8.ToArray()));
    }

    private async Task<int> BackupCommand(string operation, PostgreSqlContainer container)
    {
        var start = new ProcessStartInfo("python3") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        foreach (var argument in new[] { Path.Combine(AppContext.BaseDirectory, "scripts/postgres-backup.py"), operation,
            "--container", container.Name, "--database", "postgres", "--username", "postgres", _directory }) start.ArgumentList.Add(argument);
        using var process = Process.Start(start)!;
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var stdout = process.StandardOutput.ReadToEndAsync(timeout.Token);
        var stderr = process.StandardError.ReadToEndAsync(timeout.Token);
        try { await process.WaitForExitAsync(timeout.Token); }
        finally { if (!process.HasExited) process.Kill(true); }
        await Task.WhenAll(stdout, stderr);
        return process.ExitCode;
    }

    private FleetDbContext Database(PostgreSqlContainer container) => new(new DbContextOptionsBuilder<FleetDbContext>().UseNpgsql(container.GetConnectionString()).Options);
    private IFleetCoordinator Coordinator(FleetDbContext database) => new PostgresFleetCoordinator(database, TimeProvider.System, _options);
    public async Task DisposeAsync()
    {
        await _source.DisposeAsync();
        await _target.DisposeAsync();
        if (Directory.Exists(_directory)) Directory.Delete(_directory, true);
    }
}
