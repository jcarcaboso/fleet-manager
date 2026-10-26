using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Fleet.Core.Coordination;
using Fleet.Server.Persistence;
using Fleet.Server.Transport;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Fleet.Tests;

public sealed class TelemetryTests(OperatorApiFixture fixture) : IClassFixture<OperatorApiFixture>
{
    private static JsonObject Valid(string version = "0.9.0") => new()
    {
        ["agentVersion"] = version,
        ["os"] = new JsonObject { ["name"] = "Fedora Linux", ["version"] = "44", ["kernel"] = "7.2.11-200.fc44.x86_64" },
        ["arch"] = "x86_64",
        ["hostname"] = "studio-mini.home.arpa",
        ["user"] = "joan",
        ["installMethod"] = "homebrew",
        ["serviceManager"] = "launchd",
        ["stateDirectory"] = "~/.local/state/fleet-agent"
    };

    private async Task<(int Status, JsonElement Body)> PutAsync(EnrolledNode node, JsonNode body, string method = "PUT")
    {
        var result = await fixture.SendNodeAsync("/agent/v1/telemetry", node.Certificate, body, method);
        var length = result.Response.Body.Length;
        return (result.Response.StatusCode, length == 0 ? default : await JsonSerializer.DeserializeAsync<JsonElement>(result.Response.Body));
    }

    private static async Task<JsonNode> DetailAsync(HttpClient client, string alias) =>
        await OperatorApiFixture.ReadAsync(await client.GetAsync($"/operator/v1/nodes/{alias}"));

    private static async Task<JsonNode> ListRowAsync(HttpClient client, string alias)
    {
        var list = await OperatorApiFixture.ReadAsync(await client.GetAsync("/operator/v1/nodes?limit=100"));
        ContractShape.AssertMatches("nodes-page.json", list);
        return list["items"]!.AsArray().Single(x => x!["name"]!.GetValue<string>() == alias)!;
    }

    private static async Task<JsonNode?> IssueAsync(HttpClient client, EnrolledNode node)
    {
        var issues = await OperatorApiFixture.ReadAsync(await client.GetAsync("/operator/v1/issues"));
        ContractShape.AssertMatches("issues.json", issues);
        return issues["items"]!.AsArray().SingleOrDefault(x => x!["id"]!.GetValue<string>() == $"agent_outdated:{node.NodeId.Value:D}");
    }

    /// <summary>A Server host on the same database that believes <paramref name="latest"/> is the newest version. Returns an Operator client for it.</summary>
    private (WebApplicationFactory<Program> Factory, HttpClient Reader) HostWithLatest(string latest)
    {
        var factory = fixture.Factory.WithWebHostBuilder(builder => builder.ConfigureServices(services =>
            services.AddSingleton(new LatestAgentVersion(SemanticVersion.Parse(latest)))));
        var client = factory.CreateDefaultClient(new Uri(OperatorApiFixture.Origin), new RawTargetHandler());
        client.DefaultRequestHeaders.Authorization = new("Bearer", OperatorApiFixture.ReadToken);
        return (factory, client);
    }

    [Fact]
    public async Task A_report_is_stored_and_shown_in_the_Node_list_and_detail_to_a_read_Operator_under_both_prefixes()
    {
        var node = await fixture.EnrollAsync("tel-visible");
        Assert.Null((await ListRowAsync(fixture.Reader, "tel-visible"))["agent"]);
        Assert.Null((await DetailAsync(fixture.Reader, "tel-visible"))["agent"]);

        var before = DateTimeOffset.UtcNow;
        Assert.Equal(204, (await PutAsync(node, Valid())).Status);

        var agent = (await ListRowAsync(fixture.Reader, "tel-visible"))["agent"]!.AsObject();
        Assert.Equal(["version", "outdated", "os", "arch", "hostname"], agent.Select(x => x.Key));
        Assert.Equal("0.9.0", agent["version"]!.GetValue<string>());
        Assert.Equal(["name", "version"], agent["os"]!.AsObject().Select(x => x.Key));
        Assert.Equal("Fedora Linux", agent["os"]!["name"]!.GetValue<string>());
        Assert.Equal("44", agent["os"]!["version"]!.GetValue<string>());
        Assert.Equal("x86_64", agent["arch"]!.GetValue<string>());
        Assert.Equal("studio-mini.home.arpa", agent["hostname"]!.GetValue<string>());

        var detail = await DetailAsync(fixture.Reader, "tel-visible");
        ContractShape.AssertMatches("node-detail.json", detail);
        var full = detail["agent"]!.AsObject();
        Assert.Equal(["version", "latestVersion", "outdated", "os", "arch", "hostname", "user", "installMethod", "serviceManager",
            "stateDirectory", "reportedAt"], full.Select(x => x.Key));
        Assert.Equal(ServerVersion.Current.Text, full["latestVersion"]!.GetValue<string>());
        Assert.Equal("7.2.11-200.fc44.x86_64", full["os"]!["kernel"]!.GetValue<string>());
        Assert.Equal("joan", full["user"]!.GetValue<string>());
        Assert.Equal("homebrew", full["installMethod"]!.GetValue<string>());
        Assert.Equal("launchd", full["serviceManager"]!.GetValue<string>());
        Assert.Equal("~/.local/state/fleet-agent", full["stateDirectory"]!.GetValue<string>());
        Assert.InRange(full["reportedAt"]!.GetValue<DateTimeOffset>(), before.AddSeconds(-1), DateTimeOffset.UtcNow.AddSeconds(1));

        await using var browser = new Handle(await fixture.BrowserAsync(OperatorApiFixture.ReadToken));
        var dashboard = await OperatorApiFixture.ReadAsync(await browser.Client.GetAsync("/dashboard/api/nodes/tel-visible"));
        Assert.Equal("studio-mini.home.arpa", dashboard["agent"]!["hostname"]!.GetValue<string>());
        var dashboardList = await OperatorApiFixture.ReadAsync(await browser.Client.GetAsync("/dashboard/api/nodes?limit=100"));
        Assert.Equal("0.9.0", dashboardList["items"]!.AsArray().Single(x => x!["name"]!.GetValue<string>() == "tel-visible")!["agent"]!["version"]!
            .GetValue<string>());
    }

    [Fact]
    public async Task A_later_report_replaces_the_earlier_one_including_fields_that_became_null()
    {
        var node = await fixture.EnrollAsync("tel-replace");
        Assert.Equal(204, (await PutAsync(node, Valid("0.8.0"))).Status);
        var first = (await DetailAsync(fixture.Reader, "tel-replace"))["agent"]!["reportedAt"]!.GetValue<DateTimeOffset>();

        var second = new JsonObject
        {
            ["agentVersion"] = "0.9.1-rc.2",
            ["os"] = new JsonObject { ["name"] = null, ["version"] = null, ["kernel"] = null },
            ["arch"] = null,
            ["hostname"] = null,
            ["user"] = null,
            ["installMethod"] = null,
            ["serviceManager"] = null,
            ["stateDirectory"] = null
        };
        Assert.Equal(204, (await PutAsync(node, second)).Status);

        var agent = (await DetailAsync(fixture.Reader, "tel-replace"))["agent"]!.AsObject();
        Assert.Equal("0.9.1-rc.2", agent["version"]!.GetValue<string>());
        Assert.Null(agent["os"]!["name"]);
        Assert.Null(agent["os"]!["kernel"]);
        foreach (var name in new[] { "arch", "hostname", "user", "installMethod", "serviceManager", "stateDirectory" }) Assert.Null(agent[name]);
        Assert.True(agent["reportedAt"]!.GetValue<DateTimeOffset>() >= first);
        Assert.Null((await ListRowAsync(fixture.Reader, "tel-replace"))["agent"]!["hostname"]);

        using var scope = fixture.Scope();
        var db = scope.ServiceProvider.GetRequiredService<FleetDbContext>();
        Assert.Equal(1, await db.NodeTelemetries.CountAsync(x => x.NodeId == node.NodeId.Value));
    }

    [Fact]
    public async Task Control_characters_are_removed_before_the_length_is_checked_and_stored()
    {
        var node = await fixture.EnrollAsync("tel-control");
        var body = Valid();
        body["hostname"] = "host\u0000na\nme\t\u007f\u009b";
        body["user"] = new string('j', 128) + "\u0001\u0002\r\n";
        body["os"]!["name"] = "\u0000\n";
        body["stateDirectory"] = new string('d', 512) + "\n";
        Assert.Equal(204, (await PutAsync(node, body)).Status);
        var agent = (await DetailAsync(fixture.Reader, "tel-control"))["agent"]!;
        Assert.Equal("hostname", agent["hostname"]!.GetValue<string>());
        Assert.Equal(new string('j', 128), agent["user"]!.GetValue<string>());
        Assert.Equal(512, agent["stateDirectory"]!.GetValue<string>().Length);
        // Nothing is left of the name, so it is stored as absent.
        Assert.Null(agent["os"]!["name"]);

        var version = Valid("0.9.\u00000");
        Assert.Equal(204, (await PutAsync(node, version)).Status);
        Assert.Equal("0.9.0", (await DetailAsync(fixture.Reader, "tel-control"))["agent"]!["version"]!.GetValue<string>());
    }

    private static readonly Dictionary<string, Action<JsonObject>> Invalid = new()
    {
        ["version two parts"] = x => x["agentVersion"] = "0.9",
        ["version v prefix"] = x => x["agentVersion"] = "v0.9.0",
        ["version leading zero"] = x => x["agentVersion"] = "0.09.0",
        ["version build metadata"] = x => x["agentVersion"] = "0.9.0+abc",
        ["version empty prerelease"] = x => x["agentVersion"] = "0.9.0-",
        ["version words"] = x => x["agentVersion"] = "latest",
        ["version empty"] = x => x["agentVersion"] = "",
        ["version only control characters"] = x => x["agentVersion"] = "\u0000\n",
        ["version null"] = x => x["agentVersion"] = null,
        ["version number"] = x => x["agentVersion"] = 9,
        ["version too long"] = x => x["agentVersion"] = "0.9.0-" + new string('a', 123),
        ["install method unknown"] = x => x["installMethod"] = "apt",
        ["install method case"] = x => x["installMethod"] = "Homebrew",
        ["install method empty"] = x => x["installMethod"] = "",
        ["service manager unknown"] = x => x["serviceManager"] = "runit",
        ["service manager case"] = x => x["serviceManager"] = "SystemD",
        ["os name too long"] = x => x["os"]!["name"] = new string('n', 129),
        ["os version too long"] = x => x["os"]!["version"] = new string('v', 129),
        ["os kernel too long"] = x => x["os"]!["kernel"] = new string('k', 129),
        ["arch too long"] = x => x["arch"] = new string('a', 129),
        ["hostname too long"] = x => x["hostname"] = new string('h', 129),
        ["user too long"] = x => x["user"] = new string('u', 129),
        ["state directory too long"] = x => x["stateDirectory"] = new string('s', 513),
        ["hostname number"] = x => x["hostname"] = 5,
        ["hostname object"] = x => x["hostname"] = new JsonObject(),
        ["os null"] = x => x["os"] = null,
        ["os string"] = x => x["os"] = "linux",
        ["unknown member"] = x => x["extra"] = true,
        ["unknown os member"] = x => x["os"]!["build"] = "1",
        ["missing agentVersion"] = x => x.Remove("agentVersion"),
        ["missing os"] = x => x.Remove("os"),
        ["missing os name"] = x => x["os"]!.AsObject().Remove("name"),
        ["missing os version"] = x => x["os"]!.AsObject().Remove("version"),
        ["missing os kernel"] = x => x["os"]!.AsObject().Remove("kernel"),
        ["missing arch"] = x => x.Remove("arch"),
        ["missing hostname"] = x => x.Remove("hostname"),
        ["missing user"] = x => x.Remove("user"),
        ["missing installMethod"] = x => x.Remove("installMethod"),
        ["missing serviceManager"] = x => x.Remove("serviceManager"),
        ["missing stateDirectory"] = x => x.Remove("stateDirectory"),
        ["empty object"] = x => x.Clear(),
    };

    public static TheoryData<string> InvalidNames => new(Invalid.Keys);

    [Theory]
    [MemberData(nameof(InvalidNames))]
    public async Task Invalid_reports_get_a_400_and_leave_the_stored_report_alone(string name)
    {
        var alias = "tel-invalid-" + name.Replace(' ', '-');
        var node = await fixture.EnrollAsync(alias);
        Assert.Equal(204, (await PutAsync(node, Valid("0.8.5"))).Status);
        var body = Valid();
        Invalid[name](body);

        var (status, response) = await PutAsync(node, body);
        Assert.Equal(400, status);
        Assert.Equal("invalid_request", response.GetProperty("code").GetString());
        Assert.False(string.IsNullOrWhiteSpace(response.GetProperty("message").GetString()), name);
        Assert.Equal("0.8.5", (await DetailAsync(fixture.Reader, alias))["agent"]!["version"]!.GetValue<string>());
    }

    [Theory]
    [InlineData("empty", "")]
    [InlineData("null", "null")]
    [InlineData("array", "[]")]
    [InlineData("truncated", "{")]
    public async Task A_body_that_is_not_an_object_gets_a_400(string name, string json)
    {
        var node = await fixture.EnrollAsync("tel-body-" + name);
        var result = await RawAsync(node, json);
        Assert.Equal(400, result.Response.StatusCode);
        Assert.Equal("invalid_request", (await JsonSerializer.DeserializeAsync<JsonElement>(result.Response.Body)).GetProperty("code").GetString());
    }

    private async Task<Microsoft.AspNetCore.Http.HttpContext> RawAsync(EnrolledNode node, string json)
    {
        using var client = new HttpClient(fixture.Factory.Server.CreateHandler(context =>
        {
            context.Connection.ClientCertificate = node.Certificate;
            context.Connection.RemoteIpAddress = IPAddress.Loopback;
        }))
        { BaseAddress = new Uri(OperatorApiFixture.Origin) };
        using var request = new HttpRequestMessage(HttpMethod.Put, "/agent/v1/telemetry")
        {
            Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json")
        };
        using var response = await client.SendAsync(request);
        var result = new Microsoft.AspNetCore.Http.DefaultHttpContext();
        result.Response.StatusCode = (int)response.StatusCode;
        result.Response.Body = new MemoryStream(await response.Content.ReadAsByteArrayAsync());
        return result;
    }

    [Fact]
    public async Task Values_at_the_length_limits_and_prerelease_tags_are_accepted()
    {
        var node = await fixture.EnrollAsync("tel-limits");
        var body = Valid("10.20.30-alpha-1.rc.0");
        body["hostname"] = new string('h', 128);
        body["stateDirectory"] = new string('s', 512);
        body["installMethod"] = "cargo";
        body["serviceManager"] = "none";
        Assert.Equal(204, (await PutAsync(node, body)).Status);
        var agent = (await DetailAsync(fixture.Reader, "tel-limits"))["agent"]!;
        Assert.Equal("10.20.30-alpha-1.rc.0", agent["version"]!.GetValue<string>());
        Assert.Equal("none", agent["serviceManager"]!.GetValue<string>());
    }

    [Fact]
    public async Task Reports_need_the_Node_certificate_an_active_Node_and_the_route_accepts_only_PUT()
    {
        var node = await fixture.EnrollAsync("tel-auth");
        using var anonymous = await fixture.Anonymous.PutAsJsonAsync("/agent/v1/telemetry", Valid());
        Assert.True(anonymous.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden, anonymous.StatusCode.ToString());
        Assert.Equal(405, (await PutAsync(node, Valid(), "POST")).Status);
        Assert.Null((await DetailAsync(fixture.Reader, "tel-auth"))["agent"]);

        (await fixture.Admin.PostAsync($"/operator/v1/nodes/{node.NodeId.Value}/revoke", null)).EnsureSuccessStatusCode();
        Assert.Equal(401, (await PutAsync(node, Valid())).Status);
        Assert.Null((await DetailAsync(fixture.Reader, "tel-auth"))["agent"]);
    }

    [Fact]
    public async Task Telemetry_and_disk_reports_share_one_per_Node_bucket_with_a_message_on_429()
    {
        var noisy = await fixture.EnrollAsync("tel-noisy");
        var calm = await fixture.EnrollAsync("tel-calm");
        fixture.FreezeRateLimit(noisy);
        var results = await Task.WhenAll(Enumerable.Range(0, NodeRequestRateLimit.Burst + 40).Select(_ => PutAsync(noisy, Valid())));
        Assert.Contains(results, x => x.Status == 204);
        var limited = results.Where(x => x.Status == 429).ToArray();
        Assert.NotEmpty(limited);
        Assert.All(limited, x =>
        {
            Assert.Equal("rate_limited", x.Body.GetProperty("code").GetString());
            Assert.False(string.IsNullOrWhiteSpace(x.Body.GetProperty("message").GetString()));
        });
        Assert.All(results, x => Assert.True(x.Status is 204 or 429, x.Status.ToString()));
        Assert.Equal(NodeRequestRateLimit.Burst, results.Count(x => x.Status == 204));

        // The same bucket limits disk usage reports and attempt detail.
        var disk = await fixture.SendNodeAsync("/agent/v1/disk-usage", noisy.Certificate,
            new { volumes = new[] { new { label = "home", totalBytes = 1000, usedBytes = 100, availableBytes = 800 } } }, "PUT");
        Assert.Equal(429, disk.Response.StatusCode);
        Assert.Equal(204, (await PutAsync(calm, Valid())).Status);

        // And the other way round: a Node that used its burst on disk reports is limited for telemetry.
        var diskNoisy = await fixture.EnrollAsync("tel-disk-noisy");
        fixture.FreezeRateLimit(diskNoisy);
        var disks = await Task.WhenAll(Enumerable.Range(0, NodeRequestRateLimit.Burst + 40).Select(_ => fixture.SendNodeAsync(
            "/agent/v1/disk-usage", diskNoisy.Certificate,
            new { volumes = new[] { new { label = "home", totalBytes = 1000, usedBytes = 100, availableBytes = 800 } } }, "PUT")));
        Assert.Contains(disks, x => x.Response.StatusCode == 429);
        Assert.Equal(429, (await PutAsync(diskNoisy, Valid())).Status);
        Assert.Null((await DetailAsync(fixture.Reader, "tel-disk-noisy"))["agent"]);
    }

    [Fact]
    public async Task The_poll_response_has_the_same_shape_with_and_without_telemetry()
    {
        var node = await fixture.EnrollAsync("tel-poll");
        string[] shape = ["workspaceId", "nodeId", "assignment", "nextPollSeconds"];
        async Task<string[]> KeysAsync()
        {
            var result = await fixture.SendNodeAsync("/agent/v1/poll", node.Certificate, null, "POST");
            Assert.Equal(200, result.Response.StatusCode);
            return JsonNode.Parse(await new StreamReader(result.Response.Body).ReadToEndAsync())!.AsObject().Select(x => x.Key).ToArray();
        }
        Assert.Equal(shape, await KeysAsync());
        Assert.Equal(204, (await PutAsync(node, Valid())).Status);
        Assert.Equal(shape, await KeysAsync());
    }

    [Theory]
    [InlineData("0.9.0", "0.8.9", true)]
    [InlineData("0.9.0", "0.9.0", false)]
    [InlineData("0.9.0", "1.0.0", false)]
    [InlineData("0.9.0", "0.9.0-rc.1", true)]
    [InlineData("0.9.0", "0.10.0-rc.1", false)]
    [InlineData("0.9.0-rc.1", "0.9.0-beta.3", true)]
    [InlineData("0.9.0-rc.1", "0.9.0-rc.1", false)]
    [InlineData("0.9.0-rc.1", "0.9.0", false)]
    [InlineData("0.9.0", "0.9.0-0", true)]
    [InlineData("1.0.0", "0.99.99", true)]
    public async Task Outdated_is_computed_against_the_latest_version_in_the_list_the_detail_and_the_issues(string latest, string running, bool outdated)
    {
        var alias = $"tel-outdated-{latest}-{running}".Replace('.', '-');
        var node = await fixture.EnrollAsync(alias);
        Assert.Equal(204, (await PutAsync(node, Valid(running))).Status);
        var (factory, reader) = HostWithLatest(latest);
        await using var _ = factory;
        using var __ = reader;

        Assert.Equal(outdated, (await ListRowAsync(reader, alias))["agent"]!["outdated"]!.GetValue<bool>());
        var detail = (await DetailAsync(reader, alias))["agent"]!;
        Assert.Equal(outdated, detail["outdated"]!.GetValue<bool>());
        Assert.Equal(latest, detail["latestVersion"]!.GetValue<string>());
        Assert.Equal(outdated, await IssueAsync(reader, node) is not null);
    }

    [Theory]
    [InlineData("homebrew", "brew upgrade fleet-agent")]
    [InlineData("cargo", "cargo install --locked --force")]
    [InlineData("binary", "release archive")]
    [InlineData(null, "release archive")]
    public async Task The_agent_outdated_issue_names_both_versions_and_the_upgrade_for_the_install_method(string? installMethod, string expected)
    {
        var alias = $"tel-issue-{installMethod ?? "unknown"}";
        var node = await fixture.EnrollAsync(alias);
        var body = Valid("0.8.0");
        body["installMethod"] = installMethod;
        Assert.Equal(204, (await PutAsync(node, body)).Status);
        var (factory, reader) = HostWithLatest("0.9.0");
        await using var _ = factory;
        using var __ = reader;

        var issue = (await IssueAsync(reader, node))!;
        Assert.Equal("agent_outdated", issue["code"]!.GetValue<string>());
        Assert.Equal("warning", issue["severity"]!.GetValue<string>());
        Assert.Equal("nodes", issue["section"]!.GetValue<string>());
        Assert.Equal(node.NodeId.Value, issue["nodeId"]!.GetValue<Guid>());
        Assert.Equal(alias, issue["nodeName"]!.GetValue<string>());
        Assert.Null(issue["target"]);
        Assert.Null(issue["errorCode"]);
        var detail = issue["detail"]!.GetValue<string>();
        Assert.Contains("0.8.0", detail);
        Assert.Contains("0.9.0", detail);
        Assert.Contains(expected, issue["action"]!.GetValue<string>());
        Assert.Equal([$"fleet nodes show {alias}"], issue["commands"]!.AsArray().Select(x => x!.GetValue<string>()));
        Assert.Equal((await DetailAsync(reader, alias))["agent"]!["reportedAt"]!.GetValue<DateTimeOffset>(), issue["since"]!.GetValue<DateTimeOffset>());
    }

    [Fact]
    public async Task The_agent_outdated_issue_is_absent_without_telemetry_when_current_and_for_revoked_Nodes()
    {
        var silent = await fixture.EnrollAsync("tel-silent");
        var current = await fixture.EnrollAsync("tel-current");
        var revoked = await fixture.EnrollAsync("tel-revoked");
        Assert.Equal(204, (await PutAsync(current, Valid("0.9.0"))).Status);
        Assert.Equal(204, (await PutAsync(revoked, Valid("0.1.0"))).Status);
        var (factory, reader) = HostWithLatest("0.9.0");
        await using var _ = factory;
        using var __ = reader;

        Assert.NotNull(await IssueAsync(reader, revoked));
        (await fixture.Admin.PostAsync($"/operator/v1/nodes/{revoked.NodeId.Value}/revoke", null)).EnsureSuccessStatusCode();
        Assert.Null(await IssueAsync(reader, silent));
        Assert.Null(await IssueAsync(reader, current));
        Assert.Null(await IssueAsync(reader, revoked));
        // The revoked Node still shows what it last reported.
        Assert.True((await DetailAsync(reader, "tel-revoked"))["agent"]!["outdated"]!.GetValue<bool>());
    }

    [Fact]
    public void The_catalog_explains_the_issue_and_points_to_the_update_documents()
    {
        var entry = ErrorCatalog.Find("agent_outdated")!;
        Assert.Equal(ErrorCatalog.Issue, entry.Source);
        var steps = string.Join('\n', entry.Fix);
        Assert.Contains("brew upgrade fleet-agent", steps, StringComparison.Ordinal);
        Assert.Contains("docs/technical-design/client-updates.md", steps, StringComparison.Ordinal);
        Assert.Contains("docs/technical-design/cli-installation.md", steps, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Migration_adds_the_table_with_bounded_columns_and_the_row_goes_with_the_Node()
    {
        using var scope = fixture.Scope();
        var db = scope.ServiceProvider.GetRequiredService<FleetDbContext>();
        Assert.False(db.Database.HasPendingModelChanges());
        Assert.Contains("20261026160000_AddNodeTelemetry", await db.Database.GetAppliedMigrationsAsync());
        Assert.Equal(["AgentVersion:character varying:128:NO", "Arch:character varying:128:YES", "Hostname:character varying:128:YES",
            "InstallMethod:character varying:16:YES", "NodeId:uuid::NO", "OsKernel:character varying:128:YES", "OsName:character varying:128:YES",
            "OsVersion:character varying:128:YES", "ReportedAt:timestamp with time zone::NO", "ServiceManager:character varying:16:YES",
            "StateDirectory:character varying:512:YES", "User:character varying:128:YES"], await db.Database.SqlQuery<string>($"""
            SELECT column_name || ':' || data_type || ':' || COALESCE(character_maximum_length::text, '') || ':' || is_nullable AS "Value"
            FROM information_schema.columns WHERE table_name = 'node_telemetry' ORDER BY column_name
            """).ToListAsync());

        var node = await fixture.EnrollAsync("tel-cascade");
        Assert.Equal(204, (await PutAsync(node, Valid())).Status);
        Assert.Equal(1, await db.NodeTelemetries.CountAsync(x => x.NodeId == node.NodeId.Value));
        (await fixture.Admin.PostAsync($"/operator/v1/nodes/{node.NodeId.Value}/revoke", null)).EnsureSuccessStatusCode();
        (await fixture.Admin.PostAsJsonAsync($"/operator/v1/nodes/{node.NodeId.Value}/remove", new { alias = "tel-cascade" })).EnsureSuccessStatusCode();
        Assert.Equal(0, await db.NodeTelemetries.CountAsync(x => x.NodeId == node.NodeId.Value));
    }

    [Fact]
    public async Task Concurrent_reports_queue_behind_the_Node_row_lock_and_leave_exactly_one_row()
    {
        var node = await fixture.EnrollAsync("tel-race");
        using var authScope = fixture.Scope();
        var authentication = (await authScope.ServiceProvider.GetRequiredService<IFleetCoordinator>().FindActiveNodeByCertificateAsync(
            node.Certificate.GetCertHashString(System.Security.Cryptography.HashAlgorithmName.SHA256).ToLowerInvariant()))!;

        using var holderScope = fixture.Scope();
        var holderDb = holderScope.ServiceProvider.GetRequiredService<FleetDbContext>();
        await using var holder = await holderDb.Database.BeginTransactionAsync();
        var id = node.NodeId.Value;
        await holderDb.Database.ExecuteSqlInterpolatedAsync($"SELECT 1 FROM nodes WHERE \"Id\" = {id} FOR UPDATE");

        Task Report(string version)
        {
            var scope = fixture.Scope();
            var coordinator = scope.ServiceProvider.GetRequiredService<IFleetCoordinator>();
            return coordinator.RecordAgentTelemetryAsync(authentication, new(version, null, null, null, null, null, null, null, null, null))
                .ContinueWith(_ => scope.Dispose(), TaskScheduler.Default);
        }
        var a = Report("0.9.1");
        var b = Report("0.9.2");
        await Task.WhenAny(Task.WhenAll(a, b), Task.Delay(500));
        Assert.False(a.IsCompleted || b.IsCompleted, "The report did not wait for the Node row lock.");
        await holder.CommitAsync();
        await Task.WhenAll(a, b);
        using var check = fixture.Scope();
        var rows = await check.ServiceProvider.GetRequiredService<FleetDbContext>().NodeTelemetries.AsNoTracking()
            .Where(x => x.NodeId == id).ToListAsync();
        var only = Assert.Single(rows);
        Assert.Contains(only.AgentVersion, new[] { "0.9.1", "0.9.2" });
    }

    private sealed class Handle(HttpClient client) : IAsyncDisposable
    {
        public HttpClient Client { get; } = client;

        public ValueTask DisposeAsync()
        {
            Client.Dispose();
            return ValueTask.CompletedTask;
        }
    }
}
