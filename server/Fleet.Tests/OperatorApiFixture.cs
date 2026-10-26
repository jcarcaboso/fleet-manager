using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Fleet.Core.Coordination;
using Fleet.Server.Persistence;
using Fleet.Server.Transport;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Testcontainers.PostgreSql;

namespace Fleet.Tests;

/// <summary>One Server host on one PostgreSQL container, shared by the tests of a class. Tests enroll their own uniquely named Nodes.</summary>
public sealed class OperatorApiFixture : IAsyncLifetime
{
    public const string AdminToken = "test-only-admin-token-with-at-least-32-characters";
    public const string OperateToken = "test-only-operate-token-with-at-least-32-characters";
    public const string ReadToken = "test-only-read-token-with-at-least-32-characters";
    public const string Origin = "https://localhost";

    private readonly PostgreSqlContainer postgres = new PostgreSqlBuilder("postgres:17.5-alpine").Build();
    private readonly string directory = Path.Combine(Path.GetTempPath(), "fleet-operator-" + Guid.NewGuid().ToString("N"));
    // Publishing a snapshot converts CLIProxy targets that it omits to native mode, so every snapshot repeats them.
    private readonly List<SnapshotTarget> pinned = [];
    private readonly TestNodeRateLimit rateLimit = new();

    public void FreezeRateLimit(EnrolledNode node) => rateLimit.Freeze(node.NodeId.Value);

    public WebApplicationFactory<Program> Factory { get; private set; } = null!;
    public HttpClient Admin { get; private set; } = null!;
    public HttpClient Operate { get; private set; } = null!;
    public HttpClient Reader { get; private set; } = null!;
    public HttpClient Anonymous { get; private set; } = null!;
    public string ConnectionString => postgres.GetConnectionString();
    public string CertificatePath => Path.Combine(directory, "ca.pem");
    public string KeyPath => Path.Combine(directory, "ca.key");

    public async Task InitializeAsync()
    {
        await postgres.StartAsync();
        Directory.CreateDirectory(directory);
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest("CN=Fleet test issuer", key, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign, true));
        using var certificate = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddYears(1));
        await File.WriteAllTextAsync(CertificatePath, certificate.ExportCertificatePem());
        await File.WriteAllTextAsync(KeyPath, key.ExportPkcs8PrivateKeyPem());
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(KeyPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        Factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder => builder.ConfigureAppConfiguration((_, config) =>
            config.AddInMemoryCollection(Configuration(new()))).ConfigureServices(services =>
                services.AddTransient<IStartupFilter, UniqueClientAddress>().AddTransient<IStartupFilter, RawTargetFromHeader>()
                    .AddSingleton(new NodeRequestRateLimit(rateLimit))));
        Admin = Client(AdminToken);
        Operate = Client(OperateToken);
        Reader = Client(ReadToken);
        Anonymous = NewClient();
        using var scope = Factory.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<FleetDbContext>().Database.MigrateAsync();
    }

    /// <summary>Server settings with one admin (the default scope), one operate and one read Operator.</summary>
    public Dictionary<string, string?> Configuration(Dictionary<string, string?> extra)
    {
        var settings = new Dictionary<string, string?>
        {
            ["ConnectionStrings:Fleet"] = ConnectionString,
            ["Fleet:WorkspaceId"] = "ecf620df-4637-490d-95b3-a9f81ca4c353",
            ["Fleet:OperatorTokenSha256"] = Digest(AdminToken),
            ["Fleet:Operators:operate-bot"] = Digest(OperateToken),
            ["Fleet:Operators:read-bot"] = Digest(ReadToken),
            ["Fleet:OperatorScopes:operate-bot"] = "operate",
            ["Fleet:OperatorScopes:read-bot"] = "read",
            ["Fleet:IssuerCertificatePath"] = CertificatePath,
            ["Fleet:IssuerKeyPath"] = KeyPath,
            ["Fleet:PublicUrl"] = Origin,
            ["Source:Remote"] = "",
            ["urls"] = "https://localhost:7443"
        };
        foreach (var item in extra) settings[item.Key] = item.Value;
        return settings;
    }

    public static string Digest(string token) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    public HttpClient Client(string token)
    {
        var client = NewClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        return client;
    }

    /// <summary>
    /// A client that sends the request target as written. The in-memory test server does not fill
    /// <c>IHttpRequestFeature.RawTarget</c> as Kestrel does, so the target travels in a header and is restored by <see cref="RawTargetFromHeader"/>.
    /// </summary>
    private HttpClient NewClient(bool cookies = false) => Factory.CreateDefaultClient(new Uri(Origin),
        cookies ? [new RawTargetHandler(), new CookieJarHandler()] : [new RawTargetHandler()]);

    public async Task<HttpClient> BrowserAsync(string token)
    {
        var browser = NewClient(cookies: true);
        browser.DefaultRequestHeaders.Add("Origin", Origin);
        await RefreshCsrfAsync(browser);
        (await browser.PostAsJsonAsync("/dashboard/api/login", new { token })).EnsureSuccessStatusCode();
        await RefreshCsrfAsync(browser);
        return browser;
    }

    public static async Task RefreshCsrfAsync(HttpClient browser)
    {
        var response = await browser.GetFromJsonAsync<JsonElement>("/dashboard/api/csrf");
        browser.DefaultRequestHeaders.Remove("X-Fleet-CSRF");
        browser.DefaultRequestHeaders.Add("X-Fleet-CSRF", response.GetProperty("token").GetString());
    }

    public async Task<EnrolledNode> EnrollAsync(string alias)
    {
        var authorization = await Admin.PostAsJsonAsync("/operator/v1/enrollment-tokens", new { expiresInSeconds = 900 });
        var token = (await authorization.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("token").GetString();
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var csr = new CertificateRequest("CN=ignored", key, HashAlgorithmName.SHA256).CreateSigningRequestPem();
        var enrollment = await Anonymous.PostAsJsonAsync("/agent/v1/enroll",
            new { token, certificateRequestPem = csr, nodeName = alias, platform = "macos" });
        enrollment.EnsureSuccessStatusCode();
        var issued = await enrollment.Content.ReadFromJsonAsync<JsonElement>();
        var certificate = X509Certificate2.CreateFromPem(issued.GetProperty("certificatePem").GetString()!);
        return new(new(issued.GetProperty("nodeId").GetGuid()), alias, certificate);
    }

    public IServiceScope Scope() => Factory.Services.CreateScope();

    /// <summary>Publishes the three Target kinds for a Node. Returns the Node's authentication for later Agent calls.</summary>
    public async Task<NodeAuthentication> PublishAsync(EnrolledNode node, string revision, bool aiClientUsesProxy = false)
    {
        var skill = Bundle("fleet.bundle/v1", "skill " + revision);
        var other = Bundle("fleet.bundle/v1", "other skill " + revision);
        var file = FileBundle("claude instructions " + revision);
        var aiClient = aiClientUsesProxy
            ? new AiClientAssignment("fleet.ai-client/v1", "claude", "cliproxy", "https://proxy.example/v1", "claude-sonnet-5-5")
            : new AiClientAssignment("fleet.ai-client/v1", "claude", "native");
        var targets = new[]
        {
            new SnapshotTarget(node.NodeId, "skills", new("home", ".agents/skills"),
                [new("git-workflow", skill.Digest), new("code-review", other.Digest)]),
            new SnapshotTarget(node.NodeId, "agent-file/claude", new("home", ".claude"), [], File: new("CLAUDE.md", file.Digest)),
            new SnapshotTarget(node.NodeId, "ai-client/claude", new("home", ".claude"), [], AiClient: aiClient)
        };
        if (aiClientUsesProxy)
        {
            pinned.RemoveAll(x => x.NodeId == node.NodeId && x.TargetName == targets[2].TargetName);
            pinned.Add(targets[2]);
        }
        await PublishRawAsync(revision, [skill, other, file], targets);
        using var scope = Scope();
        return (await scope.ServiceProvider.GetRequiredService<IFleetCoordinator>().FindActiveNodeByCertificateAsync(
            node.Certificate.GetCertHashString(HashAlgorithmName.SHA256).ToLowerInvariant()))!;
    }

    public async Task PublishRawAsync(string revision, SnapshotBundle[] bundles, SnapshotTarget[] targets)
    {
        using var scope = Scope();
        var all = targets.Concat(pinned.Where(p => !targets.Any(t => t.NodeId == p.NodeId && t.TargetName == p.TargetName))).ToArray();
        await scope.ServiceProvider.GetRequiredService<IFleetCoordinator>().AcceptSourceSnapshotAsync(
            new(revision, bundles, all, [], DateTimeOffset.UtcNow));
    }

    /// <summary>Plays the Agent: polls until nothing is pending and reports an outcome for each Assignment it receives.</summary>
    public async Task<List<string>> RunAgentAsync(NodeAuthentication node, Func<string, (ConvergenceState State, string? ErrorCode)> outcome)
    {
        using var scope = Scope();
        var coordinator = scope.ServiceProvider.GetRequiredService<IFleetCoordinator>();
        var handled = new List<string>();
        while ((await coordinator.PollAsync(node, DateTimeOffset.UtcNow)).Assignment is { } assignment)
        {
            var (state, errorCode) = outcome(assignment.TargetName);
            await coordinator.ReportAttemptAsync(node, new(assignment.AttemptId, state, errorCode, null, DateTimeOffset.UtcNow));
            handled.Add(assignment.TargetName);
        }
        return handled;
    }

    public static SnapshotBundle Bundle(string schema, string content)
    {
        var bytes = Encoding.UTF8.GetBytes(content);
        return new(Convert.ToHexStringLower(SHA256.HashData(bytes)), schema, bytes.Length, bytes);
    }

    public static SnapshotBundle FileBundle(string content)
    {
        var bytes = Encoding.UTF8.GetBytes(content);
        var digest = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("fleet.file/v1\0").Concat(bytes).ToArray()));
        return new(digest, "fleet.file/v1", bytes.Length, bytes);
    }

    public async Task<HttpContext> SendNodeAsync(string path, X509Certificate2 certificate, object? body = null, string method = "POST",
        string? capabilities = null)
    {
        using var client = new HttpClient(Factory.Server.CreateHandler(context =>
        {
            context.Connection.ClientCertificate = certificate;
            context.Connection.RemoteIpAddress = IPAddress.Loopback;
        }))
        { BaseAddress = new Uri(Origin) };
        using var request = new HttpRequestMessage(new HttpMethod(method), path);
        if (body is not null) request.Content = JsonContent.Create(body);
        if (capabilities is not null) request.Headers.TryAddWithoutValidation("X-Fleet-Agent-Capabilities", capabilities);
        using var response = await client.SendAsync(request);
        var result = new DefaultHttpContext();
        result.Response.StatusCode = (int)response.StatusCode;
        result.Response.Body = new MemoryStream(await response.Content.ReadAsByteArrayAsync());
        return result;
    }

    public static async Task<JsonNode> ReadAsync(HttpResponseMessage response, HttpStatusCode? expected = HttpStatusCode.OK)
    {
        var text = await response.Content.ReadAsStringAsync();
        if (expected is { } status) Assert.True(status == response.StatusCode, $"{(int)response.StatusCode} {text}");
        return JsonNode.Parse(text)!;
    }

    public async Task DisposeAsync()
    {
        Admin?.Dispose();
        Operate?.Dispose();
        Reader?.Dispose();
        Anonymous?.Dispose();
        if (Factory is not null) await Factory.DisposeAsync();
        rateLimit.Dispose();
        await postgres.DisposeAsync();
        if (Directory.Exists(directory)) Directory.Delete(directory, true);
    }
}

/// <summary>
/// Test clients share one unknown address, which would put every test in one enrollment rate-limit window.
/// Give each request its own address unless the test already chose one.
/// </summary>
internal sealed class UniqueClientAddress : IStartupFilter
{
    private static int counter;

    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
    {
        app.Use(async (context, continuation) =>
        {
            if (context.Connection.RemoteIpAddress is null)
            {
                var n = Interlocked.Increment(ref counter);
                context.Connection.RemoteIpAddress = new IPAddress([10, (byte)(n >> 16), (byte)(n >> 8), (byte)n]);
            }
            await continuation();
        });
        next(app);
    };
}

internal sealed class RawTargetHandler : DelegatingHandler
{
    public const string Header = "X-Test-Raw-Target";

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var written = request.RequestUri!.OriginalString;
        var path = written.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? written[written.IndexOf('/', written.IndexOf("://", StringComparison.Ordinal) + 3)..] : written;
        request.Headers.Remove(Header);
        request.Headers.Add(Header, path);
        return base.SendAsync(request, cancellationToken);
    }
}

/// <summary>Sets <c>RawTarget</c> from the header added by <see cref="RawTargetHandler"/>, as Kestrel does for a real request.</summary>
internal sealed class RawTargetFromHeader : IStartupFilter
{
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
    {
        app.Use(async (context, continuation) =>
        {
            if (context.Request.Headers.Remove(RawTargetHandler.Header, out var raw) && context.Features.Get<IHttpRequestFeature>() is { } feature &&
                string.IsNullOrEmpty(feature.RawTarget))
                feature.RawTarget = raw.ToString();
            await continuation();
        });
        next(app);
    };
}

/// <summary>Keeps cookies for the in-memory server, which the default test client does only through its own handler chain.</summary>
internal sealed class CookieJarHandler : DelegatingHandler
{
    private readonly Dictionary<string, string> cookies = [];

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (cookies.Count > 0) request.Headers.Add("Cookie", string.Join("; ", cookies.Select(x => x.Key + "=" + x.Value)));
        var response = await base.SendAsync(request, cancellationToken);
        if (response.Headers.TryGetValues("Set-Cookie", out var values))
            foreach (var value in values)
            {
                var pair = value.Split(';')[0];
                var separator = pair.IndexOf('=');
                if (separator > 0) cookies[pair[..separator]] = pair[(separator + 1)..];
            }
        return response;
    }
}

public sealed record EnrolledNode(NodeId NodeId, string Alias, X509Certificate2 Certificate);

/// <summary>Compares a real response with a shared contract fixture: same property names at every depth, same JSON kinds.</summary>
public static class ContractShape
{
    public static JsonNode Fixture(string name) =>
        JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "contracts/operator", name)))!;

    public static void AssertMatches(string fixture, JsonNode actual) => Compare(Fixture(fixture), actual, "$");

    private static void Compare(JsonNode? expected, JsonNode? actual, string path)
    {
        // A null in the fixture is an optional value of unspecified kind; a null in the response is an absent optional value.
        if (expected is null || actual is null) return;
        Assert.True(expected.GetValueKind() == actual.GetValueKind() ||
            expected.GetValueKind() is JsonValueKind.True or JsonValueKind.False && actual.GetValueKind() is JsonValueKind.True or JsonValueKind.False,
            $"{path}: expected {expected.GetValueKind()} but found {actual.GetValueKind()}");
        switch (expected)
        {
            case JsonObject expectedObject:
                var actualObject = actual.AsObject();
                Assert.True(expectedObject.Select(x => x.Key).Order().SequenceEqual(actualObject.Select(x => x.Key).Order()),
                    $"{path}: expected properties [{string.Join(",", expectedObject.Select(x => x.Key).Order())}] but found [{string.Join(",", actualObject.Select(x => x.Key).Order())}]");
                foreach (var property in expectedObject) Compare(property.Value, actualObject[property.Key], path + "." + property.Key);
                break;
            case JsonArray expectedArray when expectedArray.Count > 0:
                // Every element must have the shape of at least one fixture element.
                foreach (var (item, index) in actual.AsArray().Select((x, i) => (x, i)))
                {
                    var failures = new List<string>();
                    var matched = expectedArray.Any(candidate =>
                    {
                        try { Compare(candidate, item, $"{path}[{index}]"); return true; }
                        catch (Xunit.Sdk.XunitException error) { failures.Add(error.Message); return false; }
                    });
                    Assert.True(matched, string.Join(" | ", failures));
                }
                break;
        }
    }
}
