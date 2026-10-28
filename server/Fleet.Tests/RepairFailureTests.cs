using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Fleet.Core.Coordination;
using Fleet.Server.Persistence;
using Fleet.Server.Transport;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Fleet.Tests;

/// <summary><c>PUT /agent/v1/repair-failures</c> and the <c>repair_failed</c> issue of <c>GET issues</c>.</summary>
public sealed class RepairFailureTests(OperatorApiFixture fixture) : IClassFixture<OperatorApiFixture>
{
    private static JsonObject Failure(string target, Guid assignmentId, string errorCode = "ai_client_reconcile_failed",
        string diagnostic = "Fleet-owned Codex settings were changed outside Fleet", string? path = ".claude/settings.json",
        string? step = "configure")
    {
        var failure = new JsonObject
        {
            ["target"] = target,
            ["assignmentId"] = assignmentId,
            ["errorCode"] = errorCode,
            ["diagnostic"] = diagnostic
        };
        if (path is not null) failure["path"] = path;
        if (step is not null) failure["step"] = step;
        return failure;
    }

    private static JsonObject Report(params JsonNode[] failures) => new() { ["failures"] = new JsonArray(failures) };

    private async Task<(int Status, JsonElement Body)> PutAsync(EnrolledNode node, JsonNode? body, string method = "PUT")
    {
        var result = await fixture.SendNodeAsync("/agent/v1/repair-failures", node.Certificate, body, method);
        return (result.Response.StatusCode, result.Response.Body.Length == 0 ? default : await JsonSerializer.DeserializeAsync<JsonElement>(result.Response.Body));
    }

    /// <summary>Enrolls a Node, publishes its Targets and lets the Agent apply them. Returns the current Assignment of each Target.</summary>
    private async Task<(EnrolledNode Node, NodeAuthentication Agent, Dictionary<string, Guid> Assignments)> AppliedAsync(string alias,
        Func<string, (ConvergenceState, string?)>? outcome = null)
    {
        var node = await fixture.EnrollAsync(alias);
        var agent = await fixture.PublishAsync(node, "rev-" + alias);
        await fixture.RunAgentAsync(agent, outcome ?? (_ => (ConvergenceState.Succeeded, null)));
        return (node, agent, await AssignmentsAsync(alias));
    }

    private async Task<Dictionary<string, Guid>> AssignmentsAsync(string alias) =>
        (await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync($"/operator/v1/nodes/{alias}")))["targets"]!.AsArray()
            .ToDictionary(x => x!["name"]!.GetValue<string>(), x => x!["assignmentId"]!.GetValue<Guid>());

    private async Task<JsonNode[]> RepairIssuesAsync(EnrolledNode node)
    {
        var issues = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/issues"));
        ContractShape.AssertMatches("issues.json", issues);
        return issues["items"]!.AsArray().Select(x => x!)
            .Where(x => x["code"]!.GetValue<string>() == "repair_failed" && x["nodeId"]!.GetValue<Guid>() == node.NodeId.Value).ToArray();
    }

    private async Task<List<NodeRepairFailureRow>> RowsAsync(EnrolledNode node)
    {
        using var scope = fixture.Scope();
        return await scope.ServiceProvider.GetRequiredService<FleetDbContext>().NodeRepairFailures.AsNoTracking()
            .Where(x => x.NodeId == node.NodeId.Value).OrderBy(x => x.Target).ToListAsync();
    }

    [Fact]
    public async Task A_report_is_stored_and_shown_as_a_repair_failed_issue_with_its_detail()
    {
        var (node, _, assignments) = await AppliedAsync("repair-visible");
        Assert.Empty(await RepairIssuesAsync(node));

        var before = DateTimeOffset.UtcNow;
        Assert.Equal(204, (await PutAsync(node, Report(Failure("ai-client/claude", assignments["ai-client/claude"],
            diagnostic: "settings.json is not valid JSON at line 12\n\tnear \"model\"")))).Status);

        var issue = Assert.Single(await RepairIssuesAsync(node));
        Assert.Equal($"repair_failed:{node.NodeId.Value:D}:ai-client/claude", issue["id"]!.GetValue<string>());
        Assert.Equal("error", issue["severity"]!.GetValue<string>());
        Assert.Equal("nodes", issue["section"]!.GetValue<string>());
        Assert.Equal("repair-visible: ai-client/claude cannot be kept in sync", issue["title"]!.GetValue<string>());
        Assert.StartsWith("The last apply succeeded, but the Agent could not repair local changes: it reported ai_client_reconcile_failed (AI client setup failed) at ",
            issue["detail"]!.GetValue<string>());
        Assert.Equal(ErrorCatalog.Find("ai_client_reconcile_failed")!.Fix[0], issue["action"]!.GetValue<string>());
        Assert.Equal("ai_client_reconcile_failed", issue["errorCode"]!.GetValue<string>());
        Assert.Equal("repair-visible", issue["nodeName"]!.GetValue<string>());
        Assert.Equal("ai-client/claude", issue["target"]!.GetValue<string>());
        Assert.Equal("settings.json is not valid JSON at line 12\n\tnear \"model\"", issue["diagnostic"]!.GetValue<string>());
        Assert.Equal(".claude/settings.json", issue["path"]!.GetValue<string>());
        Assert.Equal("configure", issue["step"]!.GetValue<string>());
        Assert.Equal("open", issue["state"]!.GetValue<string>());
        Assert.InRange(issue["since"]!.GetValue<DateTimeOffset>(), before.AddSeconds(-1), DateTimeOffset.UtcNow.AddSeconds(1));
        Assert.Equal(["fleet nodes show repair-visible", "fleet explain ai_client_reconcile_failed", "fleet retry repair-visible ai-client/claude"],
            issue["commands"]!.AsArray().Select(x => x!.GetValue<string>()));

        // An unknown code and no path or step: the generic remedy for the Target kind, and no catalog title.
        Assert.Equal(204, (await PutAsync(node, Report(Failure("skills", assignments["skills"], "something_new", "boom", null, null)))).Status);
        issue = Assert.Single(await RepairIssuesAsync(node));
        Assert.Equal("skills", issue["target"]!.GetValue<string>());
        Assert.Matches(@"^The last apply succeeded, but the Agent could not repair local changes: it reported something_new at \S+ \S+Z\.$",
            issue["detail"]!.GetValue<string>());
        Assert.Equal("Check Agent logs for permissions, ownership conflicts or download failures.", issue["action"]!.GetValue<string>());
        Assert.Null(issue["path"]);
        Assert.Null(issue["step"]);

        // Control characters are removed from the diagnostic (except line breaks and tabs) and the path, as for Attempt detail.
        Assert.Equal(204, (await PutAsync(node, Report(Failure("skills", assignments["skills"], diagnostic: "a\u0007b\nc", path: "dir/\u0001file")))).Status);
        var row = Assert.Single(await RowsAsync(node));
        Assert.Equal("ab\nc", row.Diagnostic);
        Assert.Equal("dir/file", row.Path);

        // The dashboard prefix returns the same issue.
        using var browser = await fixture.BrowserAsync(OperatorApiFixture.ReadToken);
        var viaDashboard = await OperatorApiFixture.ReadAsync(await browser.GetAsync("/dashboard/api/issues"));
        Assert.Contains(viaDashboard["items"]!.AsArray(), x => x!["id"]!.GetValue<string>() == $"repair_failed:{node.NodeId.Value:D}:skills");
    }

    [Fact]
    public async Task Each_report_replaces_the_stored_failures_and_an_empty_list_clears_them()
    {
        var (node, _, assignments) = await AppliedAsync("repair-replace");
        var other = await AppliedAsync("repair-replace-other");
        Assert.Equal(204, (await PutAsync(other.Node, Report(Failure("skills", other.Assignments["skills"])))).Status);

        Assert.Equal(204, (await PutAsync(node, Report(Failure("skills", assignments["skills"]),
            Failure("ai-client/claude", assignments["ai-client/claude"]), Failure("agent-file/claude", assignments["agent-file/claude"])))).Status);
        Assert.Equal(["agent-file/claude", "ai-client/claude", "skills"], (await RowsAsync(node)).Select(x => x.Target));
        Assert.Equal(3, (await RepairIssuesAsync(node)).Length);

        Assert.Equal(204, (await PutAsync(node, Report(Failure("ai-client/claude", assignments["ai-client/claude"])))).Status);
        Assert.Equal(["ai-client/claude"], (await RowsAsync(node)).Select(x => x.Target));
        Assert.Equal(["ai-client/claude"], (await RepairIssuesAsync(node)).Select(x => x["target"]!.GetValue<string>()));

        Assert.Equal(204, (await PutAsync(node, Report())).Status);
        Assert.Empty(await RowsAsync(node));
        Assert.Empty(await RepairIssuesAsync(node));
        // A repeat of the empty list is accepted, and other Nodes keep their failures.
        Assert.Equal(204, (await PutAsync(node, Report())).Status);
        Assert.Single(await RowsAsync(other.Node));
        Assert.Single(await RepairIssuesAsync(other.Node));
    }

    [Fact]
    public async Task An_unchanged_failure_keeps_its_first_time_and_a_new_error_code_starts_again()
    {
        var (node, _, assignments) = await AppliedAsync("repair-since");
        var skills = assignments["skills"];
        Assert.Equal(204, (await PutAsync(node, Report(Failure("skills", skills, "io", "first")))).Status);
        var first = Assert.Single(await RowsAsync(node));
        Assert.Equal(first.FailedSince, first.ReportedAt);

        await Task.Delay(20);
        Assert.Equal(204, (await PutAsync(node, Report(Failure("skills", skills, "io", "second", "other/path", "stage")))).Status);
        var repeat = Assert.Single(await RowsAsync(node));
        Assert.Equal(first.FailedSince, repeat.FailedSince);
        Assert.True(repeat.ReportedAt > first.ReportedAt);
        Assert.Equal(("second", "other/path", "stage"), (repeat.Diagnostic, repeat.Path, repeat.Step));
        var issue = Assert.Single(await RepairIssuesAsync(node));
        Assert.Equal(first.FailedSince, issue["since"]!.GetValue<DateTimeOffset>());

        await Task.Delay(20);
        Assert.Equal(204, (await PutAsync(node, Report(Failure("skills", skills, "lock_failed", "third")))).Status);
        var changed = Assert.Single(await RowsAsync(node));
        Assert.True(changed.FailedSince > first.FailedSince);
        Assert.Equal(changed.FailedSince, changed.ReportedAt);

        // A failure that was cleared and comes back starts again too.
        Assert.Equal(204, (await PutAsync(node, Report())).Status);
        await Task.Delay(20);
        Assert.Equal(204, (await PutAsync(node, Report(Failure("skills", skills, "lock_failed", "fourth")))).Status);
        Assert.True(Assert.Single(await RowsAsync(node)).FailedSince > changed.FailedSince);
    }

    [Fact]
    public async Task Failures_of_an_Assignment_that_is_not_current_are_skipped_and_a_superseded_failure_raises_no_issue()
    {
        var (node, _, assignments) = await AppliedAsync("repair-stale");
        Assert.Equal(204, (await PutAsync(node, Report(Failure("skills", assignments["skills"]),
            Failure("agent-file/claude", assignments["agent-file/claude"])))).Status);
        Assert.Equal(2, (await RepairIssuesAsync(node)).Length);

        // A new revision gives both Targets new Assignments: the stored failures stop raising issues until the Agent reports again.
        await fixture.PublishAsync(node, "rev-repair-stale-2");
        var current = await AssignmentsAsync("repair-stale");
        Assert.NotEqual(assignments["skills"], current["skills"]);
        Assert.NotEqual(assignments["agent-file/claude"], current["agent-file/claude"]);
        Assert.Equal(2, (await RowsAsync(node)).Count);
        Assert.Empty(await RepairIssuesAsync(node));

        // A report that still names the old Assignment (a race with the new one), an unknown Assignment, another Target's Assignment and
        // a Target the Node does not have are skipped without an error, and the report still replaces the stored failures.
        Assert.Equal(204, (await PutAsync(node, Report(Failure("skills", assignments["skills"]),
            Failure("agent-file/claude", Guid.NewGuid()), Failure("ai-client/claude", current["skills"]),
            Failure("ai-client/codex", current["ai-client/claude"])))).Status);
        Assert.Empty(await RowsAsync(node));
        Assert.Equal(204, (await PutAsync(node, Report(Failure("skills", assignments["skills"]),
            Failure("agent-file/claude", current["agent-file/claude"])))).Status);
        Assert.Equal(["agent-file/claude"], (await RowsAsync(node)).Select(x => x.Target));
        Assert.Single(await RepairIssuesAsync(node));

        // Another Node's Assignment is never accepted.
        var other = await AppliedAsync("repair-stale-other");
        Assert.Equal(204, (await PutAsync(other.Node, Report(Failure("agent-file/claude", current["agent-file/claude"])))).Status);
        Assert.Empty(await RowsAsync(other.Node));
    }

    [Fact]
    public async Task A_failed_Assignment_raises_only_assignment_failed()
    {
        var (node, _, assignments) = await AppliedAsync("repair-failed",
            target => target == "skills" ? (ConvergenceState.Failed, "lock_failed") : (ConvergenceState.Succeeded, null));
        Assert.Equal(204, (await PutAsync(node, Report(Failure("skills", assignments["skills"]),
            Failure("agent-file/claude", assignments["agent-file/claude"])))).Status);
        Assert.Equal(2, (await RowsAsync(node)).Count);
        Assert.Equal(["agent-file/claude"], (await RepairIssuesAsync(node)).Select(x => x["target"]!.GetValue<string>()));
        var issues = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/issues"));
        Assert.Contains(issues["items"]!.AsArray(), x => x!["id"]!.GetValue<string>() == $"assignment_failed:{node.NodeId.Value:D}:skills");
    }

    [Fact]
    public async Task Reports_are_validated_and_a_rejected_report_changes_nothing()
    {
        var (node, _, assignments) = await AppliedAsync("repair-valid");
        var skills = assignments["skills"];
        Assert.Equal(204, (await PutAsync(node, Report(Failure("skills", skills, diagnostic: "kept")))).Status);

        // Limits that are accepted.
        Assert.Equal(204, (await PutAsync(node, Report(Failure("skills", skills, new string('e', 100), new string('d', 2048),
            new string('p', 512), "validate"), Failure(new string('t', 100), Guid.NewGuid())))).Status);
        Assert.Equal(204, (await PutAsync(node, Report(Enumerable.Range(0, 50).Select(i => (JsonNode)Failure($"t-{i}", Guid.NewGuid())).ToArray()))).Status);
        Assert.Equal(204, (await PutAsync(node, Report(Failure("skills", skills, diagnostic: "kept")))).Status);

        JsonObject Without(string member)
        {
            var failure = Failure("skills", skills);
            failure.Remove(member);
            return Report(failure);
        }
        JsonObject With(string member, JsonNode? value)
        {
            var failure = Failure("skills", skills);
            failure[member] = value;
            return Report(failure);
        }
        var bad = new Dictionary<string, JsonNode?>
        {
            ["51 failures"] = Report(Enumerable.Range(0, 51).Select(i => (JsonNode)Failure($"t-{i}", Guid.NewGuid())).ToArray()),
            ["duplicate target"] = Report(Failure("skills", skills), Failure("skills", Guid.NewGuid())),
            ["missing failures"] = new JsonObject(),
            ["null failures"] = new JsonObject { ["failures"] = null },
            ["null failure"] = new JsonObject { ["failures"] = new JsonArray((JsonNode?)null) },
            ["unknown member"] = new JsonObject { ["failures"] = new JsonArray(), ["extra"] = 1 },
            ["unknown failure member"] = With("extra", 1),
            ["missing target"] = Without("target"),
            ["missing assignmentId"] = Without("assignmentId"),
            ["missing errorCode"] = Without("errorCode"),
            ["missing diagnostic"] = Without("diagnostic"),
            ["null target"] = With("target", null),
            ["null assignmentId"] = With("assignmentId", null),
            ["null errorCode"] = With("errorCode", null),
            ["null diagnostic"] = With("diagnostic", null),
            ["empty target"] = With("target", ""),
            ["target too long"] = With("target", new string('t', 101)),
            ["target control character"] = With("target", "skills\n"),
            ["assignmentId not a uuid"] = With("assignmentId", "not-a-uuid"),
            ["empty errorCode"] = With("errorCode", ""),
            ["errorCode too long"] = With("errorCode", new string('e', 101)),
            ["empty diagnostic"] = With("diagnostic", ""),
            ["diagnostic of control characters"] = With("diagnostic", "\u0001\u0002"),
            ["diagnostic too long"] = With("diagnostic", new string('d', 2049)),
            ["absolute path"] = With("path", "/etc/passwd"),
            ["windows absolute path"] = With("path", "C:\\Users\\joan"),
            ["parent segment"] = With("path", "a/../../b"),
            ["path too long"] = With("path", new string('p', 513)),
            ["unknown step"] = With("step", "reboot"),
            ["path is not a string"] = With("path", 1),
        };
        foreach (var (name, body) in bad)
        {
            var result = await PutAsync(node, body);
            Assert.True(result.Status == 400, $"{name}: {result.Status}");
            Assert.Equal("invalid_request", result.Body.GetProperty("code").GetString());
        }
        Assert.Equal(400, (await PutAsync(node, null)).Status);

        var row = Assert.Single(await RowsAsync(node));
        Assert.Equal(("skills", "kept"), (row.Target, row.Diagnostic));

        Assert.Equal("invalid_request", Assert.Throws<CoordinationException>(() => RepairFailureRules.Sanitize(null)).Code);
        Assert.Equal("invalid_request", Assert.Throws<CoordinationException>(() => RepairFailureRules.Sanitize(new(null!))).Code);
    }

    [Fact]
    public async Task Only_an_active_Node_can_report_and_failures_go_with_the_removed_Node()
    {
        var (node, _, assignments) = await AppliedAsync("repair-auth");
        using var anonymous = await fixture.Anonymous.PutAsJsonAsync("/agent/v1/repair-failures", Report());
        Assert.True(anonymous.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden, anonymous.StatusCode.ToString());
        Assert.Equal(405, (await PutAsync(node, Report(), "POST")).Status);
        Assert.Equal(204, (await PutAsync(node, Report(Failure("skills", assignments["skills"])))).Status);

        (await fixture.Admin.PostAsync($"/operator/v1/nodes/{node.NodeId.Value}/revoke", null)).EnsureSuccessStatusCode();
        Assert.Equal(401, (await PutAsync(node, Report())).Status);
        // A revoked Node raises no issue, and its stored failures are kept until it is removed.
        Assert.Empty(await RepairIssuesAsync(node));
        Assert.Single(await RowsAsync(node));

        (await fixture.Admin.PostAsJsonAsync($"/operator/v1/nodes/{node.NodeId.Value}/remove", new { alias = "repair-auth" })).EnsureSuccessStatusCode();
        Assert.Empty(await RowsAsync(node));
    }

    [Fact]
    public async Task A_revoked_Node_is_rejected_by_the_coordinator_too()
    {
        var (node, agent, assignments) = await AppliedAsync("repair-revoked");
        (await fixture.Admin.PostAsync($"/operator/v1/nodes/{node.NodeId.Value}/revoke", null)).EnsureSuccessStatusCode();
        using var scope = fixture.Scope();
        var coordinator = scope.ServiceProvider.GetRequiredService<IFleetCoordinator>();
        var error = await Assert.ThrowsAsync<CoordinationException>(() => coordinator.RecordRepairFailuresAsync(agent,
            new([new("skills", new(assignments["skills"]), "io", "boom", null, null)])));
        Assert.Equal("node_unauthorized", error.Code);
        Assert.Empty(await RowsAsync(node));
    }

    [Fact]
    public async Task Repair_failure_reports_share_the_per_Node_bucket_with_the_other_Agent_reports()
    {
        var (noisy, _, _) = await AppliedAsync("repair-noisy");
        var (calm, _, _) = await AppliedAsync("repair-calm");
        fixture.FreezeRateLimit(noisy);
        var results = await Task.WhenAll(Enumerable.Range(0, NodeRequestRateLimit.Burst + 10).Select(_ => PutAsync(noisy, Report())));
        Assert.All(results, x => Assert.True(x.Status is 204 or 429, x.Status.ToString()));
        Assert.Equal(NodeRequestRateLimit.Burst, results.Count(x => x.Status == 204));
        Assert.All(results.Where(x => x.Status == 429), x => Assert.Equal("rate_limited", x.Body.GetProperty("code").GetString()));
        var drift = await fixture.SendNodeAsync("/agent/v1/drift", noisy.Certificate, new JsonObject
        {
            ["target"] = "skills",
            ["files"] = new JsonArray("a")
        });
        Assert.Equal(429, drift.Response.StatusCode);
        Assert.Equal(204, (await PutAsync(calm, Report())).Status);
    }

    [Fact]
    public void The_migrations_snapshot_matches_the_model()
    {
        using var scope = fixture.Scope();
        Assert.False(scope.ServiceProvider.GetRequiredService<FleetDbContext>().Database.HasPendingModelChanges());
    }

    [Fact]
    public void The_catalog_explains_repair_failed()
    {
        var entry = ErrorCatalog.Find("repair_failed")!;
        Assert.Equal(ErrorCatalog.Issue, entry.Source);
        Assert.Contains(entry.Fix, x => x.Contains("`fleet retry <node> <target>`", StringComparison.Ordinal));
    }
}
