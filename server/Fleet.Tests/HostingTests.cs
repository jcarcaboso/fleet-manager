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
    public async Task Operator_and_node_credentials_cannot_cross_interfaces()
    {
        using var anonymous = _factory.CreateClient(new() { BaseAddress = new Uri("https://localhost") });
        foreach (var route in new[] { "nodes", "rollouts", "warnings", "desired-revisions", "audit", "metrics" })
        {
            Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/operator/v1/" + route)).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await _operator.GetAsync("/operator/v1/" + route)).StatusCode);
        }
        Assert.Equal(HttpStatusCode.Unauthorized, (await _operator.PostAsync("/agent/v1/poll", null)).StatusCode);
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
