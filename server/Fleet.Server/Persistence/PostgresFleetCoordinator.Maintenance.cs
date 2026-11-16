using Fleet.Core.Coordination;
using Microsoft.EntityFrameworkCore;

namespace Fleet.Server.Persistence;

// Persistence maintenance (IPersistenceMaintenance): batched scrubbing and deletion of expired data.
public sealed partial class PostgresFleetCoordinator
{
    private const int CheckinRetentionDays = 7;

    public async Task<PersistenceMaintenanceResult> MaintainPersistenceAsync(PersistenceMaintenancePolicy policy,
        CancellationToken cancellationToken = default)
    {
        if (policy.BatchSize is < 1 or > 10_000 || policy.AuditEventRetention <= TimeSpan.Zero ||
            policy.SourceScanRetention <= TimeSpan.Zero)
            throw Error("invalid_retention_policy", "Retention periods must be positive and batch size must be between 1 and 10,000.");
        await EnsureWorkspace(cancellationToken);
        var now = clock.GetUtcNow();
        var workspaceId = options.WorkspaceId.Value;
        var scrubbed = await db.Database.ExecuteSqlInterpolatedAsync($$"""
            WITH expired AS (
                SELECT "Id" FROM enrollment_authorizations
                WHERE "WorkspaceId" = {{workspaceId}} AND "DeliveryPayload" IS NOT NULL AND "RetryUntil" < {{now}}
                ORDER BY "RetryUntil" LIMIT {{policy.BatchSize}} FOR UPDATE SKIP LOCKED
            )
            UPDATE enrollment_authorizations e SET "DeliveryPayload" = NULL
            FROM expired WHERE e."Id" = expired."Id"
            """, cancellationToken);
        var auditDeleted = policy.AuditEventRetention is TimeSpan auditRetention
            ? await DeleteAuditEvents(workspaceId, now - auditRetention, policy.BatchSize, cancellationToken) : 0;
        var scansDeleted = policy.SourceScanRetention is TimeSpan scanRetention
            ? await DeleteSourceScans(workspaceId, now - scanRetention, policy.BatchSize, cancellationToken) : 0;
        // Check-in history is operational telemetry with a fixed window, independent of the opt-in retention policy.
        var checkinsDeleted = await DeleteCheckins(now.AddDays(-CheckinRetentionDays), policy.BatchSize, cancellationToken);
        return new(scrubbed, auditDeleted, scansDeleted, checkinsDeleted);
    }

    private async Task<int> DeleteAuditEvents(Guid workspaceId, DateTimeOffset cutoff, int batchSize, CancellationToken cancellationToken) =>
        await db.Database.ExecuteSqlInterpolatedAsync($$"""
            WITH expired AS (SELECT "Id" FROM audit_events WHERE "WorkspaceId" = {{workspaceId}} AND "RecordedAt" < {{cutoff}} ORDER BY "RecordedAt" LIMIT {{batchSize}} FOR UPDATE SKIP LOCKED)
            DELETE FROM audit_events a USING expired WHERE a."Id" = expired."Id"
            """, cancellationToken);

    private async Task<int> DeleteSourceScans(Guid workspaceId, DateTimeOffset cutoff, int batchSize, CancellationToken cancellationToken) =>
        await db.Database.ExecuteSqlInterpolatedAsync($$"""
            WITH expired AS (SELECT "Id" FROM source_scans WHERE "WorkspaceId" = {{workspaceId}} AND "ObservedAt" < {{cutoff}} ORDER BY "ObservedAt" LIMIT {{batchSize}} FOR UPDATE SKIP LOCKED)
            DELETE FROM source_scans s USING expired WHERE s."Id" = expired."Id"
            """, cancellationToken);

    private async Task<int> DeleteCheckins(DateTimeOffset cutoff, int batchSize, CancellationToken cancellationToken) =>
        await db.Database.ExecuteSqlInterpolatedAsync($$"""
            WITH expired AS (SELECT "NodeId", "Hour" FROM node_checkins WHERE "Hour" < {{cutoff}} ORDER BY "Hour" LIMIT {{batchSize}} FOR UPDATE SKIP LOCKED)
            DELETE FROM node_checkins c USING expired WHERE c."NodeId" = expired."NodeId" AND c."Hour" = expired."Hour"
            """, cancellationToken);
}
