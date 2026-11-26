using Fleet.Core.Coordination;

namespace Fleet.Server.Source;

internal static class SourceTargetPublishers
{
    // Where each client keeps its agent instruction file and its AI client configuration. The keys are CliProxyRules.AiClients.
    internal static readonly IReadOnlyDictionary<string, AgentClient> AgentClients =
        new Dictionary<string, AgentClient>(StringComparer.Ordinal)
        {
            ["codex"] = new(".codex", "AGENTS.md"),
            ["opencode"] = new(".config/opencode", "AGENTS.md"),
            ["claude"] = new(".claude", "CLAUDE.md"),
            ["antigravity"] = new(".gemini", "GEMINI.md"),
        };

    internal static readonly SnapshotBundle EmptyAgentInstructions = AgentInstructionsBundle([]);

    private delegate IEnumerable<SnapshotTarget> TargetPublisher(TargetPublication context);

    private static readonly TargetPublisher[] Publishers =
    [
        BuildSkillTargets,
        BuildAgentTargets,
        BuildAiClientTargets,
    ];

    internal static SnapshotTarget[] Publish(TargetPublication publication) =>
        Publishers.SelectMany(publisher => publisher(publication)).ToArray();

    internal static SnapshotBundle AgentInstructionsBundle(byte[] content) =>
        new(BundleDigests.FileDigest(content), BundleDigests.FileSchema, content.LongLength, content);

    internal static IEnumerable<string> SelectedGroups(
        ManifestTarget target,
        IReadOnlyDictionary<string, Dictionary<string, BuiltSkill>> groups) =>
        target.Groups is { Count: > 0 } ? target.Groups : groups.Keys.Order(StringComparer.Ordinal);

    private static IEnumerable<SnapshotTarget> BuildSkillTargets(TargetPublication publication)
    {
        foreach (var pair in publication.Manifest.Nodes.OrderBy(x => x.Key, StringComparer.Ordinal))
        {
            var target = pair.Value.Targets.Skills;
            var skills = new Dictionary<string, SnapshotSkill>(StringComparer.Ordinal);
            foreach (var group in SelectedGroups(target, publication.SkillGroups))
                foreach (var skill in publication.SkillGroups[group].OrderBy(x => x.Key, StringComparer.Ordinal))
                    skills.TryAdd(skill.Key, new SnapshotSkill(skill.Key, skill.Value.Bundle.Digest));
            var descriptor = new TargetDescriptor("home", target.Path ?? publication.Manifest.Targets.Skills.Path!);
            var resolvedSkills = skills.Values.ToArray();
            var excludeClaude = target.ExcludeClaude ?? publication.Manifest.Targets.Skills.ExcludeClaude ?? false;
            var excludeAntigravity = target.ExcludeAntigravity ?? publication.Manifest.Targets.Skills.ExcludeAntigravity ?? false;
            var claudeSkills = excludeClaude ? [] : resolvedSkills;
            var antigravitySkills = excludeAntigravity ? [] : resolvedSkills;
            var primarySkills = descriptor.Path == ".claude/skills" ? claudeSkills :
                descriptor.Path == ".gemini/config/skills" ? antigravitySkills : resolvedSkills;
            yield return new SnapshotTarget(publication.NodeAliases[pair.Key], "skills", descriptor, primarySkills);

            if (descriptor.Path != ".claude/skills")
                yield return new SnapshotTarget(publication.NodeAliases[pair.Key], "skills/claude",
                    new TargetDescriptor("home", ".claude/skills"), claudeSkills);

            // Antigravity reads personal Skills from ~/.gemini/config/skills, not ~/.agents/skills.
            if (descriptor.Path != ".gemini/config/skills")
                yield return new SnapshotTarget(publication.NodeAliases[pair.Key], "skills/antigravity",
                    new TargetDescriptor("home", ".gemini/config/skills"), antigravitySkills);
        }
    }

    private static IEnumerable<SnapshotTarget> BuildAgentTargets(TargetPublication publication)
    {
        foreach (var node in publication.Manifest.Nodes.OrderBy(x => x.Key, StringComparer.Ordinal))
        {
            var configured = node.Value.Targets.Agents;
            if (configured is null) continue;
            if (configured.Count == 0)
            {
                foreach (var client in AgentClients.OrderBy(x => x.Key, StringComparer.Ordinal))
                    yield return new SnapshotTarget(publication.NodeAliases[node.Key], $"agent-file/{client.Key}",
                        new TargetDescriptor("home", client.Value.TargetPath), [],
                        new SnapshotFile(client.Value.TargetFileName, EmptyAgentInstructions.Digest));
                continue;
            }
            var desiredByClient = new Dictionary<string, SnapshotBundle>(StringComparer.Ordinal);
            foreach (var agentTarget in configured)
                foreach (var client in agentTarget!.Clients ?? AgentClients.Keys)
                    desiredByClient.Add(client, publication.AgentSources[agentTarget.Source!]);
            foreach (var desired in desiredByClient.OrderBy(x => x.Key, StringComparer.Ordinal))
            {
                var client = AgentClients[desired.Key];
                yield return new SnapshotTarget(publication.NodeAliases[node.Key], $"agent-file/{desired.Key}",
                    new TargetDescriptor("home", client.TargetPath), [],
                    new SnapshotFile(client.TargetFileName, desired.Value.Digest));
            }
        }
    }

    private static IEnumerable<SnapshotTarget> BuildAiClientTargets(TargetPublication publication)
    {
        CliProxyRules.TryNormalizeBaseUrl(publication.Manifest.CliProxy?.BaseUrl, out var baseUrl);
        foreach (var node in publication.Manifest.Nodes.OrderBy(x => x.Key, StringComparer.Ordinal))
        {
            var configuredClients = node.Value.Targets.AiClients ?? new Dictionary<string, ManifestAiClientTarget>();
            foreach (var configured in configuredClients.OrderBy(x => x.Key, StringComparer.Ordinal))
            {
                var desired = configured.Value;
                yield return new SnapshotTarget(publication.NodeAliases[node.Key], $"ai-client/{configured.Key}",
                    new TargetDescriptor("home", AgentClients[configured.Key].TargetPath), [],
                    AiClient: new AiClientAssignment(CliProxyRules.AiClientSchema, configured.Key, desired.Mode!,
                        desired.Mode == "cliproxy" ? baseUrl : null,
                        desired.Mode == "cliproxy" ? desired.Model : null));
            }
        }
    }
}

internal sealed record TargetPublication(
    FleetManifest Manifest,
    IReadOnlyDictionary<string, NodeId> NodeAliases,
    Dictionary<string, Dictionary<string, BuiltSkill>> SkillGroups,
    IReadOnlyDictionary<string, SnapshotBundle> AgentSources);

internal sealed record BuiltSkill(SnapshotBundle Bundle, string Location);

internal sealed record AgentClient(string TargetPath, string TargetFileName);
