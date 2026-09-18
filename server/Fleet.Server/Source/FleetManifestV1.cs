using YamlDotNet.Serialization;

namespace Fleet.Server.Source;

internal sealed class FleetManifestV1Parser : IManifestSchemaParser
{
    public string Schema => "fleet/v1";

    public FleetManifest Parse(string yaml)
    {
        var source = ManifestSchemaParser.StrictDeserializer().Deserialize<FleetManifestV1>(yaml);
        return new FleetManifest
        {
            Schema = Schema,
            Targets = Map(source.Targets),
            Nodes = source.Nodes?.ToDictionary(
                pair => pair.Key,
                pair => new ManifestNode { Targets = Map(pair.Value?.Targets) },
                StringComparer.Ordinal)!,
        };
    }

    private static ManifestDefaults Map(ManifestDefaultsV1? source) => new() { Skills = Map(source?.Skills) };
    private static ManifestNodeTargets Map(ManifestNodeTargetsV1? source) => new()
    {
        Skills = Map(source?.Skills),
        Agents = source?.Agents?.Select(agent => agent is null ? null! : new ManifestAgentTarget
        {
            Source = agent.Source,
            Clients = agent.Clients,
        }).ToList(),
    };
    private static ManifestTarget Map(ManifestTargetV1? source) => new()
    {
        Base = source?.Base,
        Path = source?.Path,
        Groups = source?.Groups,
    };
}

internal sealed class FleetManifestV1
{
    [YamlMember(Alias = "schema")] public string? Schema { get; init; }
    [YamlMember(Alias = "targets")] public ManifestDefaultsV1? Targets { get; init; }
    [YamlMember(Alias = "nodes")] public Dictionary<string, ManifestNodeV1?>? Nodes { get; init; }
}
internal sealed class ManifestDefaultsV1
{
    [YamlMember(Alias = "skills")] public ManifestTargetV1? Skills { get; init; }
}
internal sealed class ManifestNodeV1
{
    [YamlMember(Alias = "targets")] public ManifestNodeTargetsV1? Targets { get; init; }
}
internal sealed class ManifestNodeTargetsV1
{
    [YamlMember(Alias = "skills")] public ManifestTargetV1? Skills { get; init; }
    [YamlMember(Alias = "agents")] public List<ManifestAgentTargetV1?>? Agents { get; init; }
}
internal sealed class ManifestAgentTargetV1
{
    [YamlMember(Alias = "source")] public string? Source { get; init; }
    [YamlMember(Alias = "clients")] public List<string>? Clients { get; init; }
}
internal sealed class ManifestTargetV1
{
    [YamlMember(Alias = "base")] public string? Base { get; init; }
    [YamlMember(Alias = "path")] public string? Path { get; init; }
    [YamlMember(Alias = "groups")] public List<string>? Groups { get; init; }
}
