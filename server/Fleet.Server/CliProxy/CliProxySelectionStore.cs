using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Fleet.Core.Coordination;
using Fleet.Server.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Fleet.Server.CliProxy;

public sealed record CliProxySelectionPolicy(bool IncludeNew, string[] DisabledFamilies, Dictionary<string, bool> ModelOverrides,
    string[] EnabledFamilies, bool SkipClaudeModelsForOtherClients = true,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] Dictionary<string, string[]>? ClientRouting = null);
public sealed record CliProxySelectedCatalog(string BaseUrl, IReadOnlyList<CliProxyModel> Models,
    bool SkipClaudeModelsForOtherClients,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] Dictionary<string, string[]>? ClientRouting = null);
public sealed record CliProxySelectionModel(string Id, IReadOnlyList<string> ReasoningLevels, string FamilyKey,
    string FamilyLabel, bool Selected);

public sealed class CliProxySelectionStore(FleetDbContext database, CliProxyCatalog catalog)
{
    private static readonly CliProxySelectionPolicy DefaultPolicy = new(true, [], new(StringComparer.Ordinal), []);
    private const string InvalidSelection = "The selection is malformed or leaves no model selected.";
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly Regex GptFamily = new("^gpt-(\\d+)(?:\\.\\d+)?(?:-|$)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);
    private static readonly string[] AllClients = ["claude", "codex", "opencode"];
    private static readonly Dictionary<string, string[]> DefaultRouting = new(StringComparer.Ordinal)
    {
        ["claude"] = ["claude"],
        ["gpt"] = ["codex", "opencode"],
        ["other"] = ["opencode"]
    };

    public async Task<object> ListAsync(CancellationToken ct)
    {
        var rows = await database.CliProxySelections.AsNoTracking().ToDictionaryAsync(x => x.BaseUrl, ct);
        var result = new List<object>();
        foreach (var baseUrl in catalog.BaseUrls())
        {
            rows.TryGetValue(baseUrl, out var row);
            var policy = ReadPolicy(row?.PolicyJson);
            var models = await catalog.GetAsync(baseUrl, ct);
            if (models is null) continue;
            result.Add(new
            {
                baseUrl,
                models = models.Select(model => Describe(model, policy)).ToArray(),
                policy,
                version = row?.Version ?? 0
            });
        }
        return new { catalogs = result };
    }

    public async Task<(int Status, object Body)> SaveAsync(string baseUrl, long version,
        CliProxySelectionPolicy? policy, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(baseUrl) || baseUrl.Length > 2048 || policy is null || version < 0 ||
            policy.DisabledFamilies is null || policy.EnabledFamilies is null || policy.ModelOverrides is null ||
            policy.DisabledFamilies.Length > 500 || policy.EnabledFamilies.Length > 500 || policy.ModelOverrides.Count > 2000 ||
            policy.DisabledFamilies.Any(key => !ValidFamilyKey(key)) ||
            policy.EnabledFamilies.Any(key => !ValidFamilyKey(key)) ||
            policy.DisabledFamilies.Intersect(policy.EnabledFamilies, StringComparer.Ordinal).Any() ||
            policy.ModelOverrides.Any(pair => !CliProxyRules.IsValidModelId(pair.Key)) ||
            policy.ClientRouting?.Any(pair => !DefaultRouting.ContainsKey(pair.Key) ||
                pair.Value is not { Length: > 0 and <= 3 } ||
                pair.Value.Except(AllClients, StringComparer.Ordinal).Any() ||
                pair.Value.Distinct(StringComparer.Ordinal).Count() != pair.Value.Length) == true)
            return (400, new { code = "invalid_selection", message = InvalidSelection });

        var models = await catalog.GetAsync(baseUrl, ct);
        if (models is null) return (404, new { code = "catalog_unavailable", message = "No model catalog is available for that proxy yet." });
        // Older operators can still edit model selection without discarding explicit routing.
        var clientRouting = policy.ClientRouting ?? (version > 0 ? (await GetPolicyAsync(baseUrl, ct)).ClientRouting : null);
        var pinned = await database.AssignmentAiClients.AsNoTracking()
            .Join(database.Assignments.AsNoTracking().Where(x => x.IsCurrent), client => client.AssignmentId,
                assignment => assignment.Id, (client, assignment) => client)
            .Where(client => client.Mode == "cliproxy" && client.BaseUrl == baseUrl && client.Model != null)
            .Select(client => new { client.Client, Model = client.Model! }).Distinct().ToArrayAsync(ct);
        var familyKeys = models.Select(model => Family(model.Id)).Distinct(StringComparer.Ordinal).ToArray();
        var disabled = policy.DisabledFamilies.ToHashSet(StringComparer.Ordinal);
        var enabled = policy.EnabledFamilies.ToHashSet(StringComparer.Ordinal);
        // Families first seen at save time are frozen to the submitted default so later includeNew edits
        // cannot silently change a catalog family the operator already saw.
        foreach (var key in familyKeys)
            if (!disabled.Contains(key) && !enabled.Contains(key))
            {
                if (policy.IncludeNew) enabled.Add(key);
                else disabled.Add(key);
            }
        var savedPolicy = policy with
        {
            DisabledFamilies = disabled.Order(StringComparer.Ordinal).ToArray(),
            EnabledFamilies = enabled.Order(StringComparer.Ordinal).ToArray(),
            ClientRouting = clientRouting
        };
        var routing = ResolveRouting(savedPolicy);
        var described = models.Select(model => Describe(model, savedPolicy)).ToArray();
        var excluded = described.Where(model => !model.Selected).Select(model => model.Id).ToHashSet(StringComparer.Ordinal);
        var pinnedExcluded = pinned.Where(client =>
            excluded.Contains(client.Model) || !routing[RoutingGroup(client.Model)].Contains(client.Client, StringComparer.Ordinal))
            .Select(client => client.Model).Distinct().ToArray();
        if (pinnedExcluded.Length > 0) return (409, new { code = "pinned_model_excluded", message = "A model pinned in fleet.yml must stay selected and available to its assigned client.", models = pinnedExcluded });

        if (described.All(model => !model.Selected)) return (400, new { code = "invalid_selection", message = InvalidSelection });
        var json = JsonSerializer.Serialize(savedPolicy, JsonOptions);
        int affected;
        if (version == 0)
            affected = await database.Database.ExecuteSqlInterpolatedAsync($"""
                INSERT INTO cliproxy_selections ("BaseUrl", "PolicyJson", "Version")
                VALUES ({baseUrl}, {json}, 1) ON CONFLICT ("BaseUrl") DO NOTHING
                """, ct);
        else
            affected = await database.Database.ExecuteSqlInterpolatedAsync($"""
                UPDATE cliproxy_selections SET "PolicyJson" = {json}, "Version" = "Version" + 1
                WHERE "BaseUrl" = {baseUrl} AND "Version" = {version}
                """, ct);
        if (affected == 0) return (409, new { code = "stale_selection", message = "The selection changed since it was loaded. Reload it and try again." });
        var entry = new
        {
            baseUrl,
            models = described,
            policy = savedPolicy,
            version = version + 1
        };
        return (200, new { catalog = entry });
    }

    public async Task<IReadOnlyList<CliProxyModel>?> GetSelectedAsync(string baseUrl, CancellationToken ct) =>
        (await GetSelectedCatalogAsync(baseUrl, ct))?.Models;

    public async Task<CliProxySelectedCatalog?> GetSelectedCatalogAsync(string baseUrl, CancellationToken ct, bool includeRouting = false)
    {
        var models = await catalog.GetAsync(baseUrl, ct);
        if (models is null) return null;
        var policy = await GetPolicyAsync(baseUrl, ct);
        var selected = models.Where(model => Describe(model, policy).Selected).ToArray();
        var routing = ResolveRouting(policy);
        return selected.Length == 0 ? null : new(baseUrl, selected,
            routing["claude"].Length != AllClients.Length, includeRouting ? routing : null);
    }

    private async Task<CliProxySelectionPolicy> GetPolicyAsync(string baseUrl, CancellationToken ct) =>
        ReadPolicy(await database.CliProxySelections.AsNoTracking()
            .Where(x => x.BaseUrl == baseUrl).Select(x => x.PolicyJson).SingleOrDefaultAsync(ct));

    private static Dictionary<string, string[]> ResolveRouting(CliProxySelectionPolicy policy) =>
        DefaultRouting.ToDictionary(pair => pair.Key, pair =>
            policy.ClientRouting?.GetValueOrDefault(pair.Key) ??
            (pair.Key == "claude" && !policy.SkipClaudeModelsForOtherClients ? AllClients : pair.Value),
            StringComparer.Ordinal);

    // The Agent uses the same prefixes when applying the catalog's routes.
    private static string RoutingGroup(string model) =>
        model.StartsWith("claude-", StringComparison.OrdinalIgnoreCase) ? "claude" :
        model.StartsWith("gpt-", StringComparison.OrdinalIgnoreCase) ? "gpt" : "other";

    private static CliProxySelectionPolicy ReadPolicy(string? json)
    {
        var policy = json is null ? null : JsonSerializer.Deserialize<CliProxySelectionPolicy>(json, JsonOptions);
        return policy is null ? DefaultPolicy : policy with
        {
            DisabledFamilies = policy.DisabledFamilies ?? [],
            EnabledFamilies = policy.EnabledFamilies ?? [],
            ModelOverrides = policy.ModelOverrides ?? new(StringComparer.Ordinal)
        };
    }

    private static CliProxySelectionModel Describe(CliProxyModel model, CliProxySelectionPolicy policy)
    {
        var family = Family(model.Id);
        return new(model.Id, model.ReasoningLevels, family, FamilyLabel(family),
            IsSelected(new(model.Id, model.ReasoningLevels, family, family, false), policy));
    }

    private static bool IsSelected(CliProxySelectionModel model, CliProxySelectionPolicy policy) =>
        policy.ModelOverrides.TryGetValue(model.Id, out var selected) ? selected :
        policy.DisabledFamilies.Contains(model.FamilyKey, StringComparer.Ordinal) ? false :
        policy.EnabledFamilies.Contains(model.FamilyKey, StringComparer.Ordinal) || policy.IncludeNew;

    private static string Family(string id)
    {
        var match = GptFamily.Match(id);
        if (match.Success) return "gpt-" + match.Groups[1].Value;
        if (id.StartsWith("claude-", StringComparison.OrdinalIgnoreCase)) return "claude";
        if (id.StartsWith("gemini-", StringComparison.OrdinalIgnoreCase)) return "gemini";

        // Unknown providers still group deterministically by their first two ID segments (or whole ID).
        var segments = id.Split('-', StringSplitOptions.RemoveEmptyEntries);
        return string.Join('-', segments.Take(Math.Min(2, segments.Length))).ToLowerInvariant();
    }

    private static string FamilyLabel(string key) => key switch
    {
        "claude" => "Claude",
        "gemini" => "Gemini",
        _ when key.StartsWith("gpt-", StringComparison.Ordinal) => "GPT " + key[4..],
        _ => string.Join(' ', key.Split('-', StringSplitOptions.RemoveEmptyEntries)
            .Select(part => char.ToUpperInvariant(part[0]) + part[1..]))
    };

    private static bool ValidFamilyKey(string? key) => key is { Length: > 0 and <= 200 } &&
        CliProxyRules.IsValidModelId(key);
}
