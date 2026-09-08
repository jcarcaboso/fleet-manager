using Fleet.Core.Coordination;

namespace Fleet.Server.Persistence;

public sealed class FleetCoordinationOptions
{
    public WorkspaceId WorkspaceId { get; init; } = new(Guid.Parse("00000000-0000-0000-0000-000000000001"));
    public string WorkspaceName { get; init; } = "default";
    public int MaximumDiagnosticLength { get; init; } = 2_048;
}
