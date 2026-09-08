using System.Collections.Concurrent;
using System.Diagnostics.Metrics;

namespace Fleet.Server.Hosting;

public sealed class FleetMetrics : IDisposable
{
    private readonly Meter _meter = new("Fleet.Server", "0.1.0");
    private readonly Counter<long> _requests;
    private readonly Histogram<double> _requestDuration;
    private readonly Histogram<double> _databaseDuration;
    private readonly Counter<long> _bundleBytes;
    private readonly Counter<long> _cleanup;
    private readonly Counter<long> _sourceScans;
    private readonly ConcurrentDictionary<string, long> _counts = new(StringComparer.Ordinal);

    public FleetMetrics()
    {
        _requests = _meter.CreateCounter<long>("fleet.http.requests");
        _requestDuration = _meter.CreateHistogram<double>("fleet.http.duration", "s");
        _databaseDuration = _meter.CreateHistogram<double>("fleet.database.duration", "s");
        _bundleBytes = _meter.CreateCounter<long>("fleet.bundle.response_bytes", "By");
        _cleanup = _meter.CreateCounter<long>("fleet.maintenance.records");
        _sourceScans = _meter.CreateCounter<long>("fleet.source.scans");
    }

    public void RecordRequest(string operation, int status, double seconds, long bytes)
    {
        var result = status is 401 or 403 ? "unauthorized" : status == 429 ? "limited" : status >= 500 ? "server_error" : status >= 400 ? "invalid" : "ok";
        _counts.AddOrUpdate(operation + "." + result, 1, (_, count) => count + 1);
        _requests.Add(1, new("operation", operation), new("outcome", result));
        _requestDuration.Record(seconds, new KeyValuePair<string, object?>("operation", operation));
        if (operation == "bundle" && status == 200) _bundleBytes.Add(bytes);
    }

    public void RecordDatabase(TimeSpan elapsed, bool failed) =>
        _databaseDuration.Record(elapsed.TotalSeconds, new KeyValuePair<string, object?>("outcome", failed ? "failed" : "ok"));

    public void RecordSourceScan(string outcome)
    {
        var safe = outcome is "accepted" or "unchanged" or "invalid" or "failed" or "busy" or "disabled" ? outcome : "failed";
        _sourceScans.Add(1, new KeyValuePair<string, object?>("outcome", safe));
        _counts.AddOrUpdate("source." + safe, 1, (_, count) => count + 1);
    }

    public void RecordMaintenance(int enrollment, int audit, int scans)
    {
        _cleanup.Add(enrollment, new KeyValuePair<string, object?>("record", "enrollment_delivery"));
        _cleanup.Add(audit, new KeyValuePair<string, object?>("record", "audit"));
        _cleanup.Add(scans, new KeyValuePair<string, object?>("record", "source_scan"));
    }

    public IReadOnlyDictionary<string, long> Snapshot() => new SortedDictionary<string, long>(_counts, StringComparer.Ordinal);
    public void Dispose() => _meter.Dispose();
}
