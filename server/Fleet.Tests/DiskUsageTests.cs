using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Fleet.Core.Coordination;
using Fleet.Server.Persistence;
using Fleet.Server.Transport;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Fleet.Tests;

public sealed class DiskUsageTests(OperatorApiFixture fixture) : IClassFixture<OperatorApiFixture>
{
    private const long Total = 994_662_584_320;
    private const long Used = 871_203_905_536;
    private const long Available = 72_818_462_720;

    private static object Volume(string label, long total, long used, long available) =>
        new { label, totalBytes = total, usedBytes = used, availableBytes = available };

    private async Task<(int Status, JsonElement Body)> PutAsync(EnrolledNode node, object body)
    {
        var result = await fixture.SendNodeAsync("/agent/v1/disk-usage", node.Certificate, body, "PUT");
        var length = result.Response.Body.Length;
        return (result.Response.StatusCode, length == 0 ? default : await JsonSerializer.DeserializeAsync<JsonElement>(result.Response.Body));
    }

    private Task<(int Status, JsonElement Body)> ReportAsync(EnrolledNode node, params (string Label, long Total, long Used, long Available)[] volumes) =>
        PutAsync(node, new { volumes = volumes.Select(x => Volume(x.Label, x.Total, x.Used, x.Available)).ToArray() });

    private async Task<(int Status, string Text)> PollAsync(EnrolledNode node, string? capabilities)
    {
        var result = await fixture.SendNodeAsync("/agent/v1/poll", node.Certificate, null, "POST", capabilities);
        return (result.Response.StatusCode, await new StreamReader(result.Response.Body).ReadToEndAsync());
    }

    private async Task<JsonNode> DetailAsync(string alias) =>
        await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync($"/operator/v1/nodes/{alias}"));

    private async Task<JsonNode> ListRowAsync(string alias)
    {
        var list = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/nodes?limit=100"));
        return list["items"]!.AsArray().Single(x => x!["name"]!.GetValue<string>() == alias)!;
    }

    private async Task<JsonNode?> IssueAsync(EnrolledNode node, string code)
    {
        var issues = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/issues"));
        ContractShape.AssertMatches("issues.json", issues);
        return issues["items"]!.AsArray().SingleOrDefault(x => x!["id"]!.GetValue<string>() == $"{code}:{node.NodeId.Value:D}");
    }

    [Fact]
    public async Task A_report_is_stored_and_shown_in_the_Node_list_and_detail_under_both_prefixes()
    {
        var node = await fixture.EnrollAsync("disk-visible");
        Assert.Null((await ListRowAsync("disk-visible"))["disk"]);
        Assert.Null((await DetailAsync("disk-visible"))["disk"]);

        var before = DateTimeOffset.UtcNow;
        Assert.Equal(204, (await ReportAsync(node, ("home", Total, Used, Available), ("state", 100, 10, 50))).Status);

        var row = await ListRowAsync("disk-visible");
        var list = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/nodes?limit=100"));
        ContractShape.AssertMatches("nodes-page.json", list);
        var disk = row["disk"]!;
        // The fullest volume: home is 92.3% used, state only 16.7%.
        Assert.Equal("home", disk["label"]!.GetValue<string>());
        Assert.Equal(92.3, disk["usedPercent"]!.GetValue<double>());
        Assert.Equal(Used, disk["usedBytes"]!.GetValue<long>());
        Assert.Equal(Available, disk["availableBytes"]!.GetValue<long>());
        Assert.Equal(Total, disk["totalBytes"]!.GetValue<long>());
        var measured = disk["measuredAt"]!.GetValue<DateTimeOffset>();
        Assert.InRange(measured, before.AddSeconds(-1), DateTimeOffset.UtcNow.AddSeconds(1));

        var detail = await DetailAsync("disk-visible");
        ContractShape.AssertMatches("node-detail.json", detail);
        var volumes = detail["disk"]!["volumes"]!.AsArray();
        Assert.Equal(["home", "state"], volumes.Select(x => x!["label"]!.GetValue<string>()));
        Assert.Equal([92.3, 16.7], volumes.Select(x => x!["usedPercent"]!.GetValue<double>()));
        Assert.Equal(measured, detail["disk"]!["measuredAt"]!.GetValue<DateTimeOffset>());
        Assert.Null(detail["disk"]!["refreshRequestedAt"]);

        await using var browser = new Handle(await fixture.BrowserAsync(OperatorApiFixture.ReadToken));
        var dashboard = await OperatorApiFixture.ReadAsync(await browser.Client.GetAsync("/dashboard/api/nodes/disk-visible"));
        Assert.Equal(92.3, dashboard["disk"]!["volumes"]![0]!["usedPercent"]!.GetValue<double>());
        var dashboardList = await OperatorApiFixture.ReadAsync(await browser.Client.GetAsync("/dashboard/api/nodes?limit=100"));
        Assert.Equal("home", dashboardList["items"]!.AsArray().Single(x => x!["name"]!.GetValue<string>() == "disk-visible")!["disk"]!["label"]!.GetValue<string>());
    }

    [Fact]
    public async Task A_new_report_replaces_every_volume_and_a_zero_size_volume_is_zero_percent()
    {
        var node = await fixture.EnrollAsync("disk-replace");
        Assert.Equal(204, (await ReportAsync(node, ("home", 1000, 500, 400), ("state", 1000, 900, 50))).Status);
        Assert.Equal(2, (await DetailAsync("disk-replace"))["disk"]!["volumes"]!.AsArray().Count);

        Assert.Equal(204, (await ReportAsync(node, ("home", 2000, 100, 1800))).Status);
        var volumes = (await DetailAsync("disk-replace"))["disk"]!["volumes"]!.AsArray();
        var only = Assert.Single(volumes)!;
        Assert.Equal(("home", 2000L, 100L, 1800L, 5.3), (only["label"]!.GetValue<string>(), only["totalBytes"]!.GetValue<long>(),
            only["usedBytes"]!.GetValue<long>(), only["availableBytes"]!.GetValue<long>(), only["usedPercent"]!.GetValue<double>()));
        Assert.Equal("home", (await ListRowAsync("disk-replace"))["disk"]!["label"]!.GetValue<string>());

        // Only the state volume this time: home is dropped.
        Assert.Equal(204, (await ReportAsync(node, ("state", 0, 0, 0))).Status);
        var state = Assert.Single((await DetailAsync("disk-replace"))["disk"]!["volumes"]!.AsArray())!;
        Assert.Equal(("state", 0.0), (state["label"]!.GetValue<string>(), state["usedPercent"]!.GetValue<double>()));

        using var scope = fixture.Scope();
        var db = scope.ServiceProvider.GetRequiredService<FleetDbContext>();
        Assert.Equal(["state"], await db.NodeDiskUsages.Where(x => x.NodeId == node.NodeId.Value).Select(x => x.Label).ToListAsync());
    }

    public static TheoryData<string, object> InvalidReports => new()
    {
        { "no volumes", new { volumes = Array.Empty<object>() } },
        { "volumes null", new { volumes = (object?)null } },
        { "volumes missing", new { } },
        { "three volumes", new { volumes = new[] { Volume("home", 10, 1, 1), Volume("state", 10, 1, 1), Volume("home", 10, 1, 1) } } },
        { "duplicate label", new { volumes = new[] { Volume("home", 10, 1, 1), Volume("home", 10, 1, 1) } } },
        { "unknown label", new { volumes = new[] { Volume("data", 10, 1, 1) } } },
        { "label case", new { volumes = new[] { Volume("Home", 10, 1, 1) } } },
        { "negative total", new { volumes = new[] { Volume("home", -1, 0, 0) } } },
        { "negative used", new { volumes = new[] { Volume("home", 10, -1, 1) } } },
        { "negative available", new { volumes = new[] { Volume("home", 10, 1, -1) } } },
        { "used plus available above total", new { volumes = new[] { Volume("home", 100, 60, 41) } } },
        { "used above total", new { volumes = new[] { Volume("home", 100, 101, 0) } } },
        { "sum overflows a long", new { volumes = new[] { Volume("home", long.MaxValue, long.MaxValue, long.MaxValue) } } },
        { "missing field", new { volumes = new[] { new { label = "home", totalBytes = 10, usedBytes = 1 } } } },
        { "null volume", new { volumes = new object?[] { null } } },
        { "fractional bytes", new { volumes = new[] { new { label = "home", totalBytes = 10.5, usedBytes = 1, availableBytes = 1 } } } },
        { "unknown member", new { volumes = new[] { Volume("home", 10, 1, 1) }, extra = true } },
        { "unknown volume member", new { volumes = new[] { new { label = "home", totalBytes = 10, usedBytes = 1, availableBytes = 1, path = "/" } } } },
    };

    [Theory]
    [MemberData(nameof(InvalidReports))]
    public async Task Invalid_reports_get_a_400_and_leave_the_stored_report_alone(string name, object body)
    {
        var alias = "disk-invalid-" + name.Replace(' ', '-');
        var node = await fixture.EnrollAsync(alias);
        Assert.Equal(204, (await ReportAsync(node, ("home", 1000, 100, 800))).Status);

        var (status, response) = await PutAsync(node, body);
        Assert.Equal(400, status);
        Assert.Equal("invalid_request", response.GetProperty("code").GetString());
        Assert.False(string.IsNullOrWhiteSpace(response.GetProperty("message").GetString()), name);
        var volume = Assert.Single((await DetailAsync(alias))["disk"]!["volumes"]!.AsArray())!;
        Assert.Equal(100, volume["usedBytes"]!.GetValue<long>());
    }

    [Fact]
    public async Task Reports_need_the_Node_certificate_and_the_route_accepts_only_PUT()
    {
        var node = await fixture.EnrollAsync("disk-auth");
        using var anonymous = await fixture.Anonymous.PutAsJsonAsync("/agent/v1/disk-usage", new { volumes = new[] { Volume("home", 10, 1, 1) } });
        Assert.True(anonymous.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden, anonymous.StatusCode.ToString());
        var post = await fixture.SendNodeAsync("/agent/v1/disk-usage", node.Certificate, new { volumes = new[] { Volume("home", 10, 1, 1) } });
        Assert.Equal(405, post.Response.StatusCode);
        Assert.Null((await DetailAsync("disk-auth"))["disk"]);
    }

    [Fact]
    public async Task Disk_reports_and_attempt_detail_share_one_per_Node_bucket()
    {
        var noisy = await fixture.EnrollAsync("disk-noisy");
        var calm = await fixture.EnrollAsync("disk-calm");
        var results = await Task.WhenAll(Enumerable.Range(0, NodeRequestRateLimit.Burst + 40)
            .Select(_ => PutAsync(noisy, new { volumes = new[] { Volume("home", 1000, 100, 800) } })));
        Assert.Contains(results, x => x.Status == 204);
        var limited = results.Where(x => x.Status == 429).ToArray();
        Assert.NotEmpty(limited);
        Assert.All(limited, x =>
        {
            Assert.Equal("rate_limited", x.Body.GetProperty("code").GetString());
            Assert.False(string.IsNullOrWhiteSpace(x.Body.GetProperty("message").GetString()));
        });
        Assert.All(results, x => Assert.True(x.Status is 204 or 429, x.Status.ToString()));
        Assert.True(results.Count(x => x.Status == 204) <= NodeRequestRateLimit.Burst + 5);

        // The same bucket also limits attempt detail (an unlimited request would be a 404 for the unknown Attempt).
        var detail = await fixture.SendNodeAsync($"/agent/v1/attempts/{Guid.NewGuid()}/detail", noisy.Certificate, new { diagnostic = "x" });
        Assert.Equal(429, detail.Response.StatusCode);
        // Other Nodes are unaffected.
        Assert.Equal(204, (await ReportAsync(calm, ("home", 1000, 100, 800))).Status);
    }

    [Fact]
    public async Task A_refresh_request_reaches_the_Agent_on_its_next_poll_and_the_report_clears_it()
    {
        var node = await fixture.EnrollAsync("disk-refresh");
        Assert.Equal(204, (await ReportAsync(node, ("home", 1000, 100, 800))).Status);
        Assert.DoesNotContain("diskUsageRequested", (await PollAsync(node, "disk-usage")).Text);

        var first = await OperatorApiFixture.ReadAsync(await fixture.Operate.PostAsync("/operator/v1/nodes/disk-refresh/disk-usage/refresh", null),
            HttpStatusCode.Accepted);
        var requestedAt = first["refreshRequestedAt"]!.GetValue<DateTimeOffset>();
        Assert.InRange(requestedAt, DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddSeconds(1));

        // A repeat, by ID and through the dashboard, keeps the original timestamp.
        var repeat = await OperatorApiFixture.ReadAsync(await fixture.Operate.PostAsync(
            $"/operator/v1/nodes/{node.NodeId.Value}/disk-usage/refresh", null), HttpStatusCode.Accepted);
        Assert.Equal(requestedAt, repeat["refreshRequestedAt"]!.GetValue<DateTimeOffset>());
        await using (var browser = new Handle(await fixture.BrowserAsync(OperatorApiFixture.OperateToken)))
        {
            var again = await OperatorApiFixture.ReadAsync(await browser.Client.PostAsync("/dashboard/api/nodes/disk-refresh/disk-usage/refresh", null),
                HttpStatusCode.Accepted);
            Assert.Equal(requestedAt, again["refreshRequestedAt"]!.GetValue<DateTimeOffset>());
        }
        var pending = (await DetailAsync("disk-refresh"))["disk"]!;
        Assert.Equal(requestedAt, pending["refreshRequestedAt"]!.GetValue<DateTimeOffset>());
        Assert.Single(pending["volumes"]!.AsArray());

        // Only an Agent that announces the capability sees the flag; the header is a comma-separated, case-insensitive list.
        foreach (var capabilities in new[] { "disk-usage", "DISK-USAGE", " other , Disk-Usage ", "future-thing,disk-usage" })
        {
            var (status, text) = await PollAsync(node, capabilities);
            Assert.Equal(200, status);
            Assert.True(JsonNode.Parse(text)!["diskUsageRequested"]!.GetValue<bool>(), capabilities);
        }
        // The flag stays until the Agent reports.
        Assert.Contains("\"diskUsageRequested\":true", (await PollAsync(node, "disk-usage")).Text);

        Assert.Equal(204, (await ReportAsync(node, ("home", 1000, 110, 790))).Status);
        Assert.DoesNotContain("diskUsageRequested", (await PollAsync(node, "disk-usage")).Text);
        Assert.Null((await DetailAsync("disk-refresh"))["disk"]!["refreshRequestedAt"]);

        // A new request after the report gets a new timestamp.
        var second = await OperatorApiFixture.ReadAsync(await fixture.Operate.PostAsync("/operator/v1/nodes/disk-refresh/disk-usage/refresh", null),
            HttpStatusCode.Accepted);
        Assert.True(second["refreshRequestedAt"]!.GetValue<DateTimeOffset>() > requestedAt);

        // One audit event per request that was recorded; repeats are not new requests.
        var audit = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/audit?node=disk-refresh"));
        Assert.Equal(2, audit["items"]!.AsArray().Count(x => x!["action"]!.GetValue<string>() == "node.disk_refresh_requested"));
    }

    [Fact]
    public async Task A_refresh_request_before_the_first_report_shows_in_the_detail_without_volumes()
    {
        var node = await fixture.EnrollAsync("disk-first");
        (await fixture.Operate.PostAsync("/operator/v1/nodes/disk-first/disk-usage/refresh", null)).EnsureSuccessStatusCode();
        var disk = (await DetailAsync("disk-first"))["disk"]!;
        Assert.Null(disk["measuredAt"]);
        Assert.NotNull(disk["refreshRequestedAt"]);
        Assert.Empty(disk["volumes"]!.AsArray());
        Assert.Null((await ListRowAsync("disk-first"))["disk"]);
        Assert.Equal(204, (await ReportAsync(node, ("home", 1000, 100, 800))).Status);
        Assert.NotNull((await DetailAsync("disk-first"))["disk"]!["measuredAt"]);
    }

    [Fact]
    public async Task The_poll_response_never_has_the_property_without_the_capability_header()
    {
        var node = await fixture.EnrollAsync("disk-old-agent");
        Assert.Equal(204, (await ReportAsync(node, ("home", 1000, 100, 800))).Status);
        (await fixture.Operate.PostAsync("/operator/v1/nodes/disk-old-agent/disk-usage/refresh", null)).EnsureSuccessStatusCode();

        string[] shape = ["workspaceId", "nodeId", "assignment", "nextPollSeconds"];
        foreach (var capabilities in new string?[] { null, "", "other", "disk-usage-v2", "xdisk-usage", "disk usage" })
        {
            var (status, text) = await PollAsync(node, capabilities);
            Assert.Equal(200, status);
            Assert.Equal(shape, JsonNode.Parse(text)!.AsObject().Select(x => x.Key));
            Assert.DoesNotContain("diskUsageRequested", text);
        }
        var with = JsonNode.Parse((await PollAsync(node, "disk-usage")).Text)!.AsObject();
        Assert.Equal([.. shape, "diskUsageRequested"], with.Select(x => x.Key));

        // A Node without a pending request never gets it either.
        var calm = await fixture.EnrollAsync("disk-no-request");
        Assert.Equal(shape, JsonNode.Parse((await PollAsync(calm, "disk-usage")).Text)!.AsObject().Select(x => x.Key));
    }

    [Theory]
    [InlineData("disk-usage", true)]
    [InlineData("Disk-Usage", true)]
    [InlineData(" a , DISK-USAGE ,b", true)]
    [InlineData("a,b", false)]
    [InlineData("disk-usage2", false)]
    [InlineData("", false)]
    public void Capability_tokens_are_comma_separated_trimmed_and_case_insensitive(string header, bool expected)
    {
        var context = new DefaultHttpContext();
        context.Request.Headers["X-Fleet-Agent-Capabilities"] = header;
        Assert.Equal(expected, FleetEndpoints.HasCapability(context, "disk-usage"));
        Assert.False(FleetEndpoints.HasCapability(new DefaultHttpContext(), "disk-usage"));
    }

    [Fact]
    public async Task Refresh_needs_the_operate_scope_and_a_Node_that_is_not_revoked()
    {
        var node = await fixture.EnrollAsync("disk-scope");
        var denied = await OperatorApiFixture.ReadAsync(await fixture.Reader.PostAsync("/operator/v1/nodes/disk-scope/disk-usage/refresh", null),
            HttpStatusCode.Forbidden);
        Assert.Equal("insufficient_scope", denied["code"]!.GetValue<string>());
        Assert.Null((await DetailAsync("disk-scope"))["disk"]);
        await using (var browser = new Handle(await fixture.BrowserAsync(OperatorApiFixture.ReadToken)))
            Assert.Equal(HttpStatusCode.Forbidden, (await browser.Client.PostAsync("/dashboard/api/nodes/disk-scope/disk-usage/refresh", null)).StatusCode);

        var missing = await OperatorApiFixture.ReadAsync(await fixture.Operate.PostAsync("/operator/v1/nodes/nobody-here/disk-usage/refresh", null),
            HttpStatusCode.NotFound);
        Assert.Equal("node_not_found", missing["code"]!.GetValue<string>());

        (await fixture.Admin.PostAsync($"/operator/v1/nodes/{node.NodeId.Value}/revoke", null)).EnsureSuccessStatusCode();
        var revoked = await OperatorApiFixture.ReadAsync(await fixture.Operate.PostAsync("/operator/v1/nodes/disk-scope/disk-usage/refresh", null),
            HttpStatusCode.Conflict);
        Assert.Equal("node_revoked", revoked["code"]!.GetValue<string>());
        Assert.Null((await DetailAsync("disk-scope"))["disk"]);
    }

    [Theory]
    [InlineData(849, 151, null, 84.9)]
    [InlineData(850, 150, "disk_space_low", 85.0)]
    [InlineData(949, 51, "disk_space_low", 94.9)]
    [InlineData(950, 50, "disk_space_critical", 95.0)]
    [InlineData(1000, 0, "disk_space_critical", 100.0)]
    [InlineData(0, 0, null, 0.0)]
    public async Task Issues_use_the_rounded_used_percent_of_the_fullest_volume_with_thresholds_at_85_and_95(
        long used, long available, string? expectedCode, double percent)
    {
        var node = await fixture.EnrollAsync($"disk-issue-{used}-{available}");
        Assert.Equal(204, (await ReportAsync(node, ("home", 1000, used, available))).Status);
        Assert.Equal(percent, (await ListRowAsync(node.Alias))["disk"]!["usedPercent"]!.GetValue<double>());

        var low = await IssueAsync(node, "disk_space_low");
        var critical = await IssueAsync(node, "disk_space_critical");
        var issue = expectedCode == "disk_space_low" ? low : critical;
        Assert.True(expectedCode == "disk_space_low" ? critical is null : low is null);
        if (expectedCode is null)
        {
            Assert.Null(low);
            Assert.Null(critical);
            return;
        }
        Assert.NotNull(issue);
        Assert.Equal(expectedCode, issue["code"]!.GetValue<string>());
        Assert.Equal(expectedCode == "disk_space_low" ? "warning" : "error", issue["severity"]!.GetValue<string>());
        Assert.Equal("nodes", issue["section"]!.GetValue<string>());
        Assert.Equal(node.NodeId.Value, issue["nodeId"]!.GetValue<Guid>());
        Assert.Equal(node.Alias, issue["nodeName"]!.GetValue<string>());
        Assert.Null(issue["target"]);
        Assert.Null(issue["errorCode"]);
        Assert.Equal((await ListRowAsync(node.Alias))["disk"]!["measuredAt"]!.GetValue<DateTimeOffset>(), issue["since"]!.GetValue<DateTimeOffset>());
        Assert.Equal([$"fleet nodes disk {node.Alias}", $"fleet nodes disk {node.Alias} --refresh"],
            issue["commands"]!.AsArray().Select(x => x!.GetValue<string>()));
        Assert.Contains($"{percent:0.0}%", issue["detail"]!.GetValue<string>());
        Assert.NotNull(ErrorCatalog.Find(expectedCode));
    }

    [Fact]
    public async Task One_issue_per_Node_comes_from_the_fullest_volume_and_revoked_Nodes_are_skipped()
    {
        var node = await fixture.EnrollAsync("disk issue/quoted name");
        Assert.Equal(204, (await ReportAsync(node, ("home", 1000, 100, 800), ("state", 1000, 960, 40))).Status);
        Assert.Null(await IssueAsync(node, "disk_space_low"));
        var issue = (await IssueAsync(node, "disk_space_critical"))!;
        Assert.Contains("state volume", issue["detail"]!.GetValue<string>());
        Assert.Equal(["fleet nodes disk 'disk issue/quoted name'", "fleet nodes disk 'disk issue/quoted name' --refresh"],
            issue["commands"]!.AsArray().Select(x => x!.GetValue<string>()));

        (await fixture.Admin.PostAsync($"/operator/v1/nodes/{node.NodeId.Value}/revoke", null)).EnsureSuccessStatusCode();
        Assert.Null(await IssueAsync(node, "disk_space_critical"));
        Assert.Null(await IssueAsync(node, "disk_space_low"));
    }

    [Fact]
    public async Task Migration_adds_the_table_and_column_and_the_rows_go_with_the_Node()
    {
        using var scope = fixture.Scope();
        var db = scope.ServiceProvider.GetRequiredService<FleetDbContext>();
        Assert.False(db.Database.HasPendingModelChanges());
        Assert.Contains("20261026150000_AddNodeDiskUsage", await db.Database.GetAppliedMigrationsAsync());
        Assert.Equal(["AvailableBytes:bigint:NO", "Label:character varying:NO", "MeasuredAt:timestamp with time zone:NO", "NodeId:uuid:NO",
            "TotalBytes:bigint:NO", "UsedBytes:bigint:NO"], await db.Database.SqlQuery<string>($"""
            SELECT column_name || ':' || data_type || ':' || is_nullable AS "Value"
            FROM information_schema.columns WHERE table_name = 'node_disk_usage' ORDER BY column_name
            """).ToListAsync());
        Assert.Equal(["DiskUsageRefreshRequestedAt:YES"], await db.Database.SqlQuery<string>($"""
            SELECT column_name || ':' || is_nullable AS "Value"
            FROM information_schema.columns WHERE table_name = 'nodes' AND column_name = 'DiskUsageRefreshRequestedAt'
            """).ToListAsync());

        var node = await fixture.EnrollAsync("disk-cascade");
        Assert.Equal(204, (await ReportAsync(node, ("home", 1000, 100, 800), ("state", 1000, 100, 800))).Status);
        Assert.Equal(2, await db.NodeDiskUsages.CountAsync(x => x.NodeId == node.NodeId.Value));
        (await fixture.Admin.PostAsync($"/operator/v1/nodes/{node.NodeId.Value}/revoke", null)).EnsureSuccessStatusCode();
        (await fixture.Admin.PostAsJsonAsync($"/operator/v1/nodes/{node.NodeId.Value}/remove", new { alias = "disk-cascade" })).EnsureSuccessStatusCode();
        Assert.Equal(0, await db.NodeDiskUsages.CountAsync(x => x.NodeId == node.NodeId.Value));
    }

    [Fact]
    public void Disk_percent_is_rounded_to_one_decimal_and_the_catalog_explains_the_new_codes()
    {
        Assert.Equal(0, DiskUsageRules.UsedPercent(0, 0));
        Assert.Equal(33.3, DiskUsageRules.UsedPercent(1, 2));
        Assert.Equal(85.0, DiskUsageRules.UsedPercent(8495, 1505));
        Assert.Equal(100.0, DiskUsageRules.UsedPercent(long.MaxValue, 0));
        foreach (var code in new[] { "disk_space_low", "disk_space_critical" })
        {
            var entry = ErrorCatalog.Find(code)!;
            Assert.Equal(ErrorCatalog.Issue, entry.Source);
            Assert.Contains(entry.Fix, x => x.Contains("git worktree prune", StringComparison.Ordinal));
        }
    }

    private static readonly WorkspaceId Workspace = new(Guid.Parse("ecf620df-4637-490d-95b3-a9f81ca4c353"));

    private sealed class TestClock(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    /// <summary>A coordinator on its own scope (so its own DbContext and connection) with a controllable clock.</summary>
    private (IServiceScope Scope, FleetDbContext Db, PostgresFleetCoordinator Coordinator) NewCoordinator(DateTimeOffset? at = null)
    {
        var scope = fixture.Scope();
        var db = scope.ServiceProvider.GetRequiredService<FleetDbContext>();
        return (scope, db, new PostgresFleetCoordinator(db, new TestClock(at ?? DateTimeOffset.UtcNow), new() { WorkspaceId = Workspace }));
    }

    private async Task<NodeAuthentication> AuthenticationAsync(EnrolledNode node)
    {
        using var scope = fixture.Scope();
        return (await scope.ServiceProvider.GetRequiredService<IFleetCoordinator>().FindActiveNodeByCertificateAsync(
            node.Certificate.GetCertHashString(System.Security.Cryptography.HashAlgorithmName.SHA256).ToLowerInvariant()))!;
    }

    private static DiskUsageReport Single(string label, long used) => new([new(label, 1000, used, 800)]);

    private async Task<string[]> LabelsAsync(EnrolledNode node)
    {
        using var scope = fixture.Scope();
        var db = scope.ServiceProvider.GetRequiredService<FleetDbContext>();
        var id = node.NodeId.Value;
        return await db.NodeDiskUsages.AsNoTracking().Where(x => x.NodeId == id).OrderBy(x => x.Label).Select(x => x.Label).ToArrayAsync();
    }

    private async Task<DateTimeOffset?> PendingAsync(EnrolledNode node)
    {
        using var scope = fixture.Scope();
        var db = scope.ServiceProvider.GetRequiredService<FleetDbContext>();
        var id = node.NodeId.Value;
        return await db.Nodes.AsNoTracking().Where(x => x.Id == id).Select(x => x.DiskUsageRefreshRequestedAt).SingleAsync();
    }

    /// <summary>Holds the Node row lock from another connection, as a report or refresh request that is in the middle of its transaction would.</summary>
    private async Task<(IServiceScope Scope, Microsoft.EntityFrameworkCore.Storage.IDbContextTransaction Transaction)> HoldNodeLockAsync(EnrolledNode node)
    {
        var scope = fixture.Scope();
        var db = scope.ServiceProvider.GetRequiredService<FleetDbContext>();
        var transaction = await db.Database.BeginTransactionAsync();
        var id = node.NodeId.Value;
        await db.Database.ExecuteSqlInterpolatedAsync($"SELECT 1 FROM nodes WHERE \"Id\" = {id} FOR UPDATE");
        return (scope, transaction);
    }

    private static async Task AssertStillRunningAsync(params Task[] tasks)
    {
        await Task.WhenAny(Task.WhenAll(tasks), Task.Delay(500));
        Assert.All(tasks, x => Assert.False(x.IsCompleted, "The operation did not wait for the Node row lock."));
    }

    [Fact]
    public async Task Concurrent_reports_with_different_volumes_leave_exactly_one_reports_volumes()
    {
        var node = await fixture.EnrollAsync("disk-race");
        var authentication = await AuthenticationAsync(node);

        // Deterministic: both reports queue behind the Node row lock, then run one after the other.
        for (var round = 0; round < 3; round++)
        {
            var (holderScope, holder) = await HoldNodeLockAsync(node);
            using var _ = holderScope;
            var a = NewCoordinator();
            var b = NewCoordinator();
            using var scopeA = a.Scope;
            using var scopeB = b.Scope;
            var home = a.Coordinator.RecordDiskUsageAsync(authentication, Single("home", 100));
            var state = b.Coordinator.RecordDiskUsageAsync(authentication, Single("state", 100));
            await AssertStillRunningAsync(home, state);
            await holder.CommitAsync();
            await Task.WhenAll(home, state);
            var labels = await LabelsAsync(node);
            Assert.Single(labels);
        }

        // Unsynchronized: many races, each ending with one report's volumes and never both.
        for (var i = 0; i < 40; i++)
        {
            var a = NewCoordinator();
            var b = NewCoordinator();
            using var scopeA = a.Scope;
            using var scopeB = b.Scope;
            await Task.WhenAll(Task.Run(() => a.Coordinator.RecordDiskUsageAsync(authentication, Single("home", 100 + i))),
                Task.Run(() => b.Coordinator.RecordDiskUsageAsync(authentication, Single("state", 100 + i))));
            Assert.Single(await LabelsAsync(node));
        }
    }

    [Fact]
    public async Task Refresh_requests_and_reports_serialize_on_the_Node_row()
    {
        var node = await fixture.EnrollAsync("disk-serial");
        var authentication = await AuthenticationAsync(node);
        Assert.Equal(204, (await ReportAsync(node, ("home", 1000, 100, 800))).Status);

        // A report that is in flight holds the lock; a refresh request made meanwhile waits for it and then stays pending.
        var (holderScope, holder) = await HoldNodeLockAsync(node);
        using (holderScope)
        {
            var refresh = Task.Run(async () =>
            {
                var c = NewCoordinator();
                using var scope = c.Scope;
                return await c.Coordinator.RequestDiskUsageRefreshAsync(node.NodeId, "tester");
            });
            await AssertStillRunningAsync(refresh);
            await holder.CommitAsync();
            var requested = await refresh;
            Assert.Equal(requested.RefreshRequestedAt, await PendingAsync(node));
        }

        // And the other way round: a report waits for a refresh request that holds the lock.
        var (secondScope, second) = await HoldNodeLockAsync(node);
        using (secondScope)
        {
            var c = NewCoordinator();
            using var scope = c.Scope;
            var report = c.Coordinator.RecordDiskUsageAsync(authentication, Single("home", 200));
            await AssertStillRunningAsync(report);
            await second.CommitAsync();
            await report;
            Assert.Null(await PendingAsync(node));
        }
    }

    [Fact]
    public async Task A_report_does_not_clear_a_refresh_request_that_is_newer_than_its_receipt()
    {
        var node = await fixture.EnrollAsync("disk-newer");
        var authentication = await AuthenticationAsync(node);
        var receipt = DateTimeOffset.UtcNow;
        var id = node.NodeId.Value;
        var newer = new DateTimeOffset((receipt.UtcTicks + TimeSpan.TicksPerSecond) / 10 * 10, TimeSpan.Zero);
        using (var scope = fixture.Scope())
            await scope.ServiceProvider.GetRequiredService<FleetDbContext>().Database.ExecuteSqlInterpolatedAsync(
                $"UPDATE nodes SET \"DiskUsageRefreshRequestedAt\" = {newer} WHERE \"Id\" = {id}");

        var late = NewCoordinator(receipt);
        using (late.Scope) await late.Coordinator.RecordDiskUsageAsync(authentication, Single("home", 100));
        Assert.Equal(newer, await PendingAsync(node));
        Assert.Equal(["home"], await LabelsAsync(node));

        // The same request is answered by a report received at or after it.
        var answering = NewCoordinator(newer);
        using (answering.Scope) await answering.Coordinator.RecordDiskUsageAsync(authentication, Single("home", 110));
        Assert.Null(await PendingAsync(node));
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
