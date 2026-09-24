using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Text.Json;
using Fleet.Server.Security;
using Fleet.Server.Source;
using Microsoft.Extensions.Options;

namespace Fleet.Server.Transport;

public sealed record CliProxyModel(string Id, IReadOnlyList<string> ReasoningLevels);

public sealed class CliProxyCatalog(IHttpClientFactory clients, IOptions<FleetOptions> options, TimeProvider clock)
{
    private const int MaximumBytes = 4 * 1024 * 1024;
    private readonly SemaphoreSlim gate = new(1);
    private sealed record Entry(IReadOnlyList<CliProxyModel>? Models, DateTimeOffset? LastSuccess,
        DateTimeOffset NextRefresh, string Outcome, string? ErrorCode);
    private readonly ConcurrentDictionary<string, Entry> entries = new(StringComparer.Ordinal);

    // Agent reads never contact the upstream API or wait for an in-progress refresh.
    public Task<IReadOnlyList<CliProxyModel>?> GetAsync(string baseUrl, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        return Task.FromResult(options.Value.CliProxyApiKey.Length > 0 && entries.TryGetValue(baseUrl, out var entry)
            ? entry.Models : null);
    }

    public IReadOnlyList<string> BaseUrls() => entries.Keys.Order(StringComparer.Ordinal).ToArray();

    public object Status() => new
    {
        enabled = options.Value.CliProxyApiKey.Length > 0,
        intervalSeconds = options.Value.CliProxySyncIntervalSeconds,
        errorCode = options.Value.CliProxyApiKey.Length == 0 ? "credential_unavailable" : null,
        catalogs = entries.OrderBy(pair => pair.Key, StringComparer.Ordinal).Select(pair => new
        {
            baseUrl = pair.Key,
            modelCount = pair.Value.Models?.Count ?? 0,
            lastSuccess = pair.Value.LastSuccess,
            nextRefresh = pair.Value.NextRefresh,
            outcome = pair.Value.Outcome,
            errorCode = pair.Value.ErrorCode
        }).ToArray()
    };

    public async Task SyncAsync(IEnumerable<string> baseUrls, bool force, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            var active = options.Value.CliProxyApiKey.Length == 0 ? [] : baseUrls
                .Where(url => SourceTargetPublishers.TryNormalizeCliProxyBaseUrl(url, out var normalized) && normalized == url)
                .ToHashSet(StringComparer.Ordinal);
            foreach (var url in entries.Keys.Where(url => !active.Contains(url)))
                entries.TryRemove(url, out _);
            foreach (var baseUrl in active)
            {
                entries.TryGetValue(baseUrl, out var previous);
                if (!force && previous is not null && clock.GetUtcNow() < previous.NextRefresh) continue;
                var next = new Entry(previous?.Models, previous?.LastSuccess, clock.GetUtcNow().AddMinutes(1), "failed", null);
                try
                {
                    // CLIProxy's Codex response includes effort metadata omitted from the ordinary list.
                    using var request = new HttpRequestMessage(HttpMethod.Get, baseUrl + "/models?client_version=0.154.0");
                    request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", options.Value.CliProxyApiKey);
                    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                    timeout.CancelAfter(TimeSpan.FromSeconds(15));
                    using var response = await clients.CreateClient("cliproxy").SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
                    response.EnsureSuccessStatusCode();
                    if (response.Content.Headers.ContentLength > MaximumBytes) throw new InvalidDataException("Oversized CLIProxy catalog.");
                    await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
                    using var bytes = new MemoryStream();
                    var buffer = new byte[8192];
                    int count;
                    while ((count = await stream.ReadAsync(buffer, timeout.Token)) != 0)
                    {
                        if (bytes.Length + count > MaximumBytes) throw new InvalidDataException("Oversized CLIProxy catalog.");
                        bytes.Write(buffer, 0, count);
                    }
                    next = new Entry(Parse(bytes.ToArray()), clock.GetUtcNow(),
                        clock.GetUtcNow().AddSeconds(options.Value.CliProxySyncIntervalSeconds), "succeeded", null);
                }
                catch (Exception error) when (error is HttpRequestException or JsonException or IOException or InvalidDataException ||
                                             error is OperationCanceledException && !ct.IsCancellationRequested)
                {
                    // Keep the last valid catalog during an upstream outage; never expose credentials or bodies.
                    next = next with
                    {
                        ErrorCode = error switch
                        {
                            HttpRequestException { StatusCode: { } status } => $"upstream_http_{(int)status}",
                            HttpRequestException => "upstream_unreachable",
                            OperationCanceledException => "upstream_timeout",
                            JsonException or InvalidDataException => "invalid_catalog",
                            _ => "upstream_read_failed"
                        }
                    };
                }
                entries[baseUrl] = next;
            }
        }
        finally { gate.Release(); }
    }

    public static IReadOnlyList<CliProxyModel> Parse(byte[] bytes)
    {
        using var document = JsonDocument.Parse(bytes);
        var root = document.RootElement;
        if (root.ValueKind == JsonValueKind.Object)
        {
            if (!root.TryGetProperty("data", out var items) && !root.TryGetProperty("models", out items))
                throw new InvalidDataException("Unsupported CLIProxy catalog.");
            root = items;
        }
        var models = new List<CliProxyModel>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        void Add(string? id, JsonElement item)
        {
            if (id is null || !SourceTargetPublishers.IsValidModelId(id) || !seen.Add(id)) return;
            var efforts = new List<string>();
            if (item.ValueKind == JsonValueKind.Object)
            {
                JsonElement levels = default;
                if (!item.TryGetProperty("supported_reasoning_levels", out levels) &&
                    item.TryGetProperty("thinking", out var thinking) && thinking.ValueKind == JsonValueKind.Object)
                    thinking.TryGetProperty("levels", out levels);
                if (levels.ValueKind == JsonValueKind.Array)
                    foreach (var level in levels.EnumerateArray())
                    {
                        var effort = level.ValueKind == JsonValueKind.String ? level.GetString() :
                            level.ValueKind == JsonValueKind.Object && level.TryGetProperty("effort", out var value) &&
                            value.ValueKind == JsonValueKind.String ? value.GetString() : null;
                        if (effort is "none" or "minimal" or "low" or "medium" or "high" or "xhigh" or "max" or "ultra" && !efforts.Contains(effort))
                            efforts.Add(effort);
                    }
            }
            models.Add(new(id, efforts));
        }
        if (root.ValueKind == JsonValueKind.Object)
            foreach (var property in root.EnumerateObject().OrderBy(property => property.Name, StringComparer.Ordinal))
                Add(property.Name, property.Value);
        else if (root.ValueKind == JsonValueKind.Array)
            foreach (var item in root.EnumerateArray())
            {
                string? id = item.ValueKind == JsonValueKind.String ? item.GetString() : null;
                if (item.ValueKind == JsonValueKind.Object)
                    foreach (var field in new[] { "id", "slug", "name", "model", "value" })
                        if (item.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.String)
                        { id = value.GetString(); break; }
                Add(id, item);
            }
        else throw new InvalidDataException("Unsupported CLIProxy catalog.");
        if (models.Count == 0) throw new InvalidDataException("Empty CLIProxy catalog.");
        return models;
    }
}
