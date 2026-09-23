using Fleet.Server.Persistence;
using Fleet.Server.Security;
using Fleet.Server.Transport;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Fleet.Server.Hosting;

public sealed class CliProxySyncService(IServiceScopeFactory scopes, CliProxyCatalog catalog,
    IOptions<FleetOptions> options, TimeProvider clock, ILogger<CliProxySyncService> logger) : BackgroundService
{
    public async Task<object> SyncNowAsync(bool force, CancellationToken ct)
    {
        string[] urls = [];
        if (options.Value.CliProxyApiKey.Length > 0)
        {
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<FleetDbContext>();
            urls = await (from assignment in db.Assignments.AsNoTracking()
                          join client in db.AssignmentAiClients on assignment.Id equals client.AssignmentId
                          join node in db.Nodes on assignment.NodeId equals node.Id
                          where assignment.IsCurrent && client.Mode == "cliproxy" && client.BaseUrl != null &&
                                node.WorkspaceId == options.Value.WorkspaceId && node.RevokedAt == null
                          select client.BaseUrl!).Distinct().ToArrayAsync(ct);
        }
        await catalog.SyncAsync(urls, force, ct);
        return catalog.Status();
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Check for newly assigned proxies promptly; each catalog has its own refresh deadline.
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(Math.Min(30, options.Value.CliProxySyncIntervalSeconds)), clock);
        do
        {
            try { await SyncNowAsync(false, stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception) { logger.LogWarning("CLIProxy synchronization failed; it will retry on the next check"); }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
