using System.Text.Json;
using System.Text.RegularExpressions;
using Fleet.Core.Coordination;
using Fleet.Server.Persistence;
using Fleet.Server.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Fleet.Server.Transport;

public sealed record OperatorIssue(
    string Id,
    string Code,
    string Severity,
    string Title,
    string Detail,
    string Action,
    string Section,
    string? ErrorCode,
    Guid? NodeId,
    string? NodeName,
    string? Target,
    DateTimeOffset? Since,
    IReadOnlyList<string> Commands,
    string? Diagnostic = null,
    string? Path = null,
    string? Step = null);

/// <summary>Builds the open issues of the Workspace. <c>GET issues</c> returns them; the legacy diagnostics reuse the configuration part.</summary>
public static partial class OperatorIssues
{
    public const int MaximumItems = 200;

    private sealed record LatestFailure(string? ErrorCode, string? Diagnostic, string? Path, string? Step);

    private sealed record FailedAssignment(Guid NodeId, string NodeName, string TargetName, DateTimeOffset? FirstFailedAt, LatestFailure? Latest);

    public static async Task<IReadOnlyList<OperatorIssue>> ReadAsync(FleetDbContext db, IFleetCoordinator coordinator,
        CliProxyCatalog catalog, IOptions<FleetOptions> options, IConfiguration configuration, TimeProvider clock, CancellationToken ct)
    {
        var settings = options.Value;
        var now = clock.GetUtcNow();
        var issues = (await ConfigurationAsync(db, coordinator, catalog, settings, configuration, ct)).ToList();
        var nodes = db.Nodes.AsNoTracking().Where(node => node.WorkspaceId == settings.WorkspaceId && node.RevokedAt == null);

        var cutoff = now.AddSeconds(-settings.StaleAfterSeconds);
        var stale = await nodes.Where(node => node.LastContactAt < cutoff || node.LastContactAt == null && node.EnrolledAt < cutoff)
            .OrderBy(node => node.Name).Take(MaximumItems).Select(node => new { node.Id, node.Name, node.LastContactAt, node.EnrolledAt })
            .ToListAsync(ct);
        foreach (var node in stale)
        {
            var alias = Quote(node.Name);
            issues.Add(new($"node_not_contacting:{node.Id:D}", "node_not_contacting", "warning", $"{node.Name} is not checking in",
                node.LastContactAt is { } last ? $"The last contact was at {last:u}." : $"The Node has not contacted the Server since it enrolled at {node.EnrolledAt:u}.",
                "Check the Agent service, its running version, network connection and certificate. Restart the service after upgrading the binary.",
                "nodes", null, node.Id, node.Name, null, node.LastContactAt ?? node.EnrolledAt,
                [$"fleet nodes show {alias}", $"fleet nodes checkins {alias}"]));
        }

        var failed = from assignment in db.Assignments.AsNoTracking()
                     join node in nodes on assignment.NodeId equals node.Id
                     where assignment.IsCurrent && assignment.State == (int)ConvergenceState.Failed
                     select new { AssignmentId = assignment.Id, NodeId = node.Id, NodeName = node.Name, assignment.TargetName };
        var failedCount = await failed.CountAsync(ct);
        // The first failure time and latest error code come from PostgreSQL, one bounded row per Assignment, because
        // an Assignment (an AI client in particular) can accumulate thousands of failed Attempts.
        var failedState = (int)ConvergenceState.Failed;
        var failedRows = await failed.OrderBy(x => x.NodeName).ThenBy(x => x.TargetName).Take(MaximumItems)
            .Select(x => new FailedAssignment(x.NodeId, x.NodeName, x.TargetName,
                db.Attempts.Where(a => a.AssignmentId == x.AssignmentId && a.State == failedState).Min(a => (DateTimeOffset?)a.UpdatedAt),
                db.Attempts.Where(a => a.AssignmentId == x.AssignmentId && a.State == failedState)
                    .OrderByDescending(a => a.UpdatedAt).ThenByDescending(a => a.Id)
                    .Select(a => new LatestFailure(a.ErrorCode, a.Diagnostic, a.FailurePath, a.FailureStep)).FirstOrDefault()))
            .ToListAsync(ct);
        foreach (var row in failedRows)
        {
            var attempt = (ErrorCode: row.Latest?.ErrorCode, Since: row.FirstFailedAt);
            var known = attempt.ErrorCode is null ? null : ErrorCatalog.Find(attempt.ErrorCode);
            var alias = Quote(row.NodeName);
            var commands = new List<string> { $"fleet nodes show {alias}" };
            if (attempt.ErrorCode is not null) commands.Add($"fleet explain {Quote(attempt.ErrorCode)}");
            commands.Add($"fleet retry {alias} {Quote(row.TargetName)}");
            issues.Add(new($"assignment_failed:{row.NodeId:D}:{row.TargetName}", "assignment_failed", "error",
                $"{row.NodeName}: {row.TargetName} failed",
                attempt.ErrorCode is null ? "The Agent reported a failure for this current assignment."
                    : known is null ? $"The Agent reported {attempt.ErrorCode} for this current assignment."
                    : $"The Agent reported {attempt.ErrorCode} ({known.Title}) for this current assignment.",
                known?.Fix[0] ?? (row.TargetName.StartsWith("ai-client/", StringComparison.Ordinal)
                    ? "Resolve any model-sync issue, then check Agent logs for configuration or ownership conflicts. AI-client setup retries after one minute."
                    : "Check Agent logs for permissions, ownership conflicts or download failures."),
                "nodes", attempt.ErrorCode, row.NodeId, row.NodeName, row.TargetName, attempt.Since,
                commands, row.Latest?.Diagnostic, row.Latest?.Path, row.Latest?.Step));
        }

        var ordered = Order(issues);
        var failedShown = ordered.Take(MaximumItems).Count(x => x.Code == "assignment_failed");
        if (ordered.Count > MaximumItems || failedCount > failedShown)
        {
            ordered = ordered.Take(MaximumItems - 1).ToList();
            failedShown = ordered.Count(x => x.Code == "assignment_failed");
            if (failedCount > failedShown)
                ordered = Order([.. ordered, new("more_failed_assignments", "more_failed_assignments", "warning",
                    $"{failedCount - failedShown} more assignments failed", "Only the first failures are listed.",
                    "Run `fleet nodes list` to see the failed counts for every Node.", "nodes", null, null, null, null, null, ["fleet nodes list"])]);
        }
        return ordered;
    }

    /// <summary>Repository and CLIProxy issues. They do not depend on a Node.</summary>
    public static async Task<IReadOnlyList<OperatorIssue>> ConfigurationAsync(FleetDbContext db, IFleetCoordinator coordinator,
        CliProxyCatalog catalog, FleetOptions settings, IConfiguration configuration, CancellationToken ct)
    {
        var issues = new List<OperatorIssue>();
        var nodes = db.Nodes.AsNoTracking().Where(node => node.WorkspaceId == settings.WorkspaceId && node.RevokedAt == null);
        var proxies = await (from assignment in db.Assignments.AsNoTracking()
                             join node in nodes on assignment.NodeId equals node.Id
                             join client in db.AssignmentAiClients on assignment.Id equals client.AssignmentId
                             where assignment.IsCurrent && client.Mode == "cliproxy"
                             select client.BaseUrl!).Distinct().ToArrayAsync(ct);
        if (proxies.Length > 0 && settings.CliProxyApiKey.Length == 0)
            issues.Add(new("cliproxy_key_missing", "cliproxy_key_missing", "error", "CLIProxy API key is missing",
                "Nodes are assigned to CLIProxy, but the Server cannot retrieve or distribute their models.",
                "Set Fleet:CliProxyApiKey in the Server's private configuration, recreate the Server, then refresh models.", "models",
                null, null, null, null, null, ["fleet models refresh"]));
        else if (proxies.Length > 0)
        {
            var status = JsonSerializer.SerializeToElement(catalog.Status());
            var catalogs = status.GetProperty("catalogs").EnumerateArray().ToArray();
            foreach (var url in proxies.Take(20))
            {
                var entry = catalogs.FirstOrDefault(item => item.GetProperty("baseUrl").GetString() == url);
                if (entry.ValueKind == JsonValueKind.Undefined)
                    issues.Add(new($"cliproxy_discovery_pending:{url}", "cliproxy_discovery_pending", "warning",
                        "Model discovery has not completed", url,
                        "Refresh models or wait for the next discovery check. Initial discovery normally starts within 30 seconds.", "models",
                        null, null, null, null, null, ["fleet models refresh"]));
                else if (entry.GetProperty("errorCode").GetString() is { } error)
                {
                    var cached = entry.GetProperty("modelCount").GetInt32() > 0;
                    var action = error is "upstream_http_401" or "upstream_http_403"
                        ? "Check that CLIProxy accepts the dedicated Fleet key, then refresh models."
                        : error == "invalid_catalog" ? "Check CLIProxy's model response. It must contain a valid, non-empty model list."
                        : "Check the proxy URL, TLS trust and connectivity from the Server, then refresh models.";
                    issues.Add(new($"cliproxy_refresh_failed:{url}", "cliproxy_refresh_failed", cached ? "warning" : "error",
                        "CLIProxy model refresh failed",
                        $"{url}: {error}. " + (cached ? "Agents can use the last valid catalog." : "No model catalog is available."), action, "models",
                        null, null, null, null, null, ["fleet models refresh"]));
                }
            }
        }
        var source = await coordinator.GetLatestSourceScanAsync(ct);
        if (string.IsNullOrWhiteSpace(configuration["Source:Remote"]))
            issues.Add(new("source_not_configured", "source_not_configured", "warning", "No repository is configured",
                "The Server cannot publish new assignments from Git.", "Set Source:Remote, then sync the repository.", "repository",
                null, null, null, null, null, []));
        else if (source?.Outcome is SourceScanOutcome.Failed or SourceScanOutcome.Invalid)
            issues.Add(new("source_sync_failed", "source_sync_failed", "error", "Repository sync failed",
                $"The last scan at {source.ObservedAt:u} was {source.Outcome.ToString().ToLowerInvariant()}. Existing assignments remain active.",
                "Check repository access and fleet.yml validation in the Server logs, then sync the repository again.", "repository",
                null, null, null, null, source.ObservedAt, ["fleet source rescan"]));
        else if (source is null)
            issues.Add(new("source_not_scanned", "source_not_scanned", "warning", "Repository has not been synced",
                "No source scan has been recorded.", "Sync the repository to validate configuration and publish assignments.", "repository",
                null, null, null, null, null, ["fleet source rescan"]));
        return issues;
    }

    // Errors first, then by Node name and Target. Issues without a Node come before Node issues of the same severity.
    private static List<OperatorIssue> Order(IEnumerable<OperatorIssue> issues) => issues
        .OrderBy(x => x.Severity == "error" ? 0 : 1)
        .ThenBy(x => x.NodeName, StringComparer.Ordinal)
        .ThenBy(x => x.Target, StringComparer.Ordinal)
        .ThenBy(x => x.Code, StringComparer.Ordinal)
        .ThenBy(x => x.Id, StringComparer.Ordinal).ToList();

    /// <summary>Quotes a value for a POSIX shell command line unless it only contains plain characters.</summary>
    public static string Quote(string value) => SafeArgument().IsMatch(value) ? value : "'" + value.Replace("'", "'\\''") + "'";

    [GeneratedRegex("^[A-Za-z0-9_@%+=:,./-]+$")]
    private static partial Regex SafeArgument();
}
