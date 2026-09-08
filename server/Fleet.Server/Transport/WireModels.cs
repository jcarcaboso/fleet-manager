using System.Text.Json;
using System.Text.Json.Serialization;
using Fleet.Core.Coordination;

namespace Fleet.Server.Transport;

public sealed record EnrollmentRequest(string Token, string CertificateRequestPem, string NodeName, string Platform);
public sealed record RenewalRequest(string CertificateRequestPem);
public sealed record OperatorRenameAliasRequest(string CurrentAlias, string Alias);
public sealed record AliasRequest(string Alias);
public sealed record EnrollmentTokenRequest(int ExpiresInSeconds = 900);
public sealed record EnrollmentResponse(Guid WorkspaceId, Guid NodeId, Guid CredentialId, string CertificatePem,
    DateTimeOffset ExpiresAt, int PollIntervalSeconds);
public sealed record ReportRequest(Guid AttemptId, ConvergenceState State, string? ErrorCode = null);

public sealed class IdentifierJsonConverter<T>(Func<Guid, T> create, Func<T, Guid> value) : JsonConverter<T>
{
    public override T Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) => create(reader.GetGuid());
    public override void Write(Utf8JsonWriter writer, T identifier, JsonSerializerOptions options) => writer.WriteStringValue(value(identifier));
}

public static class WireJson
{
    public static void Configure(JsonSerializerOptions options)
    {
        options.UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow;
        options.MaxDepth = 16;
        options.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.SnakeCaseLower, allowIntegerValues: false));
        options.Converters.Add(new IdentifierJsonConverter<NodeId>(x => new(x), x => x.Value));
        options.Converters.Add(new IdentifierJsonConverter<CredentialId>(x => new(x), x => x.Value));
        options.Converters.Add(new IdentifierJsonConverter<DesiredRevisionId>(x => new(x), x => x.Value));
        options.Converters.Add(new IdentifierJsonConverter<RolloutId>(x => new(x), x => x.Value));
        options.Converters.Add(new IdentifierJsonConverter<AssignmentId>(x => new(x), x => x.Value));
        options.Converters.Add(new IdentifierJsonConverter<AttemptId>(x => new(x), x => x.Value));
    }
}
