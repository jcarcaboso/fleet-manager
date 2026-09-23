using System.Net;
using System.Text;
using System.Text.Json;
using Fleet.Server.Security;
using Fleet.Server.Transport;
using Microsoft.Extensions.Options;

namespace Fleet.Tests;

public sealed class CliProxyCatalogTests
{
    [Theory]
    [InlineData("{\"data\":[{\"id\":\"one\"},{\"id\":\"ONE\"},{\"id\":\"two\"}]}")]
    [InlineData("{\"models\":{\"one\":{},\"two\":{}}}")]
    [InlineData("[\"one\",\"two\"]")]
    public void Parses_legacy_shapes(string json) =>
        Assert.Equal(["one", "two"], CliProxyCatalog.Parse(Encoding.UTF8.GetBytes(json)).Select(model => model.Id));

    [Fact]
    public async Task Discovers_efforts_once_and_keeps_valid_catalog_on_failure()
    {
        var handler = new Handler();
        var clock = new Clock();
        var catalog = new CliProxyCatalog(handler, Options.Create(new FleetOptions { CliProxyApiKey = "secret" }), clock);
        Assert.Null(await catalog.GetAsync("https://proxy.example/v1", default));
        Assert.Equal(0, handler.Calls);
        await catalog.SyncAsync(["https://proxy.example/v1"], false, default);
        var models = await catalog.GetAsync("https://proxy.example/v1", default);
        Assert.Equal(["low", "high"], Assert.Single(models!).ReasoningLevels);
        Assert.Same(models, await catalog.GetAsync("https://proxy.example/v1", default));
        Assert.Equal(1, handler.Calls);
        clock.Now = clock.Now.AddDays(6);
        await catalog.SyncAsync(["https://proxy.example/v1"], false, default);
        Assert.Equal(1, handler.Calls);
        foreach (var body in new[] { "{\"models\":[]}", "invalid", new string('x', 4 * 1024 * 1024 + 1) })
        {
            handler.Body = body;
            clock.Now = clock.Now.AddDays(8);
            await catalog.SyncAsync(["https://proxy.example/v1"], false, default);
            Assert.Same(models, await catalog.GetAsync("https://proxy.example/v1", default));
            var calls = handler.Calls;
            await catalog.SyncAsync(["https://proxy.example/v1"], false, default);
            Assert.Equal(calls, handler.Calls);
            var status = JsonSerializer.SerializeToElement(catalog.Status());
            Assert.Equal("invalid_catalog", status.GetProperty("catalogs")[0].GetProperty("errorCode").GetString());
        }
        handler.Status = HttpStatusCode.Redirect;
        clock.Now = clock.Now.AddMinutes(2);
        await catalog.SyncAsync(["https://proxy.example/v1"], false, default);
        Assert.Same(models, await catalog.GetAsync("https://proxy.example/v1", default));
        Assert.Null(await catalog.GetAsync("https://other.example/v1", default));
        Assert.Null(await catalog.GetAsync("http://proxy.example/v1", default));
    }

    [Fact]
    public async Task Refreshes_on_schedule_without_agent_requests_and_manual_refresh_bypasses_deadline()
    {
        var handler = new Handler();
        var clock = new Clock();
        var settings = new FleetOptions { CliProxyApiKey = "secret", CliProxySyncIntervalSeconds = 120 };
        var catalog = new CliProxyCatalog(handler, Options.Create(settings), clock);
        string[] urls = ["https://proxy.example/v1", "https://proxy.example/v1"];
        await catalog.SyncAsync(urls, false, default);
        handler.Body = """{"data":[{"id":"two","thinking":{"levels":["medium","high"]}}]}""";
        clock.Now = clock.Now.AddSeconds(119);
        await catalog.SyncAsync(urls, false, default);
        Assert.Equal(1, handler.Calls);
        Assert.Equal("one", Assert.Single((await catalog.GetAsync(urls[0], default))!).Id);
        clock.Now = clock.Now.AddSeconds(1);
        await catalog.SyncAsync(urls, false, default);
        Assert.Equal(2, handler.Calls);
        Assert.Equal("two", Assert.Single((await catalog.GetAsync(urls[0], default))!).Id);
        handler.Body = """{"data":[{"id":"three"}]}""";
        await catalog.SyncAsync(urls, true, default);
        Assert.Equal("three", Assert.Single((await catalog.GetAsync(urls[0], default))!).Id);
        await catalog.SyncAsync([], false, default);
        Assert.Null(await catalog.GetAsync(urls[0], default));
        settings.CliProxyApiKey = "";
        await catalog.SyncAsync(urls, true, default);
        Assert.Equal(3, handler.Calls);
        settings.CliProxyApiKey = "secret";
        await catalog.SyncAsync(["http://proxy.example/v1", "https://proxy.example/v1/"], true, default);
        Assert.Equal(3, handler.Calls);
    }

    private sealed class Clock : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = DateTimeOffset.UtcNow;
        public override DateTimeOffset GetUtcNow() => Now;
    }

    internal sealed class Handler : HttpMessageHandler, IHttpClientFactory
    {
        public int Calls { get; private set; }
        public string Body { get; set; } = """{"models":[{"slug":"one","supported_reasoning_levels":[{"effort":"low"},{"effort":"high"},{"effort":"high"},{"effort":"invented"}]}]}""";
        public HttpStatusCode Status { get; set; } = HttpStatusCode.OK;
        public HttpClient CreateClient(string name) => new(this, false);
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls++;
            Assert.Equal("/v1/models?client_version=0.154.0", request.RequestUri!.PathAndQuery);
            Assert.Equal("Bearer", request.Headers.Authorization!.Scheme);
            return Task.FromResult(new HttpResponseMessage(Status) { Content = new StringContent(Body) });
        }
    }
}
