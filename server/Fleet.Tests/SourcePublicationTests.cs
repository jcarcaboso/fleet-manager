using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using Fleet.Core.Coordination;
using Fleet.Server.Persistence;
using Fleet.Server.Source;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
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
        await database.Database.MigrateAsync();
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

        await coordinator.ReportAttemptAsync(authentication,
            new(assignment.AttemptId, ConvergenceState.Succeeded, null, null, DateTimeOffset.UtcNow));
        Assert.Null((await coordinator.PollAsync(authentication, DateTimeOffset.UtcNow)).Assignment);
        var claude = Assert.IsType<AgentAssignment>((await coordinator.PollAsync(
            authentication, DateTimeOffset.UtcNow, AgentCapabilities.ClaudeSkills)).Assignment);
        Assert.Equal("skills/claude", claude.TargetName);
        Assert.Equal(new TargetDescriptor("home", ".claude/skills"), claude.Target);
        Assert.Equal(sourceBundle.Digest, Assert.Single(claude.Skills).BundleDigest);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task A_server_upgrade_rechecks_the_same_commit_without_reinstalling_unchanged_targets(
        bool succeeded, bool claudeAlreadyPublished)
    {
        await using var database = Database();
        var coordinator = Coordinator(database);
        var nodeId = await EnrollAsync(coordinator, "upgrade-certificate");
        var authentication = Assert.IsType<NodeAuthentication>(
            await coordinator.FindActiveNodeByCertificateAsync(Sha("upgrade-certificate")));
        var source = CreateRepository();
        var scanner = new GitSourceScanner(source, Path.Combine(_files, "upgrade-mirror.git"), new Nodes(nodeId));
        var scan = Assert.IsType<SourceScanResult.Snapshot>(await scanner.ScanAsync(null, CancellationToken.None));
        var previous = await coordinator.AcceptSourceSnapshotAsync(scan.Value with
        {
            Targets = scan.Value.Targets.Where(target => claudeAlreadyPublished || target.TargetName != "skills/claude").ToArray()
        });
        var skills = Assert.IsType<AgentAssignment>((await coordinator.PollAsync(authentication, DateTimeOffset.UtcNow)).Assignment);
        if (succeeded)
            await coordinator.ReportAttemptAsync(authentication,
                new(skills.AttemptId, ConvergenceState.Succeeded, null, null, DateTimeOffset.UtcNow));

        // Restore the pre-upgrade schema, then apply the migration to existing data.
        await using (var upgrade = Database())
        {
            await upgrade.GetService<IMigrator>().MigrateAsync("20261029120000_AddAgentUpdates");
        }
        await using (var upgrade = Database())
        {
            await upgrade.Database.MigrateAsync();
        }
        database.ChangeTracker.Clear();
        Assert.Equal(1, (await database.DesiredRevisions.AsNoTracking().SingleAsync()).PublicationVersion);

        // A restarted Server scans the same commit with the new target publisher.
        var rescanned = Assert.IsType<SourceScanResult.Snapshot>(await scanner.ScanAsync(null, CancellationToken.None));
        Assert.Equal(scan.Value.SourceRevision, rescanned.Value.SourceRevision);
        var publication = await coordinator.AcceptSourceSnapshotAsync(rescanned.Value);
        Assert.Equal(PublicationOutcome.Accepted, publication.Outcome);
        Assert.NotEqual(previous.DesiredRevisionId, publication.DesiredRevisionId);
        Assert.Equal(claudeAlreadyPublished ? 0 : 1, publication.ChangedAssignmentCount);
        if (claudeAlreadyPublished) Assert.Null(publication.RolloutId);
        Assert.Equal(skills.AssignmentId.Value, (await database.Assignments.AsNoTracking()
            .SingleAsync(row => row.TargetName == "skills" && row.IsCurrent)).Id);
        Assert.Equal(succeeded ? (int)ConvergenceState.Succeeded : (int)ConvergenceState.Pending,
            (await database.Assignments.AsNoTracking().SingleAsync(row => row.Id == skills.AssignmentId.Value)).State);

        if (!succeeded)
            await coordinator.ReportAttemptAsync(authentication,
                new(skills.AttemptId, ConvergenceState.Succeeded, null, null, DateTimeOffset.UtcNow));
        var claude = Assert.IsType<AgentAssignment>((await coordinator.PollAsync(
            authentication, DateTimeOffset.UtcNow, AgentCapabilities.ClaudeSkills)).Assignment);
        Assert.Equal("skills/claude", claude.TargetName);
        Assert.Equal(new TargetDescriptor("home", ".claude/skills"), claude.Target);
        Assert.Equal(Assert.Single(skills.Skills).BundleDigest, Assert.Single(claude.Skills).BundleDigest);
        await coordinator.ReportAttemptAsync(authentication,
            new(claude.AttemptId, ConvergenceState.Succeeded, null, null, DateTimeOffset.UtcNow));
        var repeated = await coordinator.AcceptSourceSnapshotAsync(rescanned.Value);
        Assert.Equal(PublicationOutcome.Unchanged, repeated.Outcome);
        Assert.Equal(publication.DesiredRevisionId, repeated.DesiredRevisionId);
        Assert.Equal(2, await database.DesiredRevisions.CountAsync());
        Assert.Equal(2, await database.Assignments.CountAsync());
        Assert.Null((await coordinator.PollAsync(
            authentication, DateTimeOffset.UtcNow, AgentCapabilities.ClaudeSkills)).Assignment);
    }

    [Theory]
    [InlineData("fleet/v1", true)]
    [InlineData("fleet/v2", true)]
    [InlineData("fleet/v1", false)]
    [InlineData("fleet/v2", false)]
    public async Task Exclusion_and_repository_removal_publish_empty_skill_assignments(string schema, bool excludeClaude)
    {
        await using var database = Database();
        var coordinator = Coordinator(database);
        var nodeId = await EnrollAsync(coordinator, "skills-cleanup-certificate");
        var authentication = Assert.IsType<NodeAuthentication>(
            await coordinator.FindActiveNodeByCertificateAsync(Sha("skills-cleanup-certificate")));
        var source = CreateRepository();
        var manifest = File.ReadAllText(Path.Combine(source, "fleet.yml"))
            .Replace("schema: fleet/v1", $"schema: {schema}", StringComparison.Ordinal)
            .Replace("    path: .agents/skills", "    path: .agents/skills\n    excludeClaude: false", StringComparison.Ordinal)
            .Replace("        groups:\n          - stable", "        groups: []", StringComparison.Ordinal);
        Write(source, "fleet.yml", manifest);
        Git(source, "add", ".");
        Git(source, "commit", "-m", "configure cleanup test");
        var scanner = new GitSourceScanner(source, Path.Combine(_files, "cleanup-mirror.git"), new Nodes(nodeId));
        var initial = Assert.IsType<SourceScanResult.Snapshot>(await scanner.ScanAsync(null, CancellationToken.None));
        await coordinator.AcceptSourceSnapshotAsync(initial.Value);
        for (var index = 0; index < 2; index++)
        {
            var assignment = Assert.IsType<AgentAssignment>((await coordinator.PollAsync(
                authentication, DateTimeOffset.UtcNow, AgentCapabilities.ClaudeSkills)).Assignment);
            Assert.Equal("review", Assert.Single(assignment.Skills).Name);
            await coordinator.ReportAttemptAsync(authentication,
                new(assignment.AttemptId, ConvergenceState.Succeeded, null, null, DateTimeOffset.UtcNow));
        }

        if (excludeClaude)
            Write(source, "fleet.yml", manifest.Replace("excludeClaude: false", "excludeClaude: true", StringComparison.Ordinal));
        else
            Git(source, "rm", "-r", "skills");
        Git(source, "add", ".");
        Git(source, "commit", "-m", "remove managed skills");
        var cleanup = Assert.IsType<SourceScanResult.Snapshot>(
            await scanner.ScanAsync(initial.Value.SourceRevision, CancellationToken.None));
        var publication = await coordinator.AcceptSourceSnapshotAsync(cleanup.Value);
        Assert.Equal(excludeClaude ? 1 : 2, publication.ChangedAssignmentCount);
        string[] targets = excludeClaude ? ["skills/claude"] : ["skills", "skills/claude"];
        foreach (var target in targets)
        {
            var assignment = Assert.IsType<AgentAssignment>((await coordinator.PollAsync(
                authentication, DateTimeOffset.UtcNow, AgentCapabilities.ClaudeSkills)).Assignment);
            Assert.Equal(target, assignment.TargetName);
            Assert.Empty(assignment.Skills);
            await coordinator.ReportAttemptAsync(authentication,
                new(assignment.AttemptId, ConvergenceState.Succeeded, null, null, DateTimeOffset.UtcNow));
        }
        Assert.Null((await coordinator.PollAsync(
            authentication, DateTimeOffset.UtcNow, AgentCapabilities.ClaudeSkills)).Assignment);

        if (excludeClaude)
        {
            Write(source, "fleet.yml", manifest);
            Git(source, "add", ".");
            Git(source, "commit", "-m", "include Claude skills again");
            var restored = Assert.IsType<SourceScanResult.Snapshot>(
                await scanner.ScanAsync(cleanup.Value.SourceRevision, CancellationToken.None));
            Assert.Equal(1, (await coordinator.AcceptSourceSnapshotAsync(restored.Value)).ChangedAssignmentCount);
            var assignment = Assert.IsType<AgentAssignment>((await coordinator.PollAsync(
                authentication, DateTimeOffset.UtcNow, AgentCapabilities.ClaudeSkills)).Assignment);
            Assert.Equal("skills/claude", assignment.TargetName);
            Assert.Equal("review", Assert.Single(assignment.Skills).Name);
        }
    }

    [Theory]
    [InlineData("codex")]
    [InlineData("claude")]
    public async Task Publication_persists_managed_files_and_authorizes_their_content(string client)
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
        Write(source, "fleet.yml", $$"""
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
                      clients: [{{client}}]
            """);
        Write(source, "agents/personal/AGENTS.md", "# Fleet instructions\n");
        Git(source, "add", ".");
        Git(source, "commit", "-m", "add managed agent file");

        var scanner = new GitSourceScanner(source, Path.Combine(_files, "managed-file-mirror.git"), new Nodes(nodeId));
        var scan = Assert.IsType<SourceScanResult.Snapshot>(await scanner.ScanAsync(null, CancellationToken.None));
        await coordinator.AcceptSourceSnapshotAsync(scan.Value);

        var authentication = new NodeAuthentication(nodeId, credentialId, certificateDigest);
        AgentAssignment? clientFile = null;
        AgentAssignment? claudeSkills = null;
        for (var index = 0; index < 3; index++)
        {
            var assignment = Assert.IsType<AgentAssignment>((await coordinator.PollAsync(
                authentication, DateTimeOffset.UtcNow, AgentCapabilities.ClaudeSkills)).Assignment);
            if (assignment.TargetName == $"agent-file/{client}") clientFile = assignment;
            if (assignment.TargetName == "skills/claude") claudeSkills = assignment;
            await coordinator.ReportAttemptAsync(authentication,
                new(assignment.AttemptId, ConvergenceState.Succeeded, null, null, DateTimeOffset.UtcNow));
        }

        Assert.NotNull(clientFile);
        Assert.Empty(clientFile.Skills);
        Assert.Equal(client == "claude" ? "CLAUDE.md" : "AGENTS.md", clientFile.File!.Name);
        Assert.Equal("fleet.file/v1", clientFile.File.Schema);
        var content = await coordinator.GetBundleAsync(authentication, clientFile.File.BundleDigest!);
        Assert.Equal("# Fleet instructions\n"u8.ToArray(), content.Content);
        Assert.NotNull(claudeSkills);
        Assert.Equal(new TargetDescriptor("home", ".claude/skills"), claudeSkills.Target);
        var skill = Assert.Single(claudeSkills.Skills);
        Assert.Equal("review", skill.Name);
        var bundle = await coordinator.GetBundleAsync(authentication, skill.BundleDigest);
        Assert.Equal(scan.Value.Bundles.Single(candidate => candidate.Digest == skill.BundleDigest).Content, bundle.Content);
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
