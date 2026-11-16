namespace Fleet.Core.Coordination;

/// <summary>
/// Everything the coordinator offers. Consumers that need one role can depend on the role interface instead.
/// </summary>
public interface IFleetCoordinator : INodeCredentialLookup, IAgentProtocol, ISourcePublication, IOperatorCommands, IOperatorQueries,
    IPersistenceMaintenance;
