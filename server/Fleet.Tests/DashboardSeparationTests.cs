using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Fleet.Server.Security;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace Fleet.Tests;

/// <summary>The dashboard is a separate application. These tests cover what the Server still owes it: redirects, CORS and Origin checks.</summary>
public sealed class DashboardSeparationTests(OperatorApiFixture fixture) : IClassFixture<OperatorApiFixture>
{
    private const string Dashboard = OperatorApiFixture.DashboardOrigin;

    [Theory]
    [InlineData("", true)]
    [InlineData("https://fleet.home.arpa", true)]
    [InlineData("https://fleet.home.arpa:7444", true)]
    [InlineData("https://fleet.home.arpa:7444/", true)]
    [InlineData("HTTPS://Fleet.Home.Arpa:7444", true)]
    [InlineData("http://fleet.home.arpa:7444", false)]
    [InlineData("fleet.home.arpa:7444", false)]
    [InlineData("https://fleet.home.arpa:7444/dashboard", false)]
    [InlineData("https://user:secret@fleet.home.arpa:7444", false)]
    [InlineData("https://fleet.home.arpa:7444?x=1", false)]
    [InlineData("https://fleet.home.arpa:7444/?", false)]
    [InlineData("https://fleet.home.arpa:7444#fragment", false)]
    [InlineData("https://fleet.home.arpa:7444/#", false)]
    [InlineData("https://", false)]
    [InlineData("*", false)]
    public void Dashboard_origin_follows_the_public_URL_rules(string value, bool valid) =>
        Assert.Equal(valid, new FleetOptions { DashboardOrigin = value }.HasValidDashboardOrigin());

    [Fact]
    public void Dashboard_origin_is_limited_to_200_characters()
    {
        var atLimit = "https://" + new string('a', 200 - "https://".Length - ".example".Length) + ".example";
        Assert.Equal(200, atLimit.Length);
        Assert.True(new FleetOptions { DashboardOrigin = atLimit }.HasValidDashboardOrigin());
        Assert.False(new FleetOptions { DashboardOrigin = atLimit + "x" }.HasValidDashboardOrigin());
    }

    [Theory]
    [InlineData("http://localhost:7444")]
    [InlineData("https://localhost:7444/dashboard")]
    [InlineData("https://user@localhost:7444")]
    public void An_invalid_dashboard_origin_fails_Server_startup_validation(string value)
    {
        using var factory = Factory(new() { ["Fleet:DashboardOrigin"] = value });
        var error = Assert.ThrowsAny<Exception>(() => factory.CreateClient());
        Assert.Contains("DashboardOrigin", error.ToString());
    }

    [Theory]
    [InlineData("/")]
    [InlineData("/dashboard")]
    [InlineData("/dashboard/")]
    [InlineData("/dashboard/anything")]
    [InlineData("/dashboard/machines/studio-mini/security")]
    [InlineData("/DASHBOARD/Anything")]
    [InlineData("/dashboard/app.js")]
    [InlineData("/dashboard/style.css")]
    [InlineData("/dashboard/enroll.js")]
    [InlineData("/dashboard/index.html")]
    [InlineData("/dashboard/apis")]
    [InlineData("/dashboard/apix/y")]
    public async Task Old_dashboard_addresses_redirect_to_the_dashboard_origin_and_serve_no_assets(string path)
    {
        using var client = Client(fixture.Factory);
        var response = await client.GetAsync(path);
        Assert.Equal(HttpStatusCode.Found, response.StatusCode);
        Assert.Equal(Dashboard, response.Headers.Location!.OriginalString);
    }

    [Fact]
    public async Task Without_a_dashboard_origin_the_old_addresses_are_404_and_the_dashboard_API_is_not_mapped()
    {
        using var factory = Factory(new() { ["Fleet:DashboardOrigin"] = "" });
        using var client = Client(factory);
        foreach (var path in new[] { "/", "/dashboard", "/dashboard/", "/dashboard/anything", "/dashboard/app.js" })
        {
            var response = await client.GetAsync(path);
            var body = await OperatorApiFixture.ReadAsync(response, HttpStatusCode.NotFound);
            Assert.Equal("dashboard_not_configured", body["code"]!.GetValue<string>());
            Assert.False(string.IsNullOrWhiteSpace(body["message"]!.GetValue<string>()));
            Assert.Null(response.Headers.Location);
        }
        foreach (var path in new[] { "/dashboard/api/csrf", "/dashboard/api/nodes", "/dashboard/api/session", "/dashboard/api" })
            Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(path)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsJsonAsync("/dashboard/api/login", new { token = OperatorApiFixture.AdminToken })).StatusCode);
        using var preflight = new HttpRequestMessage(HttpMethod.Options, "/dashboard/api/nodes");
        preflight.Headers.Add("Origin", Dashboard);
        var answered = await client.SendAsync(preflight);
        Assert.NotEqual(HttpStatusCode.NoContent, answered.StatusCode);
        Assert.False(answered.Headers.Contains("Access-Control-Allow-Origin"));
        // The enrollment page does not depend on the dashboard.
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/enroll")).StatusCode);
    }

    [Fact]
    public async Task The_dashboard_API_also_needs_the_public_URL()
    {
        using var factory = Factory(new() { ["Fleet:PublicUrl"] = "" });
        using var client = Client(factory);
        Assert.Equal(HttpStatusCode.Found, (await client.GetAsync("/dashboard")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/dashboard/api/csrf")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/enroll")).StatusCode);
    }

    [Fact]
    public async Task CORS_headers_cover_success_unauthorized_bad_request_and_not_found_responses_for_the_dashboard_origin()
    {
        await using var browser = new Browser(await fixture.BrowserAsync(OperatorApiFixture.AdminToken));
        var ok = await browser.Client.GetAsync("/dashboard/api/nodes");
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        AssertAllowed(ok);

        var badRequest = await browser.Client.GetAsync("/dashboard/api/nodes?limit=201");
        Assert.Equal(HttpStatusCode.BadRequest, badRequest.StatusCode);
        AssertAllowed(badRequest);

        var missingNode = await browser.Client.GetAsync("/dashboard/api/nodes/no-such-node");
        Assert.Equal(HttpStatusCode.NotFound, missingNode.StatusCode);
        AssertAllowed(missingNode);

        var unrouted = await browser.Client.GetAsync("/dashboard/api/no-such-route");
        Assert.Equal(HttpStatusCode.NotFound, unrouted.StatusCode);
        AssertAllowed(unrouted);

        var denied = await Send(fixture.Anonymous, HttpMethod.Get, "/dashboard/api/nodes", Dashboard);
        Assert.Equal(HttpStatusCode.Unauthorized, denied.StatusCode);
        AssertAllowed(denied);

        await using var reader = new Browser(await fixture.BrowserAsync(OperatorApiFixture.ReadToken));
        var forbidden = await reader.Client.PostAsJsonAsync("/dashboard/api/enrollment-links", new { alias = "cors-denied" });
        Assert.Equal(HttpStatusCode.Forbidden, forbidden.StatusCode);
        AssertAllowed(forbidden);

        var rejectedLogin = await Send(fixture.Anonymous, HttpMethod.Post, "/dashboard/api/login", Dashboard);
        Assert.Equal(HttpStatusCode.BadRequest, rejectedLogin.StatusCode);
        AssertAllowed(rejectedLogin);

        // The scheme and host are compared without case. The header carries the configured spelling.
        var shouting = await Send(fixture.Anonymous, HttpMethod.Get, "/dashboard/api/csrf", "HTTPS://LOCALHOST:7444");
        Assert.Equal(HttpStatusCode.OK, shouting.StatusCode);
        AssertAllowed(shouting);
    }

    public static TheoryData<string> OtherOrigins => new()
    {
        "https://evil.example", "https://localhost", "https://localhost:7443", "https://localhost:7445", "http://localhost:7444",
        "https://localhost:7444.evil.example", "https://evil-localhost:7444", "https://sub.localhost:7444", "https://localhost:7444/",
        "https://localhost:74440", "https://localhost:7444/path", "null", "*", "https://evil.example, https://localhost:7444"
    };

    [Theory]
    [MemberData(nameof(OtherOrigins))]
    public async Task No_CORS_headers_for_other_origins_but_responses_still_vary_by_Origin(string origin)
    {
        var response = await Send(fixture.Anonymous, HttpMethod.Get, "/dashboard/api/csrf", origin);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        AssertNoCors(response);
        Assert.Contains("Origin", response.Headers.GetValues("Vary").SelectMany(x => x.Split(',')).Select(x => x.Trim()));

        // The same holds for a preflight: refused, not answered with the allow list.
        var preflight = await Send(fixture.Anonymous, HttpMethod.Options, "/dashboard/api/nodes", origin);
        var body = await OperatorApiFixture.ReadAsync(preflight, HttpStatusCode.Forbidden);
        Assert.Equal("invalid_origin", body["code"]!.GetValue<string>());
        Assert.False(string.IsNullOrWhiteSpace(body["message"]!.GetValue<string>()));
        AssertNoCors(preflight);
    }

    [Fact]
    public async Task Requests_without_an_Origin_header_get_no_CORS_headers()
    {
        foreach (var path in new[] { "/dashboard/api/csrf", "/dashboard/api/nodes", "/dashboard/api/no-such-route" })
        {
            var response = await Send(fixture.Anonymous, HttpMethod.Get, path, null);
            AssertNoCors(response);
            Assert.Contains("Origin", response.Headers.GetValues("Vary"));
        }
        await using var browser = new Browser(await fixture.BrowserAsync(OperatorApiFixture.AdminToken));
        browser.Client.DefaultRequestHeaders.Remove("Origin");
        var authenticated = await browser.Client.GetAsync("/dashboard/api/nodes");
        Assert.Equal(HttpStatusCode.OK, authenticated.StatusCode);
        AssertNoCors(authenticated);
        // OPTIONS without Origin is not a preflight.
        var options = await Send(fixture.Anonymous, HttpMethod.Options, "/dashboard/api/nodes", null);
        Assert.NotEqual(HttpStatusCode.NoContent, options.StatusCode);
        AssertNoCors(options);
    }

    [Theory]
    [InlineData("/dashboard/api/nodes")]
    [InlineData("/dashboard/api/login")]
    [InlineData("/dashboard/api/csrf")]
    [InlineData("/dashboard/api/no-such-route")]
    [InlineData("/Dashboard/API/nodes")]
    public async Task A_preflight_from_the_dashboard_origin_needs_no_session_and_no_CSRF_token(string path)
    {
        using var request = new HttpRequestMessage(HttpMethod.Options, path);
        request.Headers.Add("Origin", Dashboard);
        request.Headers.Add("Access-Control-Request-Method", "POST");
        request.Headers.Add("Access-Control-Request-Headers", "content-type,x-fleet-csrf");
        var response = await fixture.Anonymous.SendAsync(request);
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal(Dashboard, response.Headers.GetValues("Access-Control-Allow-Origin").Single());
        Assert.Equal("true", response.Headers.GetValues("Access-Control-Allow-Credentials").Single());
        Assert.Equal("GET, POST, OPTIONS", response.Headers.GetValues("Access-Control-Allow-Methods").Single());
        Assert.Equal("Content-Type, X-Fleet-CSRF", response.Headers.GetValues("Access-Control-Allow-Headers").Single());
        Assert.Equal("600", response.Headers.GetValues("Access-Control-Max-Age").Single());
        Assert.Contains("Origin", response.Headers.GetValues("Vary"));
        Assert.False(response.Headers.Contains("Access-Control-Expose-Headers"));
        Assert.Empty(await response.Content.ReadAsStringAsync());
        Assert.False(response.Headers.Contains("Set-Cookie"));
    }

    [Theory]
    [InlineData("/operator/v1/nodes", "GET")]
    [InlineData("/operator/v1/nodes", "OPTIONS")]
    [InlineData("/agent/v1/poll", "POST")]
    [InlineData("/agent/v1/poll", "OPTIONS")]
    [InlineData("/enroll", "GET")]
    [InlineData("/enroll", "OPTIONS")]
    [InlineData("/enroll/enroll.js", "GET")]
    [InlineData("/health/live", "GET")]
    [InlineData("/health/ready", "GET")]
    [InlineData("/health/live", "OPTIONS")]
    [InlineData("/dashboard", "GET")]
    [InlineData("/", "GET")]
    [InlineData("/dashboardx/api/nodes", "GET")]
    [InlineData("/openapi/operator.json", "GET")]
    public async Task There_is_no_CORS_outside_the_dashboard_API(string path, string method)
    {
        foreach (var client in new[] { fixture.Anonymous, fixture.Admin })
        {
            var response = await Send(client, new HttpMethod(method), path, Dashboard);
            AssertNoCors(response);
            if (method == "OPTIONS") Assert.NotEqual(HttpStatusCode.NoContent, response.StatusCode);
            Assert.False(response.Headers.Contains("Vary") && response.Headers.GetValues("Vary").Any(x => x.Contains("Origin")), path);
        }
    }

    [Fact]
    public async Task Dashboard_API_responses_carry_the_security_headers_even_when_they_are_errors()
    {
        await using var browser = new Browser(await fixture.BrowserAsync(OperatorApiFixture.AdminToken));
        foreach (var response in new[]
        {
            await browser.Client.GetAsync("/dashboard/api/nodes"),
            await browser.Client.GetAsync("/dashboard/api/nodes?limit=201"),
            await Send(fixture.Anonymous, HttpMethod.Get, "/dashboard/api/nodes", Dashboard),
            await Send(fixture.Anonymous, HttpMethod.Get, "/dashboard/api/no-such-route", null),
            await Send(fixture.Anonymous, HttpMethod.Options, "/dashboard/api/nodes", Dashboard)
        })
        {
            Assert.Equal("no-referrer", response.Headers.GetValues("Referrer-Policy").Single());
            Assert.Equal("nosniff", response.Headers.GetValues("X-Content-Type-Options").Single());
            Assert.Equal("no-store", response.Headers.GetValues("Cache-Control").Single());
            Assert.Contains("frame-ancestors 'none'", response.Headers.GetValues("Content-Security-Policy").Single());
        }
    }

    [Fact]
    public async Task Writes_need_the_dashboard_origin_as_well_as_the_session_and_the_CSRF_token()
    {
        await using var browser = new Browser(await fixture.BrowserAsync(OperatorApiFixture.AdminToken));
        var csrf = browser.Client.DefaultRequestHeaders.GetValues("X-Fleet-CSRF").Single();
        browser.Client.DefaultRequestHeaders.Remove("Origin");
        browser.Client.DefaultRequestHeaders.Remove("X-Fleet-CSRF");

        // A valid session and a valid CSRF token are not enough from any other origin, including the Server's own.
        foreach (var origin in new[] { "https://evil.example", OperatorApiFixture.Origin, "https://localhost:7444.evil.example", Dashboard + "/", null })
        {
            var response = await Send(browser.Client, HttpMethod.Post, "/dashboard/api/logout", origin, csrf);
            var body = await OperatorApiFixture.ReadAsync(response, HttpStatusCode.BadRequest);
            Assert.Equal("invalid_origin", body["code"]!.GetValue<string>());
            AssertNoCors(response);
        }
        // Right origin, no CSRF token.
        var noToken = await Send(browser.Client, HttpMethod.Post, "/dashboard/api/logout", Dashboard, null);
        Assert.Equal("invalid_csrf", (await OperatorApiFixture.ReadAsync(noToken, HttpStatusCode.BadRequest))["code"]!.GetValue<string>());
        AssertAllowed(noToken);
        // Session still alive.
        Assert.Equal(HttpStatusCode.OK, (await Send(browser.Client, HttpMethod.Get, "/dashboard/api/session", Dashboard)).StatusCode);

        // Right origin and token.
        var logout = await Send(browser.Client, HttpMethod.Post, "/dashboard/api/logout", Dashboard, csrf, new { });
        Assert.Equal(HttpStatusCode.OK, logout.StatusCode);
        AssertAllowed(logout);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Send(browser.Client, HttpMethod.Get, "/dashboard/api/session", Dashboard)).StatusCode);
    }

    [Fact]
    public async Task Login_works_from_the_dashboard_origin_with_CORS_headers_and_the_strict_host_cookie()
    {
        using var client = fixture.Factory.CreateClient(new() { BaseAddress = new Uri(OperatorApiFixture.Origin) });
        var csrfResponse = await Send(client, HttpMethod.Get, "/dashboard/api/csrf", Dashboard);
        AssertAllowed(csrfResponse);
        var csrf = (await OperatorApiFixture.ReadAsync(csrfResponse))["token"]!.GetValue<string>();
        var cookies = string.Join("; ", csrfResponse.Headers.GetValues("Set-Cookie").Select(x => x.Split(';')[0]));
        var login = await Send(client, HttpMethod.Post, "/dashboard/api/login", Dashboard, csrf, new { token = OperatorApiFixture.AdminToken }, cookies);
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        AssertAllowed(login);
        var session = login.Headers.GetValues("Set-Cookie").Single(x => x.StartsWith("__Host-Fleet-Session=", StringComparison.Ordinal));
        Assert.Contains("secure", session);
        Assert.Contains("httponly", session);
        Assert.Contains("samesite=strict", session);
        Assert.DoesNotContain("domain", session);
    }

    [Fact]
    public async Task The_Server_host_check_applies_to_the_API_and_the_enrollment_page_and_the_error_is_readable_cross_origin()
    {
        using var elsewhere = fixture.Factory.CreateClient(new() { BaseAddress = new Uri("https://other.example") });
        var page = await OperatorApiFixture.ReadAsync(await elsewhere.GetAsync("/enroll"), HttpStatusCode.BadRequest);
        Assert.Equal("dashboard_origin_required", page["code"]!.GetValue<string>());
        var api = await Send(elsewhere, HttpMethod.Get, "/dashboard/api/csrf", Dashboard);
        Assert.Equal("dashboard_origin_required", (await OperatorApiFixture.ReadAsync(api, HttpStatusCode.BadRequest))["code"]!.GetValue<string>());
        AssertAllowed(api);
        // A preflight is answered before the host check, so the browser reaches the clear error above.
        var preflight = await Send(elsewhere, HttpMethod.Options, "/dashboard/api/csrf", Dashboard);
        Assert.Equal(HttpStatusCode.NoContent, preflight.StatusCode);
        // Redirects carry no information and do not depend on the host.
        using var noFollow = fixture.Factory.CreateClient(new() { BaseAddress = new Uri("https://other.example"), AllowAutoRedirect = false });
        Assert.Equal(HttpStatusCode.Found, (await noFollow.GetAsync("/dashboard")).StatusCode);
    }

    [Fact]
    public async Task The_enrollment_page_and_exactly_its_two_assets_are_served_by_the_Server()
    {
        using var client = Client(fixture.Factory);
        var page = await client.GetAsync("/enroll");
        page.EnsureSuccessStatusCode();
        Assert.StartsWith("text/html", page.Content.Headers.ContentType!.ToString());
        var html = await page.Content.ReadAsStringAsync();
        Assert.Contains("href=\"/enroll/enroll.css\"", html);
        Assert.Contains("src=\"/enroll/enroll.js\"", html);
        Assert.DoesNotContain("/dashboard/", html);

        var script = await client.GetAsync("/enroll/enroll.js");
        script.EnsureSuccessStatusCode();
        Assert.StartsWith("text/javascript", script.Content.Headers.ContentType!.ToString());
        Assert.Contains("#fleet-v1=", await script.Content.ReadAsStringAsync());

        var style = await client.GetAsync("/enroll/enroll.css");
        style.EnsureSuccessStatusCode();
        Assert.StartsWith("text/css", style.Content.Headers.ContentType!.ToString());
        var css = await style.Content.ReadAsStringAsync();
        Assert.DoesNotContain("body:not", css);
        Assert.Contains("#message:not(:empty)", css);
        Assert.True(css.Length < 4_096, "The enrollment stylesheet stays small.");

        foreach (var response in new[] { page, script, style })
        {
            Assert.Equal("default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
                response.Headers.GetValues("Content-Security-Policy").Single());
            Assert.Equal("no-referrer", response.Headers.GetValues("Referrer-Policy").Single());
            Assert.Equal("nosniff", response.Headers.GetValues("X-Content-Type-Options").Single());
            Assert.Equal("no-store", response.Headers.GetValues("Cache-Control").Single());
        }

        foreach (var denied in new[]
        {
            "/enroll/enroll.html", "/enroll/enroll.js.map", "/enroll/index.html", "/enroll/enroll", "/enroll/x/enroll.js",
            "/enroll/style.css", "/enroll/app.js", "/enroll/%2e%2e/appsettings.json", "/enroll.js", "/enroll.css", "/enroll/enroll.json"
        })
            Assert.True((await client.GetAsync(denied)).StatusCode == HttpStatusCode.NotFound, denied);
    }

    private sealed class Browser(HttpClient client) : IAsyncDisposable
    {
        public HttpClient Client { get; } = client;
        public ValueTask DisposeAsync()
        {
            Client.Dispose();
            return ValueTask.CompletedTask;
        }
    }

    private WebApplicationFactory<Program> Factory(Dictionary<string, string?> extra) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder => builder.ConfigureAppConfiguration((_, config) =>
            config.AddInMemoryCollection(fixture.Configuration(extra))));

    private static HttpClient Client(WebApplicationFactory<Program> factory) =>
        factory.CreateClient(new() { BaseAddress = new Uri(OperatorApiFixture.Origin), AllowAutoRedirect = false });

    private static Task<HttpResponseMessage> Send(HttpClient client, HttpMethod method, string path, string? origin, string? csrf = null,
        object? body = null, string? cookies = null)
    {
        var request = new HttpRequestMessage(method, path);
        if (origin is not null) request.Headers.TryAddWithoutValidation("Origin", origin);
        if (csrf is not null) request.Headers.Add("X-Fleet-CSRF", csrf);
        if (cookies is not null) request.Headers.Add("Cookie", cookies);
        if (method == HttpMethod.Options) request.Headers.Add("Access-Control-Request-Method", "GET");
        if (body is not null) request.Content = JsonContent.Create(body);
        return client.SendAsync(request);
    }

    private static void AssertAllowed(HttpResponseMessage response)
    {
        Assert.Equal(Dashboard, response.Headers.GetValues("Access-Control-Allow-Origin").Single());
        Assert.Equal("true", response.Headers.GetValues("Access-Control-Allow-Credentials").Single());
        Assert.Contains("Origin", response.Headers.GetValues("Vary").SelectMany(x => x.Split(',')).Select(x => x.Trim()));
    }

    private static void AssertNoCors(HttpResponseMessage response)
    {
        foreach (var header in response.Headers.Concat(response.Content.Headers))
            Assert.False(header.Key.StartsWith("Access-Control-", StringComparison.OrdinalIgnoreCase), header.Key);
    }
}
