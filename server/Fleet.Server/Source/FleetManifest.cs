namespace Fleet.Server.Source;

// Versioned YAML contracts normalize into these records. The scanner and publisher
// deliberately do not depend on a particular manifest version.
internal sealed class FleetManifest
{
    public required string Schema { get; init; }
    public required ManifestDefaults Targets { get; init; }
    public required Dictionary<string, ManifestNode> Nodes { get; init; }
    public ManifestCliProxy? CliProxy { get; init; }
}

internal sealed class ManifestDefaults
{
    public required ManifestTarget Skills { get; init; }
}

internal sealed class ManifestNodeTargets
{
    public required ManifestTarget Skills { get; init; }
    public List<ManifestAgentTarget>? Agents { get; init; }
    public Dictionary<string, ManifestAiClientTarget>? AiClients { get; init; }
}

internal sealed class ManifestAgentTarget
{
    public string? Source { get; init; }
    public List<string>? Clients { get; init; }
}

internal sealed class ManifestTarget
{
    public string? Base { get; init; }
    public string? Path { get; init; }
    public List<string>? Groups { get; init; }
}

internal sealed class ManifestNode
{
    public required ManifestNodeTargets Targets { get; init; }
}

internal sealed class ManifestCliProxy
{
    public string? BaseUrl { get; init; }
}

internal sealed class ManifestAiClientTarget
{
    public string? Mode { get; init; }
    public string? Model { get; init; }
}
