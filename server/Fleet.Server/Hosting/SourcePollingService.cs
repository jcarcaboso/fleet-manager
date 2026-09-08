using Fleet.Core.Coordination;
using Fleet.Server.Source;

namespace Fleet.Server.Hosting;

public sealed class RegisteredNodeSource(IServiceScopeFactory scopes) : IEnrolledNodeSource
{
    public async Task<IReadOnlySet<NodeId>> GetNodeIdsAsync(CancellationToken cancellationToken)
    {
        using var scope = scopes.CreateScope();
        var coordinator = scope.ServiceProvider.GetRequiredService<IFleetCoordinator>();
        HashSet<NodeId> ids = [];
        string? cursor = null;
        do
        {
            var page = await coordinator.GetNodesAsync(new(200, cursor), DateTimeOffset.UtcNow, TimeSpan.FromMinutes(5), cancellationToken);
            foreach (var node in page.Items) ids.Add(node.NodeId);
            cursor = page.NextCursor;
        } while (cursor is not null);
        return ids;
    }
}

public sealed class SourcePollingService(
    IServiceScopeFactory scopes,
    IConfiguration configuration,
    IEnrolledNodeSource nodes,
    FleetMetrics metrics,
    ILogger<SourcePollingService> logger) : BackgroundService
{
    private readonly SemaphoreSlim _scan = new(1, 1);
    private string? _lastObserved;

    public Task<object> ScanNowAsync(CancellationToken cancellationToken) => ScanNowAsync(null, cancellationToken);

    public async Task<object> ScanNowAsync(string? requestedBy = null, CancellationToken cancellationToken = default)
    {
        var remote = configuration["Source:Remote"];
        if (string.IsNullOrWhiteSpace(remote))
        {
            metrics.RecordSourceScan("disabled");
            return new { outcome = "disabled" };
        }
        if (!await _scan.WaitAsync(0, cancellationToken))
        {
            metrics.RecordSourceScan("busy");
            return new { outcome = "already_running" };
        }
        try
        {
            var defaults = new SourceLimits();
            var limits = defaults with
            {
                MaxMirrorBytes = configuration.GetValue("Source:MaxMirrorBytes", defaults.MaxMirrorBytes),
                MaxMirrorEntries = configuration.GetValue("Source:MaxMirrorEntries", defaults.MaxMirrorEntries),
                ScanTimeoutSeconds = configuration.GetValue("Source:ScanTimeoutSeconds", defaults.ScanTimeoutSeconds),
                GitCommandTimeoutSeconds = configuration.GetValue("Source:GitCommandTimeoutSeconds", defaults.GitCommandTimeoutSeconds),
            };
            var scanner = new GitSourceScanner(remote, configuration["Source:MirrorPath"] ?? ".local/source.git", nodes, limits);
            // Operator scans re-read the same commit because registry changes can make a
            // previously invalid Node reference valid without a new Git commit.
            var result = await scanner.ScanAsync(requestedBy is null ? _lastObserved : null, cancellationToken);
            using var scope = scopes.CreateScope();
            var coordinator = scope.ServiceProvider.GetRequiredService<IFleetCoordinator>();
            switch (result)
            {
                case SourceScanResult.Unchanged unchanged:
                    _lastObserved = unchanged.SourceRevision;
                    await coordinator.RecordSourceScanAsync(new RecordSourceScan(unchanged.SourceRevision,
                        SourceScanOutcome.Unchanged, null, null, DateTimeOffset.UtcNow, requestedBy), cancellationToken);
                    metrics.RecordSourceScan("unchanged");
                    return new { outcome = "unchanged", sourceRevision = unchanged.SourceRevision };
                case SourceScanResult.Invalid invalid:
                    // Only bounded validator diagnostics are returned; never log Git stderr or file bytes.
                    logger.LogWarning("Source scan rejected with {Count} diagnostics", invalid.Diagnostics.Count);
                    var first = invalid.Diagnostics.FirstOrDefault();
                    await coordinator.RecordSourceScanAsync(new RecordSourceScan(invalid.SourceRevision,
                        first?.Code == "git_source_failure" ? SourceScanOutcome.Failed : SourceScanOutcome.Invalid,
                        first?.Code, first?.Message, DateTimeOffset.UtcNow, requestedBy), cancellationToken);
                    metrics.RecordSourceScan(first?.Code == "git_source_failure" ? "failed" : "invalid");
                    return new { outcome = "invalid", sourceRevision = invalid.SourceRevision, diagnostics = invalid.Diagnostics };
                case SourceScanResult.Snapshot snapshot:
                    var publication = await coordinator.AcceptSourceSnapshotAsync(snapshot.Value, cancellationToken);
                    _lastObserved = snapshot.Value.SourceRevision;
                    if (requestedBy is not null)
                    {
                        try
                        {
                            await coordinator.RecordSourceScanAsync(new RecordSourceScan(snapshot.Value.SourceRevision,
                                publication.Outcome == PublicationOutcome.Accepted ? SourceScanOutcome.Accepted : SourceScanOutcome.Unchanged,
                                null, null, DateTimeOffset.UtcNow, requestedBy), cancellationToken);
                        }
                        catch (Exception) when (!cancellationToken.IsCancellationRequested)
                        {
                            logger.LogWarning("Accepted source scan actor could not be recorded");
                        }
                    }
                    logger.LogInformation("Source accepted with {Count} changed assignments", publication.ChangedAssignmentCount);
                    metrics.RecordSourceScan(publication.Outcome == PublicationOutcome.Accepted ? "accepted" : "unchanged");
                    return publication;
                default:
                    throw new InvalidOperationException("Unknown source scan result.");
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception)
        {
            metrics.RecordSourceScan("failed");
            logger.LogWarning("Source scan failed; current desired state is unchanged");
            try
            {
                using var scope = scopes.CreateScope();
                var coordinator = scope.ServiceProvider.GetRequiredService<IFleetCoordinator>();
                await coordinator.RecordSourceScanAsync(new RecordSourceScan(null, SourceScanOutcome.Failed,
                    "source_scan_failed", "Source scanning failed before validation completed.", DateTimeOffset.UtcNow, requestedBy), cancellationToken);
            }
            catch (Exception) when (!cancellationToken.IsCancellationRequested)
            {
                logger.LogWarning("Source scan failure could not be recorded");
            }
            return new { outcome = "failed" };
        }
        finally { _scan.Release(); }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var seconds = configuration.GetValue("Source:PollIntervalSeconds", 1800);
        if (seconds is < 10 or > 86400) throw new InvalidOperationException("Source polling interval must be between 10 and 86400 seconds.");
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(seconds));
        do
        {
            try { await ScanNowAsync(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception)
            {
                metrics.RecordSourceScan("failed");
                logger.LogWarning("Source scan failed; current desired state is unchanged");
                try
                {
                    using var scope = scopes.CreateScope();
                    var coordinator = scope.ServiceProvider.GetRequiredService<IFleetCoordinator>();
                    await coordinator.RecordSourceScanAsync(new RecordSourceScan(null, SourceScanOutcome.Failed,
                        "source_scan_failed", "Source scanning failed before validation completed.", DateTimeOffset.UtcNow), stoppingToken);
                }
                catch (Exception) when (!stoppingToken.IsCancellationRequested)
                {
                    logger.LogWarning("Source scan failure could not be recorded");
                }
            }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
