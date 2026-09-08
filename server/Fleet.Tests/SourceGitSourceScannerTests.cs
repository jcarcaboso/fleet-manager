using System.Diagnostics;
using System.Runtime.Versioning;
using System.Text;
using Fleet.Core.Coordination;
using Fleet.Server.Source;

namespace Fleet.Tests;

public sealed class SourceGitSourceScannerTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), $"fleet-source-{Guid.NewGuid():N}");
    private readonly NodeId _nodeId = new(Guid.NewGuid());

    [Fact]
    public async Task Builds_complete_deterministic_bundle_and_resolves_group_precedence()
    {
        var repository = CreateRepository();
        Write(repository, "fleet.yml", Manifest(["first", "second"]));
        Write(repository, "groups/first/shared/SKILL.md", "first");
        Write(repository, "groups/first/shared/assets/data.bin", new byte[] { 0, 255, 12, 0 });
        Write(repository, "groups/first/shared/run.sh", "#!/bin/sh\n");
        Run(repository, "update-index", "--chmod=+x", "groups/first/shared/run.sh");
        Write(repository, "groups/second/shared/SKILL.md", "second");
        Commit(repository, "initial");

        var scanner = Scanner(repository);
        var first = Assert.IsType<SourceScanResult.Snapshot>(await scanner.ScanAsync(null, CancellationToken.None));
        var target = Assert.Single(first.Value.Targets);
        Assert.Equal(_nodeId, target.NodeId);
        Assert.Equal(first.Value.Bundles.Single(x => x.Digest == Assert.Single(target.Skills).BundleDigest).Digest, target.Skills[0].BundleDigest);
        var warning = Assert.Single(first.Value.Warnings, x => x.Code == "duplicate_skill_name");
        Assert.Contains(_nodeId.Value.ToString(), warning.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("fixture", warning.Message, StringComparison.Ordinal);
        var bytes = first.Value.Bundles.Single(x => x.Digest == target.Skills[0].BundleDigest).Content;
        Assert.Contains(new byte[] { 0, 255, 12, 0 }, bytes.AsSpan());
        Assert.Contains((byte)1, bytes);

        Write(repository, "README.md", "documentation only");
        Commit(repository, "docs");
        var second = Assert.IsType<SourceScanResult.Snapshot>(await scanner.ScanAsync(first.Value.SourceRevision, CancellationToken.None));
        Assert.Equal(first.Value.Bundles.Select(x => x.Digest), second.Value.Bundles.Select(x => x.Digest));
        Assert.IsType<SourceScanResult.Unchanged>(await scanner.ScanAsync(second.Value.SourceRevision, CancellationToken.None));
    }

    [Fact]
    public async Task Rejects_unknown_manifest_fields_without_replacing_a_snapshot()
    {
        var repository = CreateRepository();
        Write(repository, "fleet.yml", Manifest(["stable"]));
        Write(repository, "groups/stable/review/SKILL.md", "valid");
        Commit(repository, "valid");
        var scanner = Scanner(repository);
        var accepted = Assert.IsType<SourceScanResult.Snapshot>(await scanner.ScanAsync(null, CancellationToken.None));

        Write(repository, "fleet.yml", Manifest(["stable"]) + "unknown: true\n");
        Commit(repository, "invalid");
        var invalid = Assert.IsType<SourceScanResult.Invalid>(await scanner.ScanAsync(accepted.Value.SourceRevision, CancellationToken.None));
        Assert.Contains(invalid.Diagnostics, x => x.Code == "invalid_manifest");
    }

    [Fact]
    public async Task Rejects_symlinks_missing_skill_manifest_and_unknown_node_aliases()
    {
        var repository = CreateRepository();
        Write(repository, "fleet.yml", Manifest(["stable"], "Fixture"));
        Write(repository, "groups/stable/review/content.txt", "content");
        File.CreateSymbolicLink(Path.Combine(repository, "groups/stable/review/link"), "content.txt");
        Run(repository, "add", "groups/stable/review/link");
        Commit(repository, "invalid tree");

        var invalid = Assert.IsType<SourceScanResult.Invalid>(await Scanner(repository).ScanAsync(null, CancellationToken.None));
        Assert.Contains(invalid.Diagnostics, x => x.Code == "unsafe_entry_type");
        Assert.Contains(invalid.Diagnostics, x => x.Code == "unknown_node");
    }

    [Fact]
    public async Task Rejects_legacy_node_ids()
    {
        var repository = CreateRepository();
        Write(repository, "fleet.yml", Manifest([]).Replace("fixture:\n", $"fixture:\n    id: {_nodeId.Value}\n", StringComparison.Ordinal));
        Commit(repository, "legacy node id");

        var invalid = Assert.IsType<SourceScanResult.Invalid>(await Scanner(repository).ScanAsync(null, CancellationToken.None));

        Assert.Equal("invalid_manifest", Assert.Single(invalid.Diagnostics).Code);
    }

    [Fact]
    public async Task Rejects_duplicate_node_alias_keys()
    {
        var repository = CreateRepository();
        var duplicate = Manifest([]) + "  fixture:\n    targets:\n      skills:\n        groups: []\n";
        Write(repository, "fleet.yml", duplicate);
        Commit(repository, "duplicate node alias");

        var invalid = Assert.IsType<SourceScanResult.Invalid>(await Scanner(repository).ScanAsync(null, CancellationToken.None));

        Assert.Equal("invalid_manifest", Assert.Single(invalid.Diagnostics).Code);
    }

    [Fact]
    public async Task Accepts_empty_groups_and_an_empty_node_subscription_for_removal()
    {
        var repository = CreateRepository();
        Write(repository, "fleet.yml", Manifest([]));
        Commit(repository, "remove desired skills");

        var snapshot = Assert.IsType<SourceScanResult.Snapshot>(await Scanner(repository).ScanAsync(null, CancellationToken.None));
        Assert.Empty(snapshot.Value.Bundles);
        Assert.Empty(Assert.Single(snapshot.Value.Targets).Skills);
    }

    [Fact]
    public async Task Rejects_colliding_directory_prefixes()
    {
        var repository = CreateRepository();
        Write(repository, "fleet.yml", Manifest(["stable"]));
        Write(repository, "groups/stable/review/SKILL.md", "review");
        Write(repository, "groups/stable/review/refs/A/one.txt", "one");
        Write(repository, "groups/stable/review/refs/a/two.txt", "two");
        Commit(repository, "colliding prefixes");

        var invalid = Assert.IsType<SourceScanResult.Invalid>(await Scanner(repository).ScanAsync(null, CancellationToken.None));
        Assert.Contains(invalid.Diagnostics, x => x.Code == "path_collision");
    }

    [Fact]
    public async Task Rejects_yaml_aliases_without_returning_manifest_content()
    {
        var repository = CreateRepository();
        var secret = "do-not-return-this-value";
        Write(repository, "fleet.yml", $"schema: &schema fleet/v1\ngroups: []\ntargets: {{ skills: {{ base: home, path: .agents/skills }} }}\nnodes: {{ copied: *schema }}\n# {secret}\n");
        Commit(repository, "alias");

        var invalid = Assert.IsType<SourceScanResult.Invalid>(await Scanner(repository).ScanAsync(null, CancellationToken.None));
        var diagnostic = Assert.Single(invalid.Diagnostics);
        Assert.Equal("invalid_manifest", diagnostic.Code);
        Assert.DoesNotContain(secret, diagnostic.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Rejects_a_skill_whose_encoded_bundle_exceeds_the_bundle_limit()
    {
        var repository = CreateRepository();
        Write(repository, "fleet.yml", Manifest(["stable"]));
        Write(repository, "groups/stable/review/SKILL.md", "small source file");
        Commit(repository, "bundle overhead exceeds test limit");

        var limits = new SourceLimits(MaxBundleBytes: 16);
        var scanner = new GitSourceScanner(repository, Path.Combine(_root, "small-bundle-mirror"), new Nodes(_nodeId), limits);
        var invalid = Assert.IsType<SourceScanResult.Invalid>(await scanner.ScanAsync(null, CancellationToken.None));

        Assert.Contains(invalid.Diagnostics, x => x.Code == "bundle_too_large");
    }

    [Fact]
    public async Task Rejects_a_symbolic_link_mirror_and_an_unsupported_remote_protocol()
    {
        var repository = CreateRepository();
        Write(repository, "fleet.yml", Manifest([]));
        Commit(repository, "source");
        var linkedMirror = Path.Combine(_root, "linked-mirror");
        Directory.CreateSymbolicLink(linkedMirror, repository);

        var linked = new GitSourceScanner(repository, linkedMirror, new Nodes(_nodeId));
        var linkedResult = Assert.IsType<SourceScanResult.Invalid>(await linked.ScanAsync(null, CancellationToken.None));
        Assert.Equal("git_source_failure", Assert.Single(linkedResult.Diagnostics).Code);

        var unsupported = new GitSourceScanner("http://example.invalid/source.git", Path.Combine(_root, "http-mirror"), new Nodes(_nodeId));
        var unsupportedResult = Assert.IsType<SourceScanResult.Invalid>(await unsupported.ScanAsync(null, CancellationToken.None));
        Assert.Equal("git_source_failure", Assert.Single(unsupportedResult.Diagnostics).Code);

        var credentialUrl = new GitSourceScanner("https://token@example.invalid/source.git", Path.Combine(_root, "credential-mirror"), new Nodes(_nodeId));
        var credentialResult = Assert.IsType<SourceScanResult.Invalid>(await credentialUrl.ScanAsync(null, CancellationToken.None));
        Assert.Equal("git_source_failure", Assert.Single(credentialResult.Diagnostics).Code);
        Assert.False(Directory.Exists(Path.Combine(_root, "credential-mirror")));
    }

    [Fact]
    [UnsupportedOSPlatform("windows")]
    public async Task Applies_private_mirror_permissions_and_rejects_an_oversized_completed_mirror()
    {
        var repository = CreateRepository();
        Write(repository, "fleet.yml", Manifest([]));
        Commit(repository, "source");
        var mirror = Path.Combine(_root, "bounded-mirror");
        var scanner = new GitSourceScanner(repository, mirror, new Nodes(_nodeId), new SourceLimits(MaxMirrorBytes: 1));

        var invalid = Assert.IsType<SourceScanResult.Invalid>(await scanner.ScanAsync(null, CancellationToken.None));

        Assert.Equal("git_source_failure", Assert.Single(invalid.Diagnostics).Code);
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute, File.GetUnixFileMode(mirror));
    }

    [Fact]
    public async Task Rejects_duplicate_warnings_that_exceed_the_location_bound()
    {
        var repository = CreateRepository();
        Write(repository, "fleet.yml", Manifest(["one", "two", "three"]));
        foreach (var group in new[] { "one", "two", "three" })
            Write(repository, $"groups/{group}/shared/SKILL.md", group);
        Commit(repository, "too many duplicate locations");
        var scanner = new GitSourceScanner(repository, Path.Combine(_root, "warning-mirror"), new Nodes(_nodeId),
            new SourceLimits(MaxWarningLocations: 2));

        var invalid = Assert.IsType<SourceScanResult.Invalid>(await scanner.ScanAsync(null, CancellationToken.None));

        Assert.Contains(invalid.Diagnostics, x => x.Code == "warning_too_large");
    }

    [Fact]
    public async Task Rejects_a_warning_message_that_exceeds_the_coordination_contract()
    {
        var repository = CreateRepository();
        Write(repository, "fleet.yml", Manifest(["one", "two"]));
        Write(repository, "groups/one/shared/SKILL.md", "one");
        Write(repository, "groups/two/shared/SKILL.md", "two");
        Commit(repository, "warning message bound");
        var scanner = new GitSourceScanner(repository, Path.Combine(_root, "warning-message-mirror"), new Nodes(_nodeId),
            new SourceLimits(MaxWarningMessageChars: 32));

        var invalid = Assert.IsType<SourceScanResult.Invalid>(await scanner.ScanAsync(null, CancellationToken.None));

        Assert.Contains(invalid.Diagnostics, x => x.Code == "warning_too_large");
    }

    private GitSourceScanner Scanner(string repository) => new(repository, Path.Combine(_root, $"mirror-{Guid.NewGuid():N}"), new Nodes(_nodeId));

    private string CreateRepository()
    {
        var path = Path.Combine(_root, "source");
        Directory.CreateDirectory(path);
        Run(path, "init", "-b", "main");
        Run(path, "config", "user.email", "fixture@example.invalid");
        Run(path, "config", "user.name", "Fleet Fixture");
        return path;
    }

    private static string Manifest(string[] groups, string alias = "fixture")
    {
        var declaredGroups = groups.Length == 0 ? "groups: []" : $"groups:\n{string.Join('\n', groups.Select(x => $"  - {x}"))}";
        var subscribedGroups = groups.Length == 0 ? "groups: []" : $"groups:\n{string.Join('\n', groups.Select(x => $"          - {x}"))}";
        return $$"""
        schema: fleet/v1
        {{declaredGroups}}
        targets:
          skills:
            base: home
            path: .agents/skills
        nodes:
          {{alias}}:
            targets:
              skills:
                {{subscribedGroups}}

        """;
    }

    private static void Write(string repository, string relativePath, string content) => Write(repository, relativePath, Encoding.UTF8.GetBytes(content));
    private static void Write(string repository, string relativePath, byte[] content)
    {
        var path = Path.Combine(repository, relativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllBytes(path, content);
        Run(repository, "add", relativePath);
    }

    private static void Commit(string repository, string message) => Run(repository, "commit", "-m", message);
    private static void Run(string repository, params string[] arguments)
    {
        var start = new ProcessStartInfo("git") { WorkingDirectory = repository, RedirectStandardError = true, RedirectStandardOutput = true, UseShellExecute = false };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        using var process = Process.Start(start)!;
        var error = process.StandardError.ReadToEnd();
        process.WaitForExit();
        Assert.True(process.ExitCode == 0, error);
    }

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, true);
        GC.SuppressFinalize(this);
    }

    private sealed class Nodes(NodeId id) : IEnrolledNodeSource
    {
        public Task<IReadOnlyDictionary<string, NodeId>> GetNodeAliasesAsync(CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyDictionary<string, NodeId>>(new Dictionary<string, NodeId>(StringComparer.Ordinal) { ["fixture"] = id });
    }
}
