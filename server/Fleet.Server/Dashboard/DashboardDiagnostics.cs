using System.Text.Json;
using Fleet.Core.Coordination;
using Fleet.Server.Persistence;
using Fleet.Server.Security;
using Fleet.Server.Transport;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Fleet.Server.Dashboard;

public sealed record DashboardIssue(string Code, string Severity, string Title, string Detail, string Action, string Section);

public static class DashboardDiagnostics
{
    public static async Task<object> ReadAsync(FleetDbContext db, IFleetCoordinator coordinator,
        CliProxyCatalog catalog, IOptions<FleetOptions> options, IConfiguration configuration, TimeProvider clock, CancellationToken ct)
    {
        var issues = new List<DashboardIssue>();
        var settings = options.Value;
        var now = clock.GetUtcNow();
        var nodes = db.Nodes.AsNoTracking().Where(node => node.WorkspaceId == settings.WorkspaceId && node.RevokedAt == null);
        var assignments = from assignment in db.Assignments.AsNoTracking()
                          join node in nodes on assignment.NodeId equals node.Id
                          where assignment.IsCurrent
                          select new { Assignment = assignment, Node = node };
        var proxies = await (from assignment in assignments
                             join client in db.AssignmentAiClients on assignment.Assignment.Id equals client.AssignmentId
                             where client.Mode == "cliproxy"
                             select client.BaseUrl!).Distinct().ToArrayAsync(ct);
        if (proxies.Length > 0 && settings.CliProxyApiKey.Length == 0)
            issues.Add(new("cliproxy_key_missing", "error", "CLIProxy API key is missing",
                "Nodes are assigned to CLIProxy, but the Server cannot retrieve or distribute their models.",
                "Set Fleet:CliProxyApiKey in the Server's private configuration, recreate the Server, then refresh models.", "models"));
        else if (proxies.Length > 0)
        {
            var status = JsonSerializer.SerializeToElement(catalog.Status());
            var catalogs = status.GetProperty("catalogs").EnumerateArray().ToArray();
            foreach (var url in proxies.Take(20))
            {
                var entry = catalogs.FirstOrDefault(item => item.GetProperty("baseUrl").GetString() == url);
                if (entry.ValueKind == JsonValueKind.Undefined)
                    issues.Add(new("cliproxy_discovery_pending", "warning", "Model discovery has not completed", url,
                        "Refresh models or wait for the next discovery check. Initial discovery normally starts within 30 seconds.", "models"));
                else if (entry.GetProperty("errorCode").GetString() is { } error)
                {
                    var cached = entry.GetProperty("modelCount").GetInt32() > 0;
                    var action = error is "upstream_http_401" or "upstream_http_403"
                        ? "Check that CLIProxy accepts the dedicated Fleet key, then refresh models."
                        : error == "invalid_catalog" ? "Check CLIProxy's model response. It must contain a valid, non-empty model list."
                        : "Check the proxy URL, TLS trust and connectivity from the Server, then refresh models.";
                    issues.Add(new("cliproxy_refresh_failed", cached ? "warning" : "error", "CLIProxy model refresh failed",
                        $"{url}: {error}. " + (cached ? "Agents can use the last valid catalog." : "No model catalog is available."), action, "models"));
                }
            }
        }
        var source = await coordinator.GetLatestSourceScanAsync(ct);
        if (string.IsNullOrWhiteSpace(configuration["Source:Remote"]))
            issues.Add(new("source_not_configured", "warning", "No repository is configured",
                "The Server cannot publish new assignments from Git.", "Set Source:Remote, then sync the repository.", "repository"));
        else if (source?.Outcome is SourceScanOutcome.Failed or SourceScanOutcome.Invalid)
            issues.Add(new("source_sync_failed", "error", "Repository sync failed",
                $"The last scan at {source.ObservedAt:u} was {source.Outcome.ToString().ToLowerInvariant()}. Existing assignments remain active.",
                "Check repository access and fleet.yml validation in the Server logs, then sync the repository again.", "repository"));
        else if (source is null)
            issues.Add(new("source_not_scanned", "warning", "Repository has not been synced",
                "No source scan has been recorded.", "Sync the repository to validate configuration and publish assignments.", "repository"));
        var cutoff = now.AddSeconds(-settings.StaleAfterSeconds);
        var stale = nodes.Where(node => node.LastContactAt < cutoff || node.LastContactAt == null && node.EnrolledAt < cutoff);
        var staleCount = await stale.CountAsync(ct);
        if (staleCount > 0)
        {
            var names = await stale.OrderBy(node => node.Name).Take(5).Select(node => node.Name).ToListAsync(ct);
            issues.Add(new("nodes_not_contacting", "warning", $"{staleCount} {(staleCount == 1 ? "node is" : "nodes are")} not checking in",
                string.Join(", ", names) + (staleCount > names.Count ? " and more" : ""),
                "Check each Agent service, its running version, network connection and certificate. Restart the service after upgrading the binary.", "nodes-section"));
        }
        var failed = assignments.Where(item => item.Assignment.State == (int)ConvergenceState.Failed);
        var failedCount = await failed.CountAsync(ct);
        foreach (var item in await failed.OrderBy(item => item.Node.Name).ThenBy(item => item.Assignment.TargetName).Take(20).ToListAsync(ct))
            issues.Add(new("assignment_failed", "error", $"{item.Node.Name}: {item.Assignment.TargetName} failed",
                "The Agent reported a failure for this current assignment.",
                item.Assignment.TargetName.StartsWith("ai-client/", StringComparison.Ordinal)
                    ? "Resolve any model-sync issue above, then check Agent logs for configuration or ownership conflicts. AI-client setup retries after one minute."
                    : "Check Agent logs for permissions, ownership conflicts or download failures.", "nodes-section"));
        if (failedCount > 20)
            issues.Add(new("more_failed_assignments", "warning", $"{failedCount - 20} more assignments failed",
                "Only the first 20 failures are shown.", "Inspect rollout attempts through the Operator API for the full list.", "nodes-section"));
        return new { checkedAt = now, issues };
    }
}
