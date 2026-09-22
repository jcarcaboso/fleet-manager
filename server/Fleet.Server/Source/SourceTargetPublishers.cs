using System.Security.Cryptography;
using System.Text;
using Fleet.Core.Coordination;

namespace Fleet.Server.Source;

internal static class SourceTargetPublishers
{
    internal static readonly IReadOnlyDictionary<string, AgentClient> AgentClients =
        new Dictionary<string, AgentClient>(StringComparer.Ordinal)
        {
            ["codex"] = new(".codex", "AGENTS.md"),
            ["opencode"] = new(".config/opencode", "AGENTS.md"),
            ["claude"] = new(".claude", "CLAUDE.md"),
        };

    internal static readonly IReadOnlyDictionary<string, string> AiClientPaths =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["codex"] = ".codex",
            ["opencode"] = ".config/opencode",
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

    internal static SnapshotBundle AgentInstructionsBundle(byte[] content)
    {
        var digestInput = Encoding.UTF8.GetBytes("fleet.file/v1\0").Concat(content).ToArray();
        var digest = $"sha256:{Convert.ToHexStringLower(SHA256.HashData(digestInput))}";
        return new SnapshotBundle(digest, "fleet.file/v1", content.LongLength, content);
    }

    internal static IEnumerable<string> SelectedGroups(
        ManifestTarget target,
        IReadOnlyDictionary<string, Dictionary<string, BuiltSkill>> groups) =>
        target.Groups is { Count: > 0 } ? target.Groups : groups.Keys.Order(StringComparer.Ordinal);

    internal static bool TryNormalizeCliProxyBaseUrl(string? value, out string? normalized)
    {
        normalized = null;
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps ||
            string.IsNullOrEmpty(uri.Host) || !string.IsNullOrEmpty(uri.UserInfo) ||
            !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment) ||
            uri.AbsolutePath.TrimEnd('/') is not ("" or "/v1"))
            return false;
        normalized = new UriBuilder(uri) { Path = "/v1", Query = "", Fragment = "" }.Uri.AbsoluteUri.TrimEnd('/');
        return true;
    }

    internal static bool IsValidModelId(string value) => value.Length is > 0 and <= 200 &&
        value.All(character => character is >= '!' and <= '~');

    private static IEnumerable<SnapshotTarget> BuildSkillTargets(TargetPublication publication) =>
        publication.Manifest.Nodes.OrderBy(x => x.Key, StringComparer.Ordinal).Select(pair =>
        {
            var target = pair.Value.Targets.Skills;
            var skills = new Dictionary<string, SnapshotSkill>(StringComparer.Ordinal);
            foreach (var group in SelectedGroups(target, publication.SkillGroups))
                foreach (var skill in publication.SkillGroups[group].OrderBy(x => x.Key, StringComparer.Ordinal))
                    skills.TryAdd(skill.Key, new SnapshotSkill(skill.Key, skill.Value.Bundle.Digest));
            return new SnapshotTarget(publication.NodeAliases[pair.Key], "skills",
                new TargetDescriptor("home", target.Path ?? publication.Manifest.Targets.Skills.Path!), skills.Values.ToArray());
        });

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
        TryNormalizeCliProxyBaseUrl(publication.Manifest.CliProxy?.BaseUrl, out var baseUrl);
        foreach (var node in publication.Manifest.Nodes.OrderBy(x => x.Key, StringComparer.Ordinal))
        {
            var configuredClients = node.Value.Targets.AiClients ?? new Dictionary<string, ManifestAiClientTarget>();
            foreach (var configured in configuredClients.OrderBy(x => x.Key, StringComparer.Ordinal))
            {
                var desired = configured.Value;
                yield return new SnapshotTarget(publication.NodeAliases[node.Key], $"ai-client/{configured.Key}",
                    new TargetDescriptor("home", AiClientPaths[configured.Key]), [],
                    AiClient: new AiClientAssignment("fleet.ai-client/v1", configured.Key, desired.Mode!,
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
