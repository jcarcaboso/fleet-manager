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
    private string? cachedBaseUrl;
    private IReadOnlyList<CliProxyModel>? cached;
    private DateTimeOffset refreshAfter;

    public async Task<IReadOnlyList<CliProxyModel>?> GetAsync(string baseUrl, CancellationToken ct)
    {
        if (!SourceTargetPublishers.TryNormalizeCliProxyBaseUrl(baseUrl, out var normalized) || normalized != baseUrl)
            return null;
        await gate.WaitAsync(ct);
        try
        {
            if (cachedBaseUrl != baseUrl)
            {
                cachedBaseUrl = baseUrl;
                cached = null;
                refreshAfter = DateTimeOffset.MinValue;
            }
            if (options.Value.CliProxyApiKey.Length == 0) return null;
            if (clock.GetUtcNow() < refreshAfter) return cached;
            refreshAfter = clock.GetUtcNow().AddMinutes(1);
            try
            {
                // CLIProxy's Codex response includes effort metadata omitted from the ordinary list.
                using var request = new HttpRequestMessage(HttpMethod.Get, baseUrl + "/models?client_version=0.154.0");
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", options.Value.CliProxyApiKey);
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(TimeSpan.FromSeconds(15));
                using var response = await clients.CreateClient("cliproxy").SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
                response.EnsureSuccessStatusCode();
                if (response.Content.Headers.ContentLength > MaximumBytes) return cached;
                await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
                using var bytes = new MemoryStream();
                var buffer = new byte[8192];
                int count;
                while ((count = await stream.ReadAsync(buffer, timeout.Token)) != 0)
                {
                    if (bytes.Length + count > MaximumBytes) return cached;
                    bytes.Write(buffer, 0, count);
                }
                cached = Parse(bytes.ToArray());
            }
            catch (Exception error) when (error is HttpRequestException or JsonException or IOException or InvalidDataException ||
                                         error is OperationCanceledException && !ct.IsCancellationRequested)
            {
                // Keep the last valid catalog during an upstream outage; never log credentials or bodies.
            }
            return cached;
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
