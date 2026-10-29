using System.Data;
using Fleet.Core.Coordination;
using Microsoft.EntityFrameworkCore;

namespace Fleet.Server.Persistence;

// Agent self-update requests. One row per Node in agent_updates; the Node row lock serializes requests and cancellations of a
// Node, and the update row lock serializes the Agent's reports with them. Each request gets a new UpdateId, which the poll
// sends and every report must repeat.
public sealed partial class PostgresFleetCoordinator
{
    private const int MaximumOutdatedNodes = 500;

    public Task<PollResult> PollAsync(NodeAuthentication authentication, DateTimeOffset contactedAt, AgentCapabilities capabilities,
        CancellationToken cancellationToken = default) =>
        PollInternal(authentication, contactedAt, null, capabilities, cancellationToken);

    public async Task<AgentUpdateStatus> RequestAgentUpdateAsync(NodeId nodeId, SemanticVersion targetVersion, string requestedBy,
        bool checkOnly = false, CancellationToken cancellationToken = default)
    {
        var actor = Required(requestedBy, 200, "requested_by");
        await EnsureWorkspace(cancellationToken);
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var id = nodeId.Value;
        var node = checkOnly
            ? await db.Nodes.AsNoTracking().SingleOrDefaultAsync(x => x.Id == id, cancellationToken)
            : await db.Nodes.FromSqlInterpolated($"SELECT * FROM nodes WHERE \"Id\" = {id} FOR UPDATE").AsNoTracking()
                .SingleOrDefaultAsync(cancellationToken);
        if (node is null || node.WorkspaceId != options.WorkspaceId.Value) throw Error("node_not_found", "Node was not found.");
        if (node.RevokedAt is not null) throw Error("node_revoked", "A revoked Node cannot be updated.");
        if (!node.AgentSelfUpdate)
            throw Error("agent_update_unsupported",
                "The Agent on this Node cannot update itself. Upgrade it once by hand and run `fleet-agent service install`.");
        var running = await db.NodeTelemetries.AsNoTracking().Where(x => x.NodeId == id).Select(x => x.AgentVersion)
            .SingleOrDefaultAsync(cancellationToken);
        if (running is not null && SemanticVersion.TryParse(running, out var version) && version >= targetVersion)
            throw Error("agent_update_current", $"The Agent already runs version {running}.");
        // The check before mirroring tracks nothing: the write after it must read the row again, locked, as it is by then.
        var existing = checkOnly
            ? await db.AgentUpdates.AsNoTracking().SingleOrDefaultAsync(x => x.NodeId == id, cancellationToken)
            : await db.AgentUpdates.FromSqlInterpolated($"SELECT * FROM agent_updates WHERE \"NodeId\" = {id} FOR UPDATE")
                .SingleOrDefaultAsync(cancellationToken);
        var now = TruncateToMicroseconds(clock.GetUtcNow());
        if (existing is not null && AgentUpdateRules.IsActive(existing.State))
        {
            if (existing.State == AgentUpdateRules.Requested && existing.TargetVersion == targetVersion.Text) return Status(existing);
            if (existing.State != AgentUpdateRules.Requested && existing.UpdatedAt > now - AgentUpdateRules.AbandonedAfter)
                throw Error("agent_update_in_progress", $"The Agent is already updating to {existing.TargetVersion}.");
        }
        if (checkOnly) return new(running, targetVersion.Text, AgentUpdateRules.Requested, null, actor, now, now, null);
        if (existing is null)
        {
            existing = new AgentUpdateRow { NodeId = id, TargetVersion = targetVersion.Text, State = AgentUpdateRules.Requested, RequestedBy = actor };
            db.AgentUpdates.Add(existing);
        }
        existing.UpdateId = Guid.NewGuid();
        existing.FromVersion = running;
        existing.TargetVersion = targetVersion.Text;
        existing.State = AgentUpdateRules.Requested;
        existing.ErrorCode = null;
        existing.RequestedBy = actor;
        existing.RequestedAt = now;
        existing.UpdatedAt = now;
        existing.FinishedAt = null;
        db.AuditEvents.Add(UpdateAudit("agent.update_requested", actor, now, id, $"{running ?? "unknown"} -> {targetVersion.Text}"));
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return Status(existing);
    }

    public async Task<AgentUpdateStatus> CancelAgentUpdateAsync(NodeId nodeId, string cancelledBy, CancellationToken cancellationToken = default)
    {
        var actor = Required(cancelledBy, 200, "cancelled_by");
        await EnsureWorkspace(cancellationToken);
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var id = nodeId.Value;
        var node = await db.Nodes.FromSqlInterpolated($"SELECT * FROM nodes WHERE \"Id\" = {id} FOR UPDATE").AsNoTracking()
            .SingleOrDefaultAsync(cancellationToken);
        if (node is null || node.WorkspaceId != options.WorkspaceId.Value) throw Error("node_not_found", "Node was not found.");
        var row = await db.AgentUpdates.FromSqlInterpolated($"SELECT * FROM agent_updates WHERE \"NodeId\" = {id} FOR UPDATE")
            .SingleOrDefaultAsync(cancellationToken);
        if (row is null || row.State != AgentUpdateRules.Requested)
            throw Error("agent_update_not_cancellable", "Only an update the Agent has not started can be cancelled.");
        var now = TruncateToMicroseconds(clock.GetUtcNow());
        row.State = AgentUpdateRules.Cancelled;
        row.UpdatedAt = now;
        row.FinishedAt = now;
        db.AuditEvents.Add(UpdateAudit("agent.update_cancelled", actor, now, id, row.TargetVersion));
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return Status(row);
    }

    public async Task<bool> RecordAgentUpdateReportAsync(NodeAuthentication authentication, AgentUpdateReport report,
        CancellationToken cancellationToken = default)
    {
        var valid = AgentUpdateRules.Validate(report);
        await Authenticate(authentication, clock.GetUtcNow(), false, cancellationToken);
        var id = authentication.NodeId.Value;
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        var row = await db.AgentUpdates.FromSqlInterpolated($"SELECT * FROM agent_updates WHERE \"NodeId\" = {id} FOR UPDATE")
            .SingleOrDefaultAsync(cancellationToken);
        if (row is null || row.UpdateId != valid.UpdateId || row.TargetVersion != valid.Version || !AgentUpdateRules.CanMove(row.State, valid.State))
            return false;
        if (row.State == valid.State) return true;
        var now = TruncateToMicroseconds(clock.GetUtcNow());
        row.State = valid.State;
        row.ErrorCode = valid.ErrorCode;
        row.UpdatedAt = now;
        if (AgentUpdateRules.IsFinished(valid.State))
        {
            row.FinishedAt = now;
            db.AuditEvents.Add(UpdateAudit($"agent.update_{valid.State}", id.ToString("D"), now, id, valid.ErrorCode ?? valid.Version));
        }
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return true;
    }

    public async Task<IReadOnlyList<NodeAliasResult>> GetOutdatedNodesAsync(SemanticVersion latest, CancellationToken cancellationToken = default)
    {
        await EnsureWorkspace(cancellationToken);
        var workspaceId = options.WorkspaceId.Value;
        var rows = await (from telemetry in db.NodeTelemetries.AsNoTracking()
                          join node in db.Nodes.AsNoTracking() on telemetry.NodeId equals node.Id
                          where node.WorkspaceId == workspaceId && node.RevokedAt == null
                          orderby node.Name, node.Id
                          select new { node.Id, node.Name, telemetry.AgentVersion }).ToListAsync(cancellationToken);
        return rows.Where(x => AgentTelemetryRules.IsOutdated(x.AgentVersion, latest)).Take(MaximumOutdatedNodes)
            .Select(x => new NodeAliasResult(new(x.Id), x.Name)).ToList();
    }

    private async Task<AgentUpdateInstruction?> RequestedAgentUpdate(Guid nodeId, CancellationToken cancellationToken)
    {
        // Only the Server's own version is served, so a request for another version (made before a Server upgrade) waits for a new request.
        var version = options.LatestAgentVersion.Text;
        return await db.AgentUpdates.AsNoTracking()
            .Where(x => x.NodeId == nodeId && x.State == AgentUpdateRules.Requested && x.TargetVersion == version)
            .Select(x => new AgentUpdateInstruction(x.TargetVersion, x.UpdateId)).SingleOrDefaultAsync(cancellationToken);
    }

    private static AgentUpdateStatus Status(AgentUpdateRow row) => new(row.FromVersion, row.TargetVersion, row.State, row.ErrorCode,
        row.RequestedBy, row.RequestedAt, row.UpdatedAt, row.FinishedAt);

    private AuditEventRow UpdateAudit(string action, string actor, DateTimeOffset at, Guid nodeId, string detail)
    {
        var audit = Audit(action, actor, at, nodeId);
        audit.Detail = detail.Length <= 64 ? detail : detail[..64];
        return audit;
    }
}
