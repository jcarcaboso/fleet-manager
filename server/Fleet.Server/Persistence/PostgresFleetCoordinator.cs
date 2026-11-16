using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Fleet.Core.Coordination;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Npgsql;

namespace Fleet.Server.Persistence;

// The coordinator's support code: Node certificate lookup (INodeCredentialLookup) and Node authentication, the Workspace check,
// alias changes, paging, input checks, audit rows and time truncation. Each role interface has its own partial file.
public sealed partial class PostgresFleetCoordinator(
    FleetDbContext db,
    TimeProvider clock,
    FleetCoordinationOptions options,
    ILogger<PostgresFleetCoordinator>? logger = null) : IFleetCoordinator
{
    public async Task<NodeAuthentication?> FindActiveNodeByCertificateAsync(string certificateSha256, CancellationToken cancellationToken = default, bool allowExpired = false)
    {
        await EnsureWorkspace(cancellationToken);
        ValidateSha256(certificateSha256, "certificate_sha256");
        var now = clock.GetUtcNow();
        var found = await (from credential in db.Credentials
                           join node in db.Nodes on credential.NodeId equals node.Id
                           where credential.CertificateSha256 == certificateSha256 && credential.RevokedAt == null &&
                                 credential.NotBefore <= now && (allowExpired || credential.NotAfter > now) && node.RevokedAt == null &&
                                 node.WorkspaceId == options.WorkspaceId.Value
                           select new { credential.Id, NodeId = node.Id }).SingleOrDefaultAsync(cancellationToken);
        return found is null ? null : new(new(found.NodeId), new(found.Id), certificateSha256);
    }

    // Returns the Node row it loaded anyway, so poll reads the pending disk refresh request without another query.
    // With selfUpdate, the contact update also records whether the Agent announced the agent-update capability.
    private async Task<NodeRow> Authenticate(NodeAuthentication authentication, DateTimeOffset contact, bool updateContact, CancellationToken cancellationToken,
        bool? selfUpdate = null)
    {
        await EnsureWorkspace(cancellationToken);
        var now = clock.GetUtcNow();
        var valid = await (from credential in db.Credentials
                           join node in db.Nodes on credential.NodeId equals node.Id
                           where credential.Id == authentication.CredentialId.Value && node.Id == authentication.NodeId.Value &&
                                 credential.CertificateSha256 == authentication.CertificateSha256 && credential.RevokedAt == null &&
                                 credential.NotBefore <= now && credential.NotAfter > now && node.RevokedAt == null &&
                                 node.WorkspaceId == options.WorkspaceId.Value
                           select node).SingleOrDefaultAsync(cancellationToken);
        if (valid is null) throw Error("node_unauthorized", "Node credential is not active.");
        if (updateContact)
        {
            var nodeId = authentication.NodeId.Value;
            if (selfUpdate is { } capable)
                await db.Database.ExecuteSqlInterpolatedAsync($"UPDATE nodes SET \"LastContactAt\" = GREATEST(COALESCE(\"LastContactAt\", {contact}), {contact}), \"AgentSelfUpdate\" = {capable} WHERE \"Id\" = {nodeId}", cancellationToken);
            else
                await db.Database.ExecuteSqlInterpolatedAsync($"UPDATE nodes SET \"LastContactAt\" = GREATEST(COALESCE(\"LastContactAt\", {contact}), {contact}) WHERE \"Id\" = {nodeId}", cancellationToken);
        }
        return valid;
    }

    // Serializes source publication with Node removal. Both take it before they lock or read Node rows.
    private const string PublicationLockSql = "SELECT pg_advisory_xact_lock(1179403596)";

    private IQueryable<NodeRow> NodeForUpdate(Guid id) =>
        db.Nodes.FromSqlInterpolated($"SELECT * FROM nodes WHERE \"Id\" = {id} FOR UPDATE");

    // Locks a Node of this Workspace, or throws node_not_found. Callers that only read the row pass tracked: false.
    private async Task<NodeRow> LockNodeAsync(Guid id, CancellationToken cancellationToken, bool tracked = true)
    {
        var query = NodeForUpdate(id);
        var node = await (tracked ? query : query.AsNoTracking()).SingleOrDefaultAsync(cancellationToken);
        if (node is null || node.WorkspaceId != options.WorkspaceId.Value) throw Error("node_not_found", "Node was not found.");
        return node;
    }

    // Locks the Node an Agent report comes from, after Authenticate, and throws node_unauthorized if it is gone or revoked by now.
    private async Task LockReportingNodeAsync(Guid nodeId, CancellationToken cancellationToken)
    {
        var node = await NodeForUpdate(nodeId).AsNoTracking().SingleOrDefaultAsync(cancellationToken);
        if (node is null || node.RevokedAt is not null) throw Error("node_unauthorized", "Node credential is not active.");
    }

    // Locks the Node, then its credential, and throws node_unauthorized unless both are active. With allowExpired, a credential
    // past its NotAfter still counts (credential renewal).
    private async Task<(NodeRow Node, CredentialRow Credential)> LockActiveCredentialAsync(NodeAuthentication authentication,
        DateTimeOffset now, bool allowExpired, CancellationToken cancellationToken)
    {
        var credentialId = authentication.CredentialId.Value;
        var node = await NodeForUpdate(authentication.NodeId.Value).SingleOrDefaultAsync(cancellationToken);
        var credential = await db.Credentials.FromSqlInterpolated($"SELECT * FROM node_credentials WHERE \"Id\" = {credentialId} FOR UPDATE")
            .SingleOrDefaultAsync(cancellationToken);
        if (node is null || credential is null || node.WorkspaceId != options.WorkspaceId.Value || node.RevokedAt is not null ||
            credential.NodeId != node.Id || credential.RevokedAt is not null || credential.NotBefore > now ||
            !allowExpired && credential.NotAfter <= now || credential.CertificateSha256 != authentication.CertificateSha256)
            throw Error("node_unauthorized", "Node credential is not active.");
        return (node, credential);
    }

    private static AttemptRow NewPendingAttempt(Guid assignmentId, Guid rolloutId, Guid nodeId, DateTimeOffset at) => new()
    {
        Id = Guid.NewGuid(),
        AssignmentId = assignmentId,
        RolloutId = rolloutId,
        NodeId = nodeId,
        State = (int)ConvergenceState.Pending,
        UpdatedAt = at
    };

    private async Task EnsureWorkspace(CancellationToken cancellationToken)
    {
        var workspaceId = options.WorkspaceId.Value;
        var workspaceName = options.WorkspaceName;
        await db.Database.ExecuteSqlInterpolatedAsync($"INSERT INTO workspaces (\"Id\", \"SingletonKey\", \"Name\") VALUES ({workspaceId}, 1, {workspaceName}) ON CONFLICT (\"SingletonKey\") DO NOTHING", cancellationToken);
        var actual = await db.Workspaces.AsNoTracking().Select(x => x.Id).SingleAsync(cancellationToken);
        if (actual != workspaceId) throw Error("workspace_mismatch", "The database belongs to a different Workspace.");
    }

    private async Task ChangeNodeAlias(NodeRow node, string alias, string actor, Guid? credentialId,
        CancellationToken cancellationToken)
    {
        if (node.Name == alias) return;
        if (await db.Nodes.AnyAsync(x => x.WorkspaceId == options.WorkspaceId.Value && x.Name == alias && x.Id != node.Id,
                cancellationToken))
            throw Error("node_alias_in_use", "The Node alias is already registered in this Workspace.");
        node.Name = alias;
        db.AuditEvents.Add(Audit("node_alias_changed", actor, clock.GetUtcNow(), node.Id, credentialId));
        try
        {
            await db.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateException exception) when (exception.InnerException is PostgresException
        { SqlState: PostgresErrorCodes.UniqueViolation, ConstraintName: "IX_nodes_WorkspaceId_Name" })
        {
            throw Error("node_alias_in_use", "The Node alias is already registered in this Workspace.");
        }
    }

    private static (int Limit, Guid Cursor) PageArgs(PageRequest page)
    {
        if (page.Limit is < 1 or > PageRequest.MaximumLimit) throw Error("invalid_request", $"limit must be between 1 and {PageRequest.MaximumLimit}.");
        return (page.Limit, page.Cursor is null ? Guid.Empty : Guid.TryParse(page.Cursor, out var id) ? id
            : throw Error("invalid_request", "after is not a valid cursor for this order."));
    }

    private static Page<TOut> MakePage<TRow, TOut>(List<TRow> rows, int limit, Func<TRow, Guid> id, Func<TRow, TOut> map)
    {
        var items = rows.Take(limit).Select(map).ToList();
        return new(items, rows.Count > limit ? id(rows[limit - 1]).ToString("D") : null);
    }

    private static (int Limit, (DateTimeOffset At, Guid Id)? After) OperatorPageArgs(PageRequest page)
    {
        if (page.Limit is < 1 or > PageRequest.MaximumLimit)
            throw Error("invalid_request", $"limit must be between 1 and {PageRequest.MaximumLimit}.");
        if (page.Cursor is null) return (page.Limit, null);
        try
        {
            var text = Encoding.UTF8.GetString(Microsoft.AspNetCore.WebUtilities.WebEncoders.Base64UrlDecode(page.Cursor));
            var parts = text.Split(':');
            if (parts.Length == 2 && long.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out var ticks) &&
                ticks <= DateTime.MaxValue.Ticks && Guid.TryParseExact(parts[1], "N", out var id))
                return (page.Limit, (new DateTimeOffset(ticks, TimeSpan.Zero), id));
        }
        catch (FormatException) { }
        throw Error("invalid_request", "after is not a valid cursor for this order.");
    }

    private static Page<TOut> MakeTimePage<TRow, TOut>(List<TRow> rows, int limit, Func<TRow, DateTimeOffset> at, Func<TRow, Guid> id,
        Func<TRow, TOut> map)
    {
        var items = rows.Take(limit).Select(map).ToList();
        if (rows.Count <= limit) return new(items, null);
        var last = rows[limit - 1];
        return new(items, Base64Url(Encoding.UTF8.GetBytes(
            at(last).UtcTicks.ToString(CultureInfo.InvariantCulture) + ":" + id(last).ToString("N"))));
    }

    private static string Required(string value, int maximum, string field)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > maximum) throw Error("invalid_" + field, $"{field} is required and bounded.");
        return value;
    }

    private static void ValidateSha256(string value, string field)
    {
        var hex = value.StartsWith("sha256:", StringComparison.Ordinal) ? value[7..] : value;
        if (hex.Length != 64 || !hex.All(Uri.IsHexDigit)) throw Error("invalid_" + field, $"{field} must be a SHA-256 digest.");
    }

    private static DateTimeOffset TruncateToMicroseconds(DateTimeOffset value) => new(value.UtcTicks / 10 * 10, TimeSpan.Zero);

    private static DateTimeOffset TruncateToHour(DateTimeOffset value)
    {
        var utc = value.UtcDateTime;
        return new(utc.Year, utc.Month, utc.Day, utc.Hour, 0, 0, TimeSpan.Zero);
    }

    private static string TokenDigest(string token) => Convert.ToHexString(SHA256.HashData(
        Encoding.UTF8.GetBytes("fleet-enrollment-token-v1\0" + token))).ToLowerInvariant();
    private static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static CoordinationException Error(string code, string message) => new(code, message);
    private AuditEventRow Audit(string action, string actor, DateTimeOffset at, Guid? nodeId = null, Guid? credentialId = null) =>
        new()
        {
            Id = Guid.NewGuid(),
            WorkspaceId = options.WorkspaceId.Value,
            RecordedAt = at,
            Action = action,
            Actor = Required(actor, 200, "actor"),
            NodeId = nodeId,
            CredentialId = credentialId
        };
}
