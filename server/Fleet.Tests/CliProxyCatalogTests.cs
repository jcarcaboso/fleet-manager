using System.Net;
using System.Text;
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
        var models = await catalog.GetAsync("https://proxy.example/v1", default);
        Assert.Equal(["low", "high"], Assert.Single(models!).ReasoningLevels);
        Assert.Same(models, await catalog.GetAsync("https://proxy.example/v1", default));
        Assert.Equal(1, handler.Calls);
        foreach (var body in new[] { "{\"models\":[]}", "invalid", new string('x', 4 * 1024 * 1024 + 1) })
        {
            handler.Body = body;
            clock.Now = clock.Now.AddMinutes(2);
            Assert.Same(models, await catalog.GetAsync("https://proxy.example/v1", default));
        }
        handler.Status = HttpStatusCode.Redirect;
        clock.Now = clock.Now.AddMinutes(2);
        Assert.Same(models, await catalog.GetAsync("https://proxy.example/v1", default));
        Assert.Null(await catalog.GetAsync("https://other.example/v1", default));
        Assert.Null(await catalog.GetAsync("http://proxy.example/v1", default));
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
