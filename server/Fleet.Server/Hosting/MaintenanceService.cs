using System.ComponentModel.DataAnnotations;
using Fleet.Core.Coordination;
using Microsoft.Extensions.Options;

namespace Fleet.Server.Hosting;

public sealed class MaintenanceOptions
{
    [Range(10, 86400)] public int IntervalSeconds { get; set; } = 300;
    [Range(1, 1000)] public int BatchSize { get; set; } = 500;
    [Range(1, 36500)] public int? AuditRetentionDays { get; set; }
    [Range(1, 36500)] public int? SourceScanRetentionDays { get; set; }
}

public sealed class MaintenanceService(IServiceScopeFactory scopes, IOptions<MaintenanceOptions> options,
    FleetMetrics metrics, ILogger<MaintenanceService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var settings = options.Value;
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(settings.IntervalSeconds));
        // The first run is delayed so a new installation can apply migrations before cleanup.
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                using var scope = scopes.CreateScope();
                var result = await scope.ServiceProvider.GetRequiredService<IFleetCoordinator>().MaintainPersistenceAsync(new(
                    settings.AuditRetentionDays is int audit ? TimeSpan.FromDays(audit) : null,
                    settings.SourceScanRetentionDays is int scans ? TimeSpan.FromDays(scans) : null, settings.BatchSize), stoppingToken);
                metrics.RecordMaintenance(result.EnrollmentPayloadsScrubbed, result.AuditEventsDeleted, result.SourceScansDeleted);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception) { logger.LogWarning("Persistence maintenance failed; it will retry on the next interval"); }
        }
    }
}
