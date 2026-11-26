using System.Net;
using Fleet.Server.CliProxy;
using Fleet.Server.Persistence;
using Fleet.Server.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Testcontainers.PostgreSql;

namespace Fleet.Tests;

public sealed class CliProxySelectionTests : IAsyncLifetime
{
    private readonly PostgreSqlContainer postgres = new PostgreSqlBuilder("postgres:17.5-alpine").Build();
    private readonly CliProxyCatalogTests.Handler upstream = new();
    private const string BaseUrl = "https://proxy.example/v1";

    public async Task InitializeAsync()
    {
        await postgres.StartAsync();
        await using var db = Database();
        await db.Database.MigrateAsync();
    }

    public async Task DisposeAsync() => await postgres.DisposeAsync();

    [Fact]
    public async Task Policy_persists_and_tracks_new_and_removed_catalog_models()
    {
        upstream.Body = """{"data":[{"id":"gpt-6-codex"},{"id":"claude-opus-4-1"}]}""";
        var catalog = NewCatalog();
        await catalog.SyncAsync([BaseUrl], true, default);
        await using (var db = Database())
        {
            var store = new CliProxySelectionStore(db, catalog);
            var policy = new CliProxySelectionPolicy(true, ["gpt-6"], new(StringComparer.Ordinal)
            {
                ["gpt-6-codex"] = false,
                ["claude-opus-4-2"] = false
            }, []);
            var (status, _) = await store.SaveAsync(BaseUrl, 0, policy, default);
            Assert.Equal(200, status);
        }

        // A fresh store models a server restart; a fresh upstream response models a dynamic catalog refresh.
        upstream.Body = """{"data":[{"id":"gpt-6-pro"},{"id":"claude-opus-4-2"},{"id":"claude-opus-4-3"},{"id":"claude-opus-4-1"}]}""";
        await catalog.SyncAsync([BaseUrl], true, default);
        await using (var db = Database())
        {
            var store = new CliProxySelectionStore(db, catalog);
            var selected = await store.GetSelectedAsync(BaseUrl, default);
            Assert.Equal(["claude-opus-4-1", "claude-opus-4-3"], selected!.Select(model => model.Id).Order(StringComparer.Ordinal));
            var catalogEntry = await store.ListAsync(default);
            var entry = Assert.Single((IEnumerable<object>)catalogEntry.GetType().GetProperty("catalogs")!.GetValue(catalogEntry)!);
            var version = (long)entry.GetType().GetProperty("version")!.GetValue(entry)!;
            Assert.Equal(1, version);
        }

        // A removed model cannot leak from an older dashboard or agent list.
        upstream.Body = """{"data":[{"id":"gpt-6-pro"},{"id":"claude-opus-4-2"}]}""";
        await catalog.SyncAsync([BaseUrl], true, default);
        await using (var db = Database())
        {
            var selected = await new CliProxySelectionStore(db, catalog).GetSelectedAsync(BaseUrl, default);
            Assert.Null(selected);
        }
    }

    [Fact]
    public async Task Claude_restriction_defaults_on_and_persists_when_disabled()
    {
        upstream.Body = """{"data":[{"id":"gpt-6-codex"},{"id":"claude-opus-4-1"}]}""";
        var catalog = NewCatalog();
        await catalog.SyncAsync([BaseUrl], true, default);
        await using (var db = Database())
        {
            var store = new CliProxySelectionStore(db, catalog);
            Assert.True((await store.GetSelectedCatalogAsync(BaseUrl, default))!.SkipClaudeModelsForOtherClients);
            // Existing policies without the new field also default to skipping Claude for other clients.
            db.CliProxySelections.Add(new()
            {
                BaseUrl = BaseUrl,
                Version = 1,
                PolicyJson = """{"includeNew":true,"disabledFamilies":[],"enabledFamilies":[],"modelOverrides":{}}"""
            });
            await db.SaveChangesAsync();
            Assert.True((await store.GetSelectedCatalogAsync(BaseUrl, default))!.SkipClaudeModelsForOtherClients);
            var policy = new CliProxySelectionPolicy(true, [], new(StringComparer.Ordinal), [],
                SkipClaudeModelsForOtherClients: false);
            Assert.Equal(200, (await store.SaveAsync(BaseUrl, 1, policy, default)).Status);
        }
        await using (var db = Database())
        {
            var selected = await new CliProxySelectionStore(db, catalog).GetSelectedCatalogAsync(BaseUrl, default);
            Assert.False(selected!.SkipClaudeModelsForOtherClients);
            Assert.Equal(2, selected.Models.Count);
        }
    }

    [Fact]
    public async Task Routing_overrides_survive_a_legacy_operator_write_and_can_be_reset()
    {
        upstream.Body = """{"data":[{"id":"gpt-one"},{"id":"claude-one"},{"id":"gemini-one"}]}""";
        var catalog = NewCatalog();
        await catalog.SyncAsync([BaseUrl], true, default);
        await using var db = Database();
        var store = new CliProxySelectionStore(db, catalog);
        var legacy = new CliProxySelectionPolicy(true, [], new(StringComparer.Ordinal), [], SkipClaudeModelsForOtherClients: false);

        foreach (var invalid in new Dictionary<string, string[]>[]
        {
            new() { ["unknown-group"] = ["codex"] },
            new() { ["gpt"] = ["unknown"] },
            new() { ["other"] = [] },
            new() { ["other"] = ["codex", "codex"] }
        })
            Assert.Equal(400, (await store.SaveAsync(BaseUrl, 0, legacy with { ClientRouting = invalid }, default)).Status);

        Assert.Equal(200, (await store.SaveAsync(BaseUrl, 0, legacy with
        {
            ClientRouting = new() { ["claude"] = ["claude", "opencode"], ["other"] = ["claude", "opencode"] }
        }, default)).Status);
        Assert.Equal(200, (await store.SaveAsync(BaseUrl, 1, legacy, default)).Status);
        var selected = (await store.GetSelectedCatalogAsync(BaseUrl, default, includeRouting: true))!;
        Assert.Equal(["claude", "opencode"], selected.ClientRouting!["claude"]);
        Assert.Equal(["claude", "opencode"], selected.ClientRouting!["other"]);
        Assert.True(selected.SkipClaudeModelsForOtherClients);

        Assert.Equal(200, (await store.SaveAsync(BaseUrl, 2, legacy with { ClientRouting = new() }, default)).Status);
        selected = (await store.GetSelectedCatalogAsync(BaseUrl, default, includeRouting: true))!;
        Assert.Equal(["claude", "codex", "opencode"], selected.ClientRouting!["claude"]);
        Assert.Equal(["opencode"], selected.ClientRouting!["other"]);
    }

    [Fact]
    public async Task Gemini_models_route_only_to_antigravity_and_legacy_agents_get_a_three_key_catalog()
    {
        upstream.Body = """{"data":[{"id":"claude-one"},{"id":"gpt-one"},{"id":"gemini-one"},{"id":"misc-one"}]}""";
        var catalog = NewCatalog();
        await catalog.SyncAsync([BaseUrl], true, default);
        await using var db = Database();
        var store = new CliProxySelectionStore(db, catalog);
        Assert.Equal(200, (await store.SaveAsync(BaseUrl, 0,
            new CliProxySelectionPolicy(true, [], new(StringComparer.Ordinal), []), default)).Status);

        // An Agent that announced the antigravity capability gets all four groups, with Gemini split out.
        var modern = (await store.GetSelectedCatalogAsync(BaseUrl, default, includeRouting: true, antigravity: true))!;
        Assert.Equal(4, modern.ClientRouting!.Count);
        Assert.Equal(["claude"], modern.ClientRouting!["claude"]);
        Assert.Equal(["codex", "opencode"], modern.ClientRouting!["gpt"]);
        Assert.Equal(["antigravity"], modern.ClientRouting!["gemini"]);
        Assert.Equal(["opencode"], modern.ClientRouting!["other"]);

        // A legacy Agent keeps the three-key catalog: no gemini group and never antigravity.
        var legacy = (await store.GetSelectedCatalogAsync(BaseUrl, default, includeRouting: true))!;
        Assert.Equal(3, legacy.ClientRouting!.Count);
        Assert.False(legacy.ClientRouting!.ContainsKey("gemini"));
        Assert.Equal(["claude"], legacy.ClientRouting!["claude"]);
        Assert.Equal(["codex", "opencode"], legacy.ClientRouting!["gpt"]);
        Assert.Equal(["opencode"], legacy.ClientRouting!["other"]);
        Assert.DoesNotContain(legacy.ClientRouting!, pair => pair.Value.Contains("antigravity"));
    }

    [Fact]
    public async Task Stale_writes_and_zero_selection_are_rejected()
    {
        upstream.Body = """{"data":[{"id":"gpt-6-codex"},{"id":"claude-opus-4-1"}]}""";
        var catalog = NewCatalog();
        await catalog.SyncAsync([BaseUrl], true, default);
        await using var db = Database();
        var store = new CliProxySelectionStore(db, catalog);
        var allOff = new CliProxySelectionPolicy(false, [], new(StringComparer.Ordinal)
        {
            ["gpt-6-codex"] = false,
            ["claude-opus-4-1"] = false
        }, []);
        Assert.Equal(400, (await store.SaveAsync(BaseUrl, 0, allOff, default)).Status);
        var keepOne = allOff with { ModelOverrides = new(StringComparer.Ordinal) { ["claude-opus-4-1"] = true } };
        Assert.Equal(200, (await store.SaveAsync(BaseUrl, 0, keepOne, default)).Status);
        Assert.Equal(409, (await store.SaveAsync(BaseUrl, 0, keepOne, default)).Status);
    }

    [Fact]
    public async Task Dashboard_catalog_list_skips_upstream_catalogs_that_have_not_loaded()
    {
        var catalog = NewCatalog();
        upstream.Status = HttpStatusCode.ServiceUnavailable;
        await catalog.SyncAsync([BaseUrl], true, default);
        await using var db = Database();
        var result = await new CliProxySelectionStore(db, catalog).ListAsync(default);
        var catalogs = (IEnumerable<object>)result.GetType().GetProperty("catalogs")!.GetValue(result)!;
        Assert.Empty(catalogs);
    }

    private FleetDbContext Database() => new(new DbContextOptionsBuilder<FleetDbContext>()
        .UseNpgsql(postgres.GetConnectionString()).Options);

    private CliProxyCatalog NewCatalog() => new(upstream,
        Options.Create(new FleetOptions { CliProxyApiKey = "test" }), TimeProvider.System);
}
