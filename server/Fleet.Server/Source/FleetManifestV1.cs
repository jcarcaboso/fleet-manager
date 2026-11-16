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
            Targets = ManifestYaml.Map(source.Targets),
            Nodes = source.Nodes?.ToDictionary(
                pair => pair.Key,
                pair => new ManifestNode { Targets = Map(pair.Value?.Targets) },
                StringComparer.Ordinal)!,
        };
    }

    private static ManifestNodeTargets Map(ManifestNodeTargetsV1? source) => new()
    {
        Skills = ManifestYaml.Map(source?.Skills),
        Agents = ManifestYaml.Map(source?.Agents),
    };
}

internal sealed class FleetManifestV1
{
    [YamlMember(Alias = "schema")] public string? Schema { get; init; }
    [YamlMember(Alias = "targets")] public ManifestDefaultsYaml? Targets { get; init; }
    [YamlMember(Alias = "nodes")] public Dictionary<string, ManifestNodeV1?>? Nodes { get; init; }
}
internal sealed class ManifestNodeV1
{
    [YamlMember(Alias = "targets")] public ManifestNodeTargetsV1? Targets { get; init; }
}
// No `ai-clients`: fleet/v1 rejects it.
internal sealed class ManifestNodeTargetsV1
{
    [YamlMember(Alias = "skills")] public ManifestTargetYaml? Skills { get; init; }
    [YamlMember(Alias = "agents")] public List<ManifestAgentTargetYaml?>? Agents { get; init; }
}
