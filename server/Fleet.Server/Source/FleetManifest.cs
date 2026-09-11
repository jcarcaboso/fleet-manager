using YamlDotNet.Serialization;

namespace Fleet.Server.Source;

internal sealed class FleetManifest
{
    [YamlMember(Alias = "schema")]
    public required string Schema { get; init; }
    [YamlMember(Alias = "targets")]
    public required ManifestDefaults Targets { get; init; }
    [YamlMember(Alias = "nodes")]
    public required Dictionary<string, ManifestNode> Nodes { get; init; }
}

internal sealed class ManifestDefaults
{
    [YamlMember(Alias = "skills")]
    public required ManifestTarget Skills { get; init; }
}

internal sealed class ManifestNodeTargets
{
    [YamlMember(Alias = "skills")]
    public required ManifestTarget Skills { get; init; }
    [YamlMember(Alias = "agents")]
    public List<ManifestAgentTarget>? Agents { get; init; }
}

internal sealed class ManifestAgentTarget
{
    [YamlMember(Alias = "source")]
    public string? Source { get; init; }
    [YamlMember(Alias = "clients")]
    public List<string>? Clients { get; init; }
}

internal sealed class ManifestTarget
{
    [YamlMember(Alias = "base")]
    public string? Base { get; init; }
    [YamlMember(Alias = "path")]
    public string? Path { get; init; }
    [YamlMember(Alias = "groups")]
    public List<string>? Groups { get; init; }
}

internal sealed class ManifestNode
{
    [YamlMember(Alias = "targets")]
    public required ManifestNodeTargets Targets { get; init; }
}
