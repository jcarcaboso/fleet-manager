using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace Fleet.Server.Source;

internal interface IManifestSchemaParser
{
    string Schema { get; }
    FleetManifest Parse(string yaml);
}

internal static class ManifestSchemaParser
{
    private static readonly IReadOnlyDictionary<string, IManifestSchemaParser> Parsers =
        new IManifestSchemaParser[] { new FleetManifestV1Parser(), new FleetManifestV2Parser() }
            .ToDictionary(parser => parser.Schema, StringComparer.Ordinal);

    public static FleetManifest Parse(string yaml)
    {
        var envelope = new DeserializerBuilder()
            .WithNamingConvention(NullNamingConvention.Instance)
            .WithDuplicateKeyChecking()
            .IgnoreUnmatchedProperties()
            .Build()
            .Deserialize<ManifestVersionEnvelope>(yaml);
        if (envelope?.Schema is null || !Parsers.TryGetValue(envelope.Schema, out var parser))
            throw new UnsupportedManifestSchemaException(envelope?.Schema);
        return parser.Parse(yaml);
    }

    internal static IDeserializer StrictDeserializer() => new DeserializerBuilder()
        .WithNamingConvention(NullNamingConvention.Instance)
        .WithDuplicateKeyChecking()
        .Build();

    private sealed class ManifestVersionEnvelope
    {
        [YamlMember(Alias = "schema")]
        public string? Schema { get; init; }
    }
}

internal sealed class UnsupportedManifestSchemaException(string? schema)
    : Exception(schema is null ? "Manifest schema is required." : $"Manifest schema '{schema}' is not supported.");
