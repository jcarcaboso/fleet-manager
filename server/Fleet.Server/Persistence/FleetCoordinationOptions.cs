using Fleet.Core.Coordination;

namespace Fleet.Server.Persistence;

public sealed class FleetCoordinationOptions
{
    public WorkspaceId WorkspaceId { get; init; } = new(Guid.Parse("00000000-0000-0000-0000-000000000001"));
    public string WorkspaceName { get; init; } = "default";
    /// <summary>The newest Agent version, which Node views compare reported versions with. Defaults to the Server's own version.</summary>
    public SemanticVersion LatestAgentVersion { get; init; } = ServerVersion.Current;
    public int MaximumDiagnosticLength { get; init; } = 2_048;
}
