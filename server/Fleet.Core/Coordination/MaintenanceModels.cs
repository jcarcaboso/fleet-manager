namespace Fleet.Core.Coordination;

// Persistence maintenance.

public sealed record PersistenceMaintenancePolicy(
    TimeSpan? AuditEventRetention,
    TimeSpan? SourceScanRetention,
    int BatchSize = 500);

public sealed record PersistenceMaintenanceResult(
    int EnrollmentPayloadsScrubbed,
    int AuditEventsDeleted,
    int SourceScansDeleted,
    int CheckinsDeleted = 0);
