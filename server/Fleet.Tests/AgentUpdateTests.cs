using System.Diagnostics;
using System.Formats.Tar;
using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Fleet.Core.Coordination;
using Fleet.Server.Hosting;
using Fleet.Server.Persistence;
using Fleet.Server.Security;
using Fleet.Server.Transport;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Fleet.Tests;

/// <summary>
/// Agent self-update on the Server: the release mirror, update requests, the capability-gated poll field and the Agent routes.
/// Every release here is signed with a throwaway Ed25519 key that OpenSSL generates for the test class.
/// </summary>
public sealed class AgentUpdateTests(OperatorApiFixture fixture, AgentUpdateTests.Keys keys)
    : IClassFixture<OperatorApiFixture>, IClassFixture<AgentUpdateTests.Keys>
{
    private const string Latest = "0.12.0";
    private const string Both = "disk-usage,agent-update";

    /// <summary>Two throwaway key pairs: one the Server trusts, one it does not.</summary>
    public sealed class Keys : IDisposable
    {
        public string Directory { get; } = Path.Combine(Path.GetTempPath(), "fleet-release-keys-" + Guid.NewGuid().ToString("N"));
        public string TrustedPrivate => Path.Combine(Directory, "trusted.key");
        public string TrustedPublic => File.ReadAllText(Path.Combine(Directory, "trusted.pem"));
        public string OtherPrivate => Path.Combine(Directory, "other.key");

        public Keys()
        {
            System.IO.Directory.CreateDirectory(Directory);
            foreach (var name in new[] { "trusted", "other" })
            {
                Openssl("genpkey", "-algorithm", "ed25519", "-out", Path.Combine(Directory, name + ".key"));
                Openssl("pkey", "-in", Path.Combine(Directory, name + ".key"), "-pubout", "-out", Path.Combine(Directory, name + ".pem"));
            }
        }

        public byte[] Sign(byte[] message, string privateKey)
        {
            var input = Path.Combine(Directory, Guid.NewGuid().ToString("N"));
            File.WriteAllBytes(input, message);
            Openssl("pkeyutl", "-sign", "-rawin", "-inkey", privateKey, "-in", input, "-out", input + ".sig");
            var signature = File.ReadAllBytes(input + ".sig");
            File.Delete(input);
            File.Delete(input + ".sig");
            return signature;
        }

        public static void Openssl(params string[] arguments)
        {
            var start = new ProcessStartInfo("openssl") { RedirectStandardError = true, RedirectStandardOutput = true };
            foreach (var argument in arguments) start.ArgumentList.Add(argument);
            using var process = Process.Start(start)!;
            var error = process.StandardError.ReadToEnd();
            process.WaitForExit();
            Assert.True(process.ExitCode == 0, error);
        }

        public void Dispose() => System.IO.Directory.Delete(Directory, true);
    }

    /// <summary>A release as the tag workflow publishes it: manifest, signature and one archive per platform.</summary>
    private sealed class Release
    {
        public Dictionary<string, byte[]> Binaries { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, byte[]> Files { get; } = new(StringComparer.Ordinal);
        public byte[] Manifest => Files[AgentReleaseMirror.ManifestName];
    }

    private Release MakeRelease(string version = Latest, string? signingKey = null, Func<string, byte[], byte[]>? archived = null,
        Func<JsonObject, JsonObject>? manifest = null)
    {
        var release = new Release();
        var entries = new JsonArray();
        foreach (var platform in new[] { "linux-amd64", "macos-arm64", "macos-amd64" })
        {
            var binary = RandomNumberGenerator.GetBytes(2048 + platform.Length);
            release.Binaries[platform] = binary;
            var parts = platform.Split('-');
            entries.Add(new JsonObject
            {
                ["os"] = parts[0],
                ["arch"] = parts[1],
                ["sha256"] = Convert.ToHexStringLower(SHA256.HashData(binary)),
                ["size"] = binary.Length
            });
            release.Files[$"fleet-agent-{platform}.tar.gz"] = Archive(archived?.Invoke(platform, binary) ?? binary);
        }
        var document = new JsonObject { ["schema"] = 1, ["name"] = "fleet-agent", ["version"] = version, ["gitCommit"] = new string('a', 40), ["binaries"] = entries };
        var bytes = Encoding.UTF8.GetBytes((manifest?.Invoke(document) ?? document).ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n");
        release.Files[AgentReleaseMirror.ManifestName] = bytes;
        release.Files[AgentReleaseMirror.SignatureName] = keys.Sign(bytes, signingKey ?? keys.TrustedPrivate);
        return release;
    }

    private static byte[] Archive(byte[] binary)
    {
        using var output = new MemoryStream();
        using (var gzip = new GZipStream(output, CompressionLevel.Fastest, leaveOpen: true))
        using (var tar = new TarWriter(gzip, TarEntryFormat.Ustar))
        {
            foreach (var (name, content) in new[] { ("fleet-agent", binary), ("BUILD.json", "{}"u8.ToArray()), ("LICENSE", "MIT"u8.ToArray()) })
                tar.WriteEntry(new UstarTarEntry(TarEntryType.RegularFile, name)
                {
                    DataStream = new MemoryStream(content),
                    Mode = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
                });
        }
        return output.ToArray();
    }

    /// <summary>Plays GitHub: answers release downloads from <see cref="Release"/> files and records each request.</summary>
    private sealed class ReleaseHost : HttpMessageHandler
    {
        public Release? Published { get; set; }
        public List<Uri> Requests { get; } = [];
        public Func<Uri, HttpResponseMessage?>? Override { get; set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var uri = request.RequestUri!;
            lock (Requests) Requests.Add(uri);
            if (Override?.Invoke(uri) is { } overridden) return Task.FromResult(overridden);
            var name = uri.Segments[^1];
            return Task.FromResult(uri.AbsolutePath.StartsWith("/jcarcaboso/fleet-manager/releases/download/v", StringComparison.Ordinal) &&
                                   Published?.Files.TryGetValue(name, out var content) == true
                ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(content) }
                : new HttpResponseMessage(HttpStatusCode.NotFound));
        }
    }

    private sealed class Host(WebApplicationFactory<Program> factory, ReleaseHost releases, string cache) : IAsyncDisposable
    {
        public WebApplicationFactory<Program> Factory { get; } = factory;
        public ReleaseHost Releases { get; } = releases;
        public string Cache { get; } = cache;
        public HttpClient Admin { get; } = Client(factory, OperatorApiFixture.AdminToken);
        public HttpClient Operate { get; } = Client(factory, OperatorApiFixture.OperateToken);
        public HttpClient Reader { get; } = Client(factory, OperatorApiFixture.ReadToken);

        private static HttpClient Client(WebApplicationFactory<Program> factory, string token)
        {
            var client = factory.CreateDefaultClient(new Uri(OperatorApiFixture.Origin), new RawTargetHandler());
            client.DefaultRequestHeaders.Authorization = new("Bearer", token);
            return client;
        }

        public async Task<(int Status, byte[] Body, string Text)> NodeAsync(string path, X509Certificate2 certificate, object? body = null,
            string method = "GET", string? capabilities = null)
        {
            using var client = new HttpClient(Factory.Server.CreateHandler(context =>
            {
                context.Connection.ClientCertificate = certificate;
                context.Connection.RemoteIpAddress = IPAddress.Loopback;
            }))
            { BaseAddress = new Uri(OperatorApiFixture.Origin) };
            using var request = new HttpRequestMessage(new HttpMethod(method), path);
            if (body is not null) request.Content = JsonContent.Create(body);
            if (capabilities is not null) request.Headers.TryAddWithoutValidation("X-Fleet-Agent-Capabilities", capabilities);
            using var response = await client.SendAsync(request);
            var bytes = await response.Content.ReadAsByteArrayAsync();
            return ((int)response.StatusCode, bytes, Encoding.UTF8.GetString(bytes));
        }

        public async Task<JsonObject> PollAsync(EnrolledNode node, string? capabilities)
        {
            var (status, _, text) = await NodeAsync("/agent/v1/poll", node.Certificate, null, "POST", capabilities);
            Assert.True(status == 200, text);
            return JsonNode.Parse(text)!.AsObject();
        }

        public async Task<int> ReportAsync(EnrolledNode node, string state, string? errorCode = null, string version = Latest) =>
            (await NodeAsync("/agent/v1/agent-update/report", node.Certificate, new { version, state, errorCode }, "POST")).Status;

        public async Task<JsonNode> DetailAsync(string alias) =>
            await OperatorApiFixture.ReadAsync(await Reader.GetAsync($"/operator/v1/nodes/{alias}"));

        public ValueTask DisposeAsync()
        {
            Admin.Dispose();
            Operate.Dispose();
            Reader.Dispose();
            if (Directory.Exists(Cache)) Directory.Delete(Cache, true);
            return Factory.DisposeAsync();
        }
    }

    /// <summary>A Server on the fixture database whose own version is 0.12.0, which trusts the test key and downloads from <paramref name="published"/>.</summary>
    private Host Start(Release? published, string? trustedKey = null)
    {
        var releases = new ReleaseHost { Published = published };
        var cache = Path.Combine(Path.GetTempPath(), "fleet-agent-releases-" + Guid.NewGuid().ToString("N"));
        var factory = fixture.Factory.WithWebHostBuilder(builder => builder
            .ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Fleet:AgentReleases:CacheDirectory"] = cache,
                ["Fleet:AgentReleases:PublicKeys:0"] = trustedKey ?? keys.TrustedPublic
            }))
            .ConfigureServices(services =>
            {
                services.AddSingleton(new LatestAgentVersion(SemanticVersion.Parse(Latest)));
                services.AddHttpClient(AgentReleaseMirror.HttpClientName).ConfigurePrimaryHttpMessageHandler(() => releases);
            }));
        return new(factory, releases, cache);
    }

    /// <summary>Enrolls a Node whose Agent runs <paramref name="version"/> and, unless told otherwise, announces agent-update.</summary>
    private async Task<EnrolledNode> AgentAsync(Host host, string alias, string version = "0.11.0", string? capabilities = Both)
    {
        var node = await fixture.EnrollAsync(alias);
        var telemetry = new
        {
            agentVersion = version,
            os = new { name = "Fedora Linux", version = "44", kernel = "7.2.11" },
            arch = "x86_64",
            hostname = alias,
            user = "joan",
            installMethod = "managed",
            serviceManager = "systemd",
            stateDirectory = "~/.local/state/fleet-agent"
        };
        Assert.Equal(204, (await host.NodeAsync("/agent/v1/telemetry", node.Certificate, telemetry, "PUT")).Status);
        await host.PollAsync(node, capabilities);
        return node;
    }

    private static async Task<JsonNode> ExpectAsync(HttpResponseMessage response, HttpStatusCode status, string? code = null)
    {
        var body = await OperatorApiFixture.ReadAsync(response, status);
        if (code is not null)
        {
            Assert.Equal(code, body["code"]!.GetValue<string>());
            Assert.False(string.IsNullOrWhiteSpace(body["message"]!.GetValue<string>()));
            Assert.NotNull(ErrorCatalog.Find(code));
        }
        return body;
    }

    private async Task<int> AuditCountAsync(EnrolledNode node, string action)
    {
        using var scope = fixture.Scope();
        var db = scope.ServiceProvider.GetRequiredService<FleetDbContext>();
        var id = node.NodeId.Value;
        return await db.AuditEvents.CountAsync(x => x.NodeId == id && x.Action == action);
    }

    [Fact]
    public async Task An_update_is_requested_mirrored_served_and_reported_to_success()
    {
        var release = MakeRelease();
        await using var host = Start(release);
        var node = await AgentAsync(host, "update-happy");
        Assert.True((await host.DetailAsync("update-happy"))["agent"]!["selfUpdate"]!.GetValue<bool>());
        Assert.Null((await host.DetailAsync("update-happy"))["agentUpdate"]);

        var requested = await ExpectAsync(await host.Admin.PostAsync("/operator/v1/nodes/update-happy/agent-update", null), HttpStatusCode.Accepted);
        Assert.Equal(("0.11.0", Latest, "requested", "operator"), (requested["fromVersion"]!.GetValue<string>(),
            requested["targetVersion"]!.GetValue<string>(), requested["state"]!.GetValue<string>(), requested["requestedBy"]!.GetValue<string>()));
        Assert.Null(requested["finishedAt"]);
        // The archives were downloaded once and only the verified binaries are kept.
        Assert.Equal(5, host.Releases.Requests.Count);
        Assert.Equal(["linux-amd64", "macos-amd64", "macos-arm64"],
            Directory.GetFiles(Path.Combine(host.Cache, "v" + Latest, "binaries")).Select(x => Path.GetFileName(x)).Order().ToArray<string>());
        Assert.Empty(Directory.GetFiles(Path.Combine(host.Cache, "v" + Latest), "*.tar.gz"));

        // A repeat returns the pending request unchanged and downloads nothing.
        var repeat = await ExpectAsync(await host.Admin.PostAsync($"/operator/v1/nodes/{node.NodeId.Value}/agent-update", null), HttpStatusCode.Accepted);
        Assert.True(JsonNode.DeepEquals(requested, repeat));
        Assert.Equal(5, host.Releases.Requests.Count);

        var detail = await host.DetailAsync("update-happy");
        ContractShape.AssertMatches("node-detail.json", detail);
        Assert.Equal("requested", detail["agentUpdate"]!["state"]!.GetValue<string>());
        var list = await OperatorApiFixture.ReadAsync(await host.Reader.GetAsync("/operator/v1/nodes?limit=100"));
        ContractShape.AssertMatches("nodes-page.json", list);
        Assert.Equal("requested", list["items"]!.AsArray().Single(x => x!["name"]!.GetValue<string>() == "update-happy")!["agentUpdate"]!["state"]!.GetValue<string>());

        var poll = await host.PollAsync(node, Both);
        Assert.Equal(Latest, poll["agentUpdate"]!["version"]!.GetValue<string>());
        Assert.Equal(["agentUpdate", "assignment", "nextPollSeconds", "nodeId", "workspaceId"], poll.Select(x => x.Key).Order().ToArray());

        // The Agent downloads exactly the signed bytes.
        var manifest = await host.NodeAsync($"/agent/v1/agent-releases/{Latest}/manifest", node.Certificate);
        Assert.Equal(200, manifest.Status);
        Assert.Equal(release.Manifest, manifest.Body);
        var signature = await host.NodeAsync($"/agent/v1/agent-releases/{Latest}/signature", node.Certificate);
        Assert.Equal(200, signature.Status);
        Assert.Equal(release.Files[AgentReleaseMirror.SignatureName], signature.Body);
        foreach (var platform in release.Binaries.Keys)
        {
            var binary = await host.NodeAsync($"/agent/v1/agent-releases/{Latest}/binaries/{platform}", node.Certificate);
            Assert.Equal(200, binary.Status);
            Assert.Equal(release.Binaries[platform], binary.Body);
        }
        Assert.Equal(404, (await host.NodeAsync($"/agent/v1/agent-releases/{Latest}/binaries/windows-amd64", node.Certificate)).Status);
        var other = await host.NodeAsync("/agent/v1/agent-releases/0.11.0/manifest", node.Certificate);
        Assert.Equal(404, other.Status);
        Assert.Contains("agent_release_not_found", other.Text);
        Assert.Equal(5, host.Releases.Requests.Count);
        using (var anonymous = host.Factory.CreateDefaultClient(new Uri(OperatorApiFixture.Origin)))
            Assert.True((await anonymous.GetAsync($"/agent/v1/agent-releases/{Latest}/manifest")).StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden);

        // Picked up: the poll field disappears and the request can no longer be cancelled.
        Assert.Equal(204, await host.ReportAsync(node, "downloading"));
        Assert.Equal(204, await host.ReportAsync(node, "downloading"));
        Assert.False((await host.PollAsync(node, Both)).ContainsKey("agentUpdate"));
        await ExpectAsync(await host.Admin.PostAsync("/operator/v1/nodes/update-happy/agent-update/cancel", null), HttpStatusCode.Conflict,
            "agent_update_not_cancellable");
        await ExpectAsync(await host.Admin.PostAsync("/operator/v1/nodes/update-happy/agent-update", null), HttpStatusCode.Conflict,
            "agent_update_in_progress");
        Assert.Equal(204, await host.ReportAsync(node, "restarting"));
        Assert.Equal(409, await host.ReportAsync(node, "downloading"));
        Assert.Equal(409, await host.ReportAsync(node, "succeeded", version: "0.13.0"));
        Assert.Equal(204, await host.ReportAsync(node, "succeeded"));
        Assert.Equal(409, await host.ReportAsync(node, "failed", "agent_update_crash_loop"));

        var done = (await host.DetailAsync("update-happy"))["agentUpdate"]!;
        Assert.Equal("succeeded", done["state"]!.GetValue<string>());
        Assert.NotNull(done["finishedAt"]);
        Assert.Null(done["errorCode"]);
        Assert.Equal(1, await AuditCountAsync(node, "agent.update_requested"));
        Assert.Equal(1, await AuditCountAsync(node, "agent.update_succeeded"));

        // A newer Agent version has nothing to update.
        Assert.Equal(204, (await host.NodeAsync("/agent/v1/telemetry", node.Certificate, new
        {
            agentVersion = Latest,
            os = new { name = "Fedora Linux", version = "44", kernel = "7.2.11" },
            arch = "x86_64",
            hostname = "h",
            user = "joan",
            installMethod = "managed",
            serviceManager = "systemd",
            stateDirectory = "~/.local/state/fleet-agent"
        }, "PUT")).Status);
        await ExpectAsync(await host.Admin.PostAsync("/operator/v1/nodes/update-happy/agent-update", null), HttpStatusCode.Conflict,
            "agent_update_current");
    }

    [Fact]
    public async Task Old_Agents_never_see_the_poll_field_and_cannot_be_asked_to_update()
    {
        await using var host = Start(MakeRelease());
        var old = await AgentAsync(host, "update-old", capabilities: "disk-usage");
        Assert.False((await host.DetailAsync("update-old"))["agent"]!["selfUpdate"]!.GetValue<bool>());
        await ExpectAsync(await host.Admin.PostAsync("/operator/v1/nodes/update-old/agent-update", null), HttpStatusCode.Conflict,
            "agent_update_unsupported");
        Assert.Empty(host.Releases.Requests);

        // An Agent that announced the capability, got a request, and was then downgraded by hand never receives the field.
        var node = await AgentAsync(host, "update-downgraded");
        await ExpectAsync(await host.Admin.PostAsync("/operator/v1/nodes/update-downgraded/agent-update", null), HttpStatusCode.Accepted);
        foreach (var capabilities in new string?[] { null, "", "disk-usage", "agent-updates", "disk-usage,agent_update" })
        {
            var poll = await host.PollAsync(node, capabilities);
            Assert.Equal(["assignment", "nextPollSeconds", "nodeId", "workspaceId"], poll.Select(x => x.Key).Order().ToArray());
            Assert.True(capabilities is not null || !poll.ContainsKey("agentUpdate"));
        }
        Assert.False((await host.DetailAsync("update-downgraded"))["agent"]!["selfUpdate"]!.GetValue<bool>());
        // The header is a comma-separated, case-insensitive list.
        Assert.True((await host.PollAsync(node, " Disk-Usage , AGENT-UPDATE ")).ContainsKey("agentUpdate"));
        Assert.True((await host.DetailAsync("update-downgraded"))["agent"]!["selfUpdate"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Revoked_and_unknown_Nodes_and_lower_scopes_are_rejected()
    {
        await using var host = Start(MakeRelease());
        var node = await AgentAsync(host, "update-revoked");
        Assert.Equal(HttpStatusCode.OK, (await host.Admin.PostAsync($"/operator/v1/nodes/{node.NodeId.Value}/revoke", null)).StatusCode);
        await ExpectAsync(await host.Admin.PostAsync("/operator/v1/nodes/update-revoked/agent-update", null), HttpStatusCode.Conflict, "node_revoked");
        await ExpectAsync(await host.Admin.PostAsync("/operator/v1/nodes/no-such-node/agent-update", null), HttpStatusCode.NotFound, "node_not_found");
        await AgentAsync(host, "update-scope");
        await ExpectAsync(await host.Operate.PostAsync("/operator/v1/nodes/update-scope/agent-update", null), HttpStatusCode.Forbidden, "insufficient_scope");
        await ExpectAsync(await host.Operate.PostAsJsonAsync("/operator/v1/agent-updates", new { allOutdated = true }), HttpStatusCode.Forbidden,
            "insufficient_scope");
        await ExpectAsync(await host.Operate.PostAsync("/operator/v1/nodes/update-scope/agent-update/cancel", null), HttpStatusCode.Forbidden,
            "insufficient_scope");
        Assert.Empty(host.Releases.Requests);
    }

    [Fact]
    public async Task A_request_the_Agent_has_not_picked_up_can_be_cancelled()
    {
        await using var host = Start(MakeRelease());
        var node = await AgentAsync(host, "update-cancel");
        await ExpectAsync(await host.Admin.PostAsync("/operator/v1/nodes/update-cancel/agent-update/cancel", null), HttpStatusCode.Conflict,
            "agent_update_not_cancellable");
        await ExpectAsync(await host.Admin.PostAsync("/operator/v1/nodes/update-cancel/agent-update", null), HttpStatusCode.Accepted);
        await using (var browser = new BrowserHandle(await BrowserAsync(host, OperatorApiFixture.AdminToken)))
        {
            var cancelled = await OperatorApiFixture.ReadAsync(await browser.Client.PostAsync("/dashboard/api/nodes/update-cancel/agent-update/cancel", null));
            Assert.Equal("cancelled", cancelled["state"]!.GetValue<string>());
            Assert.NotNull(cancelled["finishedAt"]);
        }
        Assert.False((await host.PollAsync(node, Both)).ContainsKey("agentUpdate"));
        // The Agent may have polled just before: its pickup is refused, so it never starts.
        Assert.Equal(409, await host.ReportAsync(node, "downloading"));
        Assert.Equal("cancelled", (await host.DetailAsync("update-cancel"))["agentUpdate"]!["state"]!.GetValue<string>());
        Assert.Equal(1, await AuditCountAsync(node, "agent.update_cancelled"));
        // A new request replaces the finished one.
        var again = await ExpectAsync(await host.Admin.PostAsync("/operator/v1/nodes/update-cancel/agent-update", null), HttpStatusCode.Accepted);
        Assert.Equal("requested", again["state"]!.GetValue<string>());
        Assert.True((await host.PollAsync(node, Both)).ContainsKey("agentUpdate"));
        // An Agent that already runs the version (upgraded by hand meanwhile) reports success without downloading.
        Assert.Equal(204, await host.ReportAsync(node, "succeeded"));
        Assert.Equal("succeeded", (await host.DetailAsync("update-cancel"))["agentUpdate"]!["state"]!.GetValue<string>());
    }

    [Fact]
    public async Task A_release_signed_with_an_untrusted_key_is_rejected_and_nothing_is_cached()
    {
        await using var host = Start(MakeRelease(signingKey: keys.OtherPrivate));
        var node = await AgentAsync(host, "update-bad-signature");
        await ExpectAsync(await host.Admin.PostAsync("/operator/v1/nodes/update-bad-signature/agent-update", null), HttpStatusCode.BadGateway,
            "agent_release_invalid");
        // The signature is checked before any archive is downloaded.
        Assert.Equal(2, host.Releases.Requests.Count);
        Assert.Empty(Directory.GetFiles(Path.Combine(host.Cache, "v" + Latest)));
        Assert.Null((await host.DetailAsync("update-bad-signature"))["agentUpdate"]);
        Assert.False((await host.PollAsync(node, Both)).ContainsKey("agentUpdate"));
        var manifest = await host.NodeAsync($"/agent/v1/agent-releases/{Latest}/manifest", node.Certificate);
        Assert.Equal(502, manifest.Status);

        // A tampered manifest fails the same way, even with a genuine signature of the original bytes.
        var genuine = MakeRelease();
        var tampered = MakeRelease();
        tampered.Files[AgentReleaseMirror.SignatureName] = genuine.Files[AgentReleaseMirror.SignatureName];
        await using var second = Start(tampered);
        await AgentAsync(second, "update-tampered");
        await ExpectAsync(await second.Admin.PostAsync("/operator/v1/nodes/update-tampered/agent-update", null), HttpStatusCode.BadGateway,
            "agent_release_invalid");
    }

    [Fact]
    public async Task An_archive_that_does_not_match_the_signed_digest_is_rejected()
    {
        // The manifest is genuine and signed, but one archive carries other bytes.
        await using var host = Start(MakeRelease(archived: (platform, binary) => platform == "macos-arm64" ? [.. binary[..^1], (byte)(binary[^1] ^ 1)] : binary));
        await AgentAsync(host, "update-digest");
        var error = await ExpectAsync(await host.Admin.PostAsync("/operator/v1/nodes/update-digest/agent-update", null), HttpStatusCode.BadGateway,
            "agent_release_invalid");
        Assert.Contains("fleet-agent-macos-arm64.tar.gz", error["message"]!.GetValue<string>());
        Assert.Null((await host.DetailAsync("update-digest"))["agentUpdate"]);
        Assert.Empty(Directory.GetFiles(Path.Combine(host.Cache, "v" + Latest), "*.tar.gz"));

        // A manifest that names another version is refused too.
        await using var second = Start(MakeRelease(manifest: document => { document["version"] = "0.12.1"; return document; }));
        await AgentAsync(second, "update-wrong-version");
        await ExpectAsync(await second.Admin.PostAsync("/operator/v1/nodes/update-wrong-version/agent-update", null), HttpStatusCode.BadGateway,
            "agent_release_invalid");
    }

    [Fact]
    public async Task An_unpublished_release_is_unavailable_and_retries_wait_a_minute()
    {
        await using var host = Start(null);
        var node = await AgentAsync(host, "update-unpublished");
        var error = await ExpectAsync(await host.Admin.PostAsync("/operator/v1/nodes/update-unpublished/agent-update", null),
            HttpStatusCode.ServiceUnavailable, "agent_release_unavailable");
        Assert.Contains("not published yet", error["message"]!.GetValue<string>());
        Assert.Null((await host.DetailAsync("update-unpublished"))["agentUpdate"]);
        Assert.Single(host.Releases.Requests);
        // Publishing does not help until the failure is a minute old: no request reaches GitHub meanwhile.
        host.Releases.Published = MakeRelease();
        await ExpectAsync(await host.Admin.PostAsync("/operator/v1/nodes/update-unpublished/agent-update", null),
            HttpStatusCode.ServiceUnavailable, "agent_release_unavailable");
        Assert.Single(host.Releases.Requests);
        Assert.Equal(0, await AuditCountAsync(node, "agent.update_requested"));
    }

    [Fact]
    public async Task Only_GitHub_release_asset_redirects_are_followed()
    {
        var release = MakeRelease();
        await using var host = Start(release);
        host.Releases.Override = uri =>
        {
            if (uri.Host == "github.com")
            {
                var redirect = new HttpResponseMessage(HttpStatusCode.Found);
                redirect.Headers.Location = new Uri("https://release-assets.githubusercontent.com/assets/" + uri.Segments[^1]);
                return redirect;
            }
            return release.Files.TryGetValue(uri.Segments[^1], out var content)
                ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(content) }
                : new HttpResponseMessage(HttpStatusCode.NotFound);
        };
        await AgentAsync(host, "update-redirect");
        await ExpectAsync(await host.Admin.PostAsync("/operator/v1/nodes/update-redirect/agent-update", null), HttpStatusCode.Accepted);
        Assert.Equal(10, host.Releases.Requests.Count);

        Assert.True(AgentReleaseMirror.IsReleaseAssetRedirect(new("https://github.com/a/b"), new("https://objects.githubusercontent.com/x")));
        Assert.False(AgentReleaseMirror.IsReleaseAssetRedirect(new("https://github.com/a/b"), new("http://objects.githubusercontent.com/x")));
        Assert.False(AgentReleaseMirror.IsReleaseAssetRedirect(new("https://github.com/a/b"), new("https://evil.example/x")));
        Assert.False(AgentReleaseMirror.IsReleaseAssetRedirect(new("https://github.com/a/b"), new("https://githubusercontent.com.evil.example/x")));
        Assert.False(AgentReleaseMirror.IsReleaseAssetRedirect(new("https://mirror.example/a"), new("https://objects.githubusercontent.com/x")));

        // Anywhere else is refused.
        await using var second = Start(release);
        second.Releases.Override = _ =>
        {
            var redirect = new HttpResponseMessage(HttpStatusCode.Found);
            redirect.Headers.Location = new Uri("https://evil.example/fleet-agent-release.json");
            return redirect;
        };
        await AgentAsync(second, "update-evil-redirect");
        await ExpectAsync(await second.Admin.PostAsync("/operator/v1/nodes/update-evil-redirect/agent-update", null),
            HttpStatusCode.ServiceUnavailable, "agent_release_unavailable");
        Assert.Single(second.Releases.Requests);
    }

    [Fact]
    public async Task An_offline_Server_uses_release_files_placed_in_its_cache()
    {
        var release = MakeRelease();
        await using var host = Start(null);
        var directory = Directory.CreateDirectory(Path.Combine(host.Cache, "v" + Latest)).FullName;
        foreach (var (name, content) in release.Files) await File.WriteAllBytesAsync(Path.Combine(directory, name), content);
        var node = await AgentAsync(host, "update-offline");
        await ExpectAsync(await host.Admin.PostAsync("/operator/v1/nodes/update-offline/agent-update", null), HttpStatusCode.Accepted);
        Assert.Empty(host.Releases.Requests);
        // The Operator's archives stay; the extracted binaries are served.
        Assert.Equal(3, Directory.GetFiles(directory, "*.tar.gz").Length);
        Assert.Equal(release.Binaries["linux-amd64"],
            (await host.NodeAsync($"/agent/v1/agent-releases/{Latest}/binaries/linux-amd64", node.Certificate)).Body);
    }

    [Fact]
    public async Task Several_Nodes_are_requested_at_once_with_a_result_each()
    {
        await using var host = Start(MakeRelease());
        await AgentAsync(host, "bulk-a");
        await AgentAsync(host, "bulk-b", capabilities: "disk-usage");
        await AgentAsync(host, "bulk-c", version: Latest);
        var response = await ExpectAsync(await host.Admin.PostAsJsonAsync("/operator/v1/agent-updates",
            new { nodes = new[] { "bulk-a", "bulk-b", "bulk-c", "bulk-missing" } }), HttpStatusCode.OK);
        Assert.Equal(Latest, response["targetVersion"]!.GetValue<string>());
        var items = response["items"]!.AsArray().Select(x => x!).ToArray();
        Assert.Equal(["bulk-a", "bulk-b", "bulk-c", "bulk-missing"], items.Select(x => x["node"]!.GetValue<string>()));
        Assert.Equal([true, false, false, false], items.Select(x => x["requested"]!.GetValue<bool>()));
        Assert.Equal(["", "agent_update_unsupported", "agent_update_current", "node_not_found"], items.Select(x => x["code"]?.GetValue<string>() ?? ""));
        Assert.Equal("requested", items[0]["agentUpdate"]!["state"]!.GetValue<string>());
        Assert.All(items.Skip(1), x => Assert.False(string.IsNullOrWhiteSpace(x["message"]!.GetValue<string>())));

        // allOutdated covers every outdated Node that is not revoked, including other tests' Nodes, so only these are checked.
        var all = await ExpectAsync(await host.Admin.PostAsJsonAsync("/operator/v1/agent-updates", new { allOutdated = true }), HttpStatusCode.OK);
        var byName = all["items"]!.AsArray().ToDictionary(x => x!["node"]!.GetValue<string>(), x => x!);
        Assert.True(byName["bulk-a"]["requested"]!.GetValue<bool>());
        Assert.Equal("agent_update_unsupported", byName["bulk-b"]["code"]!.GetValue<string>());
        Assert.False(byName.ContainsKey("bulk-c"));

        foreach (var body in new object[] { new { }, new { nodes = Array.Empty<string>() }, new { nodes = new[] { "bulk-a" }, allOutdated = true },
                     new { allOutdated = false }, new { nodes = new[] { " " } } })
            await ExpectAsync(await host.Admin.PostAsJsonAsync("/operator/v1/agent-updates", body), HttpStatusCode.BadRequest, "invalid_request");
    }

    [Fact]
    public async Task A_failed_update_replaces_the_outdated_issue_and_invalid_reports_are_rejected()
    {
        await using var host = Start(MakeRelease());
        var node = await AgentAsync(host, "update-failed");
        var outdated = await IssueAsync(host, $"agent_outdated:{node.NodeId.Value:D}");
        Assert.Contains("fleet nodes update update-failed", outdated!["commands"]!.AsArray().Select(x => x!.GetValue<string>()));
        await ExpectAsync(await host.Admin.PostAsync("/operator/v1/nodes/update-failed/agent-update", null), HttpStatusCode.Accepted);

        foreach (var body in new object[]
                 {
                     new { version = Latest, state = "failed", errorCode = (string?)null },
                     new { version = Latest, state = "failed", errorCode = "Bad Code" },
                     new { version = Latest, state = "downloading", errorCode = "agent_update_digest" },
                     new { version = Latest, state = "requested", errorCode = (string?)null },
                     new { version = "v0.12.0", state = "downloading", errorCode = (string?)null },
                     new { version = Latest, state = "downloading" },
                 })
        {
            var (status, _, text) = await host.NodeAsync("/agent/v1/agent-update/report", node.Certificate, body, "POST");
            Assert.True(status == 400, text);
        }

        Assert.Equal(204, await host.ReportAsync(node, "downloading"));
        Assert.Equal(204, await host.ReportAsync(node, "failed", "agent_update_smoke_test"));
        var update = (await host.DetailAsync("update-failed"))["agentUpdate"]!;
        Assert.Equal(("failed", "agent_update_smoke_test"), (update["state"]!.GetValue<string>(), update["errorCode"]!.GetValue<string>()));
        Assert.Null(await IssueAsync(host, $"agent_outdated:{node.NodeId.Value:D}"));
        var issue = (await IssueAsync(host, $"agent_update_failed:{node.NodeId.Value:D}"))!;
        Assert.Equal("agent_update_smoke_test", issue["errorCode"]!.GetValue<string>());
        Assert.Equal(ErrorCatalog.Find("agent_update_smoke_test")!.Fix[0], issue["action"]!.GetValue<string>());
        Assert.Contains("fleet nodes update update-failed", issue["commands"]!.AsArray().Select(x => x!.GetValue<string>()));
        Assert.Equal(1, await AuditCountAsync(node, "agent.update_failed"));
    }

    private static async Task<JsonNode?> IssueAsync(Host host, string id)
    {
        var issues = await OperatorApiFixture.ReadAsync(await host.Reader.GetAsync("/operator/v1/issues"));
        ContractShape.AssertMatches("issues.json", issues);
        return issues["items"]!.AsArray().SingleOrDefault(x => x!["id"]!.GetValue<string>() == id);
    }

    private static async Task<HttpClient> BrowserAsync(Host host, string token)
    {
        var browser = host.Factory.CreateDefaultClient(new Uri(OperatorApiFixture.Origin), new RawTargetHandler(), new CookieJarHandler());
        browser.DefaultRequestHeaders.Add("Origin", OperatorApiFixture.DashboardOrigin);
        await OperatorApiFixture.RefreshCsrfAsync(browser);
        (await browser.PostAsJsonAsync("/dashboard/api/login", OperatorApiFixture.LoginBody(token))).EnsureSuccessStatusCode();
        await OperatorApiFixture.RefreshCsrfAsync(browser);
        return browser;
    }

    private sealed class BrowserHandle(HttpClient client) : IAsyncDisposable
    {
        public HttpClient Client { get; } = client;

        public ValueTask DisposeAsync()
        {
            Client.Dispose();
            return ValueTask.CompletedTask;
        }
    }

    [Fact]
    public void Ed25519_verifies_the_RFC_8032_vector_and_OpenSSL_signatures_and_nothing_else()
    {
        // RFC 8032, section 7.1, TEST 1: the empty message.
        var rfcKey = Convert.FromHexString("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
        var rfcSignature = Convert.FromHexString(
            "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
        Assert.True(Ed25519.Verify(rfcKey, [], rfcSignature));
        Assert.False(Ed25519.Verify(rfcKey, [0], rfcSignature));

        var trusted = Ed25519.PublicKeyFromPem(keys.TrustedPublic);
        var other = Ed25519.PublicKeyFromPem(File.ReadAllText(Path.Combine(keys.Directory, "other.pem")));
        foreach (var length in new[] { 1, 63, 64, 1000 })
        {
            var message = RandomNumberGenerator.GetBytes(length);
            var signature = keys.Sign(message, keys.TrustedPrivate);
            Assert.True(Ed25519.Verify(trusted, message, signature));
            Assert.False(Ed25519.Verify(other, message, signature));
            var flipped = (byte[])message.Clone();
            flipped[^1] ^= 1;
            Assert.False(Ed25519.Verify(trusted, flipped, signature));
            for (var i = 0; i < 64; i += 21)
            {
                var broken = (byte[])signature.Clone();
                broken[i] ^= 0x10;
                Assert.False(Ed25519.Verify(trusted, message, broken));
            }
            Assert.False(Ed25519.Verify(trusted, message, signature[..63]));
        }
        Assert.Throws<FormatException>(() => Ed25519.PublicKeyFromPem(File.ReadAllText(keys.TrustedPrivate)));
        Assert.Throws<FormatException>(() => Ed25519.PublicKeyFromPem("not a key"));
    }

    [Fact]
    public void Configured_keys_are_validated_and_replace_the_embedded_ones()
    {
        var settings = new AgentReleaseOptions { PublicKeys = [keys.TrustedPublic] };
        Assert.True(settings.HasValidPublicKeys());
        Assert.Equal(Ed25519.PublicKeyFromPem(keys.TrustedPublic), Assert.Single(AgentReleaseMirror.LoadKeys(settings)));
        Assert.False(new AgentReleaseOptions { PublicKeys = ["-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----"] }.HasValidPublicKeys());
        Assert.False(new AgentReleaseOptions { PublicKeys = [keys.TrustedPublic, keys.TrustedPublic, keys.TrustedPublic] }.HasValidPublicKeys());
        Assert.True(new AgentReleaseOptions().HasValidBaseUrl());
        Assert.False(new AgentReleaseOptions { BaseUrl = "http://github.com/x" }.HasValidBaseUrl());
        Assert.False(new AgentReleaseOptions { BaseUrl = "https://user:secret@github.com/x" }.HasValidBaseUrl());
        // The embedded keys are exactly the committed public keys of the Agent.
        var committed = FindUpwards("clients/bins/fleet-agent/release-keys");
        if (committed is not null)
            Assert.Equal(Directory.GetFiles(committed, "*.pem").Order(StringComparer.Ordinal).Select(x => Ed25519.PublicKeyFromPem(File.ReadAllText(x))),
                AgentReleaseMirror.LoadKeys(new AgentReleaseOptions()));
    }

    [Fact]
    public void The_catalog_explains_every_code_the_Agent_updater_reports()
    {
        var updater = FindUpwards("clients/bins/fleet-agent/src/updater.rs");
        if (updater is null) return;
        var codes = System.Text.RegularExpressions.Regex.Matches(File.ReadAllText(updater), "\"(agent_update_[a-z_]+)\"")
            .Select(x => x.Groups[1].Value).Distinct().ToArray();
        Assert.True(codes.Length >= 10, "Expected to find the updater error codes in the Agent source.");
        Assert.All(codes, code => Assert.Equal(ErrorCatalog.Agent, ErrorCatalog.Find(code)?.Source));
    }

    private static string? FindUpwards(string relative)
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, relative);
            if (File.Exists(candidate) || Directory.Exists(candidate)) return candidate;
        }
        return null;
    }
}
