using System.Collections.Concurrent;
using System.Threading.RateLimiting;
using Fleet.Server.Transport;

namespace Fleet.Tests;

/// <summary>
/// Keeps the production limiter for ordinary requests. Burst tests opt individual Nodes into a bucket with no automatic
/// replenishment, so database or CI scheduling delays cannot add permits between assertions about shared route limits.
/// </summary>
public sealed class TestNodeRateLimit : PartitionedRateLimiter<Guid>
{
    private readonly PartitionedRateLimiter<Guid> normal = NodeRequestRateLimit.Create().Limiter;
    private readonly ConcurrentDictionary<Guid, TokenBucketRateLimiter> frozen = new();

    public void Freeze(Guid nodeId)
    {
        var bucket = new TokenBucketRateLimiter(new TokenBucketRateLimiterOptions
        {
            TokenLimit = NodeRequestRateLimit.Burst,
            TokensPerPeriod = 1,
            ReplenishmentPeriod = NodeRequestRateLimit.RefillEvery,
            AutoReplenishment = false,
            QueueLimit = 0
        });
        if (!frozen.TryAdd(nodeId, bucket)) bucket.Dispose();
    }

    public override RateLimiterStatistics? GetStatistics(Guid resource) =>
        frozen.TryGetValue(resource, out var bucket) ? bucket.GetStatistics() : normal.GetStatistics(resource);

    protected override RateLimitLease AttemptAcquireCore(Guid resource, int permitCount) =>
        frozen.TryGetValue(resource, out var bucket) ? bucket.AttemptAcquire(permitCount) : normal.AttemptAcquire(resource, permitCount);

    protected override ValueTask<RateLimitLease> AcquireAsyncCore(Guid resource, int permitCount, CancellationToken cancellationToken) =>
        frozen.TryGetValue(resource, out var bucket)
            ? bucket.AcquireAsync(permitCount, cancellationToken)
            : normal.AcquireAsync(resource, permitCount, cancellationToken);

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            normal.Dispose();
            foreach (var bucket in frozen.Values) bucket.Dispose();
        }
        base.Dispose(disposing);
    }
}
