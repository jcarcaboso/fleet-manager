using YamlDotNet.Serialization;

namespace Fleet.Server.Source;

// YAML leaf types that every manifest version declares identically, and their mapping to the normalized records.
// Root and Node types stay per version: the strict deserializer rejects unknown keys per type, which is how fleet/v1
// rejects `cliproxy:` and `ai-clients:`.
internal static class ManifestYaml
{
    public static ManifestDefaults Map(ManifestDefaultsYaml? source) => new() { Skills = Map(source?.Skills) };

    public static ManifestTarget Map(ManifestTargetYaml? source) => new()
    {
        Base = source?.Base,
        Path = source?.Path,
        Groups = source?.Groups,
        ExcludeClaude = source?.ExcludeClaude,
        ExcludeAntigravity = source?.ExcludeAntigravity,
    };

    public static ManifestCliProxy? Map(ManifestCliProxyYaml? source) =>
        source is null ? null : new ManifestCliProxy { BaseUrl = source.BaseUrl };

    public static List<ManifestAgentTarget>? Map(List<ManifestAgentTargetYaml?>? source) =>
        source?.Select(agent => agent is null ? null! : new ManifestAgentTarget
        {
            Source = agent.Source,
            Clients = agent.Clients,
        }).ToList();

    public static Dictionary<string, ManifestAiClientTarget>? Map(Dictionary<string, ManifestAiClientTargetYaml?>? source) =>
        source?.ToDictionary(
            pair => pair.Key,
            pair => pair.Value is null ? null! : new ManifestAiClientTarget { Mode = pair.Value.Mode, Model = pair.Value.Model },
            StringComparer.Ordinal);
}

internal sealed class ManifestDefaultsYaml
{
    [YamlMember(Alias = "skills")] public ManifestTargetYaml? Skills { get; init; }
}
internal sealed class ManifestCliProxyYaml
{
    [YamlMember(Alias = "base-url")] public string? BaseUrl { get; init; }
}
internal sealed class ManifestAgentTargetYaml
{
    [YamlMember(Alias = "source")] public string? Source { get; init; }
    [YamlMember(Alias = "clients")] public List<string>? Clients { get; init; }
}
internal sealed class ManifestAiClientTargetYaml
{
    [YamlMember(Alias = "mode")] public string? Mode { get; init; }
    [YamlMember(Alias = "model")] public string? Model { get; init; }
}
internal sealed class ManifestTargetYaml
{
    [YamlMember(Alias = "base")] public string? Base { get; init; }
    [YamlMember(Alias = "path")] public string? Path { get; init; }
    [YamlMember(Alias = "groups")] public List<string>? Groups { get; init; }
    [YamlMember(Alias = "excludeClaude")] public bool? ExcludeClaude { get; init; }
    [YamlMember(Alias = "excludeAntigravity")] public bool? ExcludeAntigravity { get; init; }
}
