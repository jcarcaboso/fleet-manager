using System.Net;
using Fleet.Server.Persistence;
using Fleet.Server.Security;
using Fleet.Server.Transport;
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
