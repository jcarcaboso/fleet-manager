using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using Fleet.Core.Coordination;
using Fleet.Server.Persistence;
using Fleet.Server.Source;
using Microsoft.EntityFrameworkCore;
using Testcontainers.PostgreSql;

namespace Fleet.Tests;

public sealed class SourcePublicationTests : IAsyncLifetime
{
    private readonly PostgreSqlContainer _postgres = new PostgreSqlBuilder("postgres:17.5-alpine").Build();
    private readonly string _files = Path.Combine(Path.GetTempPath(), $"fleet-publication-{Guid.NewGuid():N}");
    private readonly WorkspaceId _workspaceId = new(Guid.NewGuid());

    public async Task InitializeAsync()
    {
        await _postgres.StartAsync();
        await using var database = Database();
        await database.Database.EnsureCreatedAsync();
    }

    public async Task DisposeAsync()
    {
        await _postgres.DisposeAsync();
        if (Directory.Exists(_files)) Directory.Delete(_files, recursive: true);
    }

    [Fact]
    public async Task Git_snapshot_publication_produces_the_polled_skill_map_and_bundle_digest()
    {
        await using var database = Database();
        var coordinator = Coordinator(database);
        var now = DateTimeOffset.UtcNow;
        var nodeId = new NodeId(Guid.NewGuid());
        var credentialId = new CredentialId(Guid.NewGuid());
        var certificateDigest = Sha("publication-certificate");
        var authorization = await coordinator.CreateEnrollmentAuthorizationAsync(
            new("source-publication-test", now + TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(1)));
        await coordinator.CompleteEnrollmentAsync(new(
            authorization.Token,
            Sha("publication-csr"),
            "publication-node",
            "linux",
            new(nodeId, credentialId, certificateDigest, now - TimeSpan.FromMinutes(1), now + TimeSpan.FromHours(1), "certificate"u8.ToArray())));

        var source = CreateRepository(nodeId);
        var scanner = new GitSourceScanner(source, Path.Combine(_files, "mirror.git"), new Nodes(nodeId));
        var scan = Assert.IsType<SourceScanResult.Snapshot>(await scanner.ScanAsync(null, CancellationToken.None));
        var publication = await coordinator.AcceptSourceSnapshotAsync(scan.Value);

        var authentication = new NodeAuthentication(nodeId, credentialId, certificateDigest);
        var assignment = Assert.IsType<AgentAssignment>((await coordinator.PollAsync(authentication, DateTimeOffset.UtcNow)).Assignment);
        var skill = Assert.Single(assignment.Skills);
        var sourceBundle = Assert.Single(scan.Value.Bundles);
        Assert.Equal(PublicationOutcome.Accepted, publication.Outcome);
        Assert.Equal("review", skill.Name);
        Assert.Equal(sourceBundle.Digest, skill.BundleDigest);
        Assert.Equal(sourceBundle.Content, (await coordinator.GetBundleAsync(authentication, skill.BundleDigest)).Content);
    }

    private string CreateRepository(NodeId nodeId)
    {
        var repository = Path.Combine(_files, "source");
        Directory.CreateDirectory(repository);
        Git(repository, "init", "-b", "main");
        Git(repository, "config", "user.email", "fixture@example.invalid");
        Git(repository, "config", "user.name", "Fleet Fixture");
        Write(repository, "fleet.yml", $$"""
            schema: fleet/v1
            groups:
              - stable
            targets:
              skills:
                base: home
                path: .agents/skills
            nodes:
              publication-node:
                id: {{nodeId.Value}}
                targets:
                  skills:
                    groups:
                      - stable
            """);
        Write(repository, "groups/stable/review/SKILL.md", "# Review\n\nReview the requested change.\n");
        Git(repository, "add", ".");
        Git(repository, "commit", "-m", "publish review skill");
        return repository;
    }

    private FleetDbContext Database() => new(new DbContextOptionsBuilder<FleetDbContext>()
        .UseNpgsql(_postgres.GetConnectionString()).Options);

    private PostgresFleetCoordinator Coordinator(FleetDbContext database) => new(database, TimeProvider.System,
        new FleetCoordinationOptions { WorkspaceId = _workspaceId, WorkspaceName = "source-publication-test" });

    private static void Write(string repository, string relativePath, string content)
    {
        var path = Path.Combine(repository, relativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content, new UTF8Encoding(false));
    }

    private static void Git(string repository, params string[] arguments)
    {
        var start = new ProcessStartInfo("git")
        {
            WorkingDirectory = repository,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        using var process = Process.Start(start)!;
        var error = process.StandardError.ReadToEnd();
        process.WaitForExit();
        Assert.True(process.ExitCode == 0, error);
    }

    private static string Sha(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private sealed class Nodes(NodeId nodeId) : IEnrolledNodeSource
    {
        public Task<IReadOnlySet<NodeId>> GetNodeIdsAsync(CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlySet<NodeId>>(new HashSet<NodeId> { nodeId });
    }
}
