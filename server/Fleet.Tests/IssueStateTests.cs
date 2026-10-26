using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Fleet.Core.Coordination;
using Fleet.Server.Persistence;
using Fleet.Server.Security;
using Fleet.Server.Transport;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Fleet.Tests;

/// <summary>Phase 4, issue state: <c>POST issues/state</c> and the state fields of <c>GET issues</c>.</summary>
public sealed class IssueStateTests(OperatorApiFixture fixture) : IClassFixture<OperatorApiFixture>
{
    private const string Path = "/operator/v1/issues/state";

    private static (ConvergenceState, string?) FailSkills(string target) =>
        target == "skills" ? (ConvergenceState.Failed, "lock_failed") : (ConvergenceState.Succeeded, null);

    /// <summary>A Node whose Skills Target failed. Returns it with the ID of the resulting issue.</summary>
    private async Task<(EnrolledNode Node, NodeAuthentication Agent, string IssueId)> FailedAsync(string alias)
    {
        var node = await fixture.EnrollAsync(alias);
        var agent = await fixture.PublishAsync(node, "rev-" + alias);
        await fixture.RunAgentAsync(agent, FailSkills);
        return (node, agent, $"assignment_failed:{node.NodeId.Value:D}:skills");
    }

    private static async Task<JsonNode[]> IssuesAsync(HttpClient client, string prefix = "/operator/v1")
    {
        var response = await OperatorApiFixture.ReadAsync(await client.GetAsync(prefix + "/issues"));
        return response["items"]!.AsArray().Select(x => x!).ToArray();
    }

    private static async Task<JsonNode> IssueAsync(HttpClient client, string id, string prefix = "/operator/v1") =>
        (await IssuesAsync(client, prefix)).Single(x => x["id"]!.GetValue<string>() == id);

    private static Task<HttpResponseMessage> ChangeAsync(HttpClient client, string id, string action, int? hours = null, string path = Path) =>
        client.PostAsJsonAsync(path, hours is null ? new { id, action } : (object)new { id, action, hours });

    private async Task<string[]> AuditActionsAsync(string alias) =>
        (await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync($"/operator/v1/audit?node={alias}&order=newest")))["items"]!.AsArray()
            .Select(x => x!["action"]!.GetValue<string>()).Where(x => x.StartsWith("issue.", StringComparison.Ordinal)).Reverse().ToArray();

    [Fact]
    public async Task An_issue_is_acknowledged_snoozed_and_reopened_with_the_updated_item_returned_and_every_change_audited()
    {
        var (node, _, id) = await FailedAsync("istate-flow");
        var before = await IssuesAsync(fixture.Reader);
        var open = before.Single(x => x["id"]!.GetValue<string>() == id);
        Assert.Equal(Open, StateOf(open));

        var started = DateTimeOffset.UtcNow;
        var acknowledged = await OperatorApiFixture.ReadAsync(await ChangeAsync(fixture.Operate, id, "acknowledge"));
        Assert.Equal(id, acknowledged["id"]!.GetValue<string>());
        Assert.Equal(new StateView("acknowledged", "operate-bot", true, false), StateOf(acknowledged));
        Assert.InRange(acknowledged["stateAt"]!.GetValue<DateTimeOffset>(), started.AddSeconds(-1), DateTimeOffset.UtcNow.AddSeconds(1));
        Assert.Null(acknowledged["snoozedUntil"]);
        // The item is the issue as GET issues returns it, with only the state fields changed.
        foreach (var name in new[] { "code", "severity", "title", "detail", "action", "section", "errorCode", "nodeId", "nodeName", "target", "since", "commands" })
            Assert.True(JsonNode.DeepEquals(open[name], acknowledged[name]), name);
        Assert.Equal(open.AsObject().Select(x => x.Key), acknowledged.AsObject().Select(x => x.Key));

        var listed = await IssuesAsync(fixture.Reader);
        ContractShape.AssertMatches("issues.json", new JsonObject { ["items"] = new JsonArray(listed.Select(x => x.DeepClone()).ToArray()) });
        // Issues keep their order, and a read Operator sees who acknowledged.
        Assert.Equal(before.Select(x => x["id"]!.GetValue<string>()), listed.Select(x => x["id"]!.GetValue<string>()));
        Assert.True(JsonNode.DeepEquals(acknowledged, listed.Single(x => x["id"]!.GetValue<string>() == id)));

        var snoozed = await OperatorApiFixture.ReadAsync(await ChangeAsync(fixture.Admin, id, "snooze", 24));
        Assert.Equal(new StateView("snoozed", "operator", true, true), StateOf(snoozed));
        Assert.InRange(snoozed["snoozedUntil"]!.GetValue<DateTimeOffset>(), DateTimeOffset.UtcNow.AddHours(24).AddMinutes(-1), DateTimeOffset.UtcNow.AddHours(24).AddMinutes(1));
        Assert.True(JsonNode.DeepEquals(snoozed, await IssueAsync(fixture.Reader, id)));

        // An acknowledgement replaces the snooze.
        var again = await OperatorApiFixture.ReadAsync(await ChangeAsync(fixture.Operate, id, "acknowledge"));
        Assert.Equal("acknowledged", again["state"]!.GetValue<string>());
        Assert.Null(again["snoozedUntil"]);

        var reopened = await OperatorApiFixture.ReadAsync(await ChangeAsync(fixture.Operate, id, "reopen"));
        Assert.Equal(Open, StateOf(reopened));
        Assert.Equal(Open, StateOf(await IssueAsync(fixture.Reader, id)));
        // Reopening an open issue is fine.
        Assert.Equal("open", (await OperatorApiFixture.ReadAsync(await ChangeAsync(fixture.Operate, id, "reopen")))["state"]!.GetValue<string>());

        Assert.Equal(["issue.acknowledged", "issue.snoozed", "issue.acknowledged", "issue.reopened", "issue.reopened"], await AuditActionsAsync("istate-flow"));
        var audit = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/audit?node=istate-flow&order=newest"));
        var event0 = audit["items"]!.AsArray().First(x => x!["action"]!.GetValue<string>().StartsWith("issue.", StringComparison.Ordinal))!;
        Assert.Equal(node.NodeId.Value, event0["nodeId"]!.GetValue<Guid>());
        Assert.Equal("operate-bot", event0["actor"]!.GetValue<string>());
        using var scope = fixture.Scope();
        Assert.Equal(0, await scope.ServiceProvider.GetRequiredService<FleetDbContext>().IssueStates.CountAsync(x => x.IssueId == id));
    }

    private sealed record StateView(string State, string? By, bool HasAt, bool HasUntil);

    private static StateView StateOf(JsonNode item) =>
        new(item["state"]!.GetValue<string>(), item["stateBy"]?.GetValue<string>(), item["stateAt"] is not null, item["snoozedUntil"] is not null);

    private static readonly StateView Open = new("open", null, false, false);

    private sealed class OutageClock : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = DateTimeOffset.UtcNow;
        public override DateTimeOffset GetUtcNow() => Now;
    }

    [Fact]
    public async Task A_recovered_proxy_outage_does_not_hide_a_later_failure_with_its_acknowledgement()
    {
        const string url = "https://proxy.example/v1";
        var node = await fixture.EnrollAsync("istate-proxy-recurrence");
        await fixture.PublishAsync(node, "rev-istate-proxy-recurrence", aiClientUsesProxy: true);
        using var scope = fixture.Scope();
        var db = scope.ServiceProvider.GetRequiredService<FleetDbContext>();
        var coordinator = scope.ServiceProvider.GetRequiredService<IFleetCoordinator>();
        var settings = new FleetOptions
        {
            WorkspaceId = scope.ServiceProvider.GetRequiredService<IOptions<FleetOptions>>().Value.WorkspaceId,
            CliProxyApiKey = "test-only-key"
        };
        var handler = new CliProxyCatalogTests.Handler { Status = HttpStatusCode.ServiceUnavailable };
        var clock = new OutageClock();
        var catalog = new CliProxyCatalog(handler, Options.Create(settings), clock);
        var config = new ConfigurationBuilder().Build();
        Task<IReadOnlyList<OperatorIssue>> Issues() => OperatorIssues.ConfigurationAsync(db, coordinator, catalog, settings, config, default);

        await catalog.SyncAsync([url], true, default);
        var first = Assert.Single((await Issues()), x => x.Code == "cliproxy_refresh_failed");
        Assert.Equal(clock.Now, first.Since);
        var acknowledged = await coordinator.ChangeIssueStateAsync(new(first.Id, IssueStateAction.Acknowledge,
            null, first.Since, null, "operator", [first.Id]));
        Assert.Equal("acknowledged", OperatorIssues.WithState(first, acknowledged, clock.Now).State);

        // Repeated failed refreshes are still the same outage.
        clock.Now = clock.Now.AddMinutes(2);
        await catalog.SyncAsync([url], true, default);
        var repeated = Assert.Single((await Issues()), x => x.Code == "cliproxy_refresh_failed");
        Assert.Equal(first.Since, repeated.Since);
        Assert.Equal("acknowledged", OperatorIssues.WithState(repeated, acknowledged, clock.Now).State);

        handler.Status = HttpStatusCode.OK;
        await catalog.SyncAsync([url], true, default);
        Assert.Null(catalog.FailureSince(url));
        Assert.DoesNotContain(await Issues(), x => x.Id == first.Id);
        clock.Now = clock.Now.AddMinutes(2);
        handler.Status = HttpStatusCode.ServiceUnavailable;
        await catalog.SyncAsync([url], true, default);
        var next = Assert.Single((await Issues()), x => x.Code == "cliproxy_refresh_failed");
        Assert.Equal(first.Id, next.Id);
        Assert.True(next.Since > first.Since);
        var stored = (await coordinator.GetIssueStatesAsync([first.Id]))[first.Id];
        Assert.Equal("open", OperatorIssues.WithState(next, stored, clock.Now).State);
    }

    [Fact]
    public async Task A_snooze_ends_when_its_time_passes_and_a_later_change_deletes_stale_rows()
    {
        var (_, _, snoozedId) = await FailedAsync("istate-expiry");
        var (otherNode, otherAgent, otherId) = await FailedAsync("istate-other");
        await OperatorApiFixture.ReadAsync(await ChangeAsync(fixture.Operate, snoozedId, "snooze", 1));
        await OperatorApiFixture.ReadAsync(await ChangeAsync(fixture.Operate, otherId, "acknowledge"));
        Assert.Equal("snoozed", (await IssueAsync(fixture.Reader, snoozedId))["state"]!.GetValue<string>());

        using (var scope = fixture.Scope())
        {
            var db = scope.ServiceProvider.GetRequiredService<FleetDbContext>();
            await db.IssueStates.Where(x => x.IssueId == snoozedId).ExecuteUpdateAsync(s => s.SetProperty(x => x.SnoozedUntil, DateTimeOffset.UtcNow.AddMinutes(-1)));
        }
        var expired = await IssueAsync(fixture.Reader, snoozedId);
        Assert.Equal(Open, StateOf(expired));

        // The other issue is resolved (its Skills succeed after a retry), so its acknowledgement is obsolete.
        (await fixture.Operate.PostAsJsonAsync($"/operator/v1/nodes/{otherNode.NodeId.Value}/retry", new { target = "skills" })).EnsureSuccessStatusCode();
        await fixture.RunAgentAsync(otherAgent, _ => (ConvergenceState.Succeeded, null));
        Assert.DoesNotContain(await IssuesAsync(fixture.Reader), x => x["id"]!.GetValue<string>() == otherId);

        // Any change deletes the expired snooze and the acknowledgement of the issue that is gone, but not the one it writes.
        var (_, _, third) = await FailedAsync("istate-third");
        await OperatorApiFixture.ReadAsync(await ChangeAsync(fixture.Operate, third, "acknowledge"));
        using var check = fixture.Scope();
        var ids = await check.ServiceProvider.GetRequiredService<FleetDbContext>().IssueStates.AsNoTracking().Select(x => x.IssueId).ToListAsync();
        Assert.DoesNotContain(snoozedId, ids);
        Assert.DoesNotContain(otherId, ids);
        Assert.Contains(third, ids);
    }

    [Fact]
    public async Task An_acknowledgement_applies_only_to_the_occurrence_it_was_made_for()
    {
        var (node, agent, id) = await FailedAsync("istate-since");
        var first = await OperatorApiFixture.ReadAsync(await ChangeAsync(fixture.Operate, id, "acknowledge"));
        var firstSince = first["since"]!.GetValue<DateTimeOffset>();
        Assert.Equal("acknowledged", (await IssueAsync(fixture.Reader, id))["state"]!.GetValue<string>());

        // A retry that fails again keeps the first failure time of the Assignment, so the acknowledgement stays.
        (await fixture.Operate.PostAsJsonAsync($"/operator/v1/nodes/{node.NodeId.Value}/retry", new { target = "skills" })).EnsureSuccessStatusCode();
        await fixture.RunAgentAsync(agent, FailSkills);
        var afterRetry = await IssueAsync(fixture.Reader, id);
        Assert.Equal(firstSince, afterRetry["since"]!.GetValue<DateTimeOffset>());
        Assert.Equal("acknowledged", afterRetry["state"]!.GetValue<string>());

        // A new revision whose Assignment fails starts a new occurrence of the same issue: it is open again.
        await fixture.PublishAsync(node, "rev-istate-since-2");
        await fixture.RunAgentAsync(agent, FailSkills);
        var next = await IssueAsync(fixture.Reader, id);
        Assert.True(next["since"]!.GetValue<DateTimeOffset>() > firstSince);
        Assert.Equal(Open, StateOf(next));

        // Acknowledging again stores the new occurrence.
        Assert.Equal("acknowledged", (await OperatorApiFixture.ReadAsync(await ChangeAsync(fixture.Operate, id, "acknowledge")))["state"]!.GetValue<string>());
        Assert.Equal("acknowledged", (await IssueAsync(fixture.Reader, id))["state"]!.GetValue<string>());
    }

    [Fact]
    public async Task An_issue_without_a_since_can_be_acknowledged_and_the_audit_event_names_no_Node()
    {
        var issues = await IssuesAsync(fixture.Reader);
        var issue = issues.First(x => x["since"] is null && x["nodeId"] is null);
        var id = issue["id"]!.GetValue<string>();
        var acknowledged = await OperatorApiFixture.ReadAsync(await ChangeAsync(fixture.Operate, id, "acknowledge"));
        Assert.Equal("acknowledged", acknowledged["state"]!.GetValue<string>());
        Assert.Equal("acknowledged", (await IssueAsync(fixture.Reader, id))["state"]!.GetValue<string>());
        var audit = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/audit?order=newest&limit=20"));
        var entry = audit["items"]!.AsArray().First(x => x!["action"]!.GetValue<string>() == "issue.acknowledged")!;
        Assert.Null(entry["nodeId"]);
        await OperatorApiFixture.ReadAsync(await ChangeAsync(fixture.Operate, id, "reopen"));
    }

    [Fact]
    public async Task Unknown_ids_invalid_requests_and_a_read_credential_are_refused_without_changing_anything()
    {
        var (_, _, id) = await FailedAsync("istate-refuse");

        var denied = await OperatorApiFixture.ReadAsync(await ChangeAsync(fixture.Reader, id, "acknowledge"), HttpStatusCode.Forbidden);
        Assert.Equal("insufficient_scope", denied["code"]!.GetValue<string>());
        Assert.False(string.IsNullOrWhiteSpace(denied["message"]!.GetValue<string>()));
        Assert.Equal(HttpStatusCode.Unauthorized, (await ChangeAsync(fixture.Anonymous, id, "acknowledge")).StatusCode);

        var unknown = await OperatorApiFixture.ReadAsync(await ChangeAsync(fixture.Operate, "assignment_failed:" + Guid.NewGuid() + ":skills", "acknowledge"),
            HttpStatusCode.NotFound);
        Assert.Equal(["code", "message"], unknown.AsObject().Select(x => x.Key).Order());
        Assert.Equal("issue_not_found", unknown["code"]!.GetValue<string>());
        Assert.False(string.IsNullOrWhiteSpace(unknown["message"]!.GetValue<string>()));
        Assert.NotNull(Fleet.Server.Transport.ErrorCatalog.Find("issue_not_found"));

        var invalid = new (string Name, object Body)[]
        {
            ("no id", new { action = "acknowledge" }),
            ("empty id", new { id = "", action = "acknowledge" }),
            ("long id", new { id = new string('x', 301), action = "acknowledge" }),
            ("no action", new { id }),
            ("unknown action", new { id, action = "mute" }),
            ("wrong case", new { id, action = "Acknowledge" }),
            ("snooze without hours", new { id, action = "snooze" }),
            ("snooze 0 hours", new { id, action = "snooze", hours = 0 }),
            ("snooze 169 hours", new { id, action = "snooze", hours = 169 }),
            ("snooze negative", new { id, action = "snooze", hours = -1 }),
            ("hours with acknowledge", new { id, action = "acknowledge", hours = 1 }),
            ("hours with reopen", new { id, action = "reopen", hours = 1 }),
            ("fractional hours", new { id, action = "snooze", hours = 1.5 }),
            ("text hours", new { id, action = "snooze", hours = "2" }),
            ("unknown member", new { id, action = "acknowledge", extra = true }),
        };
        foreach (var (name, body) in invalid)
        {
            var response = await fixture.Operate.PostAsJsonAsync(Path, body);
            var json = await OperatorApiFixture.ReadAsync(response, HttpStatusCode.BadRequest);
            Assert.True(json["code"]!.GetValue<string>() == "invalid_request", name);
            Assert.False(string.IsNullOrWhiteSpace(json["message"]!.GetValue<string>()), name);
        }
        Assert.Equal((HttpStatusCode.OK, HttpStatusCode.OK), ((await ChangeAsync(fixture.Operate, id, "snooze", 1)).StatusCode,
            (await ChangeAsync(fixture.Operate, id, "snooze", 168)).StatusCode));
        await OperatorApiFixture.ReadAsync(await ChangeAsync(fixture.Operate, id, "reopen"));

        // Only the two snoozes and the reopen were audited.
        Assert.Equal(["issue.snoozed", "issue.snoozed", "issue.reopened"], await AuditActionsAsync("istate-refuse"));
    }

    [Fact]
    public async Task The_dashboard_route_needs_the_operate_scope_and_the_CSRF_token_and_shows_the_same_state()
    {
        var (_, _, id) = await FailedAsync("istate-dashboard");
        var dashboardPath = "/dashboard/api/issues/state";

        await using (var reader = new Browser(await fixture.BrowserAsync(OperatorApiFixture.ReadToken)))
        {
            var denied = await OperatorApiFixture.ReadAsync(await ChangeAsync(reader.Client, id, "acknowledge", null, dashboardPath), HttpStatusCode.Forbidden);
            Assert.Equal("insufficient_scope", denied["code"]!.GetValue<string>());
        }

        await using var browser = new Browser(await fixture.BrowserAsync(OperatorApiFixture.OperateToken));
        browser.Client.DefaultRequestHeaders.Remove("X-Fleet-CSRF");
        var noCsrf = await OperatorApiFixture.ReadAsync(await ChangeAsync(browser.Client, id, "acknowledge", null, dashboardPath), HttpStatusCode.BadRequest);
        Assert.Equal("invalid_csrf", noCsrf["code"]!.GetValue<string>());
        Assert.Equal("open", (await IssueAsync(fixture.Reader, id))["state"]!.GetValue<string>());

        await OperatorApiFixture.RefreshCsrfAsync(browser.Client);
        var acknowledged = await OperatorApiFixture.ReadAsync(await ChangeAsync(browser.Client, id, "acknowledge", null, dashboardPath));
        Assert.Equal(new StateView("acknowledged", "operate-bot", true, false), StateOf(acknowledged));
        Assert.True(JsonNode.DeepEquals(acknowledged, await IssueAsync(browser.Client, id, "/dashboard/api")));
        Assert.True(JsonNode.DeepEquals(acknowledged, await IssueAsync(fixture.Reader, id)));

        browser.Client.DefaultRequestHeaders.Remove("Origin");
        browser.Client.DefaultRequestHeaders.Add("Origin", "https://evil.example");
        var bad = await OperatorApiFixture.ReadAsync(await ChangeAsync(browser.Client, id, "reopen", null, dashboardPath), HttpStatusCode.BadRequest);
        Assert.Equal("invalid_origin", bad["code"]!.GetValue<string>());
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
}
