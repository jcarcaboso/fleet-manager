using System.Reflection;

namespace Fleet.Core.Coordination;

/// <summary>
/// The Server's own version, which is also the latest Agent version: Server and Agent releases share version numbers.
/// Read once from the entry assembly's informational version (<c>Version</c> in Directory.Build.props), without any <c>+build</c> metadata.
/// </summary>
public static class ServerVersion
{
    private static readonly Lazy<SemanticVersion> current = new(Read);

    public static SemanticVersion Current => current.Value;

    private static SemanticVersion Read()
    {
        foreach (var assembly in new[] { Assembly.GetEntryAssembly(), typeof(ServerVersion).Assembly })
        {
            var text = assembly?.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
            if (text is null) continue;
            var plus = text.IndexOf('+', StringComparison.Ordinal);
            if (SemanticVersion.TryParse(plus < 0 ? text : text[..plus], out var version)) return version;
        }
        return SemanticVersion.Parse("0.0.0");
    }
}

/// <summary>The newest Agent version, as a service for the Operator API. The Server registers its own version; tests replace it.</summary>
public sealed record LatestAgentVersion(SemanticVersion Value);
