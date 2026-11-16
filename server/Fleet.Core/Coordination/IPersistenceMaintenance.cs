namespace Fleet.Core.Coordination;

/// <summary>Periodic clean-up of stored data.</summary>
public interface IPersistenceMaintenance
{
    Task<PersistenceMaintenanceResult> MaintainPersistenceAsync(
        PersistenceMaintenancePolicy policy,
        CancellationToken cancellationToken = default);
}
