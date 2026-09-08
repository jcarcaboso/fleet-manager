using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using Fleet.Core.Coordination;
using Fleet.Server.Persistence;
using Fleet.Server.Security;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Testcontainers.PostgreSql;

namespace Fleet.Tests;

public sealed class HostingTests : IAsyncLifetime
{
    private const string Token = "test-only-operator-token-with-at-least-32-characters";
    private readonly PostgreSqlContainer _postgres = new PostgreSqlBuilder("postgres:17.5-alpine").Build();
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "fleet-host-" + Guid.NewGuid().ToString("N"));
    private WebApplicationFactory<Program> _factory = null!;
    private HttpClient _operator = null!;

    public async Task InitializeAsync()
    {
        await _postgres.StartAsync();
        Directory.CreateDirectory(_directory);
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest("CN=Fleet test issuer", key, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign, true));
        using var certificate = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddYears(1));
        var certificatePath = Path.Combine(_directory, "ca.pem");
        var keyPath = Path.Combine(_directory, "ca.key");
        await File.WriteAllTextAsync(certificatePath, certificate.ExportCertificatePem());
        await File.WriteAllTextAsync(keyPath, key.ExportPkcs8PrivateKeyPem());
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(keyPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder => builder.ConfigureAppConfiguration((_, config) =>
            config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ConnectionStrings:Fleet"] = _postgres.GetConnectionString(),
                ["Fleet:WorkspaceId"] = "ecf620df-4637-490d-95b3-a9f81ca4c353",
                ["Fleet:OperatorTokenSha256"] = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(Token))),
                ["Fleet:IssuerCertificatePath"] = certificatePath,
                ["Fleet:IssuerKeyPath"] = keyPath,
                ["Fleet:PublicUrl"] = "https://localhost",
                ["Source:Remote"] = "",
                ["urls"] = "https://localhost:7443",
                ["Fleet:Operators:second-admin"] = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(Token + "-second")))
            })));
        _operator = _factory.CreateClient(new() { BaseAddress = new Uri("https://localhost") });
        _operator.DefaultRequestHeaders.Authorization = new("Bearer", Token);
        using var scope = _factory.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<FleetDbContext>().Database.MigrateAsync();
    }

    [Fact]
    public async Task Dashboard_sessions_require_csrf_and_cannot_authenticate_as_operators_or_nodes()
    {
        using var browser = _factory.CreateClient(new() { BaseAddress = new Uri("https://localhost") });
        browser.DefaultRequestHeaders.Add("Origin", "https://localhost");
        var page = await browser.GetAsync("/dashboard");
        page.EnsureSuccessStatusCode();
        Assert.Contains("frame-ancestors 'none'", page.Headers.GetValues("Content-Security-Policy").Single());
        Assert.Equal("no-referrer", page.Headers.GetValues("Referrer-Policy").Single());
        Assert.Equal(HttpStatusCode.Unauthorized, (await browser.GetAsync("/dashboard/api/nodes")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await browser.PostAsJsonAsync("/dashboard/api/login", new { token = Token })).StatusCode);
        await DashboardCsrf(browser);
        var login = await browser.PostAsJsonAsync("/dashboard/api/login", new { token = Token });
        login.EnsureSuccessStatusCode();
        var sessionCookie = login.Headers.GetValues("Set-Cookie").Single(x => x.StartsWith("__Host-Fleet-Session=", StringComparison.Ordinal));
        Assert.Contains("secure", sessionCookie);
        Assert.Contains("httponly", sessionCookie);
        Assert.Contains("samesite=strict", sessionCookie);
        Assert.DoesNotContain(Token, sessionCookie);
        Assert.Equal(HttpStatusCode.OK, (await browser.GetAsync("/dashboard/api/nodes")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await browser.GetAsync("/operator/v1/nodes")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await browser.PostAsync("/agent/v1/poll", null)).StatusCode);
        await DashboardCsrf(browser);
        browser.DefaultRequestHeaders.Remove("Origin");
        browser.DefaultRequestHeaders.Add("Origin", "https://attacker.invalid");
        Assert.Equal(HttpStatusCode.BadRequest, (await browser.PostAsJsonAsync("/dashboard/api/enrollment-links", new { alias = "blocked" })).StatusCode);
        browser.DefaultRequestHeaders.Remove("Origin");
        browser.DefaultRequestHeaders.Add("Origin", "https://localhost");
        (await browser.PostAsJsonAsync("/dashboard/api/logout", new { })).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.Unauthorized, (await browser.GetAsync("/dashboard/api/session")).StatusCode);
    }

    [Fact]
    public async Task Dashboard_links_embed_public_trust_bind_alias_and_support_revocation()
    {
        using var browser = _factory.CreateClient(new() { BaseAddress = new Uri("https://localhost") });
        browser.DefaultRequestHeaders.Add("Origin", "https://localhost");
        await DashboardCsrf(browser);
        (await browser.PostAsJsonAsync("/dashboard/api/login", new { token = Token })).EnsureSuccessStatusCode();
        await DashboardCsrf(browser);
        var response = await browser.PostAsJsonAsync("/dashboard/api/enrollment-links", new { alias = "link-node", expiresInSeconds = 900 });
        response.EnsureSuccessStatusCode();
        var linkResponse = await response.Content.ReadFromJsonAsync<JsonElement>();
        var link = new Uri(linkResponse.GetProperty("link").GetString()!);
        Assert.Equal("https://localhost/enroll", link.GetLeftPart(UriPartial.Path));
        Assert.Empty(link.Query);
        Assert.StartsWith("#fleet-v1=", link.Fragment);
        var payload = JsonSerializer.Deserialize<JsonElement>(Microsoft.AspNetCore.WebUtilities.WebEncoders.Base64UrlDecode(link.Fragment[10..]));
        Assert.Equal(1, payload.GetProperty("version").GetInt32());
        Assert.Equal("https://localhost", payload.GetProperty("serverUrl").GetString());
        Assert.Equal("link-node", payload.GetProperty("alias").GetString());
        Assert.DoesNotContain("PRIVATE KEY", payload.GetProperty("caPem").GetString());
        using var ca = X509Certificate2.CreateFromPem(payload.GetProperty("caPem").GetString()!);
        using var expectedCa = X509Certificate2.CreateFromPem(await File.ReadAllTextAsync(Path.Combine(_directory, "ca.pem")));
        Assert.Equal(expectedCa.RawData, ca.RawData);
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var csr = new CertificateRequest("CN=ignored", key, HashAlgorithmName.SHA256).CreateSigningRequestPem();
        var token = payload.GetProperty("token").GetString();
        var mismatch = await browser.PostAsJsonAsync("/agent/v1/enroll", new { token, nodeName = "wrong-node", platform = "linux", certificateRequestPem = csr });
        Assert.Equal(HttpStatusCode.BadRequest, mismatch.StatusCode);
        var body = new { token, nodeName = "link-node", platform = "linux", certificateRequestPem = csr };
        var enrolled = await browser.PostAsJsonAsync("/agent/v1/enroll", body);
        enrolled.EnsureSuccessStatusCode();
        Assert.Equal(await enrolled.Content.ReadAsStringAsync(), await (await browser.PostAsJsonAsync("/agent/v1/enroll", body)).Content.ReadAsStringAsync());
        using var otherKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var otherCsr = new CertificateRequest("CN=ignored", otherKey, HashAlgorithmName.SHA256).CreateSigningRequestPem();
        Assert.Equal(HttpStatusCode.BadRequest, (await browser.PostAsJsonAsync("/agent/v1/enroll", new { token, nodeName = "link-node", platform = "linux", certificateRequestPem = otherCsr })).StatusCode);
        (await browser.PostAsJsonAsync($"/dashboard/api/enrollment-links/{linkResponse.GetProperty("id").GetGuid()}/revoke", new { })).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.BadRequest, (await browser.PostAsJsonAsync("/agent/v1/enroll", body)).StatusCode);
        Assert.DoesNotContain(token!, await _operator.GetStringAsync("/operator/v1/audit"));
    }

    private static async Task DashboardCsrf(HttpClient browser)
    {
        var response = await browser.GetFromJsonAsync<JsonElement>("/dashboard/api/csrf");
        browser.DefaultRequestHeaders.Remove("X-Fleet-CSRF");
        browser.DefaultRequestHeaders.Add("X-Fleet-CSRF", response.GetProperty("token").GetString());
    }

    [Fact]
    public async Task Operator_and_node_credentials_cannot_cross_interfaces()
    {
        using var anonymous = _factory.CreateClient(new() { BaseAddress = new Uri("https://localhost") });
        foreach (var route in new[] { "nodes", "rollouts", "warnings", "desired-revisions", "audit", "metrics" })
        {
            Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/operator/v1/" + route)).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await _operator.GetAsync("/operator/v1/" + route)).StatusCode);
        }
        Assert.Equal(HttpStatusCode.Unauthorized, (await _operator.PostAsync("/agent/v1/poll", null)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await _operator.PutAsJsonAsync("/agent/v1/alias", new { alias = "operator-alias" })).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.PutAsJsonAsync("/agent/v1/alias", new { alias = "anonymous-alias" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await _operator.GetAsync("/operator/v1/nodes?limit=201")).StatusCode);
        using var http = _factory.CreateClient(new() { BaseAddress = new Uri("http://localhost") });
        http.DefaultRequestHeaders.Authorization = new("Bearer", Token);
        Assert.Equal(HttpStatusCode.BadRequest, (await http.GetAsync("/operator/v1/nodes")).StatusCode);
        foreach (var document in new[] { "agent", "operator" })
        {
            Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync($"/openapi/{document}.json")).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await _operator.GetAsync($"/openapi/{document}.json")).StatusCode);
        }
    }

    [Fact]
    public async Task Named_operator_is_audited_and_metrics_do_not_expose_credentials()
    {
        using var second = _factory.CreateClient(new() { BaseAddress = new Uri("https://localhost") });
        second.DefaultRequestHeaders.Authorization = new("Bearer", Token + "-second");
        (await second.PostAsJsonAsync("/operator/v1/enrollment-tokens", new { expiresInSeconds = 900 })).EnsureSuccessStatusCode();
        var audit = await _operator.GetFromJsonAsync<JsonElement>("/operator/v1/audit");
        Assert.Contains(audit.GetProperty("items").EnumerateArray(), item => item.GetProperty("actor").GetString() == "second-admin");
        var metrics = await _operator.GetStringAsync("/operator/v1/metrics");
        Assert.DoesNotContain(Token, metrics);
        Assert.DoesNotContain("second-admin", metrics);
        Assert.Contains("operator.ok", metrics);
    }

    [Fact]
    public async Task Readiness_rejects_a_database_bound_to_another_workspace()
    {
        Assert.Equal(HttpStatusCode.OK, (await _operator.GetAsync("/health/ready")).StatusCode);
        using var scope = _factory.Services.CreateScope();
        var database = scope.ServiceProvider.GetRequiredService<FleetDbContext>();
        database.Workspaces.Add(new WorkspaceRow { Id = Guid.NewGuid(), Name = "other" });
        await database.SaveChangesAsync();
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await _operator.GetAsync("/health/ready")).StatusCode);
    }

    [Fact]
    public async Task Fake_agent_enrolls_downloads_reports_and_loses_access_after_revocation()
    {
        var tokenResponse = await _operator.PostAsJsonAsync("/operator/v1/enrollment-tokens", new { expiresInSeconds = 900 });
        tokenResponse.EnsureSuccessStatusCode();
        var token = (await tokenResponse.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("token").GetString();
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var csr = new CertificateRequest("CN=ignored", key, HashAlgorithmName.SHA256).CreateSigningRequestPem();
        var body = new { token, certificateRequestPem = csr, nodeName = "test-node", platform = "linux" };
        using var anonymous = _factory.CreateClient(new() { BaseAddress = new Uri("https://localhost") });
        var enrollment = await anonymous.PostAsJsonAsync("/agent/v1/enroll", body);
        enrollment.EnsureSuccessStatusCode();
        var firstBytes = await enrollment.Content.ReadAsByteArrayAsync();
        var retry = await anonymous.PostAsJsonAsync("/agent/v1/enroll", body);
        Assert.Equal(firstBytes, await retry.Content.ReadAsByteArrayAsync());
        var issued = JsonSerializer.Deserialize<JsonElement>(firstBytes);
        var nodeId = new NodeId(issued.GetProperty("nodeId").GetGuid());
        var credentialId = issued.GetProperty("credentialId").GetGuid();
        using var certificate = X509Certificate2.CreateFromPem(issued.GetProperty("certificatePem").GetString()!);
        var rename = await SendNodeAsync("/agent/v1/alias", certificate, new { alias = "Renamed-Node" }, "PUT");
        Assert.Equal(200, rename.Response.StatusCode);
        var renamed = await JsonSerializer.DeserializeAsync<JsonElement>(rename.Response.Body);
        Assert.Equal(nodeId.Value, renamed.GetProperty("nodeId").GetGuid());
        Assert.Equal("Renamed-Node", renamed.GetProperty("alias").GetString());
        var content = Encoding.UTF8.GetBytes("opaque test bundle");
        var digest = Convert.ToHexStringLower(SHA256.HashData(content));
        using (var scope = _factory.Services.CreateScope())
        {
            await scope.ServiceProvider.GetRequiredService<IFleetCoordinator>().AcceptSourceSnapshotAsync(new(
                "test-revision", [new(digest, "fleet.bundle/v1", content.Length, content)],
                [new(nodeId, "skills", new("home", ".agents/skills"), [new("example", digest)])], [], DateTimeOffset.UtcNow));
        }
        var poll = await SendNodeAsync("/agent/v1/poll", certificate);
        Assert.Equal(200, poll.Response.StatusCode);
        var assignment = (await JsonSerializer.DeserializeAsync<JsonElement>(poll.Response.Body)).GetProperty("assignment");
        var attemptId = assignment.GetProperty("attemptId").GetGuid();
        var bundle = await SendNodeAsync("/agent/v1/bundles/" + digest, certificate, method: "GET");
        Assert.Equal(200, bundle.Response.StatusCode);
        using var bytes = new MemoryStream();
        await bundle.Response.Body.CopyToAsync(bytes);
        Assert.Equal(content, bytes.ToArray());
        var report = new { attemptId, state = "succeeded" };
        Assert.Equal(200, (await SendNodeAsync("/agent/v1/reports", certificate, report)).Response.StatusCode);
        var duplicate = await SendNodeAsync("/agent/v1/reports", certificate, report);
        Assert.Equal("duplicate", (await JsonSerializer.DeserializeAsync<JsonElement>(duplicate.Response.Body)).GetProperty("outcome").GetString());
        Assert.Equal(401, (await SendNodeAsync("/operator/v1/nodes", certificate, method: "GET")).Response.StatusCode);
        (await _operator.PostAsync($"/operator/v1/credentials/{credentialId:D}/revoke", null)).EnsureSuccessStatusCode();
        Assert.Equal(401, (await SendNodeAsync("/agent/v1/poll", certificate)).Response.StatusCode);
        Assert.Equal(401, (await SendNodeAsync("/agent/v1/alias", certificate, new { alias = "revoked" }, "PUT")).Response.StatusCode);
    }

    [Fact]
    public async Task Operator_alias_changes_validate_names_preserve_identity_and_audit_the_operator()
    {
        using var anonymous = _factory.CreateClient(new() { BaseAddress = new Uri("https://localhost") });
        async Task<JsonElement> Enroll(string alias)
        {
            var authorization = await _operator.PostAsJsonAsync("/operator/v1/enrollment-tokens", new { expiresInSeconds = 900 });
            var token = (await authorization.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("token").GetString();
            using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
            var csr = new CertificateRequest("CN=ignored", key, HashAlgorithmName.SHA256).CreateSigningRequestPem();
            var response = await anonymous.PostAsJsonAsync("/agent/v1/enroll", new { token, certificateRequestPem = csr, nodeName = alias, platform = "linux" });
            response.EnsureSuccessStatusCode();
            return await response.Content.ReadFromJsonAsync<JsonElement>();
        }
        var node = await Enroll("before/with space");
        await Enroll("occupied");
        const string route = "/operator/v1/nodes/rename";
        var request = new { currentAlias = "before/with space", alias = "after?#" };
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.PostAsJsonAsync(route, request)).StatusCode);
        using var certificate = X509Certificate2.CreateFromPem(node.GetProperty("certificatePem").GetString()!);
        Assert.Equal(401, (await SendNodeAsync(route, certificate, request)).Response.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _operator.PostAsJsonAsync(route, new { currentAlias = "missing", alias = "new" })).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await _operator.PostAsJsonAsync(route, new { currentAlias = request.currentAlias, alias = " " })).StatusCode);
        var collision = await _operator.PostAsJsonAsync(route, new { currentAlias = request.currentAlias, alias = "occupied" });
        Assert.Equal(HttpStatusCode.Conflict, collision.StatusCode);
        Assert.Equal("node_alias_in_use", (await collision.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
        var changed = await _operator.PostAsJsonAsync(route, request);
        changed.EnsureSuccessStatusCode();
        var result = await changed.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(node.GetProperty("nodeId").GetGuid(), result.GetProperty("nodeId").GetGuid());
        Assert.Equal(request.alias, result.GetProperty("alias").GetString());
        Assert.Equal(200, (await SendNodeAsync("/agent/v1/poll", certificate)).Response.StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await _operator.PostAsJsonAsync(route, new { currentAlias = request.alias, alias = request.alias })).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _operator.PostAsJsonAsync(route, request)).StatusCode);
        using (var scope = _factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<FleetDbContext>();
            var audit = Assert.Single(await db.AuditEvents.Where(x => x.Action == "node_alias_changed").ToListAsync());
            Assert.Equal("operator", audit.Actor);
            Assert.Equal(node.GetProperty("nodeId").GetGuid(), audit.NodeId);
            Assert.Null(audit.CredentialId);
        }
        (await _operator.PostAsync($"/operator/v1/nodes/{node.GetProperty("nodeId").GetGuid()}/revoke", null)).EnsureSuccessStatusCode();
        var revoked = await _operator.PostAsJsonAsync(route, new { currentAlias = request.alias, alias = "reused" });
        Assert.Equal(HttpStatusCode.Conflict, revoked.StatusCode);
        Assert.Equal("node_revoked", (await revoked.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
    }

    [Fact]
    public async Task Invalid_CSR_does_not_consume_token_and_errors_do_not_echo_secrets()
    {
        var tokenResponse = await _operator.PostAsJsonAsync("/operator/v1/enrollment-tokens", new { expiresInSeconds = 900 });
        var token = (await tokenResponse.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("token").GetString();
        var result = await _operator.PostAsJsonAsync("/agent/v1/enroll", new { token, certificateRequestPem = "invalid-secret-body", nodeName = "valid-node", platform = "linux" });
        Assert.Equal(HttpStatusCode.BadRequest, result.StatusCode);
        Assert.DoesNotContain(token!, await result.Content.ReadAsStringAsync());
        Assert.DoesNotContain("invalid-secret-body", await result.Content.ReadAsStringAsync());
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var csr = new CertificateRequest("CN=ignored", key, HashAlgorithmName.SHA256).CreateSigningRequestPem();
        Assert.Equal(HttpStatusCode.OK, (await _operator.PostAsJsonAsync("/agent/v1/enroll", new { token, certificateRequestPem = csr, nodeName = "valid-node", platform = "linux" })).StatusCode);
    }

    private async Task<HttpContext> SendNodeAsync(string path, X509Certificate2 certificate, object? body = null, string method = "POST")
    {
        using var client = new HttpClient(_factory.Server.CreateHandler(context =>
        {
            context.Connection.ClientCertificate = certificate;
            context.Connection.RemoteIpAddress = IPAddress.Loopback;
        }))
        { BaseAddress = new Uri("https://localhost") };
        using var request = new HttpRequestMessage(new HttpMethod(method), path);
        if (body is not null) request.Content = JsonContent.Create(body);
        using var response = await client.SendAsync(request);
        var result = new DefaultHttpContext();
        result.Response.StatusCode = (int)response.StatusCode;
        result.Response.Body = new MemoryStream(await response.Content.ReadAsByteArrayAsync());
        return result;
    }

    public async Task DisposeAsync()
    {
        _operator?.Dispose();
        if (_factory is not null) await _factory.DisposeAsync();
        await _postgres.DisposeAsync();
        Directory.Delete(_directory, true);
    }
}
