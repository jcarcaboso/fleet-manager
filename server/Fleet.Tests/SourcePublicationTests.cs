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

        var source = CreateRepository();
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

    [Fact]
    public async Task Publication_persists_managed_files_and_authorizes_their_content()
    {
        await using var database = Database();
        var coordinator = Coordinator(database);
        var now = DateTimeOffset.UtcNow;
        var nodeId = new NodeId(Guid.NewGuid());
        var credentialId = new CredentialId(Guid.NewGuid());
        var certificateDigest = Sha("managed-file-certificate");
        var authorization = await coordinator.CreateEnrollmentAuthorizationAsync(
            new("managed-file-test", now + TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(1)));
        await coordinator.CompleteEnrollmentAsync(new(
            authorization.Token,
            Sha("managed-file-csr"),
            "publication-node",
            "linux",
            new(nodeId, credentialId, certificateDigest, now - TimeSpan.FromMinutes(1), now + TimeSpan.FromHours(1), "certificate"u8.ToArray())));

        var source = CreateRepository();
        Write(source, "fleet.yml", """
            schema: fleet/v1
            targets:
              skills:
                base: home
                path: .agents/skills
            nodes:
              publication-node:
                targets:
                  skills:
                    groups:
                      - stable
                  agents:
                    - source: personal
                      clients: [codex]
            """);
        Write(source, "agents/personal/AGENTS.md", "# Fleet instructions\n");
        Git(source, "add", ".");
        Git(source, "commit", "-m", "add managed agent file");

        var scanner = new GitSourceScanner(source, Path.Combine(_files, "managed-file-mirror.git"), new Nodes(nodeId));
        var scan = Assert.IsType<SourceScanResult.Snapshot>(await scanner.ScanAsync(null, CancellationToken.None));
        await coordinator.AcceptSourceSnapshotAsync(scan.Value);

        var authentication = new NodeAuthentication(nodeId, credentialId, certificateDigest);
        AgentAssignment? codex = null;
        for (var index = 0; index < 2; index++)
        {
            var assignment = Assert.IsType<AgentAssignment>((await coordinator.PollAsync(authentication, DateTimeOffset.UtcNow)).Assignment);
            if (assignment.TargetName == "agent-file/codex") codex = assignment;
            await coordinator.ReportAttemptAsync(authentication,
                new(assignment.AttemptId, ConvergenceState.Succeeded, null, null, DateTimeOffset.UtcNow));
        }

        Assert.NotNull(codex);
        Assert.Empty(codex.Skills);
        Assert.Equal("AGENTS.md", codex.File!.Name);
        Assert.Equal("fleet.file/v1", codex.File.Schema);
        var content = await coordinator.GetBundleAsync(authentication, codex.File.BundleDigest!);
        Assert.Equal("# Fleet instructions\n"u8.ToArray(), content.Content);
    }

    [Fact]
    public async Task The_tip_commit_subject_author_and_date_are_stored_with_the_revision_and_the_email_is_not()
    {
        await using var database = Database();
        var coordinator = Coordinator(database);
        var nodeId = await EnrollAsync(coordinator, "commit-certificate");
        var source = CreateRepository();
        Write(source, "notes.txt", "change\n");
        Git(source, "add", ".");
        Git(source, new Dictionary<string, string>
        {
            ["GIT_COMMITTER_DATE"] = "2026-10-20T12:30:00+02:00",
            ["GIT_AUTHOR_NAME"] = "Ada Lovelace",
            ["GIT_AUTHOR_EMAIL"] = "ada.secret@example.invalid"
        }, "commit", "-m", "Add incident-runbook skill", "-m", "A body paragraph that is not part of the subject.");

        var scan = Assert.IsType<SourceScanResult.Snapshot>(
            await new GitSourceScanner(source, Path.Combine(_files, "commit-mirror.git"), new Nodes(nodeId)).ScanAsync(null, CancellationToken.None));
        Assert.Equal(new CommitMetadata("Add incident-runbook skill", "Ada Lovelace", new DateTimeOffset(2026, 10, 20, 10, 30, 0, TimeSpan.Zero)),
            scan.Value.Commit);
        await coordinator.AcceptSourceSnapshotAsync(scan.Value);

        var row = await database.DesiredRevisions.AsNoTracking().SingleAsync(x => x.SourceRevision == scan.Value.SourceRevision);
        Assert.Equal("Add incident-runbook skill", row.CommitSubject);
        Assert.Equal("Ada Lovelace", row.CommitAuthor);
        Assert.Equal(new DateTimeOffset(2026, 10, 20, 10, 30, 0, TimeSpan.Zero), row.CommittedAt);
        Assert.DoesNotContain("example.invalid", System.Text.Json.JsonSerializer.Serialize(row));
        var listed = Assert.Single((await coordinator.GetDesiredRevisionsAsync(new(100))).Items, x => x.SourceRevision == scan.Value.SourceRevision);
        Assert.Equal(scan.Value.Commit, listed.Commit);
    }

    [Fact]
    public async Task Commit_metadata_is_cut_to_its_limits_and_loses_control_characters()
    {
        await using var database = Database();
        var coordinator = Coordinator(database);
        var nodeId = await EnrollAsync(coordinator, "limits-certificate");
        var source = CreateRepository();
        Write(source, "notes.txt", "change\n");
        Git(source, "add", ".");
        Git(source, "commit", "--author", new string('n', 200) + " <someone@example.invalid>", "-m", "Tab\there " + new string('s', 300));

        var scan = Assert.IsType<SourceScanResult.Snapshot>(
            await new GitSourceScanner(source, Path.Combine(_files, "limits-mirror.git"), new Nodes(nodeId)).ScanAsync(null, CancellationToken.None));
        Assert.Equal(CommitMetadataRules.MaximumSubjectLength, scan.Value.Commit!.Subject!.Length);
        Assert.StartsWith("Tabhere s", scan.Value.Commit.Subject);
        Assert.Equal(new string('n', CommitMetadataRules.MaximumAuthorLength), scan.Value.Commit.Author);
        await coordinator.AcceptSourceSnapshotAsync(scan.Value);
        var row = await database.DesiredRevisions.AsNoTracking().SingleAsync(x => x.SourceRevision == scan.Value.SourceRevision);
        Assert.Equal(scan.Value.Commit.Subject, row.CommitSubject);
        Assert.Equal(scan.Value.Commit.Author, row.CommitAuthor);
    }

    [Fact]
    public async Task A_commit_whose_metadata_cannot_be_read_is_still_accepted_with_null_metadata()
    {
        await using var database = Database();
        var coordinator = Coordinator(database);
        var nodeId = await EnrollAsync(coordinator, "oversized-certificate");
        var source = CreateRepository();
        Write(source, "notes.txt", "change\n");
        Write(source, "message.txt", new string('m', 100_000));
        Git(source, "add", "notes.txt");
        Git(source, "commit", "-F", "message.txt");

        // The message is larger than the bounded git output, so the metadata call fails; the scan does not.
        var scan = Assert.IsType<SourceScanResult.Snapshot>(
            await new GitSourceScanner(source, Path.Combine(_files, "oversized-mirror.git"), new Nodes(nodeId)).ScanAsync(null, CancellationToken.None));
        Assert.Null(scan.Value.Commit);
        var publication = await coordinator.AcceptSourceSnapshotAsync(scan.Value);
        Assert.Equal(PublicationOutcome.Accepted, publication.Outcome);
        var row = await database.DesiredRevisions.AsNoTracking().SingleAsync(x => x.SourceRevision == scan.Value.SourceRevision);
        Assert.Null(row.CommitSubject);
        Assert.Null(row.CommitAuthor);
        Assert.Null(row.CommittedAt);
        var listed = Assert.Single((await coordinator.GetDesiredRevisionsAsync(new(100))).Items, x => x.SourceRevision == scan.Value.SourceRevision);
        Assert.Null(listed.Commit);
    }

    private async Task<NodeId> EnrollAsync(PostgresFleetCoordinator coordinator, string certificate)
    {
        var now = DateTimeOffset.UtcNow;
        var nodeId = new NodeId(Guid.NewGuid());
        var authorization = await coordinator.CreateEnrollmentAuthorizationAsync(
            new("source-publication-test", now + TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(1)));
        await coordinator.CompleteEnrollmentAsync(new(authorization.Token, Sha(certificate + "-csr"), "publication-node", "linux",
            new(nodeId, new CredentialId(Guid.NewGuid()), Sha(certificate), now - TimeSpan.FromMinutes(1), now + TimeSpan.FromHours(1),
                "certificate"u8.ToArray())));
        return nodeId;
    }

    private string CreateRepository()
    {
        var repository = Path.Combine(_files, "source");
        Directory.CreateDirectory(repository);
        Git(repository, "init", "-b", "main");
        Git(repository, "config", "user.email", "fixture@example.invalid");
        Git(repository, "config", "user.name", "Fleet Fixture");
        Write(repository, "fleet.yml", $$"""
            schema: fleet/v1
            targets:
              skills:
                base: home
                path: .agents/skills
            nodes:
              publication-node:
                targets:
                  skills:
                    groups:
                      - stable
            """);
        Write(repository, "skills/stable/review/SKILL.md", "# Review\n\nReview the requested change.\n");
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

    private static void Git(string repository, params string[] arguments) => Git(repository, new Dictionary<string, string>(), arguments);

    private static void Git(string repository, IReadOnlyDictionary<string, string> environment, params string[] arguments)
    {
        var start = new ProcessStartInfo("git")
        {
            WorkingDirectory = repository,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        foreach (var (name, value) in environment) start.Environment[name] = value;
        using var process = Process.Start(start)!;
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        process.WaitForExit();
        Task.WhenAll(output, error).GetAwaiter().GetResult();
        Assert.True(process.ExitCode == 0, error.Result);
    }

    private static string Sha(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private sealed class Nodes(NodeId nodeId) : IEnrolledNodeSource
    {
        public Task<IReadOnlyDictionary<string, NodeId>> GetNodeAliasesAsync(CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyDictionary<string, NodeId>>(new Dictionary<string, NodeId>(StringComparer.Ordinal) { ["publication-node"] = nodeId });
    }
}
