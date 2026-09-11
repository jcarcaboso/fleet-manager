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
        Write(repository, "fleet.yml", Manifest(["z-first", "a-second"]));
        Write(repository, "skills/z-first/shared/SKILL.md", "first");
        Write(repository, "skills/z-first/shared/assets/data.bin", new byte[] { 0, 255, 12, 0 });
        Write(repository, "skills/z-first/shared/run.sh", "#!/bin/sh\n");
        Run(repository, "update-index", "--chmod=+x", "skills/z-first/shared/run.sh");
        Write(repository, "skills/a-second/shared/SKILL.md", "second");
        WriteAvailableAgentSource(repository);
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
    public async Task Empty_or_omitted_groups_select_every_discovered_group_while_values_select_a_subset()
    {
        var secondNodeId = new NodeId(Guid.NewGuid());
        var thirdNodeId = new NodeId(Guid.NewGuid());
        var repository = CreateRepository();
        Write(repository, "fleet.yml", """
            schema: fleet/v1
            targets:
              skills:
                base: home
                path: .agents/skills
            nodes:
              fixture:
                targets:
                  skills:
                    groups: []
              second:
                targets:
                  skills: {}
              third:
                targets:
                  skills:
                    groups: [beta]
            """);
        Write(repository, "skills/alpha/one/SKILL.md", "one");
        Write(repository, "skills/beta/two/SKILL.md", "two");
        WriteAvailableAgentSource(repository);
        Commit(repository, "discovered skill groups");
        var nodes = new Dictionary<string, NodeId>(StringComparer.Ordinal)
        {
            ["fixture"] = _nodeId,
            ["second"] = secondNodeId,
            ["third"] = thirdNodeId,
        };

        var snapshot = Assert.IsType<SourceScanResult.Snapshot>(await new GitSourceScanner(
            repository, Path.Combine(_root, "group-defaults-mirror"), new Nodes(nodes)).ScanAsync(null, CancellationToken.None));
        var targets = snapshot.Value.Targets.Where(x => x.TargetName == "skills").ToDictionary(x => x.NodeId);

        Assert.Equal(["one", "two"], targets[_nodeId].Skills.Select(x => x.Name));
        Assert.Equal(["one", "two"], targets[secondNodeId].Skills.Select(x => x.Name));
        Assert.Equal(["two"], targets[thirdNodeId].Skills.Select(x => x.Name));
    }

    [Fact]
    public async Task Default_group_selection_uses_group_name_order_for_duplicate_skills()
    {
        var repository = CreateRepository();
        Write(repository, "fleet.yml", Manifest([]));
        Write(repository, "skills/zebra/shared/SKILL.md", "zebra");
        Write(repository, "skills/alpha/shared/SKILL.md", "alpha");
        WriteAvailableAgentSource(repository);
        Commit(repository, "default group precedence");

        var snapshot = Assert.IsType<SourceScanResult.Snapshot>(
            await Scanner(repository).ScanAsync(null, CancellationToken.None));
        var skill = Assert.Single(Assert.Single(snapshot.Value.Targets).Skills);
        var bundle = snapshot.Value.Bundles.Single(x => x.Digest == skill.BundleDigest);

        Assert.True(bundle.Content.AsSpan().EndsWith("alpha"u8));
        Assert.Single(snapshot.Value.Warnings, x => x.Code == "duplicate_skill_name");
    }

    [Fact]
    public async Task Rejects_unknown_and_duplicate_group_selections()
    {
        var repository = CreateRepository();
        Write(repository, "fleet.yml", Manifest(["missing", "missing"]));
        Write(repository, "skills/stable/review/SKILL.md", "review");
        WriteAvailableAgentSource(repository);
        Commit(repository, "invalid group selection");

        var invalid = Assert.IsType<SourceScanResult.Invalid>(
            await Scanner(repository).ScanAsync(null, CancellationToken.None));

        Assert.Contains(invalid.Diagnostics, x => x.Code == "unknown_group");
        Assert.Contains(invalid.Diagnostics, x => x.Code == "duplicate_group");
    }

    [Fact]
    public async Task Rejects_the_legacy_groups_directory()
    {
        var repository = CreateRepository();
        Write(repository, "fleet.yml", Manifest([]));
        Write(repository, "groups/stable/review/SKILL.md", "legacy");
        Write(repository, "skills/stable/review/SKILL.md", "review");
        WriteAvailableAgentSource(repository);
        Commit(repository, "legacy skill layout");

        var invalid = Assert.IsType<SourceScanResult.Invalid>(
            await Scanner(repository).ScanAsync(null, CancellationToken.None));

        Assert.Contains(invalid.Diagnostics, x => x.Code == "legacy_skill_layout");
    }

    [Theory]
    [InlineData("agents", "missing_agents_directory")]
    [InlineData("skills", "missing_skills_directory")]
    public async Task Rejects_a_revision_when_a_required_source_directory_is_missing(
        string missingDirectory,
        string expectedDiagnostic)
    {
        var repository = CreateRepository();
        Write(repository, "fleet.yml", Manifest(["stable"]));
        if (missingDirectory != "agents")
            Write(repository, "agents/personal/AGENTS.md", "personal");
        if (missingDirectory != "skills")
            Write(repository, "skills/stable/review/SKILL.md", "review");
        Commit(repository, $"missing {missingDirectory} directory");

        var invalid = Assert.IsType<SourceScanResult.Invalid>(
            await Scanner(repository).ScanAsync(null, CancellationToken.None));

        Assert.Contains(invalid.Diagnostics, x => x.Code == expectedDiagnostic);
    }

    [Fact]
    public async Task Resolves_discovered_agent_sources_to_their_configured_clients()
    {
        var repository = CreateRepository();
        Write(repository, "fleet.yml", Manifest([]).Replace(
            "        groups: []\n",
            "        groups: []\n      agents:\n        - source: personal\n          clients: [codex, opencode]\n        - source: claude-personal\n          clients: [claude]\n",
            StringComparison.Ordinal));
        Write(repository, "agents/personal/AGENTS.md", "# Personal instructions\n");
        Write(repository, "agents/claude-personal/AGENTS.md", "# Claude instructions\n");
        WriteAvailableSkill(repository);
        Commit(repository, "configured agent sources");

        var snapshot = Assert.IsType<SourceScanResult.Snapshot>(await Scanner(repository).ScanAsync(null, CancellationToken.None));
        var fileTargets = snapshot.Value.Targets.Where(x => x.File is not null).ToDictionary(x => x.TargetName);
        Assert.Equal(3, fileTargets.Count);
        Assert.Equal((".codex", "AGENTS.md"), (fileTargets["agent-file/codex"].Descriptor.Path, fileTargets["agent-file/codex"].File!.Name));
        Assert.Equal((".config/opencode", "AGENTS.md"), (fileTargets["agent-file/opencode"].Descriptor.Path, fileTargets["agent-file/opencode"].File!.Name));
        Assert.Equal((".claude", "CLAUDE.md"), (fileTargets["agent-file/claude"].Descriptor.Path, fileTargets["agent-file/claude"].File!.Name));
        Assert.Equal(
            fileTargets["agent-file/codex"].File!.BundleDigest,
            fileTargets["agent-file/opencode"].File!.BundleDigest);
        Assert.NotEqual(
            fileTargets["agent-file/codex"].File!.BundleDigest,
            fileTargets["agent-file/claude"].File!.BundleDigest);
        var contents = snapshot.Value.Bundles.ToDictionary(x => x.Digest, x => Encoding.UTF8.GetString(x.Content));
        Assert.Equal("# Personal instructions\n", contents[fileTargets["agent-file/codex"].File!.BundleDigest!]);
        Assert.Equal("# Claude instructions\n", contents[fileTargets["agent-file/claude"].File!.BundleDigest!]);
    }

    [Fact]
    public async Task Omitted_clients_selects_all_and_an_empty_agents_list_removes_all()
    {
        var repository = CreateRepository();
        Write(repository, "fleet.yml", Manifest([]).Replace(
            "        groups: []\n",
            "        groups: []\n      agents:\n        - source: personal\n",
            StringComparison.Ordinal));
        Write(repository, "agents/personal/AGENTS.md", "# Personal instructions\n");
        WriteAvailableSkill(repository);
        Commit(repository, "all clients");
        var scanner = Scanner(repository);

        var defaults = Assert.IsType<SourceScanResult.Snapshot>(await scanner.ScanAsync(null, CancellationToken.None));
        var defaultFiles = defaults.Value.Targets.Where(x => x.File is not null).ToArray();
        Assert.Equal(3, defaultFiles.Length);
        Assert.All(defaultFiles, target => Assert.NotNull(target.File!.BundleDigest));

        Write(repository, "fleet.yml", Manifest([]).Replace(
            "        groups: []\n",
            "        groups: []\n      agents: []\n",
            StringComparison.Ordinal));
        Commit(repository, "remove all agent files");
        var removed = Assert.IsType<SourceScanResult.Snapshot>(await scanner.ScanAsync(defaults.Value.SourceRevision, CancellationToken.None));
        var removalFiles = removed.Value.Targets.Where(x => x.File is not null).ToArray();
        Assert.Equal(3, removalFiles.Length);
        Assert.All(removalFiles, target => Assert.Null(target.File!.BundleDigest));
    }

    [Fact]
    public async Task Missing_agents_target_does_not_manage_agent_files()
    {
        var repository = CreateRepository();
        Write(repository, "fleet.yml", Manifest([]));
        Write(repository, "agents/personal/AGENTS.md", "# Available but unassigned\n");
        WriteAvailableSkill(repository);
        Commit(repository, "unassigned source");

        var snapshot = Assert.IsType<SourceScanResult.Snapshot>(
            await Scanner(repository).ScanAsync(null, CancellationToken.None));

        Assert.DoesNotContain(snapshot.Value.Targets, target => target.File is not null);
    }

    [Fact]
    public async Task Different_nodes_can_select_different_agent_sources()
    {
        var secondNodeId = new NodeId(Guid.NewGuid());
        var repository = CreateRepository();
        Write(repository, "fleet.yml", """
            schema: fleet/v1
            targets:
              skills:
                base: home
                path: .agents/skills
            nodes:
              fixture:
                targets:
                  skills:
                    groups: []
                  agents:
                    - source: personal
                      clients: [codex]
              second:
                targets:
                  skills:
                    groups: []
                  agents:
                    - source: work
                      clients: [codex]
            """);
        Write(repository, "agents/personal/AGENTS.md", "personal");
        Write(repository, "agents/work/AGENTS.md", "work");
        WriteAvailableSkill(repository);
        Commit(repository, "different node sources");
        var nodes = new Dictionary<string, NodeId>(StringComparer.Ordinal)
        {
            ["fixture"] = _nodeId,
            ["second"] = secondNodeId,
        };

        var snapshot = Assert.IsType<SourceScanResult.Snapshot>(await new GitSourceScanner(
            repository, Path.Combine(_root, "two-node-mirror"), new Nodes(nodes)).ScanAsync(null, CancellationToken.None));
        var codexTargets = snapshot.Value.Targets.Where(x => x.TargetName == "agent-file/codex").ToDictionary(x => x.NodeId);

        Assert.NotEqual(codexTargets[_nodeId].File!.BundleDigest, codexTargets[secondNodeId].File!.BundleDigest);
    }

    [Fact]
    public async Task Rejects_unknown_sources_clients_and_duplicate_client_assignments()
    {
        var repository = CreateRepository();
        Write(repository, "agents/personal/AGENTS.md", "personal");
        WriteAvailableSkill(repository);
        Write(repository, "fleet.yml", Manifest([]).Replace(
            "        groups: []\n",
            "        groups: []\n      agents:\n        - source: missing\n          clients: [unknown]\n        - source: personal\n          clients: [codex, codex]\n        - source: personal\n          clients: []\n",
            StringComparison.Ordinal));
        Commit(repository, "invalid agent targets");

        var invalid = Assert.IsType<SourceScanResult.Invalid>(await Scanner(repository).ScanAsync(null, CancellationToken.None));
        Assert.Contains(invalid.Diagnostics, diagnostic => diagnostic.Code == "unknown_agent_source");
        Assert.Contains(invalid.Diagnostics, diagnostic => diagnostic.Code == "unknown_agent_client");
        Assert.Contains(invalid.Diagnostics, diagnostic => diagnostic.Code == "duplicate_agent_client");
        Assert.Contains(invalid.Diagnostics, diagnostic => diagnostic.Code == "empty_agent_clients");
    }

    [Fact]
    public async Task Rejects_unrecognized_files_in_the_agents_directory()
    {
        var repository = CreateRepository();
        Write(repository, "fleet.yml", Manifest([]));
        Write(repository, "agents/personal/notes.md", "wrong filename");
        WriteAvailableSkill(repository);
        Commit(repository, "invalid agent file");

        var invalid = Assert.IsType<SourceScanResult.Invalid>(
            await Scanner(repository).ScanAsync(null, CancellationToken.None));

        var diagnostic = Assert.Single(invalid.Diagnostics, x => x.Code == "unexpected_agent_file");
        Assert.Equal("agents/personal/notes.md", diagnostic.Path);
        Assert.Contains(invalid.Diagnostics, x => x.Code == "missing_agent_instructions");
    }

    [Fact]
    public async Task Rejects_a_legacy_group_catalog_without_replacing_a_snapshot()
    {
        var repository = CreateRepository();
        Write(repository, "fleet.yml", Manifest(["stable"]));
        Write(repository, "skills/stable/review/SKILL.md", "valid");
        WriteAvailableAgentSource(repository);
        Commit(repository, "valid");
        var scanner = Scanner(repository);
        var accepted = Assert.IsType<SourceScanResult.Snapshot>(await scanner.ScanAsync(null, CancellationToken.None));

        Write(repository, "fleet.yml", Manifest(["stable"]).Replace(
            "schema: fleet/v1\n",
            "schema: fleet/v1\ngroups: [stable]\n",
            StringComparison.Ordinal));
        Commit(repository, "invalid");
        var invalid = Assert.IsType<SourceScanResult.Invalid>(await scanner.ScanAsync(accepted.Value.SourceRevision, CancellationToken.None));
        Assert.Contains(invalid.Diagnostics, x => x.Code == "invalid_manifest");
    }

    [Fact]
    public async Task Rejects_symlinks_missing_skill_manifest_and_unknown_node_aliases()
    {
        var repository = CreateRepository();
        Write(repository, "fleet.yml", Manifest(["stable"], "Fixture"));
        Write(repository, "skills/stable/review/content.txt", "content");
        WriteAvailableAgentSource(repository);
        File.CreateSymbolicLink(Path.Combine(repository, "skills/stable/review/link"), "content.txt");
        Run(repository, "add", "skills/stable/review/link");
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
    public async Task Rejects_colliding_directory_prefixes()
    {
        var repository = CreateRepository();
        Write(repository, "fleet.yml", Manifest(["stable"]));
        Write(repository, "skills/stable/review/SKILL.md", "review");
        Write(repository, "skills/stable/review/refs/A/one.txt", "one");
        Write(repository, "skills/stable/review/refs/a/two.txt", "two");
        WriteAvailableAgentSource(repository);
        Commit(repository, "colliding prefixes");

        var invalid = Assert.IsType<SourceScanResult.Invalid>(await Scanner(repository).ScanAsync(null, CancellationToken.None));
        Assert.Contains(invalid.Diagnostics, x => x.Code == "path_collision");
    }

    [Fact]
    public async Task Rejects_yaml_aliases_without_returning_manifest_content()
    {
        var repository = CreateRepository();
        var secret = "do-not-return-this-value";
        Write(repository, "fleet.yml", $"schema: &schema fleet/v1\ntargets: {{ skills: {{ base: home, path: .agents/skills }} }}\nnodes: {{ copied: *schema }}\n# {secret}\n");
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
        Write(repository, "skills/stable/review/SKILL.md", "small source file");
        WriteAvailableAgentSource(repository);
        Commit(repository, "bundle overhead exceeds test limit");

        var limits = new SourceLimits(MaxBundleBytes: 16);
        var scanner = new GitSourceScanner(repository, Path.Combine(_root, "small-bundle-mirror"), new Nodes(_nodeId), limits);
        var invalid = Assert.IsType<SourceScanResult.Invalid>(await scanner.ScanAsync(null, CancellationToken.None));

        Assert.Contains(invalid.Diagnostics, x => x.Code == "bundle_too_large");
    }

    [Fact]
    public async Task Rejects_a_nonpositive_agent_instruction_limit()
    {
        var scanner = new GitSourceScanner(
            "unused",
            Path.Combine(_root, "invalid-limit-mirror"),
            new Nodes(_nodeId),
            new SourceLimits(MaxAgentInstructionsBytes: 0));

        var invalid = Assert.IsType<SourceScanResult.Invalid>(await scanner.ScanAsync(null, CancellationToken.None));

        Assert.Equal("git_source_failure", Assert.Single(invalid.Diagnostics).Code);
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
            Write(repository, $"skills/{group}/shared/SKILL.md", group);
        WriteAvailableAgentSource(repository);
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
        Write(repository, "skills/one/shared/SKILL.md", "one");
        Write(repository, "skills/two/shared/SKILL.md", "two");
        WriteAvailableAgentSource(repository);
        Commit(repository, "warning message bound");
        var scanner = new GitSourceScanner(repository, Path.Combine(_root, "warning-message-mirror"), new Nodes(_nodeId),
            new SourceLimits(MaxWarningMessageChars: 32));

        var invalid = Assert.IsType<SourceScanResult.Invalid>(await scanner.ScanAsync(null, CancellationToken.None));

        Assert.Contains(invalid.Diagnostics, x => x.Code == "warning_too_large");
    }

    private GitSourceScanner Scanner(string repository) => new(repository, Path.Combine(_root, $"mirror-{Guid.NewGuid():N}"), new Nodes(_nodeId));

    private static void WriteAvailableAgentSource(string repository) =>
        Write(repository, "agents/available/AGENTS.md", "available");

    private static void WriteAvailableSkill(string repository) =>
        Write(repository, "skills/stable/review/SKILL.md", "review");

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
        var subscribedGroups = groups.Length == 0 ? "groups: []" : $"groups:\n{string.Join('\n', groups.Select(x => $"          - {x}"))}";
        return $$"""
        schema: fleet/v1
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

    private sealed class Nodes : IEnrolledNodeSource
    {
        private readonly IReadOnlyDictionary<string, NodeId> _nodes;

        public Nodes(NodeId id) : this(new Dictionary<string, NodeId>(StringComparer.Ordinal) { ["fixture"] = id }) { }

        public Nodes(IReadOnlyDictionary<string, NodeId> nodes) => _nodes = nodes;

        public Task<IReadOnlyDictionary<string, NodeId>> GetNodeAliasesAsync(CancellationToken cancellationToken) =>
            Task.FromResult(_nodes);
    }
}
