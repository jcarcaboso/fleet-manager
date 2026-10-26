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
        var settings = options.Value;
        var now = clock.GetUtcNow();
        var nodes = db.Nodes.AsNoTracking().Where(node => node.WorkspaceId == settings.WorkspaceId && node.RevokedAt == null);
        var assignments = from assignment in db.Assignments.AsNoTracking()
                          join node in nodes on assignment.NodeId equals node.Id
                          where assignment.IsCurrent
                          select new { Assignment = assignment, Node = node };
        var issues = (await OperatorIssues.ConfigurationAsync(db, coordinator, catalog, settings, configuration, ct))
            .Select(issue => new DashboardIssue(issue.Code, issue.Severity, issue.Title, issue.Detail, issue.Action, issue.Section)).ToList();
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
