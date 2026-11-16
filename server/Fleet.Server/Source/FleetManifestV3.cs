using YamlDotNet.Serialization;

namespace Fleet.Server.Source;

// fleet/v3 declares every Target once under the top-level `targets` and applies it to each listed Node.
// A Node's own `targets` override the defaults during parsing, so the scanner sees fully resolved Nodes:
// - skills: each field the Node sets replaces the default field; `groups` replaces the whole list.
// - agents: a Node that sets the key replaces the default list; `agents: ~` leaves agent files unmanaged.
// - ai-clients: entries merge by client name; a Node entry replaces the default entry, `<client>: ~` drops
//   it, and `ai-clients: ~` drops every default client.
internal sealed class FleetManifestV3Parser : IManifestSchemaParser
{
    public string Schema => "fleet/v3";

    public FleetManifest Parse(string yaml)
    {
        var source = ManifestSchemaParser.StrictDeserializer().Deserialize<FleetManifestV3>(yaml);
        var defaults = source?.Targets ?? new ManifestTargetsV3();
        return new FleetManifest
        {
            Schema = Schema,
            CliProxy = source?.CliProxy is null ? null : new ManifestCliProxy { BaseUrl = source.CliProxy.BaseUrl },
            Targets = new ManifestDefaults { Skills = Map(defaults.Skills) },
            Nodes = source?.Nodes?.ToDictionary(
                pair => pair.Key,
                pair => new ManifestNode { Targets = Resolve(defaults, pair.Value?.Targets ?? new ManifestTargetsV3()) },
                StringComparer.Ordinal)!,
        };
    }

    private static ManifestNodeTargets Resolve(ManifestTargetsV3 defaults, ManifestTargetsV3 node) => new()
    {
        Skills = new ManifestTarget
        {
            Base = node.Skills?.Base ?? defaults.Skills?.Base,
            Path = node.Skills?.Path ?? defaults.Skills?.Path,
            Groups = node.Skills?.Groups ?? defaults.Skills?.Groups,
            ExcludeClaude = node.Skills?.ExcludeClaude ?? defaults.Skills?.ExcludeClaude,
        },
        Agents = (node.HasAgents ? node.Agents : defaults.Agents)?.Select(agent => agent is null ? null! : new ManifestAgentTarget
        {
            Source = agent.Source,
            Clients = agent.Clients,
        }).ToList(),
        AiClients = ResolveAiClients(defaults.AiClients, node.HasAiClients, node.AiClients),
    };

    private static Dictionary<string, ManifestAiClientTarget>? ResolveAiClients(
        Dictionary<string, ManifestAiClientTargetV3?>? defaults, bool nodeSetsAiClients, Dictionary<string, ManifestAiClientTargetV3?>? node)
    {
        if (nodeSetsAiClients && node is null) return null;
        if (defaults is null && node is null) return null;
        var merged = new Dictionary<string, ManifestAiClientTargetV3?>(StringComparer.Ordinal);
        foreach (var (client, target) in defaults ?? new())
            merged[client] = target;
        foreach (var (client, target) in node ?? new())
        {
            if (target is null) merged.Remove(client);
            else merged[client] = target;
        }
        return merged.ToDictionary(
            pair => pair.Key,
            pair => pair.Value is null ? null! : new ManifestAiClientTarget { Mode = pair.Value.Mode, Model = pair.Value.Model },
            StringComparer.Ordinal);
    }

    private static ManifestTarget Map(ManifestTargetV3? source) => new()
    {
        Base = source?.Base,
        Path = source?.Path,
        Groups = source?.Groups,
        ExcludeClaude = source?.ExcludeClaude,
    };
}

internal sealed class FleetManifestV3
{
    [YamlMember(Alias = "schema")] public string? Schema { get; init; }
    [YamlMember(Alias = "cliproxy")] public ManifestCliProxyV3? CliProxy { get; init; }
    [YamlMember(Alias = "targets")] public ManifestTargetsV3? Targets { get; init; }
    [YamlMember(Alias = "nodes")] public Dictionary<string, ManifestNodeV3?>? Nodes { get; init; }
}
internal sealed class ManifestCliProxyV3
{
    [YamlMember(Alias = "base-url")] public string? BaseUrl { get; init; }
}
internal sealed class ManifestNodeV3
{
    [YamlMember(Alias = "targets")] public ManifestTargetsV3? Targets { get; init; }
}
internal sealed class ManifestTargetsV3
{
    private List<ManifestAgentTargetV3?>? _agents;
    private Dictionary<string, ManifestAiClientTargetV3?>? _aiClients;

    [YamlMember(Alias = "skills")] public ManifestTargetV3? Skills { get; init; }

    // The setters record presence so an explicit null (`agents: ~`) can clear a default.
    [YamlMember(Alias = "agents")]
    public List<ManifestAgentTargetV3?>? Agents
    {
        get => _agents;
        init { _agents = value; HasAgents = true; }
    }

    [YamlMember(Alias = "ai-clients")]
    public Dictionary<string, ManifestAiClientTargetV3?>? AiClients
    {
        get => _aiClients;
        init { _aiClients = value; HasAiClients = true; }
    }

    [YamlIgnore] public bool HasAgents { get; private set; }
    [YamlIgnore] public bool HasAiClients { get; private set; }
}
internal sealed class ManifestAgentTargetV3
{
    [YamlMember(Alias = "source")] public string? Source { get; init; }
    [YamlMember(Alias = "clients")] public List<string>? Clients { get; init; }
}
internal sealed class ManifestAiClientTargetV3
{
    [YamlMember(Alias = "mode")] public string? Mode { get; init; }
    [YamlMember(Alias = "model")] public string? Model { get; init; }
}
internal sealed class ManifestTargetV3
{
    [YamlMember(Alias = "base")] public string? Base { get; init; }
    [YamlMember(Alias = "path")] public string? Path { get; init; }
    [YamlMember(Alias = "groups")] public List<string>? Groups { get; init; }
    [YamlMember(Alias = "excludeClaude")] public bool? ExcludeClaude { get; init; }
}
