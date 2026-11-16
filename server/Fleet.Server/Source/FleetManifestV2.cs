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
            CliProxy = ManifestYaml.Map(source.CliProxy),
            Targets = ManifestYaml.Map(source.Targets),
            Nodes = source.Nodes?.ToDictionary(
                pair => pair.Key,
                pair => new ManifestNode { Targets = Map(pair.Value?.Targets) },
                StringComparer.Ordinal)!,
        };
    }

    private static ManifestNodeTargets Map(ManifestNodeTargetsV2? source) => new()
    {
        Skills = ManifestYaml.Map(source?.Skills),
        Agents = ManifestYaml.Map(source?.Agents),
        AiClients = ManifestYaml.Map(source?.AiClients),
    };
}

internal sealed class FleetManifestV2
{
    [YamlMember(Alias = "schema")] public string? Schema { get; init; }
    [YamlMember(Alias = "cliproxy")] public ManifestCliProxyYaml? CliProxy { get; init; }
    [YamlMember(Alias = "targets")] public ManifestDefaultsYaml? Targets { get; init; }
    [YamlMember(Alias = "nodes")] public Dictionary<string, ManifestNodeV2?>? Nodes { get; init; }
}
internal sealed class ManifestNodeV2
{
    [YamlMember(Alias = "targets")] public ManifestNodeTargetsV2? Targets { get; init; }
}
internal sealed class ManifestNodeTargetsV2
{
    [YamlMember(Alias = "skills")] public ManifestTargetYaml? Skills { get; init; }
    [YamlMember(Alias = "agents")] public List<ManifestAgentTargetYaml?>? Agents { get; init; }
    [YamlMember(Alias = "ai-clients")] public Dictionary<string, ManifestAiClientTargetYaml?>? AiClients { get; init; }
}
