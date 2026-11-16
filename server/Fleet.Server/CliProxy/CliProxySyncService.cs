using Fleet.Server.Persistence;
using Fleet.Server.Security;
using Fleet.Server.Source;
using Microsoft.Extensions.Options;

namespace Fleet.Server.CliProxy;

public sealed class CliProxySyncService(IServiceScopeFactory scopes, CliProxyCatalog catalog, SourcePollingService source,
    IOptions<FleetOptions> options, TimeProvider clock, ILogger<CliProxySyncService> logger) : BackgroundService
{
    public async Task<CliProxyStatus> SyncNowAsync(bool force, CancellationToken ct)
    {
        string[] urls = [];
        if (options.Value.CliProxyApiKey.Length > 0)
        {
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<FleetDbContext>();
            urls = await CliProxyCatalog.AssignedBaseUrlsAsync(db, options.Value.WorkspaceId, ct);
            // The source's proxy has a catalog before any Node uses it, so models can be selected first.
            if (source.CliProxyBaseUrl is { } declared) urls = [.. urls, declared];
        }
        await catalog.SyncAsync(urls, force, ct);
        return catalog.Status();
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Check for newly declared or assigned proxies promptly; each catalog has its own refresh deadline.
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(Math.Min(30, options.Value.CliProxySyncIntervalSeconds)), clock);
        do
        {
            try { await SyncNowAsync(false, stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception) { logger.LogWarning("CLIProxy synchronization failed; it will retry on the next check"); }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
