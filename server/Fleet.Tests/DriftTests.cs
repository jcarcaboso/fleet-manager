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

/// <summary>Phase 4, drift: <c>POST /agent/v1/drift</c> and the <c>drift</c> list of <c>GET nodes/{node}</c>.</summary>
public sealed class DriftTests(OperatorApiFixture fixture) : IClassFixture<OperatorApiFixture>
{
    private static JsonObject Valid(string target = "skills", params string[] files) => new()
    {
        ["target"] = target,
        ["files"] = new JsonArray((files.Length == 0 ? [".agents/skills/incident-runbook/SKILL.md"] : files).Select(x => (JsonNode?)x).ToArray())
    };

    private async Task<(int Status, JsonElement Body)> PostAsync(EnrolledNode node, JsonNode? body, string method = "POST")
    {
        var result = await fixture.SendNodeAsync("/agent/v1/drift", node.Certificate, body, method);
        return (result.Response.StatusCode, result.Response.Body.Length == 0 ? default : await JsonSerializer.DeserializeAsync<JsonElement>(result.Response.Body));
    }

    private static async Task<JsonNode> DetailAsync(HttpClient client, string alias) =>
        await OperatorApiFixture.ReadAsync(await client.GetAsync($"/operator/v1/nodes/{alias}"));

    private async Task<EnrolledNode> AssignedAsync(string alias)
    {
        var node = await fixture.EnrollAsync(alias);
        await fixture.PublishAsync(node, "rev-" + alias);
        return node;
    }

    [Fact]
    public async Task A_report_is_stored_and_shown_newest_first_in_the_Node_detail_under_both_prefixes()
    {
        var node = await AssignedAsync("drift-visible");
        var empty = await DetailAsync(fixture.Reader, "drift-visible");
        Assert.Empty(empty["drift"]!.AsArray());
        ContractShape.AssertMatches("node-detail.json", empty);

        var before = DateTimeOffset.UtcNow;
        Assert.Equal(204, (await PostAsync(node, Valid("skills", ".agents/skills/a/SKILL.md", ".agents/skills/b/SKILL.md"))).Status);
        Assert.Equal(204, (await PostAsync(node, Valid("agent-file/claude", "CLAUDE.md"))).Status);

        var detail = await DetailAsync(fixture.Reader, "drift-visible");
        ContractShape.AssertMatches("node-detail.json", detail);
        var drift = detail["drift"]!.AsArray().Select(x => x!).ToArray();
        Assert.Equal(2, drift.Length);
        Assert.Equal(["target", "files", "detectedAt"], drift[0].AsObject().Select(x => x.Key));
        Assert.Equal("agent-file/claude", drift[0]["target"]!.GetValue<string>());
        Assert.Equal(["CLAUDE.md"], drift[0]["files"]!.AsArray().Select(x => x!.GetValue<string>()));
        Assert.Equal("skills", drift[1]["target"]!.GetValue<string>());
        Assert.Equal([".agents/skills/a/SKILL.md", ".agents/skills/b/SKILL.md"], drift[1]["files"]!.AsArray().Select(x => x!.GetValue<string>()));
        Assert.True(drift[0]["detectedAt"]!.GetValue<DateTimeOffset>() >= drift[1]["detectedAt"]!.GetValue<DateTimeOffset>());
        Assert.InRange(drift[1]["detectedAt"]!.GetValue<DateTimeOffset>(), before.AddSeconds(-1), DateTimeOffset.UtcNow.AddSeconds(1));

        await using var browser = new Browser(await fixture.BrowserAsync(OperatorApiFixture.ReadToken));
        var viaDashboard = await OperatorApiFixture.ReadAsync(await browser.Client.GetAsync("/dashboard/api/nodes/drift-visible"));
        Assert.True(JsonNode.DeepEquals(detail["drift"], viaDashboard["drift"]));
    }

    [Fact]
    public async Task Reports_are_validated_and_the_target_must_be_one_the_Node_is_assigned()
    {
        var node = await AssignedAsync("drift-valid");
        var long512 = new string('a', 512);
        Assert.Equal(204, (await PostAsync(node, Valid("skills", long512))).Status);
        Assert.Equal(204, (await PostAsync(node, Valid("skills", Enumerable.Range(0, 20).Select(i => $"dir/file-{i}").ToArray()))).Status);
        Assert.Equal(204, (await PostAsync(node, Valid("skills", "..hidden/file", "a..b/c", "name with spaces/ü.md"))).Status);

        var bad = new Dictionary<string, JsonNode?>
        {
            ["unknown target"] = Valid("ai-client/codex"),
            ["empty target"] = Valid(""),
            ["target too long"] = Valid(new string('t', 101)),
            ["no files"] = new JsonObject { ["target"] = "skills", ["files"] = new JsonArray() },
            ["21 files"] = Valid("skills", Enumerable.Range(0, 21).Select(i => $"f{i}").ToArray()),
            ["path too long"] = Valid("skills", new string('a', 513)),
            ["empty path"] = Valid("skills", ""),
            ["absolute path"] = Valid("skills", "/etc/passwd"),
            ["windows absolute path"] = Valid("skills", "C:\\Users\\joan\\file"),
            ["backslash root"] = Valid("skills", "\\share\\file"),
            ["parent segment"] = Valid("skills", "../outside"),
            ["inner parent segment"] = Valid("skills", "a/../../b"),
            ["backslash parent"] = Valid("skills", "a\\..\\b"),
            ["control character"] = Valid("skills", "a\nb"),
            ["nul"] = Valid("skills", "a\u0000b"),
            ["missing target"] = new JsonObject { ["files"] = new JsonArray("a") },
            ["missing files"] = new JsonObject { ["target"] = "skills" },
            ["null files"] = new JsonObject { ["target"] = "skills", ["files"] = null },
            ["null file"] = new JsonObject { ["target"] = "skills", ["files"] = new JsonArray((JsonNode?)null) },
            ["unknown member"] = new JsonObject { ["target"] = "skills", ["files"] = new JsonArray("a"), ["extra"] = 1 },
            ["file is not a string"] = new JsonObject { ["target"] = "skills", ["files"] = new JsonArray(1) },
        };
        foreach (var (name, body) in bad)
        {
            var result = await PostAsync(node, body);
            Assert.True(result.Status == 400, $"{name}: {result.Status}");
            Assert.Equal("invalid_request", result.Body.GetProperty("code").GetString());
        }
        Assert.Equal(400, (await PostAsync(node, null)).Status);

        // Rejected reports store nothing.
        var drift = (await DetailAsync(fixture.Reader, "drift-valid"))["drift"]!.AsArray();
        Assert.Equal(3, drift.Count);
        Assert.Equal(20, drift.Select(x => x!["files"]!.AsArray().Count).Max());
    }

    [Fact]
    public async Task A_Node_without_a_current_Assignment_for_the_target_is_rejected()
    {
        var bare = await fixture.EnrollAsync("drift-bare");
        var result = await PostAsync(bare, Valid());
        Assert.Equal(400, result.Status);
        Assert.Equal("invalid_request", result.Body.GetProperty("code").GetString());
        Assert.Empty((await DetailAsync(fixture.Reader, "drift-bare"))["drift"]!.AsArray());
    }

    [Fact]
    public async Task Only_the_20_newest_events_of_a_Node_are_kept_and_other_Nodes_are_untouched()
    {
        var busy = await AssignedAsync("drift-busy");
        var quiet = await AssignedAsync("drift-quiet");
        Assert.Equal(204, (await PostAsync(quiet, Valid("skills", "quiet/file"))).Status);
        for (var i = 0; i < 26; i++) Assert.Equal(204, (await PostAsync(busy, Valid("skills", $"busy/file-{i:D2}"))).Status);

        var files = (await DetailAsync(fixture.Reader, "drift-busy"))["drift"]!.AsArray().Select(x => x!["files"]![0]!.GetValue<string>()).ToArray();
        Assert.Equal(Enumerable.Range(6, 20).Reverse().Select(i => $"busy/file-{i:D2}"), files);
        Assert.Single((await DetailAsync(fixture.Reader, "drift-quiet"))["drift"]!.AsArray());
        using var scope = fixture.Scope();
        var db = scope.ServiceProvider.GetRequiredService<FleetDbContext>();
        Assert.Equal(20, await db.NodeDriftEvents.CountAsync(x => x.NodeId == busy.NodeId.Value));
    }

    [Fact]
    public async Task Drift_reports_share_the_per_Node_bucket_with_the_other_Agent_reports()
    {
        var noisy = await AssignedAsync("drift-noisy");
        var calm = await AssignedAsync("drift-calm");
        fixture.FreezeRateLimit(noisy);
        var results = await Task.WhenAll(Enumerable.Range(0, NodeRequestRateLimit.Burst + 40).Select(_ => PostAsync(noisy, Valid())));
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

        // The bucket is shared: telemetry, disk usage and attempt detail of the same Node are limited too.
        var telemetry = await fixture.SendNodeAsync("/agent/v1/telemetry", noisy.Certificate, new JsonObject
        {
            ["agentVersion"] = "0.9.0",
            ["os"] = new JsonObject { ["name"] = null, ["version"] = null, ["kernel"] = null },
            ["arch"] = null,
            ["hostname"] = null,
            ["user"] = null,
            ["installMethod"] = null,
            ["serviceManager"] = null,
            ["stateDirectory"] = null
        }, "PUT");
        Assert.Equal(429, telemetry.Response.StatusCode);
        Assert.Equal(429, (await PostAsync(noisy, Valid())).Status);
        // Other Nodes are unaffected.
        Assert.Equal(204, (await PostAsync(calm, Valid())).Status);
    }

    [Fact]
    public async Task Only_an_active_Node_can_report_and_events_go_with_the_removed_Node()
    {
        var node = await AssignedAsync("drift-auth");
        using var anonymous = await fixture.Anonymous.PostAsJsonAsync("/agent/v1/drift", Valid());
        Assert.True(anonymous.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden, anonymous.StatusCode.ToString());
        Assert.Equal(405, (await PostAsync(node, Valid(), "PUT")).Status);
        Assert.Equal(204, (await PostAsync(node, Valid())).Status);

        using (var scope = fixture.Scope())
        {
            var db = scope.ServiceProvider.GetRequiredService<FleetDbContext>();
            Assert.Equal(1, await db.NodeDriftEvents.CountAsync(x => x.NodeId == node.NodeId.Value));
        }
        (await fixture.Admin.PostAsync($"/operator/v1/nodes/{node.NodeId.Value}/revoke", null)).EnsureSuccessStatusCode();
        Assert.Equal(401, (await PostAsync(node, Valid())).Status);
        // A revoked Node still shows its history.
        Assert.Single((await DetailAsync(fixture.Reader, "drift-auth"))["drift"]!.AsArray());

        (await fixture.Admin.PostAsJsonAsync($"/operator/v1/nodes/{node.NodeId.Value}/remove", new { alias = "drift-auth" })).EnsureSuccessStatusCode();
        using var after = fixture.Scope();
        Assert.Equal(0, await after.ServiceProvider.GetRequiredService<FleetDbContext>().NodeDriftEvents.CountAsync(x => x.NodeId == node.NodeId.Value));
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
