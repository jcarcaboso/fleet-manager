using YamlDotNet.Serialization;

namespace Fleet.Server.Source;

internal sealed class FleetManifest
{
    [YamlMember(Alias = "schema")]
    public required string Schema { get; init; }
    [YamlMember(Alias = "groups")]
    public required List<string> Groups { get; init; }
    [YamlMember(Alias = "targets")]
    public required ManifestTargets Targets { get; init; }
    [YamlMember(Alias = "nodes")]
    public required Dictionary<string, ManifestNode> Nodes { get; init; }
}

internal sealed class ManifestTargets
{
    [YamlMember(Alias = "skills")]
    public required ManifestTarget Skills { get; init; }
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
    [YamlMember(Alias = "id")]
    public required string Id { get; init; }
    [YamlMember(Alias = "targets")]
    public required ManifestTargets Targets { get; init; }
}
