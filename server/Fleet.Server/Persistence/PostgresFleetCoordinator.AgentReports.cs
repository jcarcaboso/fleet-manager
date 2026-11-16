using System.Data;
using Fleet.Core.Coordination;
using Microsoft.EntityFrameworkCore;

namespace Fleet.Server.Persistence;

// Agent reports about its Node (IAgentProtocol): disk usage, telemetry, drift and repair failures. Each is written under the
// Node row lock.
public sealed partial class PostgresFleetCoordinator
{
    public async Task RecordDiskUsageAsync(NodeAuthentication authentication, DiskUsageReport report,
        CancellationToken cancellationToken = default)
    {
        DiskUsageRules.Validate(report);
        await Authenticate(authentication, clock.GetUtcNow(), false, cancellationToken);
        var nodeId = authentication.NodeId.Value;
        var labels = report.Volumes.Select(x => x.Label).ToArray();
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        // The Node row lock serializes reports of one Node with each other and with refresh requests: two concurrent reports with
        // different volumes cannot both survive, and a Node removed in the meantime cannot violate the foreign key.
        await LockReportingNodeAsync(nodeId, cancellationToken);
        // Taken under the lock: a refresh request that committed before the lock was acquired is older than this receipt, and one that
        // is made later waits for the lock, so a report never clears a request that arrived after it.
        var now = TruncateToMicroseconds(clock.GetUtcNow());
        foreach (var volume in report.Volumes)
            await db.Database.ExecuteSqlInterpolatedAsync($$"""
                INSERT INTO node_disk_usage ("NodeId", "Label", "TotalBytes", "UsedBytes", "AvailableBytes", "MeasuredAt")
                VALUES ({{nodeId}}, {{volume.Label}}, {{volume.TotalBytes}}, {{volume.UsedBytes}}, {{volume.AvailableBytes}}, {{now}})
                ON CONFLICT ("NodeId", "Label") DO UPDATE SET "TotalBytes" = EXCLUDED."TotalBytes", "UsedBytes" = EXCLUDED."UsedBytes",
                    "AvailableBytes" = EXCLUDED."AvailableBytes", "MeasuredAt" = EXCLUDED."MeasuredAt"
                """, cancellationToken);
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"DELETE FROM node_disk_usage WHERE \"NodeId\" = {nodeId} AND \"Label\" <> ALL({labels})", cancellationToken);
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"UPDATE nodes SET \"DiskUsageRefreshRequestedAt\" = NULL WHERE \"Id\" = {nodeId} AND \"DiskUsageRefreshRequestedAt\" <= {now}",
            cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    public async Task RecordAgentTelemetryAsync(NodeAuthentication authentication, AgentTelemetryReport report,
        CancellationToken cancellationToken = default)
    {
        var sanitized = AgentTelemetryRules.Sanitize(report);
        await Authenticate(authentication, clock.GetUtcNow(), false, cancellationToken);
        var nodeId = authentication.NodeId.Value;
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        // The Node row lock serializes reports of one Node, and a Node removed in the meantime cannot violate the foreign key.
        await LockReportingNodeAsync(nodeId, cancellationToken);
        var now = TruncateToMicroseconds(clock.GetUtcNow());
        await db.Database.ExecuteSqlInterpolatedAsync($$"""
            INSERT INTO node_telemetry ("NodeId", "AgentVersion", "OsName", "OsVersion", "OsKernel", "Arch", "Hostname", "User",
                "InstallMethod", "ServiceManager", "StateDirectory", "ReportedAt")
            VALUES ({{nodeId}}, {{sanitized.AgentVersion}}, {{sanitized.OsName}}, {{sanitized.OsVersion}}, {{sanitized.OsKernel}},
                {{sanitized.Arch}}, {{sanitized.Hostname}}, {{sanitized.User}}, {{sanitized.InstallMethod}}, {{sanitized.ServiceManager}},
                {{sanitized.StateDirectory}}, {{now}})
            ON CONFLICT ("NodeId") DO UPDATE SET "AgentVersion" = EXCLUDED."AgentVersion", "OsName" = EXCLUDED."OsName",
                "OsVersion" = EXCLUDED."OsVersion", "OsKernel" = EXCLUDED."OsKernel", "Arch" = EXCLUDED."Arch",
                "Hostname" = EXCLUDED."Hostname", "User" = EXCLUDED."User", "InstallMethod" = EXCLUDED."InstallMethod",
                "ServiceManager" = EXCLUDED."ServiceManager", "StateDirectory" = EXCLUDED."StateDirectory",
                "ReportedAt" = EXCLUDED."ReportedAt"
            """, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    public async Task RecordDriftAsync(NodeAuthentication authentication, DriftReport report, CancellationToken cancellationToken = default)
    {
        DriftRules.Validate(report);
        await Authenticate(authentication, clock.GetUtcNow(), false, cancellationToken);
        var nodeId = authentication.NodeId.Value;
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        // The Node row lock serializes the reports of one Node, so the pruning below always sees all earlier events, and a Node
        // removed in the meantime cannot violate the foreign key.
        await LockReportingNodeAsync(nodeId, cancellationToken);
        var target = report.Target;
        if (!await db.Assignments.AnyAsync(x => x.NodeId == nodeId && x.IsCurrent && x.TargetName == target, cancellationToken))
            throw Error("invalid_request", "target is not an assigned Target of this Node.");
        db.NodeDriftEvents.Add(new NodeDriftEventRow
        {
            Id = Guid.CreateVersion7(),
            NodeId = nodeId,
            Target = target,
            Files = [.. report.Files],
            DetectedAt = TruncateToMicroseconds(clock.GetUtcNow())
        });
        await db.SaveChangesAsync(cancellationToken);
        var keep = DriftRules.MaximumEvents;
        await db.Database.ExecuteSqlInterpolatedAsync($$"""
            DELETE FROM node_drift_events WHERE "NodeId" = {{nodeId}} AND "Id" IN (
                SELECT "Id" FROM node_drift_events WHERE "NodeId" = {{nodeId}} ORDER BY "DetectedAt" DESC, "Id" DESC OFFSET {{keep}})
            """, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    public async Task RecordRepairFailuresAsync(NodeAuthentication authentication, RepairFailureReport report,
        CancellationToken cancellationToken = default)
    {
        var clean = RepairFailureRules.Sanitize(report);
        await Authenticate(authentication, clock.GetUtcNow(), false, cancellationToken);
        var nodeId = authentication.NodeId.Value;
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        // The Node row lock serializes the reports of one Node, so the replacement below always starts from the latest stored set,
        // and a Node removed in the meantime cannot violate the foreign key.
        await LockReportingNodeAsync(nodeId, cancellationToken);
        var targets = clean.Failures.Select(x => x.Target).ToArray();
        var current = targets.Length == 0 ? new Dictionary<string, Guid>() : await db.Assignments.AsNoTracking()
            .Where(x => x.NodeId == nodeId && x.IsCurrent && targets.Contains(x.TargetName))
            .ToDictionaryAsync(x => x.TargetName, x => x.Id, StringComparer.Ordinal, cancellationToken);
        // A failure of an Assignment that is no longer current is a normal race with a new Assignment and is skipped.
        var accepted = clean.Failures.Where(x => current.GetValueOrDefault(x.Target) == x.AssignmentId.Value)
            .ToDictionary(x => x.Target, StringComparer.Ordinal);
        var stored = await db.NodeRepairFailures.Where(x => x.NodeId == nodeId).ToListAsync(cancellationToken);
        var now = TruncateToMicroseconds(clock.GetUtcNow());
        foreach (var row in stored.Where(x => !accepted.ContainsKey(x.Target))) db.NodeRepairFailures.Remove(row);
        foreach (var failure in accepted.Values)
        {
            var row = stored.SingleOrDefault(x => x.Target == failure.Target);
            if (row is null)
            {
                row = new NodeRepairFailureRow { NodeId = nodeId, Target = failure.Target, ErrorCode = failure.ErrorCode, Diagnostic = failure.Diagnostic };
                db.NodeRepairFailures.Add(row);
            }
            // The same failure of the same Assignment keeps the time it started; anything else is a new failure.
            if (row.FailedSince == default || row.AssignmentId != failure.AssignmentId.Value || row.ErrorCode != failure.ErrorCode)
                row.FailedSince = now;
            row.AssignmentId = failure.AssignmentId.Value;
            row.ErrorCode = failure.ErrorCode;
            row.Diagnostic = failure.Diagnostic;
            row.Path = failure.Path;
            row.Step = failure.Step;
            row.ReportedAt = now;
        }
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }
}
