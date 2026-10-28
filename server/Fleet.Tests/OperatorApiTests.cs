using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Fleet.Core.Coordination;
using Fleet.Server.Persistence;
using Fleet.Server.Security;
using Fleet.Server.Transport;
using System.Security.Cryptography.X509Certificates;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Fleet.Tests;

public sealed partial class OperatorApiTests(OperatorApiFixture fixture) : IClassFixture<OperatorApiFixture>
{
    private static (ConvergenceState, string?) FailAiClient(string target) =>
        target == "ai-client/claude" ? (ConvergenceState.Failed, "ai_client_reconcile_failed") : (ConvergenceState.Succeeded, null);

    private static (ConvergenceState, string?) FailSkills(string target) =>
        target == "skills" ? (ConvergenceState.Failed, "lock_failed") : (ConvergenceState.Succeeded, null);

    [Fact]
    public async Task Node_detail_describes_every_Target_and_matches_the_fixture_under_both_prefixes()
    {
        var node = await fixture.EnrollAsync("gallery-detail");
        var agent = await fixture.PublishAsync(node, "rev-detail", aiClientUsesProxy: true);
        Assert.Equal(["agent-file/claude", "ai-client/claude", "skills"], (await fixture.RunAgentAsync(agent, FailAiClient)).Order());
        await fixture.PublishAsync(node, "rev-detail-2", aiClientUsesProxy: true);

        var detail = await OperatorApiFixture.ReadAsync(await fixture.Admin.GetAsync("/operator/v1/nodes/gallery-detail"));
        ContractShape.AssertMatches("node-detail.json", detail);
        Assert.Equal(node.NodeId.Value, detail["nodeId"]!.GetValue<Guid>());
        Assert.Equal("macos", detail["platform"]!.GetValue<string>());
        Assert.Equal("fresh", detail["freshness"]!.GetValue<string>());
        Assert.False(detail["revoked"]!.GetValue<bool>());
        Assert.Equal(0, detail["credential"]!["renewals"]!.GetValue<int>());
        Assert.Null(detail["credential"]!["revokedAt"]);
        var targets = detail["targets"]!.AsArray();
        Assert.Equal(["agent-file/claude", "ai-client/claude", "skills"], targets.Select(x => x!["name"]!.GetValue<string>()));
        Assert.Equal(["agent-file", "ai-client", "skills"], targets.Select(x => x!["kind"]!.GetValue<string>()));
        var file = targets[0]!;
        Assert.Equal("pending", file["state"]!.GetValue<string>());
        Assert.Equal("rev-detail", file["lastSucceededRevision"]!.GetValue<string>());
        Assert.Equal("rev-detail-2", file["desiredRevision"]!["sourceRevision"]!.GetValue<string>());
        Assert.Equal("CLAUDE.md", file["file"]!["name"]!.GetValue<string>());
        Assert.NotNull(file["file"]!["bundleDigest"]);
        // The AI client Target is the same in both revisions, so its failed Assignment is still current.
        var client = targets[1]!;
        Assert.Equal("failed", client["state"]!.GetValue<string>());
        Assert.Equal("ai_client_reconcile_failed", client["latestAttempt"]!["errorCode"]!.GetValue<string>());
        Assert.Null(client["lastSucceededRevision"]);
        Assert.Equal(1, client["failedAttempts"]!.GetValue<int>());
        Assert.NotNull(client["firstFailedAt"]);
        Assert.Equal("cliproxy", client["aiClient"]!["mode"]!.GetValue<string>());
        Assert.Equal("claude-sonnet-5-5", client["aiClient"]!["model"]!.GetValue<string>());
        var skills = targets[2]!;
        Assert.Equal(["git-workflow", "code-review"], skills["skills"]!.AsArray().Select(x => x!["name"]!.GetValue<string>()));
        Assert.Equal("pending", skills["latestAttempt"]!["state"]!.GetValue<string>());
        Assert.Equal(2, detail["summary"]!["pending"]!.GetValue<int>());
        Assert.Equal(1, detail["summary"]!["failed"]!.GetValue<int>());

        var byId = await OperatorApiFixture.ReadAsync(await fixture.Admin.GetAsync($"/operator/v1/nodes/{node.NodeId.Value}"));
        Assert.True(JsonNode.DeepEquals(detail, byId));
        await using var browser = new BrowserHandle(await fixture.BrowserAsync(OperatorApiFixture.ReadToken));
        var viaDashboard = await OperatorApiFixture.ReadAsync(await browser.Client.GetAsync($"/dashboard/api/nodes/{node.NodeId.Value}"));
        Assert.True(JsonNode.DeepEquals(detail, viaDashboard));
    }

    [Fact]
    public async Task Failed_Target_reports_its_error_failed_attempts_and_last_successful_revision()
    {
        var node = await fixture.EnrollAsync("gallery-failed");
        var agent = await fixture.PublishAsync(node, "rev-failed-1");
        await fixture.RunAgentAsync(agent, _ => (ConvergenceState.Succeeded, null));
        await fixture.PublishAsync(node, "rev-failed-2");
        await fixture.RunAgentAsync(agent, FailSkills);

        var detail = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/nodes/gallery-failed"));
        var skills = detail["targets"]!.AsArray().Single(x => x!["name"]!.GetValue<string>() == "skills")!;
        Assert.Equal("failed", skills["state"]!.GetValue<string>());
        Assert.Equal("rev-failed-1", skills["lastSucceededRevision"]!.GetValue<string>());
        Assert.Equal("rev-failed-2", skills["desiredRevision"]!["sourceRevision"]!.GetValue<string>());
        Assert.Equal("lock_failed", skills["latestAttempt"]!["errorCode"]!.GetValue<string>());
        Assert.Equal(1, skills["failedAttempts"]!.GetValue<int>());
        Assert.Equal(1, detail["summary"]!["failed"]!.GetValue<int>());
        Assert.Equal(2, detail["summary"]!["succeeded"]!.GetValue<int>());

        var list = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/nodes"));
        ContractShape.AssertMatches("nodes-page.json", list);
        var row = list["items"]!.AsArray().Single(x => x!["name"]!.GetValue<string>() == "gallery-failed")!;
        Assert.Equal("macos", row["platform"]!.GetValue<string>());
        Assert.Equal(1, row["targets"]!["failed"]!.GetValue<int>());
        Assert.Equal(2, row["targets"]!["succeeded"]!.GetValue<int>());
        Assert.Equal("rev-failed-2", row["currentRevision"]!.GetValue<string>());
        Assert.NotNull(row["credentialNotAfter"]);
        Assert.Null(row["revokedAt"]);
        Assert.True(DateTimeOffset.TryParse(row["enrolledAt"]!.GetValue<string>(), out _));
        Assert.EndsWith("Z", row["enrolledAt"]!.GetValue<string>());
    }

    [Fact]
    public async Task Node_list_includes_revoked_Nodes_and_a_Node_without_work_has_empty_counts()
    {
        var node = await fixture.EnrollAsync("gallery-revoked");
        (await fixture.Admin.PostAsync($"/operator/v1/nodes/{node.NodeId.Value}/revoke", null)).EnsureSuccessStatusCode();

        var list = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/nodes"));
        var row = list["items"]!.AsArray().Single(x => x!["name"]!.GetValue<string>() == "gallery-revoked")!;
        Assert.True(row["revoked"]!.GetValue<bool>());
        Assert.NotNull(row["revokedAt"]);
        Assert.Null(row["credentialNotAfter"]);
        Assert.Null(row["currentRevision"]);
        Assert.Equal(0, row["targets"]!["succeeded"]!.GetValue<int>());
        var detail = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/nodes/gallery-revoked"));
        Assert.True(detail["revoked"]!.GetValue<bool>());
        Assert.Empty(detail["targets"]!.AsArray());
        Assert.NotNull(detail["credential"]!["revokedAt"]);
        Assert.Equal("operator", detail["credential"]!["revokedBy"]!.GetValue<string>());
    }

    [Fact]
    public async Task Node_routes_resolve_aliases_and_ids_and_report_unknown_Nodes_with_a_message()
    {
        var node = await fixture.EnrollAsync("resolve me");
        var other = await fixture.EnrollAsync(node.NodeId.Value.ToString("D"));
        Assert.NotEqual(node.NodeId, other.NodeId);

        var byAlias = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/nodes/resolve%20me"));
        Assert.Equal(node.NodeId.Value, byAlias["nodeId"]!.GetValue<Guid>());
        // A UUID-shaped value is an ID first, even when it is also another Node's alias.
        var byId = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync($"/operator/v1/nodes/{node.NodeId.Value}"));
        Assert.Equal(node.NodeId.Value, byId["nodeId"]!.GetValue<Guid>());
        Assert.Equal(HttpStatusCode.NotFound, (await fixture.Reader.GetAsync("/operator/v1/nodes/Resolve%20Me")).StatusCode);

        foreach (var route in new[] { "", "/attempts", "/checkins" })
        {
            var missing = await fixture.Reader.GetAsync("/operator/v1/nodes/no-such-node" + route);
            var body = await OperatorApiFixture.ReadAsync(missing, HttpStatusCode.NotFound);
            Assert.Equal("node_not_found", body["code"]!.GetValue<string>());
            Assert.False(string.IsNullOrWhiteSpace(body["message"]!.GetValue<string>()));
        }
    }

    [Fact]
    public async Task Attempts_are_listed_newest_first_across_Targets_and_can_be_filtered_and_paged()
    {
        var node = await fixture.EnrollAsync("gallery-attempts");
        var agent = await fixture.PublishAsync(node, "rev-attempts-1");
        await fixture.RunAgentAsync(agent, FailSkills);
        await fixture.PublishAsync(node, "rev-attempts-2");

        var all = new List<JsonNode>();
        string? cursor = null;
        var pages = 0;
        do
        {
            var url = "/operator/v1/nodes/gallery-attempts/attempts?limit=4" + (cursor is null ? "" : "&after=" + Uri.EscapeDataString(cursor));
            var page = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync(url));
            ContractShape.AssertMatches("node-attempts-page.json", page);
            all.AddRange(page["items"]!.AsArray().Select(x => x!));
            cursor = page["nextCursor"]?.GetValue<string>();
            pages++;
        } while (cursor is not null);

        Assert.Equal(2, pages);
        Assert.Equal(5, all.Count);
        Assert.Equal(5, all.Select(x => x["attemptId"]!.GetValue<Guid>()).Distinct().Count());
        var times = all.Select(x => DateTimeOffset.Parse(x["updatedAt"]!.GetValue<string>())).ToArray();
        Assert.Equal(times.OrderByDescending(x => x), times);
        // Only the Skills and file Targets changed in the second revision.
        Assert.Equal(2, all.Count(x => x["sourceRevision"]!.GetValue<string>() == "rev-attempts-2" && x["state"]!.GetValue<string>() == "pending"));
        var failed = all.Single(x => x["state"]!.GetValue<string>() == "failed");
        Assert.Equal("lock_failed", failed["errorCode"]!.GetValue<string>());
        Assert.Equal("skills", failed["targetName"]!.GetValue<string>());

        var filtered = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/nodes/gallery-attempts/attempts?target=skills"));
        Assert.Equal(["skills"], filtered["items"]!.AsArray().Select(x => x!["targetName"]!.GetValue<string>()).Distinct());
        Assert.Equal(2, filtered["items"]!.AsArray().Count);
        Assert.Null(filtered["nextCursor"]);
        var none = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/nodes/gallery-attempts/attempts?target=nope"));
        Assert.Empty(none["items"]!.AsArray());

        foreach (var query in new[] { "limit=0", "limit=101", "after=not-a-cursor", "limit=abc" })
        {
            var rejected = await OperatorApiFixture.ReadAsync(
                await fixture.Reader.GetAsync("/operator/v1/nodes/gallery-attempts/attempts?" + query), HttpStatusCode.BadRequest);
            Assert.Equal("invalid_request", rejected["code"]!.GetValue<string>());
            Assert.False(string.IsNullOrWhiteSpace(rejected["message"]!.GetValue<string>()));
        }
    }

    [Fact]
    public async Task Check_ins_count_polls_per_hour_and_fill_missing_hours_with_zero()
    {
        var node = await fixture.EnrollAsync("gallery-checkins");
        for (var i = 0; i < 2; i++)
            Assert.Equal(200, (await fixture.SendNodeAsync("/agent/v1/poll", node.Certificate)).Response.StatusCode);

        var page = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/nodes/gallery-checkins/checkins"));
        ContractShape.AssertMatches("node-checkins.json", page);
        Assert.Equal(168, page["hours"]!.GetValue<int>());
        var buckets = page["buckets"]!.AsArray();
        Assert.Equal(168, buckets.Count);
        var hours = buckets.Select(x => DateTimeOffset.Parse(x!["hour"]!.GetValue<string>())).ToArray();
        Assert.All(hours, hour => Assert.Equal(TimeSpan.Zero, hour.TimeOfDay - TimeSpan.FromHours(hour.Hour)));
        Assert.Equal(hours.Order(), hours);
        Assert.Equal(Enumerable.Range(0, 167).Select(_ => TimeSpan.FromHours(1)), hours.Zip(hours.Skip(1), (a, b) => b - a));
        Assert.Equal(2, buckets.Sum(x => x!["polls"]!.GetValue<int>()));
        Assert.True(buckets.Count(x => x!["polls"]!.GetValue<int>() == 0) >= 166);
        Assert.True(DateTimeOffset.UtcNow - hours[^1] < TimeSpan.FromHours(1) + TimeSpan.FromMinutes(1));

        var short_ = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/nodes/gallery-checkins/checkins?hours=3"));
        Assert.Equal(3, short_["buckets"]!.AsArray().Count);
        Assert.Equal(3, short_["hours"]!.GetValue<int>());
        Assert.Equal(2, short_["buckets"]!.AsArray().Sum(x => x!["polls"]!.GetValue<int>()));
        foreach (var hoursValue in new[] { "0", "169", "-1" })
        {
            var rejected = await OperatorApiFixture.ReadAsync(
                await fixture.Reader.GetAsync("/operator/v1/nodes/gallery-checkins/checkins?hours=" + hoursValue), HttpStatusCode.BadRequest);
            Assert.Equal("invalid_request", rejected["code"]!.GetValue<string>());
        }
    }

    [Fact]
    public async Task Retry_requeues_a_failed_Assignment_and_rejects_other_requests()
    {
        var node = await fixture.EnrollAsync("retry-node");
        var agent = await fixture.PublishAsync(node, "rev-retry");
        await fixture.RunAgentAsync(agent, FailSkills);
        var before = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/nodes/retry-node"));
        var assignmentId = before["targets"]!.AsArray().Single(x => x!["name"]!.GetValue<string>() == "skills")!["assignmentId"]!.GetValue<Guid>();

        var denied = await OperatorApiFixture.ReadAsync(await fixture.Reader.PostAsJsonAsync(
            "/operator/v1/nodes/retry-node/retry", new { target = "skills" }), HttpStatusCode.Forbidden);
        Assert.Equal("insufficient_scope", denied["code"]!.GetValue<string>());
        Assert.False(string.IsNullOrWhiteSpace(denied["message"]!.GetValue<string>()));

        var retried = await OperatorApiFixture.ReadAsync(await fixture.Operate.PostAsJsonAsync(
            "/operator/v1/nodes/retry-node/retry", new { target = "skills" }));
        Assert.Equal(["assignmentId", "attemptId", "state"], retried.AsObject().Select(x => x.Key).Order());
        Assert.Equal(assignmentId, retried["assignmentId"]!.GetValue<Guid>());
        Assert.Equal("pending", retried["state"]!.GetValue<string>());
        var after = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/nodes/retry-node"));
        var skills = after["targets"]!.AsArray().Single(x => x!["name"]!.GetValue<string>() == "skills")!;
        Assert.Equal("pending", skills["state"]!.GetValue<string>());
        Assert.Equal(retried["attemptId"]!.GetValue<Guid>(), skills["latestAttempt"]!["attemptId"]!.GetValue<Guid>());
        Assert.Equal("pending", skills["latestAttempt"]!["state"]!.GetValue<string>());
        Assert.Null(skills["latestAttempt"]!["errorCode"]);
        Assert.Equal(1, skills["failedAttempts"]!.GetValue<int>());

        // The Agent receives the new Attempt on its next poll.
        using (var scope = fixture.Scope())
        {
            var polled = (await scope.ServiceProvider.GetRequiredService<IFleetCoordinator>().PollAsync(agent, DateTimeOffset.UtcNow)).Assignment!;
            Assert.Equal(retried["attemptId"]!.GetValue<Guid>(), polled.AttemptId.Value);
        }

        var notFailed = await OperatorApiFixture.ReadAsync(await fixture.Operate.PostAsJsonAsync(
            "/operator/v1/nodes/retry-node/retry", new { target = "skills" }), HttpStatusCode.Conflict);
        Assert.Equal("target_not_failed", notFailed["code"]!.GetValue<string>());
        var unknownTarget = await OperatorApiFixture.ReadAsync(await fixture.Operate.PostAsJsonAsync(
            "/operator/v1/nodes/retry-node/retry", new { target = "ai-client/codex" }), HttpStatusCode.NotFound);
        Assert.Equal("target_not_found", unknownTarget["code"]!.GetValue<string>());
        var unknownNode = await OperatorApiFixture.ReadAsync(await fixture.Operate.PostAsJsonAsync(
            "/operator/v1/nodes/missing-node/retry", new { target = "skills" }), HttpStatusCode.NotFound);
        Assert.Equal("node_not_found", unknownNode["code"]!.GetValue<string>());
        foreach (var body in new object[] { new { }, new { target = " " }, new { target = "skills", extra = 1 } })
        {
            var invalid = await OperatorApiFixture.ReadAsync(await fixture.Operate.PostAsJsonAsync("/operator/v1/nodes/retry-node/retry", body),
                HttpStatusCode.BadRequest);
            Assert.Equal("invalid_request", invalid["code"]!.GetValue<string>());
        }

        // Fail it again, then retry through the dashboard surface with its own session.
        await fixture.RunAgentAsync(agent, FailSkills);
        await using (var browser = new BrowserHandle(await fixture.BrowserAsync(OperatorApiFixture.OperateToken)))
        {
            var viaDashboard = await OperatorApiFixture.ReadAsync(await browser.Client.PostAsJsonAsync(
                $"/dashboard/api/nodes/{node.NodeId.Value}/retry", new { target = "skills" }));
            Assert.Equal("pending", viaDashboard["state"]!.GetValue<string>());
        }
        await fixture.RunAgentAsync(agent, FailSkills);

        (await fixture.Admin.PostAsync($"/operator/v1/nodes/{node.NodeId.Value}/revoke", null)).EnsureSuccessStatusCode();
        var revoked = await OperatorApiFixture.ReadAsync(await fixture.Operate.PostAsJsonAsync(
            "/operator/v1/nodes/retry-node/retry", new { target = "skills" }), HttpStatusCode.Conflict);
        Assert.Equal("node_revoked", revoked["code"]!.GetValue<string>());

        var audit = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/audit?node=retry-node"));
        var retries = audit["items"]!.AsArray().Where(x => x!["action"]!.GetValue<string>() == "assignment.retry_requested").ToArray();
        Assert.Equal(2, retries.Length);
        Assert.Equal(["operate-bot"], retries.Select(x => x!["actor"]!.GetValue<string>()).Distinct());
        Assert.All(retries, x => Assert.Equal(node.NodeId.Value, x!["nodeId"]!.GetValue<Guid>()));
    }

    [Fact]
    public async Task Scopes_limit_what_each_credential_may_do_and_default_to_admin()
    {
        var id = Guid.NewGuid();
        foreach (var path in new[] { "nodes", "issues", "errors", "source/scans", "enrollment-links", "cliproxy/selection", "audit", "metrics" })
            Assert.Equal(HttpStatusCode.OK, (await fixture.Reader.GetAsync("/operator/v1/" + path)).StatusCode);

        var operateRoutes = new (string Path, object? Body)[]
        {
            ("source/rescan", null), ("cliproxy/refresh", null), ("nodes/missing/retry", new { target = "skills" }),
            ("nodes/missing/disk-usage/refresh", null),
            ("cliproxy/selection", new { baseUrl = "https://proxy.example/v1", version = 0, policy = (object?)null })
        };
        var adminRoutes = new (string Path, object? Body)[]
        {
            ("enrollment-tokens", new { expiresInSeconds = 900 }), ("enrollment-links", new { alias = "x", expiresInSeconds = 900 }),
            ($"enrollment-links/{id}/revoke", null), ("nodes/rename", new { currentAlias = "a", alias = "b" }),
            ($"nodes/{id}/revoke", null), ($"nodes/{id}/remove", new { alias = "a" }), ($"credentials/{id}/revoke", null)
        };
        foreach (var (path, body) in operateRoutes.Concat(adminRoutes))
        {
            var denied = await fixture.Reader.PostAsJsonAsync("/operator/v1/" + path, body ?? new { });
            Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
            Assert.Equal("insufficient_scope", (await denied.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
        }
        foreach (var (path, body) in adminRoutes)
        {
            var denied = await fixture.Operate.PostAsJsonAsync("/operator/v1/" + path, body ?? new { });
            Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
            Assert.Equal("insufficient_scope", (await denied.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
        }
        Assert.Equal(HttpStatusCode.OK, (await fixture.Operate.PostAsync("/operator/v1/source/rescan", null)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await fixture.Operate.PostAsync("/operator/v1/cliproxy/refresh", null)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await fixture.Operate.GetAsync("/operator/v1/nodes")).StatusCode);
        // The bootstrap credential has no scope entry, so it keeps its previous full rights.
        Assert.Equal(HttpStatusCode.OK, (await fixture.Admin.PostAsJsonAsync("/operator/v1/enrollment-tokens", new { expiresInSeconds = 900 })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await fixture.Admin.PostAsync("/operator/v1/source/rescan", null)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await fixture.Anonymous.GetAsync("/operator/v1/nodes")).StatusCode);

        foreach (var (token, actor, scope) in new[]
        {
            (OperatorApiFixture.ReadToken, "read-bot", "read"), (OperatorApiFixture.OperateToken, "operate-bot", "operate"),
            (OperatorApiFixture.AdminToken, "operator", "admin")
        })
        {
            await using var browser = new BrowserHandle(await fixture.BrowserAsync(token));
            var session = await OperatorApiFixture.ReadAsync(await browser.Client.GetAsync("/dashboard/api/session"));
            Assert.Equal(actor, session["actor"]!.GetValue<string>());
            Assert.Equal(scope, session["scope"]!.GetValue<string>());
            var rescan = await browser.Client.PostAsJsonAsync("/dashboard/api/source/rescan", new { });
            var link = await browser.Client.PostAsJsonAsync("/dashboard/api/enrollment-links", new { alias = "scope-" + scope, expiresInSeconds = 900 });
            Assert.Equal(scope == "read" ? HttpStatusCode.Forbidden : HttpStatusCode.OK, rescan.StatusCode);
            Assert.Equal(scope == "admin" ? HttpStatusCode.OK : HttpStatusCode.Forbidden, link.StatusCode);
            if (scope != "admin")
                Assert.Equal("insufficient_scope", (await link.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
            Assert.Equal(HttpStatusCode.OK, (await browser.Client.GetAsync("/dashboard/api/issues")).StatusCode);
        }
    }

    [Fact]
    public void Unknown_scope_values_fail_Server_startup_validation()
    {
        using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder => builder.ConfigureAppConfiguration((_, config) =>
            config.AddInMemoryCollection(fixture.Configuration(new() { ["Fleet:OperatorScopes:read-bot"] = "superuser" }))));
        var error = Assert.ThrowsAny<Exception>(() => factory.CreateClient());
        Assert.Contains("OperatorScopes", error.ToString());
    }

    [Fact]
    public async Task Issues_have_stable_ids_are_ordered_and_list_the_cli_commands_that_help()
    {
        var alpha = await fixture.EnrollAsync("issue-alpha");
        var zeta = await fixture.EnrollAsync("issue-zeta");
        var quoted = await fixture.EnrollAsync("needs 'quotes'");
        var stale = await fixture.EnrollAsync("issue-stale");
        var gone = await fixture.EnrollAsync("issue-revoked");
        var alphaAgent = await fixture.PublishAsync(alpha, "rev-issues-alpha");
        var zetaAgent = await fixture.PublishAsync(zeta, "rev-issues-zeta");
        var quotedAgent = await fixture.PublishAsync(quoted, "rev-issues-quoted");
        var goneAgent = await fixture.PublishAsync(gone, "rev-issues-gone");
        await fixture.RunAgentAsync(alphaAgent, target => target == "skills" ? (ConvergenceState.Failed, "lock_failed") : FailAiClient(target));
        await fixture.RunAgentAsync(zetaAgent, target => target == "skills" ? (ConvergenceState.Failed, null) : (ConvergenceState.Succeeded, null));
        await fixture.RunAgentAsync(quotedAgent, FailSkills);
        await fixture.RunAgentAsync(goneAgent, FailSkills);
        (await fixture.Admin.PostAsync($"/operator/v1/nodes/{gone.NodeId.Value}/revoke", null)).EnsureSuccessStatusCode();
        DateTimeOffset lastContact;
        using (var scope = fixture.Scope())
        {
            var db = scope.ServiceProvider.GetRequiredService<FleetDbContext>();
            lastContact = DateTimeOffset.UtcNow.AddDays(-2);
            await db.Nodes.Where(x => x.Id == stale.NodeId.Value).ExecuteUpdateAsync(set => set.SetProperty(x => x.LastContactAt, lastContact));
        }

        var response = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/issues"));
        Assert.Equal(["items"], response.AsObject().Select(x => x.Key));
        ContractShape.AssertMatches("issues.json", response);
        var items = response["items"]!.AsArray().Select(x => x!).ToArray();
        var ids = items.Select(x => x["id"]!.GetValue<string>()).ToArray();
        Assert.Equal(ids.Length, ids.Distinct().Count());
        Assert.InRange(items.Length, 1, 200);
        Assert.DoesNotContain(ids, id => id.Contains(gone.NodeId.Value.ToString("D")));

        JsonNode Issue(string id) => items.Single(x => x["id"]!.GetValue<string>() == id);
        var lock_ = Issue($"assignment_failed:{alpha.NodeId.Value:D}:skills");
        Assert.Equal("assignment_failed", lock_["code"]!.GetValue<string>());
        Assert.Equal("error", lock_["severity"]!.GetValue<string>());
        Assert.Equal("issue-alpha: skills failed", lock_["title"]!.GetValue<string>());
        Assert.Equal("lock_failed", lock_["errorCode"]!.GetValue<string>());
        Assert.Equal("issue-alpha", lock_["nodeName"]!.GetValue<string>());
        Assert.Equal(alpha.NodeId.Value, lock_["nodeId"]!.GetValue<Guid>());
        Assert.Equal("skills", lock_["target"]!.GetValue<string>());
        Assert.Equal("nodes", lock_["section"]!.GetValue<string>());
        Assert.NotNull(lock_["since"]);
        Assert.Contains("Another process holds the Target lock", lock_["detail"]!.GetValue<string>());
        Assert.Equal(["fleet nodes show issue-alpha", "fleet explain lock_failed", "fleet retry issue-alpha skills"],
            lock_["commands"]!.AsArray().Select(x => x!.GetValue<string>()));
        var aiIssue = Issue($"assignment_failed:{alpha.NodeId.Value:D}:ai-client/claude");
        Assert.Equal("ai_client_reconcile_failed", aiIssue["errorCode"]!.GetValue<string>());
        Assert.Equal("fleet retry issue-alpha ai-client/claude", aiIssue["commands"]!.AsArray().Last()!.GetValue<string>());

        var unknownCode = Issue($"assignment_failed:{zeta.NodeId.Value:D}:skills");
        Assert.Null(unknownCode["errorCode"]);
        Assert.Equal(["fleet nodes show issue-zeta", "fleet retry issue-zeta skills"], unknownCode["commands"]!.AsArray().Select(x => x!.GetValue<string>()));
        // Aliases with spaces or quotes are shell-quoted so the command can be pasted.
        Assert.Equal(["fleet nodes show 'needs '\\''quotes'\\'''", "fleet explain lock_failed", "fleet retry 'needs '\\''quotes'\\''' skills"],
            Issue($"assignment_failed:{quoted.NodeId.Value:D}:skills")["commands"]!.AsArray().Select(x => x!.GetValue<string>()));

        var staleIssue = Issue($"node_not_contacting:{stale.NodeId.Value:D}");
        Assert.Equal("warning", staleIssue["severity"]!.GetValue<string>());
        Assert.Equal("issue-stale", staleIssue["nodeName"]!.GetValue<string>());
        Assert.Null(staleIssue["errorCode"]);
        Assert.Null(staleIssue["target"]);
        Assert.Equal(lastContact.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss"), staleIssue["since"]!.GetValue<string>()[..19]);
        Assert.Equal(["fleet nodes show issue-stale", "fleet nodes checkins issue-stale"], staleIssue["commands"]!.AsArray().Select(x => x!.GetValue<string>()));
        Assert.Contains(items, x => x["code"]!.GetValue<string>() == "source_not_configured" && x["commands"]!.AsArray().Count == 0);

        // Errors first, then Node name and Target.
        var expectedOrder = items.OrderBy(x => x["severity"]!.GetValue<string>() == "error" ? 0 : 1)
            .ThenBy(x => x["nodeName"]?.GetValue<string>(), StringComparer.Ordinal).ThenBy(x => x["target"]?.GetValue<string>(), StringComparer.Ordinal)
            .ThenBy(x => x["code"]!.GetValue<string>(), StringComparer.Ordinal).ThenBy(x => x["id"]!.GetValue<string>(), StringComparer.Ordinal)
            .Select(x => x["id"]!.GetValue<string>());
        Assert.Equal(expectedOrder, ids);
        Assert.True(ids.ToList().IndexOf(lock_["id"]!.GetValue<string>()) > ids.ToList().IndexOf(aiIssue["id"]!.GetValue<string>()));
        Assert.True(ids.ToList().IndexOf(lock_["id"]!.GetValue<string>()) < ids.ToList().IndexOf(staleIssue["id"]!.GetValue<string>()));
        var firstWarning = items.ToList().FindIndex(x => x["severity"]!.GetValue<string>() == "warning");
        Assert.All(items.Skip(firstWarning), x => Assert.Equal("warning", x["severity"]!.GetValue<string>()));

        // Every code the endpoint can return is explained by the catalog.
        Assert.All(items.Select(x => x["code"]!.GetValue<string>()).Distinct(), code => Assert.NotNull(ErrorCatalog.Find(code)));
        // The removed legacy endpoint is gone from the dashboard API.
        await using var browser = new BrowserHandle(await fixture.BrowserAsync(OperatorApiFixture.ReadToken));
        Assert.Equal(HttpStatusCode.NotFound, (await browser.Client.GetAsync("/dashboard/api/diagnostics")).StatusCode);
    }

    [Fact]
    public async Task Node_segments_are_decoded_once_from_the_raw_target_under_both_prefixes()
    {
        var slash = await fixture.EnrollAsync("rack/A");
        var percent = await fixture.EnrollAsync("a%2Fb");
        var spaced = await fixture.EnrollAsync("two words & more");
        var plain = await fixture.EnrollAsync("plain-alias");
        var revoked = await fixture.EnrollAsync("old/rack%41");
        (await fixture.Admin.PostAsync($"/operator/v1/nodes/{revoked.NodeId.Value}/revoke", null)).EnsureSuccessStatusCode();
        await using var browser = new BrowserHandle(await fixture.BrowserAsync(OperatorApiFixture.ReadToken));

        foreach (var (segment, expected) in new[]
        {
            ("rack%2FA", slash), ("rack%2fA", slash), ("a%252Fb", percent), ("two%20words%20%26%20more", spaced), ("plain-alias", plain),
            (plain.NodeId.Value.ToString("D"), plain), (slash.NodeId.Value.ToString("D"), slash), ("old%2Frack%2541", revoked),
            (revoked.NodeId.Value.ToString("D"), revoked)
        })
            foreach (var prefix in new[] { "/operator/v1/nodes/", "/dashboard/api/nodes/" })
            {
                var client = prefix.StartsWith("/operator", StringComparison.Ordinal) ? fixture.Reader : browser.Client;
                var response = await client.GetAsync(prefix + segment);
                Assert.True(response.StatusCode == HttpStatusCode.OK, $"{prefix}{segment}: {await response.Content.ReadAsStringAsync()}");
                var detail = await OperatorApiFixture.ReadAsync(response);
                Assert.True(expected.NodeId.Value == detail["nodeId"]!.GetValue<Guid>(), $"{prefix}{segment}");
                Assert.Equal(expected.Alias, detail["name"]!.GetValue<string>());
                foreach (var route in new[] { "/attempts", "/checkins?hours=1" })
                    Assert.Equal(HttpStatusCode.OK, (await client.GetAsync(prefix + segment + route)).StatusCode);
            }
        Assert.True((await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/nodes/old%2Frack%2541")))["revoked"]!.GetValue<bool>());

        // The decoding happens once: the other spellings are different aliases and so unknown Nodes.
        foreach (var segment in new[] { "a%2Fb", "rack%252FA", "a%252fb%2F", "rack/A" })
            Assert.Equal(HttpStatusCode.NotFound, (await fixture.Reader.GetAsync("/operator/v1/nodes/" + segment)).StatusCode);
        var missing = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/nodes/no%2Fsuch/checkins"), HttpStatusCode.NotFound);
        Assert.Equal("node_not_found", missing["code"]!.GetValue<string>());

        // Retry resolves the same way. The Node has no failed Target, so the request gets as far as the Assignment lookup.
        var retry = await OperatorApiFixture.ReadAsync(await fixture.Operate.PostAsJsonAsync("/operator/v1/nodes/rack%2FA/retry",
            new { target = "skills" }), HttpStatusCode.NotFound);
        Assert.Equal("target_not_found", retry["code"]!.GetValue<string>());
        var revokedRetry = await OperatorApiFixture.ReadAsync(await fixture.Operate.PostAsJsonAsync("/operator/v1/nodes/old%2Frack%2541/retry",
            new { target = "skills" }), HttpStatusCode.Conflict);
        Assert.Equal("node_revoked", revokedRetry["code"]!.GetValue<string>());
    }

    [Fact]
    public async Task Revisions_rollouts_and_audit_page_newest_first_with_an_order_bound_cursor()
    {
        var node = await fixture.EnrollAsync("ordered-node");
        for (var i = 0; i < 3; i++) await fixture.PublishAsync(node, "rev-ordered-" + i);
        await using var browser = new BrowserHandle(await fixture.BrowserAsync(OperatorApiFixture.ReadToken));

        foreach (var (route, timestamp, idProperty) in new[]
        {
            ("desired-revisions", "acceptedAt", "desiredRevisionId"), ("rollouts", "createdAt", "rolloutId"), ("audit", "recordedAt", null)
        })
            foreach (var prefix in new[] { "/operator/v1/", "/dashboard/api/" })
            {
                var client = prefix.StartsWith("/operator", StringComparison.Ordinal) ? fixture.Reader : browser.Client;
                async Task<List<JsonNode>> Walk(string query, int limit)
                {
                    var items = new List<JsonNode>();
                    string? cursor = null;
                    do
                    {
                        var page = await OperatorApiFixture.ReadAsync(await client.GetAsync(
                            $"{prefix}{route}?limit={limit}{query}" + (cursor is null ? "" : "&after=" + Uri.EscapeDataString(cursor))));
                        items.AddRange(page["items"]!.AsArray().Select(x => x!));
                        cursor = page["nextCursor"]?.GetValue<string>();
                    } while (cursor is not null);
                    return items;
                }

                var newest = await Walk("&order=newest", 2);
                var everything = await Walk("&order=newest", 100);
                Assert.True(newest.Count >= 3, route);
                Assert.Equal(everything.Select(x => x.ToJsonString()), newest.Select(x => x.ToJsonString()));
                var times = newest.Select(x => DateTimeOffset.Parse(x[timestamp]!.GetValue<string>())).ToArray();
                Assert.Equal(times.OrderByDescending(x => x), times);
                // The same rows as the ID ordering, which stays the default.
                var byId = await Walk("", 2);
                Assert.Equal(byId.Select(x => x.ToJsonString()).Order(), newest.Select(x => x.ToJsonString()).Order());
                if (idProperty is not null)
                {
                    var ids = byId.Select(x => x[idProperty]!.GetValue<Guid>()).ToArray();
                    Assert.Equal(ids.OrderBy(x => x), ids);
                    Assert.Equal(ids.Length, ids.Distinct().Count());
                }

                // A cursor belongs to the order it came from.
                var idPage = await OperatorApiFixture.ReadAsync(await client.GetAsync($"{prefix}{route}?limit=1"));
                var newestPage = await OperatorApiFixture.ReadAsync(await client.GetAsync($"{prefix}{route}?limit=1&order=newest"));
                var idCursor = Uri.EscapeDataString(idPage["nextCursor"]!.GetValue<string>());
                var newestCursor = Uri.EscapeDataString(newestPage["nextCursor"]!.GetValue<string>());
                foreach (var query in new[] { $"order=newest&after={idCursor}", $"after={newestCursor}", "order=oldest", "order=", "order=newest&limit=101" })
                {
                    var rejected = await OperatorApiFixture.ReadAsync(await client.GetAsync($"{prefix}{route}?{query}"), HttpStatusCode.BadRequest);
                    Assert.Equal("invalid_request", rejected["code"]!.GetValue<string>());
                    Assert.False(string.IsNullOrWhiteSpace(rejected["message"]!.GetValue<string>()));
                }
            }
    }

    [Fact]
    public async Task Newest_first_paging_breaks_equal_timestamps_by_ID_without_gaps_or_repeats()
    {
        var at = new DateTimeOffset(2031, 5, 5, 12, 0, 0, TimeSpan.Zero);
        var ids = Enumerable.Range(0, 5).Select(_ => Guid.NewGuid()).ToArray();
        using (var scope = fixture.Scope())
        {
            var db = scope.ServiceProvider.GetRequiredService<FleetDbContext>();
            var workspace = scope.ServiceProvider.GetRequiredService<Microsoft.Extensions.Options.IOptions<FleetOptions>>().Value.WorkspaceId;
            foreach (var id in ids)
            {
                db.AuditEvents.Add(new() { Id = id, WorkspaceId = workspace, RecordedAt = at, Action = "test.tie", Actor = "tester" });
            }
            await db.SaveChangesAsync();
        }

        var seen = new List<string>();
        string? cursor = null;
        do
        {
            var page = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync(
                "/operator/v1/audit?order=newest&limit=2" + (cursor is null ? "" : "&after=" + Uri.EscapeDataString(cursor))));
            seen.AddRange(page["items"]!.AsArray().Where(x => x!["action"]!.GetValue<string>() == "test.tie").Select(x => x!["recordedAt"]!.GetValue<string>()));
            cursor = page["nextCursor"]?.GetValue<string>();
        } while (cursor is not null);
        Assert.Equal(5, seen.Count);
        // They are the newest rows by far, so they come first and the walk saw every one of them exactly once.
        var top = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/audit?order=newest&limit=5"));
        Assert.All(top["items"]!.AsArray(), x => Assert.Equal("test.tie", x!["action"]!.GetValue<string>()));
    }

    [Fact]
    public async Task Every_list_accepts_limits_from_1_to_100_and_rejects_others_with_an_error_message()
    {
        await fixture.EnrollAsync("limits-node");
        await using var browser = new BrowserHandle(await fixture.BrowserAsync(OperatorApiFixture.ReadToken));
        var routes = new List<string>
        {
            "nodes", "nodes/limits-node/attempts", "desired-revisions", "rollouts", "warnings", "audit", "source/scans", "enrollment-links",
            $"rollouts/{Guid.NewGuid()}/attempts"
        };
        foreach (var route in routes)
            foreach (var prefix in new[] { "/operator/v1/", "/dashboard/api/" })
            {
                var client = prefix.StartsWith("/operator", StringComparison.Ordinal) ? fixture.Reader : browser.Client;
                foreach (var ok in new[] { 1, 100 })
                    Assert.Equal(HttpStatusCode.OK, (await client.GetAsync($"{prefix}{route}?limit={ok}")).StatusCode);
                foreach (var bad in new[] { "0", "-1", "101", "200", "201", "abc" })
                {
                    var rejected = await OperatorApiFixture.ReadAsync(await client.GetAsync($"{prefix}{route}?limit={bad}"), HttpStatusCode.BadRequest);
                    Assert.Equal("invalid_request", rejected["code"]!.GetValue<string>());
                    Assert.False(string.IsNullOrWhiteSpace(rejected["message"]!.GetValue<string>()), $"{prefix}{route}?limit={bad}");
                }
            }
    }

    [Fact]
    public async Task Every_Operator_error_has_a_code_and_a_message_including_legacy_routes()
    {
        await using var browser = new BrowserHandle(await fixture.BrowserAsync(OperatorApiFixture.AdminToken));
        var cases = new List<(string Name, HttpResponseMessage Response, HttpStatusCode Status, string Code)>
        {
            ("expiry", await fixture.Admin.PostAsJsonAsync("/operator/v1/enrollment-tokens", new { expiresInSeconds = 5 }), HttpStatusCode.BadRequest, "invalid_expiry"),
            ("link expiry", await fixture.Admin.PostAsJsonAsync("/operator/v1/enrollment-links", new { alias = "x", expiresInSeconds = 5 }), HttpStatusCode.BadRequest, "invalid_expiry"),
            ("alias", await fixture.Admin.PostAsJsonAsync("/operator/v1/enrollment-links", new { alias = " ", expiresInSeconds = 900 }), HttpStatusCode.BadRequest, "invalid_alias"),
            ("dashboard link expiry", await browser.Client.PostAsJsonAsync("/dashboard/api/enrollment-links", new { alias = "x", expiresInSeconds = 5 }), HttpStatusCode.BadRequest, "invalid_expiry"),
            ("selection", await fixture.Admin.PostAsJsonAsync("/operator/v1/cliproxy/selection", new { baseUrl = "", version = 0, policy = (object?)null }), HttpStatusCode.BadRequest, "invalid_selection"),
            ("selection catalog", await fixture.Admin.PostAsJsonAsync("/operator/v1/cliproxy/selection", new
            {
                baseUrl = "https://proxy.example/none", version = 0,
                policy = new { includeNew = true, disabledFamilies = Array.Empty<string>(), enabledFamilies = Array.Empty<string>(), modelOverrides = new { }, skipClaudeModelsForOtherClients = false }
            }), HttpStatusCode.NotFound, "catalog_unavailable"),
            ("rename", await fixture.Admin.PostAsJsonAsync("/operator/v1/nodes/rename", new { currentAlias = "nobody", alias = "someone" }), HttpStatusCode.NotFound, "node_not_found"),
            ("revoke credential", await fixture.Admin.PostAsync($"/operator/v1/credentials/{Guid.NewGuid()}/revoke", null), HttpStatusCode.NotFound, "credential_not_found"),
            ("bad json", await fixture.Admin.PostAsync("/operator/v1/enrollment-tokens", new StringContent("{", Encoding.UTF8, "application/json")), HttpStatusCode.BadRequest, "invalid_request"),
            ("anonymous", await fixture.Anonymous.GetAsync("/operator/v1/nodes"), HttpStatusCode.Unauthorized, "unauthorized"),
            ("anonymous dashboard", await fixture.Anonymous.GetAsync("/dashboard/api/nodes"), HttpStatusCode.Unauthorized, "unauthorized")
        };
        foreach (var (name, response, status, code) in cases)
        {
            var body = await OperatorApiFixture.ReadAsync(response, status);
            Assert.True(code == body["code"]!.GetValue<string>(), $"{name}: {body}");
            Assert.False(string.IsNullOrWhiteSpace(body["message"]!.GetValue<string>()), name);
            Assert.Equal(["code", "message"], body.AsObject().Select(x => x.Key).Order());
        }

        // The CSRF and origin checks of the dashboard also explain themselves.
        using var noCsrf = fixture.Factory.CreateClient(new() { BaseAddress = new Uri(OperatorApiFixture.Origin) });
        noCsrf.DefaultRequestHeaders.Add("Origin", "https://evil.example");
        var origin = await OperatorApiFixture.ReadAsync(await noCsrf.PostAsJsonAsync("/dashboard/api/login", new { name = "x", password = "x" }), HttpStatusCode.BadRequest);
        Assert.Equal("invalid_origin", origin["code"]!.GetValue<string>());
        Assert.False(string.IsNullOrWhiteSpace(origin["message"]!.GetValue<string>()));

        // A rejected login explains itself too, for a wrong password, an unknown name and an invalid name.
        using var login = fixture.Factory.CreateClient(new() { BaseAddress = new Uri(OperatorApiFixture.Origin) });
        login.DefaultRequestHeaders.Add("Origin", OperatorApiFixture.DashboardOrigin);
        await OperatorApiFixture.RefreshCsrfAsync(login);
        foreach (var body in new object[]
        {
            new { name = "operator", password = "wrong-password" }, new { name = "nobody", password = OperatorApiFixture.AccountPassword },
            new { name = "not a name", password = OperatorApiFixture.AccountPassword }
        })
        {
            var rejected = await OperatorApiFixture.ReadAsync(await login.PostAsJsonAsync("/dashboard/api/login", body), HttpStatusCode.Unauthorized);
            Assert.Equal("unauthorized", rejected["code"]!.GetValue<string>());
            Assert.False(string.IsNullOrWhiteSpace(rejected["message"]!.GetValue<string>()));
        }
        // The old token body no longer binds to the login request: it is malformed, and still explained.
        var token = await OperatorApiFixture.ReadAsync(await login.PostAsJsonAsync("/dashboard/api/login", new { token = OperatorApiFixture.AdminToken }),
            HttpStatusCode.BadRequest);
        Assert.Equal("invalid_request", token["code"]!.GetValue<string>());
        Assert.False(string.IsNullOrWhiteSpace(token["message"]!.GetValue<string>()));

        // Every code in the examples above that a Server-side route can emit is explained.
        foreach (var code in new[] { "enrollment_link_not_found", "invalid_expiry", "invalid_alias", "invalid_selection", "catalog_unavailable", "unauthorized", "credential_not_found" })
            Assert.NotNull(ErrorCatalog.Find(code));
    }

    [Fact]
    public async Task Enrollment_link_can_be_read_by_ID_in_the_list_item_shape()
    {
        var created = await OperatorApiFixture.ReadAsync(await fixture.Admin.PostAsJsonAsync("/operator/v1/enrollment-links",
            new { alias = "single-link", expiresInSeconds = 900 }));
        var id = created["id"]!.GetValue<Guid>();
        var token = created["link"]!.GetValue<string>();

        var one = await fixture.Reader.GetAsync($"/operator/v1/enrollment-links/{id}");
        var text = await one.Content.ReadAsStringAsync();
        Assert.Equal(HttpStatusCode.OK, one.StatusCode);
        Assert.DoesNotContain(token, text);
        Assert.DoesNotContain("\"token\"", text);
        var link = JsonNode.Parse(text)!;
        ContractShape.AssertMatches("enrollment-link.json", link);
        Assert.Equal(id, link["id"]!.GetValue<Guid>());
        Assert.Equal("single-link", link["alias"]!.GetValue<string>());
        Assert.Equal("active", link["state"]!.GetValue<string>());
        var fromList = (await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/enrollment-links")))["items"]!.AsArray()
            .Single(x => x!["id"]!.GetValue<Guid>() == id);
        Assert.True(JsonNode.DeepEquals(fromList, link));

        (await fixture.Admin.PostAsync($"/operator/v1/enrollment-links/{id}/revoke", null)).EnsureSuccessStatusCode();
        var revoked = await OperatorApiFixture.ReadAsync(await fixture.Operate.GetAsync($"/operator/v1/enrollment-links/{id}"));
        Assert.Equal("revoked", revoked["state"]!.GetValue<string>());
        Assert.Equal("operator", revoked["revokedBy"]!.GetValue<string>());

        await using var browser = new BrowserHandle(await fixture.BrowserAsync(OperatorApiFixture.ReadToken));
        Assert.True(JsonNode.DeepEquals(revoked, await OperatorApiFixture.ReadAsync(await browser.Client.GetAsync($"/dashboard/api/enrollment-links/{id}"))));
        foreach (var missing in new[] { Guid.NewGuid().ToString(), "not-a-guid" })
        {
            var body = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/enrollment-links/" + missing), HttpStatusCode.NotFound);
            Assert.Equal("enrollment_link_not_found", body["code"]!.GetValue<string>());
            Assert.False(string.IsNullOrWhiteSpace(body["message"]!.GetValue<string>()));
            Assert.Equal(HttpStatusCode.NotFound, (await browser.Client.GetAsync("/dashboard/api/enrollment-links/" + missing)).StatusCode);
        }
        Assert.Equal(HttpStatusCode.Unauthorized, (await fixture.Anonymous.GetAsync($"/operator/v1/enrollment-links/{id}")).StatusCode);
    }

    [Fact]
    public async Task Failure_summaries_stay_correct_for_an_Assignment_with_thousands_of_failed_Attempts()
    {
        var node = await fixture.EnrollAsync("many-failures");
        var agent = await fixture.PublishAsync(node, "rev-many");
        await fixture.RunAgentAsync(agent, FailSkills);
        Guid assignmentId;
        DateTimeOffset realFailure;
        using (var scope = fixture.Scope())
        {
            var db = scope.ServiceProvider.GetRequiredService<FleetDbContext>();
            var failed = await db.Attempts.AsNoTracking().Join(db.Assignments.AsNoTracking(), a => a.AssignmentId, s => s.Id, (a, s) => new { a, s })
                .SingleAsync(x => x.s.NodeId == node.NodeId.Value && x.s.TargetName == "skills" && x.a.State == (int)ConvergenceState.Failed);
            assignmentId = failed.a.AssignmentId;
            realFailure = failed.a.UpdatedAt;
            // 3,000 older failures with another code, each a minute apart, ending an hour before the real one.
            await db.Database.ExecuteSqlInterpolatedAsync($"""
                INSERT INTO attempts ("Id", "AssignmentId", "RolloutId", "NodeId", "State", "ErrorCode", "Diagnostic", "UpdatedAt")
                SELECT gen_random_uuid(), {assignmentId}, {failed.a.RolloutId}, {node.NodeId.Value}, 3, 'io', NULL,
                       {realFailure} - interval '1 hour' - make_interval(mins => n)
                FROM generate_series(1, 3000) AS n
                """);
        }

        var detail = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/nodes/many-failures"));
        var skills = detail["targets"]!.AsArray().Single(x => x!["name"]!.GetValue<string>() == "skills")!;
        Assert.Equal(3001, skills["failedAttempts"]!.GetValue<int>());
        Assert.Equal(realFailure.AddHours(-1).AddMinutes(-3000), DateTimeOffset.Parse(skills["firstFailedAt"]!.GetValue<string>()));
        Assert.Equal("lock_failed", skills["latestAttempt"]!["errorCode"]!.GetValue<string>());
        Assert.Equal("failed", skills["latestAttempt"]!["state"]!.GetValue<string>());

        var issues = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/issues"));
        var issue = issues["items"]!.AsArray().Single(x => x!["id"]!.GetValue<string>() == $"assignment_failed:{node.NodeId.Value:D}:skills")!;
        Assert.Equal("lock_failed", issue["errorCode"]!.GetValue<string>());
        Assert.Equal(realFailure.AddHours(-1).AddMinutes(-3000), DateTimeOffset.Parse(issue["since"]!.GetValue<string>()));
    }

    [Fact]
    public async Task Error_catalog_explains_every_Agent_Server_and_issue_code()
    {
        string[] agentCodes =
        [
            "invalid_assignment", "unsupported_schema", "target_changed", "recovery_failed", "ownership_conflict", "owned_skill_drift",
            "non_regular_entry", "missing_owned_skill", "malformed_bundle", "lock_failed", "invalid_target", "invalid_state_directory",
            "invalid_skill_name", "invalid_home", "invalid_digest", "invalid_bundle_path", "filesystem_escape", "duplicate_skill",
            "corrupt_receipt", "bundle_size_mismatch", "bundle_path_collision", "bundle_limit_exceeded", "bundle_digest_mismatch",
            "assignment_superseded", "ai_client_reconcile_failed", "bundle_download_failed", "io"
        ];
        string[] serverCodes = ["node_not_found", "target_not_found", "target_not_failed", "node_revoked", "insufficient_scope", "invalid_request"];
        string[] issueCodes =
        [
            "assignment_failed", "repair_failed", "node_not_contacting", "more_failed_assignments", "cliproxy_key_missing", "cliproxy_discovery_pending",
            "cliproxy_refresh_failed", "source_not_configured", "source_sync_failed", "source_not_scanned"
        ];

        var catalog = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/errors"));
        ContractShape.AssertMatches("errors.json", catalog);
        var entries = catalog["items"]!.AsArray().Select(x => x!).ToArray();
        Assert.Equal(entries.Length, entries.Select(x => x["code"]!.GetValue<string>()).Distinct().Count());
        foreach (var (codes, source) in new[] { (agentCodes, "agent"), (serverCodes, "server"), (issueCodes, "issue") })
            foreach (var code in codes)
                Assert.Equal(source, entries.Single(x => x["code"]!.GetValue<string>() == code)["source"]!.GetValue<string>());
        foreach (var entry in entries)
        {
            var code = entry["code"]!.GetValue<string>();
            Assert.Matches("^[a-z][a-z0-9_]*$", code);
            Assert.InRange(entry["title"]!.GetValue<string>().Length, 1, 80);
            var sentences = Sentence().Matches(entry["explanation"]!.GetValue<string>()).Count;
            Assert.InRange(sentences, 1, 3);
            var fix = entry["fix"]!.AsArray().Select(x => x!.GetValue<string>()).ToArray();
            Assert.NotEmpty(fix);
            Assert.All(fix, step => Assert.False(string.IsNullOrWhiteSpace(step)));
        }
        // Remedies point at commands the CLI has.
        Assert.Contains(entries.Single(x => x["code"]!.GetValue<string>() == "lock_failed")["fix"]!.AsArray(),
            x => x!.GetValue<string>().Contains("`fleet retry <node> <target>`"));

        var one = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/errors/lock_failed"));
        Assert.True(JsonNode.DeepEquals(entries.Single(x => x["code"]!.GetValue<string>() == "lock_failed"), one));
        var missing = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/errors/not_a_code"), HttpStatusCode.NotFound);
        Assert.Equal("invalid_request", missing["code"]!.GetValue<string>());
        Assert.False(string.IsNullOrWhiteSpace(missing["message"]!.GetValue<string>()));

        // When the Agent source is checked out, the catalog must cover every code it can report.
        var reconcile = FindUpwards("clients/crates/fleet-reconcile/src/lib.rs");
        if (reconcile is not null)
        {
            var source = File.ReadAllText(reconcile);
            // The Agent also has a Step enum with its own as_str; only the error codes belong in the catalog.
            var errors = source[source.IndexOf("impl ReconcileError", StringComparison.Ordinal)..];
            var asString = errors[errors.IndexOf("pub const fn as_str", StringComparison.Ordinal)..];
            var codes = RustCode().Matches(asString[..asString.IndexOf("impl fmt::Display", StringComparison.Ordinal)]).Select(x => x.Groups[1].Value).ToArray();
            Assert.True(codes.Length >= 24, "Expected to find the reconciler error codes in the Agent source.");
            Assert.All(codes, code => Assert.NotNull(ErrorCatalog.Find(code)));
        }
    }

    [Fact]
    public async Task Source_scans_are_listed_newest_first_and_paged()
    {
        var baseTime = new DateTimeOffset(2030, 1, 1, 0, 0, 0, TimeSpan.Zero);
        using (var scope = fixture.Scope())
        {
            var coordinator = scope.ServiceProvider.GetRequiredService<IFleetCoordinator>();
            await coordinator.RecordSourceScanAsync(new("rev-a", SourceScanOutcome.Accepted, null, null, baseTime.AddMinutes(1), "operator"));
            await coordinator.RecordSourceScanAsync(new("rev-a", SourceScanOutcome.Unchanged, null, null, baseTime.AddMinutes(2)));
            await coordinator.RecordSourceScanAsync(new(null, SourceScanOutcome.Failed, "git_failed", "Repository could not be fetched.", baseTime.AddMinutes(3)));
            await coordinator.RecordSourceScanAsync(new("rev-b", SourceScanOutcome.Invalid, "invalid_manifest", "fleet.yml is invalid.", baseTime.AddMinutes(4), "read-bot"));
        }

        var first = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/source/scans?limit=3"));
        ContractShape.AssertMatches("source-scans-page.json", first);
        var items = first["items"]!.AsArray();
        Assert.Equal(3, items.Count);
        Assert.Equal(["invalid", "failed", "unchanged"], items.Select(x => x!["outcome"]!.GetValue<string>()));
        Assert.Equal("invalid_manifest", items[0]!["code"]!.GetValue<string>());
        Assert.Equal("read-bot", items[0]!["requestedBy"]!.GetValue<string>());
        Assert.Equal("fleet.yml is invalid.", items[0]!["diagnostic"]!.GetValue<string>());
        Assert.Null(items[1]!["sourceRevision"]);
        Assert.NotNull(items[0]!["scanId"]);
        var cursor = first["nextCursor"]!.GetValue<string>();
        var second = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/source/scans?limit=1&after=" + Uri.EscapeDataString(cursor)));
        var next = Assert.Single(second["items"]!.AsArray())!;
        Assert.Equal("accepted", next["outcome"]!.GetValue<string>());
        Assert.Equal("operator", next["requestedBy"]!.GetValue<string>());

        foreach (var query in new[] { "limit=0", "limit=101", "after=%25%25" })
        {
            var rejected = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/source/scans?" + query), HttpStatusCode.BadRequest);
            Assert.Equal("invalid_request", rejected["code"]!.GetValue<string>());
        }
        // The existing status route reports the latest scan and is available to the dashboard too.
        var status = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/source/status"));
        Assert.Equal("invalid", status["outcome"]!.GetValue<string>());
    }

    [Fact]
    public async Task Enrollment_links_are_listed_with_their_state_and_never_expose_tokens()
    {
        async Task<(Guid Id, string Token)> Create(string alias)
        {
            var created = await OperatorApiFixture.ReadAsync(await fixture.Admin.PostAsJsonAsync("/operator/v1/enrollment-links",
                new { alias, expiresInSeconds = 900 }));
            var link = new Uri(created["link"]!.GetValue<string>());
            Assert.Equal("https://localhost/enroll", link.GetLeftPart(UriPartial.Path));
            var payload = JsonSerializer.Deserialize<JsonElement>(Microsoft.AspNetCore.WebUtilities.WebEncoders.Base64UrlDecode(link.Fragment[10..]));
            return (created["id"]!.GetValue<Guid>(), payload.GetProperty("token").GetString()!);
        }

        var active = await Create("links-active");
        var revoked = await Create("links-revoked");
        var consumed = await Create("links-consumed");
        var expired = await Create("links-expired");
        Assert.Equal(HttpStatusCode.Forbidden, (await fixture.Operate.PostAsJsonAsync("/operator/v1/enrollment-links",
            new { alias = "links-denied", expiresInSeconds = 900 })).StatusCode);
        (await fixture.Admin.PostAsync($"/operator/v1/enrollment-links/{revoked.Id}/revoke", null)).EnsureSuccessStatusCode();
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var csr = new CertificateRequest("CN=ignored", key, HashAlgorithmName.SHA256).CreateSigningRequestPem();
        var enrolled = await fixture.Anonymous.PostAsJsonAsync("/agent/v1/enroll",
            new { token = consumed.Token, certificateRequestPem = csr, nodeName = "links-consumed", platform = "linux" });
        enrolled.EnsureSuccessStatusCode();
        var consumedNode = (await enrolled.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("nodeId").GetGuid();
        using (var scope = fixture.Scope())
            await scope.ServiceProvider.GetRequiredService<FleetDbContext>().Enrollments.Where(x => x.Id == expired.Id)
                .ExecuteUpdateAsync(set => set.SetProperty(x => x.ExpiresAt, DateTimeOffset.UtcNow.AddHours(-1)));

        var response = await fixture.Reader.GetAsync("/operator/v1/enrollment-links");
        var text = await response.Content.ReadAsStringAsync();
        foreach (var secret in new[] { active.Token, revoked.Token, consumed.Token, expired.Token })
            Assert.DoesNotContain(secret, text);
        Assert.DoesNotContain("\"link\"", text);
        Assert.DoesNotContain("\"token\"", text);
        var page = JsonNode.Parse(text)!;
        ContractShape.AssertMatches("enrollment-links-page.json", page);
        JsonNode Link(Guid id) => page["items"]!.AsArray().Single(x => x!["id"]!.GetValue<Guid>() == id)!;
        Assert.Equal("active", Link(active.Id)["state"]!.GetValue<string>());
        Assert.Equal("links-active", Link(active.Id)["alias"]!.GetValue<string>());
        Assert.Null(Link(active.Id)["nodeId"]);
        Assert.Equal("revoked", Link(revoked.Id)["state"]!.GetValue<string>());
        Assert.Equal("operator", Link(revoked.Id)["revokedBy"]!.GetValue<string>());
        Assert.NotNull(Link(revoked.Id)["revokedAt"]);
        Assert.Equal("consumed", Link(consumed.Id)["state"]!.GetValue<string>());
        Assert.Equal(consumedNode, Link(consumed.Id)["nodeId"]!.GetValue<Guid>());
        Assert.NotNull(Link(consumed.Id)["consumedAt"]);
        Assert.Equal("expired", Link(expired.Id)["state"]!.GetValue<string>());

        var expiries = page["items"]!.AsArray().Select(x => DateTimeOffset.Parse(x!["expiresAt"]!.GetValue<string>())).ToArray();
        Assert.Equal(expiries.OrderByDescending(x => x), expiries);
        var paged = new List<Guid>();
        string? cursor = null;
        do
        {
            var step = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync(
                "/operator/v1/enrollment-links?limit=2" + (cursor is null ? "" : "&after=" + Uri.EscapeDataString(cursor))));
            paged.AddRange(step["items"]!.AsArray().Select(x => x!["id"]!.GetValue<Guid>()));
            cursor = step["nextCursor"]?.GetValue<string>();
        } while (cursor is not null);
        Assert.Equal(page["items"]!.AsArray().Select(x => x!["id"]!.GetValue<Guid>()), paged);

        await using var browser = new BrowserHandle(await fixture.BrowserAsync(OperatorApiFixture.ReadToken));
        Assert.True(JsonNode.DeepEquals(page, await OperatorApiFixture.ReadAsync(await browser.Client.GetAsync("/dashboard/api/enrollment-links"))));
    }

    [Fact]
    public async Task Audit_can_be_filtered_by_Node_and_names_the_Node()
    {
        var node = await fixture.EnrollAsync("audit-node");
        (await fixture.Admin.PostAsJsonAsync("/operator/v1/nodes/rename", new { currentAlias = "audit-node", alias = "audit-renamed" })).EnsureSuccessStatusCode();
        await fixture.EnrollAsync("audit-other");

        var byAlias = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/audit?node=audit-renamed"));
        var byId = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync($"/operator/v1/audit?node={node.NodeId.Value}"));
        Assert.True(JsonNode.DeepEquals(byAlias, byId));
        var items = byAlias["items"]!.AsArray();
        Assert.Equal(2, items.Count);
        Assert.Equal(["node_alias_changed", "node_enrolled"], items.Select(x => x!["action"]!.GetValue<string>()).Order());
        Assert.All(items, x =>
        {
            Assert.Equal(node.NodeId.Value, x!["nodeId"]!.GetValue<Guid>());
            Assert.Equal("audit-renamed", x["nodeName"]!.GetValue<string>());
        });
        var unfiltered = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/audit"));
        Assert.All(unfiltered["items"]!.AsArray(), x => Assert.True(x!.AsObject().ContainsKey("nodeName")));
        Assert.Contains(unfiltered["items"]!.AsArray(), x => x!["nodeId"] is null && x["nodeName"] is null);

        var unknown = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/audit?node=nobody"), HttpStatusCode.NotFound);
        Assert.Equal("node_not_found", unknown["code"]!.GetValue<string>());
        Assert.Empty((await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync($"/operator/v1/audit?node={Guid.NewGuid()}")))["items"]!.AsArray());

        // After removal the history stays reachable by ID, with no Node name.
        (await fixture.Admin.PostAsJsonAsync($"/operator/v1/nodes/{node.NodeId.Value}/remove", new { alias = "audit-renamed" })).EnsureSuccessStatusCode();
        var removed = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync($"/operator/v1/audit?node={node.NodeId.Value}"));
        Assert.Equal(3, removed["items"]!.AsArray().Count);
        Assert.All(removed["items"]!.AsArray(), x => Assert.Null(x!["nodeName"]));
        Assert.Equal(HttpStatusCode.NotFound, (await fixture.Reader.GetAsync("/operator/v1/audit?node=audit-renamed")).StatusCode);
    }

    [Fact]
    public async Task Every_read_route_returns_the_same_answer_under_the_bearer_and_dashboard_prefixes()
    {
        await fixture.EnrollAsync("parity-node");
        await using var browser = new BrowserHandle(await fixture.BrowserAsync(OperatorApiFixture.ReadToken));
        foreach (var route in new[]
        {
            "nodes", "rollouts", "desired-revisions", "warnings", "audit", "source/status", "source/scans", "issues", "errors",
            "errors/lock_failed", "enrollment-links", "cliproxy/status", "cliproxy/selection", "nodes/parity-node", "nodes/parity-node/attempts",
            "nodes/parity-node/checkins?hours=2"
        })
        {
            var bearer = await fixture.Reader.GetAsync("/operator/v1/" + route);
            var session = await browser.Client.GetAsync("/dashboard/api/" + route);
            Assert.True(bearer.StatusCode == HttpStatusCode.OK, route);
            Assert.True(session.StatusCode == HttpStatusCode.OK, route);
            Assert.Equal(await bearer.Content.ReadAsStringAsync(), await session.Content.ReadAsStringAsync());
        }
        Assert.Equal(HttpStatusCode.Unauthorized, (await fixture.Anonymous.GetAsync("/dashboard/api/issues")).StatusCode);
    }

    private static string? FindUpwards(string relative)
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, relative);
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    [GeneratedRegex(@"[.!?](\s|$)")]
    private static partial Regex Sentence();

    [GeneratedRegex(@"=>\s*""([a-z_]+)""")]
    private static partial Regex RustCode();

    private sealed class BrowserHandle(HttpClient client) : IAsyncDisposable
    {
        public HttpClient Client { get; } = client;
        public ValueTask DisposeAsync()
        {
            Client.Dispose();
            return ValueTask.CompletedTask;
        }
    }

    [Theory]
    [InlineData("/operator/v1/nodes/rack%2FA", "/operator/v1/nodes/rack%2FA", "rack/A")]
    [InlineData("/operator/v1/nodes/a%252Fb/attempts?limit=5", "/operator/v1/nodes/a%2Fb/attempts", "a%2Fb")]
    [InlineData("/operator/v1/%6Eodes/rack%2FA", "/operator/v1/nodes/rack%2FA", "rack/A")]
    [InlineData("/dashboard/api/nodes/rack%2fA/retry", "/dashboard/api/nodes/rack%2fA/retry", "rack/A")]
    [InlineData("https://fleet.example/operator/v1/nodes/my%20box", "/operator/v1/nodes/my box", "my box")]
    [InlineData("/operator/v1/nodes/x%252fy", "/operator/v1/nodes/x%2fy", "x%2fy")]
    public void Node_segment_is_decoded_once_from_a_canonical_raw_target(string raw, string path, string expected) =>
        Assert.Equal(expected, OperatorApi.NodeSegment(RawRequest(raw, path), "ignored"));

    [Theory]
    [InlineData("/operator/v1/nodes/a/../b", "/operator/v1/nodes/b")]
    [InlineData("/operator/v1/nodes/./b", "/operator/v1/nodes/b")]
    [InlineData("/operator/v1/nodes/a/%2E%2E/b/retry", "/operator/v1/nodes/b/retry")]
    [InlineData("/operator/v1//nodes/b", "/operator/v1/nodes/b")]
    public void Node_segment_rejects_raw_targets_that_differ_from_the_matched_path(string raw, string path)
    {
        var error = Assert.Throws<OperatorApiException>(() => OperatorApi.NodeSegment(RawRequest(raw, path), "b"));
        Assert.Equal("invalid_request", error.Code);
    }

    private static Microsoft.AspNetCore.Http.HttpContext RawRequest(string raw, string path)
    {
        var http = new Microsoft.AspNetCore.Http.DefaultHttpContext();
        http.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpRequestFeature>()!.RawTarget = raw;
        http.Request.Path = new Microsoft.AspNetCore.Http.PathString(path);
        return http;
    }
}
