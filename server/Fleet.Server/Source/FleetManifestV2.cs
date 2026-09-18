using YamlDotNet.Serialization;

namespace Fleet.Server.Source;

internal sealed class FleetManifestV2Parser : IManifestSchemaParser
{
    public string Schema => "fleet/v2";

    public FleetManifest Parse(string yaml)
    {
        var source = ManifestSchemaParser.StrictDeserializer().Deserialize<FleetManifestV2>(yaml);
        return new FleetManifest
        {
            Schema = Schema,
            CliProxy = source.CliProxy is null ? null : new ManifestCliProxy { BaseUrl = source.CliProxy.BaseUrl },
            Targets = Map(source.Targets),
            Nodes = source.Nodes?.ToDictionary(
                pair => pair.Key,
                pair => new ManifestNode { Targets = Map(pair.Value?.Targets) },
                StringComparer.Ordinal)!,
        };
    }

    private static ManifestDefaults Map(ManifestDefaultsV2? source) => new() { Skills = Map(source?.Skills) };
    private static ManifestNodeTargets Map(ManifestNodeTargetsV2? source) => new()
    {
        Skills = Map(source?.Skills),
        Agents = source?.Agents?.Select(agent => agent is null ? null! : new ManifestAgentTarget
        {
            Source = agent.Source,
            Clients = agent.Clients,
        }).ToList(),
        AiClients = source?.AiClients?.ToDictionary(
            pair => pair.Key,
            pair => pair.Value is null ? null! : new ManifestAiClientTarget { Mode = pair.Value.Mode, Model = pair.Value.Model },
            StringComparer.Ordinal),
    };
    private static ManifestTarget Map(ManifestTargetV2? source) => new()
    {
        Base = source?.Base,
        Path = source?.Path,
        Groups = source?.Groups,
    };
}

internal sealed class FleetManifestV2
{
    [YamlMember(Alias = "schema")] public string? Schema { get; init; }
    [YamlMember(Alias = "cliproxy")] public ManifestCliProxyV2? CliProxy { get; init; }
    [YamlMember(Alias = "targets")] public ManifestDefaultsV2? Targets { get; init; }
    [YamlMember(Alias = "nodes")] public Dictionary<string, ManifestNodeV2?>? Nodes { get; init; }
}
internal sealed class ManifestCliProxyV2
{
    [YamlMember(Alias = "base-url")] public string? BaseUrl { get; init; }
}
internal sealed class ManifestDefaultsV2
{
    [YamlMember(Alias = "skills")] public ManifestTargetV2? Skills { get; init; }
}
internal sealed class ManifestNodeV2
{
    [YamlMember(Alias = "targets")] public ManifestNodeTargetsV2? Targets { get; init; }
}
internal sealed class ManifestNodeTargetsV2
{
    [YamlMember(Alias = "skills")] public ManifestTargetV2? Skills { get; init; }
    [YamlMember(Alias = "agents")] public List<ManifestAgentTargetV2?>? Agents { get; init; }
    [YamlMember(Alias = "ai-clients")] public Dictionary<string, ManifestAiClientTargetV2?>? AiClients { get; init; }
}
internal sealed class ManifestAgentTargetV2
{
    [YamlMember(Alias = "source")] public string? Source { get; init; }
    [YamlMember(Alias = "clients")] public List<string>? Clients { get; init; }
}
internal sealed class ManifestAiClientTargetV2
{
    [YamlMember(Alias = "mode")] public string? Mode { get; init; }
    [YamlMember(Alias = "model")] public string? Model { get; init; }
}
internal sealed class ManifestTargetV2
{
    [YamlMember(Alias = "base")] public string? Base { get; init; }
    [YamlMember(Alias = "path")] public string? Path { get; init; }
    [YamlMember(Alias = "groups")] public List<string>? Groups { get; init; }
}
