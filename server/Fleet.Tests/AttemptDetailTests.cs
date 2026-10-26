using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Fleet.Core.Coordination;
using Fleet.Server.Persistence;
using Fleet.Server.Transport;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Fleet.Tests;

public sealed class AttemptDetailTests(OperatorApiFixture fixture) : IClassFixture<OperatorApiFixture>
{
    private static (ConvergenceState, string?) FailSkills(string target) =>
        target == "skills" ? (ConvergenceState.Failed, "lock_failed") : (ConvergenceState.Succeeded, null);

    private async Task<(EnrolledNode Node, Guid AttemptId)> FailedAsync(string alias)
    {
        var node = await fixture.EnrollAsync(alias);
        var agent = await fixture.PublishAsync(node, "rev-detail-" + alias);
        await fixture.RunAgentAsync(agent, FailSkills);
        return (node, await AttemptIdAsync(alias, "failed"));
    }

    private async Task<Guid> AttemptIdAsync(string alias, string state)
    {
        var page = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync($"/operator/v1/nodes/{alias}/attempts?target=skills"));
        return page["items"]!.AsArray().First(x => x!["state"]!.GetValue<string>() == state)!["attemptId"]!.GetValue<Guid>();
    }

    private async Task<(int Status, JsonElement Body)> PostAsync(EnrolledNode node, Guid attemptId, object body)
    {
        var result = await fixture.SendNodeAsync($"/agent/v1/attempts/{attemptId}/detail", node.Certificate, body);
        var length = result.Response.Body.Length;
        return (result.Response.StatusCode, length == 0 ? default : await JsonSerializer.DeserializeAsync<JsonElement>(result.Response.Body));
    }

    private async Task<JsonNode> LatestAttemptAsync(string alias) =>
        (await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync($"/operator/v1/nodes/{alias}")))["targets"]!.AsArray()
            .Single(x => x!["name"]!.GetValue<string>() == "skills")!["latestAttempt"]!;

    [Fact]
    public async Task Detail_of_an_own_failed_Attempt_is_stored_replaced_and_shown_by_every_Operator_view()
    {
        var (node, attemptId) = await FailedAsync("detail-own");
        var (status, _) = await PostAsync(node, attemptId, new
        {
            diagnostic = "lock is held by process 4121",
            path = ".agents/skills/runbook/SKILL.md",
            step = "lock"
        });
        Assert.Equal(204, status);

        var latest = await LatestAttemptAsync("detail-own");
        Assert.Equal(attemptId, latest["attemptId"]!.GetValue<Guid>());
        Assert.Equal("lock is held by process 4121", latest["diagnostic"]!.GetValue<string>());
        Assert.Equal(".agents/skills/runbook/SKILL.md", latest["path"]!.GetValue<string>());
        Assert.Equal("lock", latest["step"]!.GetValue<string>());
        Assert.Equal("lock_failed", latest["errorCode"]!.GetValue<string>());

        var attempts = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/nodes/detail-own/attempts"));
        ContractShape.AssertMatches("node-attempts-page.json", attempts);
        var item = attempts["items"]!.AsArray().Single(x => x!["attemptId"]!.GetValue<Guid>() == attemptId)!;
        Assert.Equal(["lock", ".agents/skills/runbook/SKILL.md", "lock is held by process 4121"],
            new[] { item["step"], item["path"], item["diagnostic"] }.Select(x => x!.GetValue<string>()));

        var rollouts = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync(
            $"/operator/v1/rollouts/{item["rolloutId"]!.GetValue<Guid>()}/attempts"));
        ContractShape.AssertMatches("rollout-attempts-page.json", rollouts);
        var rolloutItem = rollouts["items"]!.AsArray().Single(x => x!["attemptId"]!.GetValue<Guid>() == attemptId)!;
        Assert.Equal("lock", rolloutItem["step"]!.GetValue<string>());
        Assert.Equal(".agents/skills/runbook/SKILL.md", rolloutItem["path"]!.GetValue<string>());
        Assert.Equal("lock is held by process 4121", rolloutItem["diagnostic"]!.GetValue<string>());
        var others = rollouts["items"]!.AsArray().Where(x => x!["attemptId"]!.GetValue<Guid>() != attemptId);
        Assert.All(others, x => Assert.True(x!["step"] is null && x["path"] is null));

        var issues = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/issues"));
        ContractShape.AssertMatches("issues.json", issues);
        var issue = issues["items"]!.AsArray().Single(x => x!["id"]!.GetValue<string>() == $"assignment_failed:{node.NodeId.Value:D}:skills")!;
        Assert.Equal("lock is held by process 4121", issue["diagnostic"]!.GetValue<string>());
        Assert.Equal(".agents/skills/runbook/SKILL.md", issue["path"]!.GetValue<string>());
        Assert.Equal("lock", issue["step"]!.GetValue<string>());
        Assert.All(issues["items"]!.AsArray().Where(x => x!["code"]!.GetValue<string>() != "assignment_failed"),
            x => Assert.True(x!["diagnostic"] is null && x["path"] is null && x["step"] is null));

        // A repeat is accepted and the latest accepted detail replaces the earlier one, including absent path and step.
        Assert.Equal(204, (await PostAsync(node, attemptId, new { diagnostic = "lock is held by process 4121" })).Status);
        Assert.Equal(204, (await PostAsync(node, attemptId, new { diagnostic = "second", path = "a/b", step = "verify" })).Status);
        Assert.Equal(204, (await PostAsync(node, attemptId, new { diagnostic = "third" })).Status);
        latest = await LatestAttemptAsync("detail-own");
        Assert.Equal("third", latest["diagnostic"]!.GetValue<string>());
        Assert.Null(latest["path"]);
        Assert.Null(latest["step"]);
    }

    private async Task<long> RowVersionAsync(Guid attemptId)
    {
        using var scope = fixture.Scope();
        var db = scope.ServiceProvider.GetRequiredService<FleetDbContext>();
        // xmin is the id of the transaction that wrote the current row version; it only changes on a physical write.
        return await db.Database.SqlQuery<long>($"""SELECT xmin::text::bigint AS "Value" FROM attempts WHERE "Id" = {attemptId}""").SingleAsync();
    }

    [Fact]
    public async Task An_identical_repeat_is_accepted_without_writing_the_row_and_a_changed_repeat_writes()
    {
        var (node, attemptId) = await FailedAsync("detail-nowrite");
        var detail = new { diagnostic = "same", path = "a/b", step = "lock" };
        Assert.Equal(204, (await PostAsync(node, attemptId, detail)).Status);
        var written = await RowVersionAsync(attemptId);

        Assert.Equal(204, (await PostAsync(node, attemptId, detail)).Status);
        Assert.Equal(204, (await PostAsync(node, attemptId, detail)).Status);
        Assert.Equal(written, await RowVersionAsync(attemptId));

        Assert.Equal(204, (await PostAsync(node, attemptId, new { diagnostic = "same", path = "a/b", step = "verify" })).Status);
        var changed = await RowVersionAsync(attemptId);
        Assert.NotEqual(written, changed);
        // Dropping an optional field is a change as well, and an unchanged null repeat is not.
        Assert.Equal(204, (await PostAsync(node, attemptId, new { diagnostic = "same" })).Status);
        var dropped = await RowVersionAsync(attemptId);
        Assert.NotEqual(changed, dropped);
        Assert.Equal(204, (await PostAsync(node, attemptId, new { diagnostic = "same" })).Status);
        Assert.Equal(dropped, await RowVersionAsync(attemptId));
        var latest = await LatestAttemptAsync("detail-nowrite");
        Assert.Equal("same", latest["diagnostic"]!.GetValue<string>());
        Assert.Null(latest["path"]);
        Assert.Null(latest["step"]);

        // An unchanged value for another Node's or an unfinished Attempt is still refused.
        var (other, _) = await FailedAsync("detail-nowrite-other");
        Assert.Equal(404, (await PostAsync(other, attemptId, new { diagnostic = "same" })).Status);
    }

    [Fact]
    public async Task Detail_requests_are_limited_per_Node_with_a_429_and_other_Nodes_are_unaffected()
    {
        var (noisy, noisyAttempt) = await FailedAsync("detail-noisy");
        var (calm, calmAttempt) = await FailedAsync("detail-calm");
        fixture.FreezeRateLimit(noisy);
        var results = await Task.WhenAll(Enumerable.Range(0, NodeRequestRateLimit.Burst + 40)
            .Select(_ => PostAsync(noisy, noisyAttempt, new { diagnostic = "same" })));
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

        Assert.Equal(204, (await PostAsync(calm, calmAttempt, new { diagnostic = "unaffected" })).Status);
        Assert.Equal("same", (await LatestAttemptAsync("detail-noisy"))["diagnostic"]!.GetValue<string>());
        Assert.NotNull(ErrorCatalog.Find("rate_limited"));
    }

    [Fact]
    public async Task Detail_never_changes_the_result_and_a_repeated_report_stays_a_duplicate()
    {
        var (node, attemptId) = await FailedAsync("detail-report");
        var before = await LatestAttemptAsync("detail-report");
        Assert.Equal(204, (await PostAsync(node, attemptId, new { diagnostic = "why", step = "stage" })).Status);
        var after = await LatestAttemptAsync("detail-report");
        Assert.Equal(before["updatedAt"]!.GetValue<string>(), after["updatedAt"]!.GetValue<string>());
        Assert.Equal("failed", after["state"]!.GetValue<string>());

        var repeat = await fixture.SendNodeAsync("/agent/v1/reports", node.Certificate,
            new { attemptId, state = "failed", errorCode = "lock_failed" });
        Assert.Equal(200, repeat.Response.StatusCode);
        Assert.Equal("duplicate", (await JsonSerializer.DeserializeAsync<JsonElement>(repeat.Response.Body)).GetProperty("outcome").GetString());
        Assert.Equal(400, (await fixture.SendNodeAsync("/agent/v1/reports", node.Certificate,
            new { attemptId, state = "failed", errorCode = "other_code" })).Response.StatusCode);
    }

    [Fact]
    public async Task Detail_of_another_Nodes_unknown_or_unfinished_Attempt_is_refused_with_a_message()
    {
        var (owner, ownerAttempt) = await FailedAsync("detail-owner");
        var (other, _) = await FailedAsync("detail-other");
        var foreign = await PostAsync(other, ownerAttempt, new { diagnostic = "not mine" });
        Assert.Equal(404, foreign.Status);
        Assert.Equal("attempt_not_found", foreign.Body.GetProperty("code").GetString());
        Assert.False(string.IsNullOrWhiteSpace(foreign.Body.GetProperty("message").GetString()));
        Assert.Null((await LatestAttemptAsync("detail-owner"))["diagnostic"]);
        var unknown = await PostAsync(owner, Guid.NewGuid(), new { diagnostic = "unknown" });
        Assert.Equal(404, unknown.Status);
        Assert.Equal("attempt_not_found", unknown.Body.GetProperty("code").GetString());

        // A pending Attempt (after a retry) and a succeeded one are not failed.
        var pending = (await OperatorApiFixture.ReadAsync(await fixture.Operate.PostAsJsonAsync(
            "/operator/v1/nodes/detail-owner/retry", new { target = "skills" })))["attemptId"]!.GetValue<Guid>();
        var notFailed = await PostAsync(owner, pending, new { diagnostic = "too early" });
        Assert.Equal(409, notFailed.Status);
        Assert.Equal("attempt_not_failed", notFailed.Body.GetProperty("code").GetString());
        Assert.False(string.IsNullOrWhiteSpace(notFailed.Body.GetProperty("message").GetString()));
        var finished = await AttemptIdAsync("detail-other", "failed");
        using (var scope = fixture.Scope())
        {
            var db = scope.ServiceProvider.GetRequiredService<FleetDbContext>();
            await db.Attempts.Where(x => x.Id == finished).ExecuteUpdateAsync(set => set.SetProperty(x => x.State, (int)ConvergenceState.Succeeded));
        }
        Assert.Equal(409, (await PostAsync(other, finished, new { diagnostic = "was fine" })).Status);

        Assert.Equal(System.Net.HttpStatusCode.Unauthorized, (await fixture.Anonymous.PostAsync($"/agent/v1/attempts/{ownerAttempt}/detail",
            System.Net.Http.Json.JsonContent.Create(new { diagnostic = "anonymous" }))).StatusCode);
    }

    [Fact]
    public async Task Invalid_detail_is_rejected_and_leaves_the_stored_detail_unchanged()
    {
        var (node, attemptId) = await FailedAsync("detail-invalid");
        Assert.Equal(204, (await PostAsync(node, attemptId, new { diagnostic = "kept", path = "kept/path", step = "lock" })).Status);
        var cases = new object[]
        {
            new { path = "a" },
            new { diagnostic = (string?)null },
            new { diagnostic = "" },
            new { diagnostic = "\u0000\u001b\r\u007f" },
            new { diagnostic = new string('x', 2049) },
            new { diagnostic = "x", path = new string('p', 513) },
            new { diagnostic = "x", path = "/etc/passwd" },
            new { diagnostic = "x", path = "\\windows\\system32" },
            new { diagnostic = "x", path = "C:\\Users\\me" },
            new { diagnostic = "x", path = "c:relative" },
            new { diagnostic = "x", path = "../outside" },
            new { diagnostic = "x", path = "a/../../b" },
            new { diagnostic = "x", path = "a\\..\\b" },
            new { diagnostic = "x", path = ".." },
            new { diagnostic = "x", step = "unknown" },
            new { diagnostic = "x", step = "LOCK" },
            new { diagnostic = "x", extra = 1 }
        };
        foreach (var body in cases)
        {
            var result = await PostAsync(node, attemptId, body);
            Assert.True(result.Status == 400, $"{JsonSerializer.Serialize(body)} returned {result.Status}");
            Assert.Equal("invalid_request", result.Body.GetProperty("code").GetString());
            Assert.False(string.IsNullOrWhiteSpace(result.Body.GetProperty("message").GetString()));
        }
        var stored = await LatestAttemptAsync("detail-invalid");
        Assert.Equal(["kept", "kept/path", "lock"], new[] { stored["diagnostic"], stored["path"], stored["step"] }.Select(x => x!.GetValue<string>()));

        // The limits themselves are accepted, and dot-prefixed names are not parent segments.
        Assert.Equal(204, (await PostAsync(node, attemptId, new { diagnostic = new string('x', 2048), path = new string('p', 512), step = "validate" })).Status);
        Assert.Equal(204, (await PostAsync(node, attemptId, new { diagnostic = "x", path = ".claude/..hidden/a..b" })).Status);
    }

    [Fact]
    public async Task Control_characters_are_stripped_but_line_breaks_and_tabs_stay_in_the_diagnostic()
    {
        var (node, attemptId) = await FailedAsync("detail-control");
        Assert.Equal(204, (await PostAsync(node, attemptId, new
        {
            diagnostic = "a\u0000b\u001b[31mc\r\nd\te\u007f\u0085f",
            path = ".claude/\nset\u0000tings\t.json"
        })).Status);
        var stored = await LatestAttemptAsync("detail-control");
        Assert.Equal("ab[31mc\nd\tef", stored["diagnostic"]!.GetValue<string>());
        Assert.Equal(".claude/settings.json", stored["path"]!.GetValue<string>());
    }

    [Fact]
    public async Task Migration_adds_the_bounded_columns_and_leaves_no_pending_model_changes()
    {
        using var scope = fixture.Scope();
        var db = scope.ServiceProvider.GetRequiredService<FleetDbContext>();
        Assert.False(db.Database.HasPendingModelChanges());
        Assert.Contains("20261026140000_AddAttemptFailureDetail", await db.Database.GetAppliedMigrationsAsync());
        var columns = await db.Database.SqlQuery<string>($"""
            SELECT column_name || ':' || character_maximum_length || ':' || is_nullable AS "Value"
            FROM information_schema.columns WHERE table_name = 'attempts' AND column_name IN ('FailurePath', 'FailureStep') ORDER BY column_name
            """).ToListAsync();
        Assert.Equal(["FailurePath:512:YES", "FailureStep:32:YES"], columns);
    }
}
