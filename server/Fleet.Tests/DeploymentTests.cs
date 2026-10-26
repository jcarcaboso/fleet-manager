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

/// <summary>Phase 4, deployments: commit metadata on revisions, the revision diff and the rollout detail.</summary>
public sealed class DeploymentTests(OperatorApiFixture fixture) : IClassFixture<OperatorApiFixture>
{
    private static string Unique(string prefix) => prefix + "-" + Guid.NewGuid().ToString("N")[..8];

    private static SnapshotBundle SkillBundle(string content) => OperatorApiFixture.Bundle("fleet.bundle/v1", content);

    private static SnapshotTarget Skills(EnrolledNode node, params (string Name, SnapshotBundle Bundle)[] skills) =>
        new(node.NodeId, "skills", new("home", ".agents/skills"), skills.Select(x => new SnapshotSkill(x.Name, x.Bundle.Digest)).ToList());

    private static SnapshotTarget File(EnrolledNode node, SnapshotBundle file) =>
        new(node.NodeId, "agent-file/claude", new("home", ".claude"), [], File: new("CLAUDE.md", file.Digest));

    private static SnapshotTarget AiClient(EnrolledNode node, string mode = "native", string? model = null) =>
        new(node.NodeId, "ai-client/claude", new("home", ".claude"), [], AiClient: mode == "native"
            ? new("fleet.ai-client/v1", "claude", "native")
            : new("fleet.ai-client/v1", "claude", mode, "https://proxy.example/v1", model));

    private async Task<PublicationResult> PublishAsync(string revision, SnapshotBundle[] bundles, SnapshotTarget[] targets,
        CommitMetadata? commit = null)
    {
        using var scope = fixture.Scope();
        return await scope.ServiceProvider.GetRequiredService<IFleetCoordinator>().AcceptSourceSnapshotAsync(
            new(revision, bundles, targets, [], DateTimeOffset.UtcNow, commit));
    }

    private static async Task<JsonNode> RevisionAsync(HttpClient client, PublicationResult publication, string prefix = "/operator/v1") =>
        await OperatorApiFixture.ReadAsync(await client.GetAsync($"{prefix}/desired-revisions/{publication.DesiredRevisionId!.Value.Value}"));

    private static string[] Names(JsonNode? list) => list!.AsArray().Select(x => x!.GetValue<string>()).ToArray();

    [Fact]
    public async Task A_revision_lists_added_changed_and_removed_Skills_and_Targets_against_the_state_before_it()
    {
        var a = await fixture.EnrollAsync(Unique("diff-a"));
        var b = await fixture.EnrollAsync(Unique("diff-b"));
        string keep = Unique("keep"), edit = Unique("edit"), drop = Unique("drop"), added = Unique("new");
        var keepBundle = SkillBundle(keep);
        var editOld = SkillBundle(edit + " old");
        var editNew = SkillBundle(edit + " new");
        var dropBundle = SkillBundle(drop);
        var addedBundle = SkillBundle(added);
        var file = OperatorApiFixture.FileBundle("claude instructions " + keep);

        var first = await PublishAsync(Unique("rev"), [keepBundle, editOld, dropBundle, file], [
            Skills(a, (keep, keepBundle), (edit, editOld), (drop, dropBundle)), Skills(b, (keep, keepBundle)), File(a, file)]);
        var second = await PublishAsync(Unique("rev"), [keepBundle, editNew, addedBundle, file], [
            Skills(a, (keep, keepBundle), (edit, editNew), (added, addedBundle)), Skills(b, (keep, keepBundle)), File(a, file), AiClient(a)],
            new CommitMetadata("Add " + added, "Joan", new DateTimeOffset(2026, 10, 25, 8, 58, 12, TimeSpan.Zero)));

        // Unchanged Targets (Node b's Skills, Node a's file) are not republished: they are neither added, changed nor removed.
        var detail = await RevisionAsync(fixture.Reader, second);
        ContractShape.AssertMatches("desired-revision.json", detail);
        Assert.Equal(["desiredRevisionId", "sourceRevision", "acceptedAt", "commit", "previous", "rolloutId", "skills", "targets"],
            detail.AsObject().Select(x => x.Key));
        Assert.Equal(second.DesiredRevisionId!.Value.Value, detail["desiredRevisionId"]!.GetValue<Guid>());
        Assert.Equal(second.SourceRevision, detail["sourceRevision"]!.GetValue<string>());
        Assert.Equal(first.DesiredRevisionId!.Value.Value, detail["previous"]!["desiredRevisionId"]!.GetValue<Guid>());
        Assert.Equal(first.SourceRevision, detail["previous"]!["sourceRevision"]!.GetValue<string>());
        Assert.Equal(second.RolloutId!.Value.Value, detail["rolloutId"]!.GetValue<Guid>());
        Assert.Equal("Add " + added, detail["commit"]!["subject"]!.GetValue<string>());
        Assert.Equal("Joan", detail["commit"]!["author"]!.GetValue<string>());
        Assert.Equal(new DateTimeOffset(2026, 10, 25, 8, 58, 12, TimeSpan.Zero), detail["commit"]!["committedAt"]!.GetValue<DateTimeOffset>());
        Assert.Equal([added], Names(detail["skills"]!["added"]));
        Assert.Equal([edit], Names(detail["skills"]!["changed"]));
        Assert.Equal([drop], Names(detail["skills"]!["removed"]));
        Assert.Equal(["added", "changed", "removed", "nodes"], detail["targets"]!.AsObject().Select(x => x.Key));
        Assert.Equal((1, 1, 0, 1), (detail["targets"]!["added"]!.GetValue<int>(), detail["targets"]!["changed"]!.GetValue<int>(),
            detail["targets"]!["removed"]!.GetValue<int>(), detail["targets"]!["nodes"]!.GetValue<int>()));

        // A Skill that only one of two Nodes loses is neither removed nor changed, but its Target is changed.
        var third = await PublishAsync(Unique("rev"), [], [Skills(b)]);
        var thirdDetail = await RevisionAsync(fixture.Reader, third);
        Assert.Empty(Names(thirdDetail["skills"]!["added"]));
        Assert.Empty(Names(thirdDetail["skills"]!["changed"]));
        Assert.Empty(Names(thirdDetail["skills"]!["removed"]));
        Assert.Equal((0, 1, 0, 1), (thirdDetail["targets"]!["added"]!.GetValue<int>(), thirdDetail["targets"]!["changed"]!.GetValue<int>(),
            thirdDetail["targets"]!["removed"]!.GetValue<int>(), thirdDetail["targets"]!["nodes"]!.GetValue<int>()));
        Assert.Null(thirdDetail["commit"]);

        // A change of the AI-client settings is a changed Target; the file digest too.
        var newFile = OperatorApiFixture.FileBundle("changed instructions " + keep);
        var fourth = await PublishAsync(Unique("rev"), [newFile], [AiClient(a, "cliproxy", "claude-sonnet-5-5"), File(a, newFile)]);
        var fourthDetail = await RevisionAsync(fixture.Reader, fourth);
        Assert.Equal((0, 2, 0, 1), (fourthDetail["targets"]!["added"]!.GetValue<int>(), fourthDetail["targets"]!["changed"]!.GetValue<int>(),
            fourthDetail["targets"]!["removed"]!.GetValue<int>(), fourthDetail["targets"]!["nodes"]!.GetValue<int>()));
        Assert.Empty(Names(fourthDetail["skills"]!["added"]));

        // A revision that changes nothing has no rollout and an empty diff.
        var fifth = await PublishAsync(Unique("rev"), [newFile], [File(a, newFile), AiClient(a, "cliproxy", "claude-sonnet-5-5")]);
        Assert.Null(fifth.RolloutId);
        var fifthDetail = await RevisionAsync(fixture.Reader, fifth);
        Assert.Null(fifthDetail["rolloutId"]);
        Assert.Equal((0, 0, 0, 0), (fifthDetail["targets"]!["added"]!.GetValue<int>(), fifthDetail["targets"]!["changed"]!.GetValue<int>(),
            fifthDetail["targets"]!["removed"]!.GetValue<int>(), fifthDetail["targets"]!["nodes"]!.GetValue<int>()));
        Assert.Equal(fourth.DesiredRevisionId!.Value.Value, fifthDetail["previous"]!["desiredRevisionId"]!.GetValue<Guid>());
        // A CLIProxy Target that a snapshot omits is published as native, so put it back: later tests share this database.
        await PublishAsync(Unique("rev"), [], [AiClient(a)]);

        await using var browser = new Browser(await fixture.BrowserAsync(OperatorApiFixture.ReadToken));
        Assert.True(JsonNode.DeepEquals(detail, await RevisionAsync(browser.Client, second, "/dashboard/api")));
    }

    [Fact]
    public async Task The_first_revision_has_no_previous_and_a_Skill_in_two_Targets_changes_only_when_its_digests_differ()
    {
        var node = await fixture.EnrollAsync(Unique("first"));
        var skill = Unique("shared");
        var one = SkillBundle(skill + " one");
        var two = SkillBundle(skill + " two");
        await PublishAsync(Unique("rev"), [one], [Skills(node, (skill, one))]);

        // The oldest revision of the Workspace is the first one: no previous.
        using (var scope = fixture.Scope())
        {
            var db = scope.ServiceProvider.GetRequiredService<FleetDbContext>();
            var oldest = await db.DesiredRevisions.AsNoTracking().OrderBy(x => x.AcceptedAt).ThenBy(x => x.Id).FirstAsync();
            var detail = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync($"/operator/v1/desired-revisions/{oldest.Id}"));
            Assert.Null(detail["previous"]);
            ContractShape.AssertMatches("desired-revision.json", detail);
            // Everything of the first revision is added.
            var addedTargets = detail["targets"]!["added"]!.GetValue<int>();
            Assert.Equal(await db.Assignments.CountAsync(x => x.DesiredRevisionId == oldest.Id), addedTargets);
            Assert.Equal(0, detail["targets"]!["changed"]!.GetValue<int>());
        }

        var changed = await PublishAsync(Unique("rev"), [two], [Skills(node, (skill, two))]);
        var changedDetail = await RevisionAsync(fixture.Reader, changed);
        Assert.Equal([skill], Names(changedDetail["skills"]!["changed"]));
        Assert.Empty(Names(changedDetail["skills"]!["added"]));
        Assert.Empty(Names(changedDetail["skills"]!["removed"]));
    }

    [Fact]
    public async Task Skill_lists_are_sorted_and_hold_at_most_200_names()
    {
        var node = await fixture.EnrollAsync(Unique("many"));
        var prefix = Unique("many");
        var bundles = Enumerable.Range(0, 230).Select(i => SkillBundle($"{prefix} {i}")).ToArray();
        var publication = await PublishAsync(Unique("rev"), bundles,
            [Skills(node, bundles.Select((x, i) => ($"{prefix}-{i:D3}", x)).ToArray())]);
        var names = Names((await RevisionAsync(fixture.Reader, publication))["skills"]!["added"]);
        Assert.Equal(200, names.Length);
        Assert.Equal(names.Order(StringComparer.Ordinal), names);
    }

    [Fact]
    public async Task Revisions_without_commit_metadata_list_it_as_null_and_the_list_carries_it_when_stored()
    {
        var node = await fixture.EnrollAsync(Unique("commit"));
        var skill = SkillBundle(Unique("commit"));
        var plain = await PublishAsync(Unique("rev"), [skill], [Skills(node, ("plain", skill))]);
        var withCommit = await PublishAsync(Unique("rev"), [], [Skills(node)], new CommitMetadata("Subject line", "Ada Lovelace",
            new DateTimeOffset(2026, 10, 24, 12, 0, 0, TimeSpan.FromHours(2))));
        // The coordinator sanitizes again: control characters go and the text is cut.
        var dirty = await PublishAsync(Unique("rev"), [skill], [Skills(node, ("plain", skill))],
            new CommitMetadata("Tab\there" + new string('x', 300), "Line\nbreak " + new string('y', 200), null));

        var list = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/desired-revisions?order=newest&limit=10"));
        JsonNode Item(PublicationResult publication) => list["items"]!.AsArray().Single(x =>
            x!["desiredRevisionId"]!.GetValue<Guid>() == publication.DesiredRevisionId!.Value.Value)!;
        Assert.Equal(["desiredRevisionId", "sourceRevision", "acceptedAt", "commit"], Item(plain).AsObject().Select(x => x.Key));
        Assert.Null(Item(plain)["commit"]);
        Assert.Equal(["subject", "author", "committedAt"], Item(withCommit)["commit"]!.AsObject().Select(x => x.Key));
        Assert.Equal("Subject line", Item(withCommit)["commit"]!["subject"]!.GetValue<string>());
        Assert.Equal("Ada Lovelace", Item(withCommit)["commit"]!["author"]!.GetValue<string>());
        Assert.Equal(new DateTimeOffset(2026, 10, 24, 10, 0, 0, TimeSpan.Zero), Item(withCommit)["commit"]!["committedAt"]!.GetValue<DateTimeOffset>());
        var subject = Item(dirty)["commit"]!["subject"]!.GetValue<string>();
        var author = Item(dirty)["commit"]!["author"]!.GetValue<string>();
        Assert.Equal(CommitMetadataRules.MaximumSubjectLength, subject.Length);
        Assert.StartsWith("Tabhere", subject);
        Assert.Equal(CommitMetadataRules.MaximumAuthorLength, author.Length);
        Assert.StartsWith("Linebreak ", author);
        Assert.Null(Item(dirty)["commit"]!["committedAt"]);
    }

    [Fact]
    public async Task An_unknown_or_malformed_revision_is_a_404_with_a_message_and_the_route_needs_the_read_scope()
    {
        foreach (var id in new[] { Guid.NewGuid().ToString(), "not-a-guid", Guid.Empty.ToString() })
        {
            var missing = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/desired-revisions/" + id), HttpStatusCode.NotFound);
            Assert.Equal(["code", "message"], missing.AsObject().Select(x => x.Key).Order());
            Assert.Equal("revision_not_found", missing["code"]!.GetValue<string>());
            Assert.False(string.IsNullOrWhiteSpace(missing["message"]!.GetValue<string>()));
        }
        Assert.NotNull(ErrorCatalog.Find("revision_not_found"));
        Assert.Equal(HttpStatusCode.Unauthorized, (await fixture.Anonymous.GetAsync("/operator/v1/desired-revisions/" + Guid.NewGuid())).StatusCode);
        await using var browser = new Browser(await fixture.BrowserAsync(OperatorApiFixture.ReadToken));
        var viaDashboard = await OperatorApiFixture.ReadAsync(
            await browser.Client.GetAsync("/dashboard/api/desired-revisions/" + Guid.NewGuid()), HttpStatusCode.NotFound);
        Assert.Equal("revision_not_found", viaDashboard["code"]!.GetValue<string>());
    }

    [Fact]
    public async Task A_rollout_shows_per_Node_progress_with_the_worst_state_the_latest_error_code_and_attempt_times()
    {
        string[] names = [Unique("roll-b"), Unique("roll-a"), Unique("roll-c")];
        var nodeB = await fixture.EnrollAsync(names[0]);
        var nodeA = await fixture.EnrollAsync(names[1]);
        var nodeC = await fixture.EnrollAsync(names[2]);
        var skill = SkillBundle(Unique("rollout"));
        var file = OperatorApiFixture.FileBundle(Unique("rollout-file"));
        var publication = await PublishAsync(Unique("rev"), [skill, file], new[] { nodeA, nodeB, nodeC }.SelectMany(n =>
            new[] { Skills(n, ("rollout", skill)), File(n, file), AiClient(n) }).ToArray());
        var agentA = await Authenticate(nodeA);
        var agentB = await Authenticate(nodeB);

        // Node a: skills failed, the others succeeded. Node b: one Target applying. Node c: nothing started.
        await fixture.RunAgentAsync(agentA, target => target == "skills" ? (ConvergenceState.Failed, "lock_failed") : (ConvergenceState.Succeeded, null));
        using (var scope = fixture.Scope())
        {
            var coordinator = scope.ServiceProvider.GetRequiredService<IFleetCoordinator>();
            var polled = (await coordinator.PollAsync(agentB, DateTimeOffset.UtcNow)).Assignment!;
            await coordinator.ReportAttemptAsync(agentB, new(polled.AttemptId, ConvergenceState.Applying, null, null, DateTimeOffset.UtcNow));
        }

        var rolloutId = publication.RolloutId!.Value.Value;
        var detail = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync($"/operator/v1/rollouts/{rolloutId}"));
        ContractShape.AssertMatches("rollout.json", detail);
        Assert.Equal(["rolloutId", "desiredRevisionId", "sourceRevision", "createdAt", "summary", "nodes"], detail.AsObject().Select(x => x.Key));
        Assert.Equal(rolloutId, detail["rolloutId"]!.GetValue<Guid>());
        Assert.Equal(publication.DesiredRevisionId!.Value.Value, detail["desiredRevisionId"]!.GetValue<Guid>());
        Assert.Equal(publication.SourceRevision, detail["sourceRevision"]!.GetValue<string>());
        Assert.Equal(["pending", "applying", "succeeded", "failed", "superseded"], detail["summary"]!.AsObject().Select(x => x.Key));
        Assert.Equal((5, 1, 2, 1, 0), (detail["summary"]!["pending"]!.GetValue<int>(), detail["summary"]!["applying"]!.GetValue<int>(),
            detail["summary"]!["succeeded"]!.GetValue<int>(), detail["summary"]!["failed"]!.GetValue<int>(), detail["summary"]!["superseded"]!.GetValue<int>()));

        // Ordered by name: a, b, c.
        var nodes = detail["nodes"]!.AsArray().Select(x => x!).ToArray();
        Assert.Equal(names.Order(StringComparer.Ordinal), nodes.Select(x => x["nodeName"]!.GetValue<string>()));
        Assert.Equal(["nodeId", "nodeName", "state", "firstAttemptAt", "lastAttemptAt", "targets"], nodes[0].AsObject().Select(x => x.Key));
        Assert.Equal([nodeA.NodeId.Value, nodeB.NodeId.Value, nodeC.NodeId.Value], nodes.Select(x => x["nodeId"]!.GetValue<Guid>()));
        Assert.Equal(["failed", "applying", "pending"], nodes.Select(x => x["state"]!.GetValue<string>()));
        var targetsA = nodes[0]["targets"]!.AsArray().Select(x => x!).ToArray();
        Assert.Equal(["agent-file/claude", "ai-client/claude", "skills"], targetsA.Select(x => x["name"]!.GetValue<string>()));
        Assert.Equal(["name", "state", "errorCode", "updatedAt"], targetsA[0].AsObject().Select(x => x.Key));
        Assert.Equal(["succeeded", "succeeded", "failed"], targetsA.Select(x => x["state"]!.GetValue<string>()));
        Assert.Equal([null, null, "lock_failed"], targetsA.Select(x => x["errorCode"]?.GetValue<string>()));
        Assert.Equal(["applying", "pending", "pending"], nodes[1]["targets"]!.AsArray().Select(x => x!["state"]!.GetValue<string>()));

        // First and last Attempt times are the earliest and latest Attempt updatedAt of the Node in the rollout.
        using (var scope = fixture.Scope())
        {
            var db = scope.ServiceProvider.GetRequiredService<FleetDbContext>();
            foreach (var (node, json) in new[] { (nodeA, nodes[0]), (nodeB, nodes[1]), (nodeC, nodes[2]) })
            {
                var attempts = await db.Attempts.AsNoTracking().Where(x => x.RolloutId == rolloutId && x.NodeId == node.NodeId.Value).ToListAsync();
                Assert.Equal(attempts.Min(x => x.UpdatedAt), json["firstAttemptAt"]!.GetValue<DateTimeOffset>());
                Assert.Equal(attempts.Max(x => x.UpdatedAt), json["lastAttemptAt"]!.GetValue<DateTimeOffset>());
            }
        }
        Assert.True(nodes[0]["firstAttemptAt"]!.GetValue<DateTimeOffset>() <= nodes[0]["lastAttemptAt"]!.GetValue<DateTimeOffset>());
        Assert.True(nodes[0]["lastAttemptAt"]!.GetValue<DateTimeOffset>() > nodes[0]["firstAttemptAt"]!.GetValue<DateTimeOffset>());

        // The error code is the latest Attempt's: after a retry the pending Attempt has none, and the Node's worst state is pending.
        (await fixture.Operate.PostAsJsonAsync($"/operator/v1/nodes/{nodeA.NodeId.Value}/retry", new { target = "skills" })).EnsureSuccessStatusCode();
        var retried = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync($"/operator/v1/rollouts/{rolloutId}"));
        var retriedA = retried["nodes"]![0]!;
        Assert.Equal("pending", retriedA["state"]!.GetValue<string>());
        var retriedSkills = retriedA["targets"]!.AsArray().Single(x => x!["name"]!.GetValue<string>() == "skills")!;
        Assert.Equal("pending", retriedSkills["state"]!.GetValue<string>());
        Assert.Null(retriedSkills["errorCode"]);
        Assert.Equal((6, 1, 2, 0), (retried["summary"]!["pending"]!.GetValue<int>(), retried["summary"]!["applying"]!.GetValue<int>(),
            retried["summary"]!["succeeded"]!.GetValue<int>(), retried["summary"]!["failed"]!.GetValue<int>()));

        await using var browser = new Browser(await fixture.BrowserAsync(OperatorApiFixture.ReadToken));
        var viaDashboard = await OperatorApiFixture.ReadAsync(await browser.Client.GetAsync($"/dashboard/api/rollouts/{rolloutId}"));
        Assert.True(JsonNode.DeepEquals(retried, viaDashboard));
    }

    [Fact]
    public async Task A_superseded_Assignment_stays_in_its_rollout_and_a_Node_of_only_superseded_Targets_is_superseded()
    {
        var node = await fixture.EnrollAsync(Unique("roll-old"));
        var first = SkillBundle(Unique("old-one"));
        var second = SkillBundle(Unique("old-two"));
        var one = await PublishAsync(Unique("rev"), [first], [Skills(node, ("only", first))]);
        await PublishAsync(Unique("rev"), [second], [Skills(node, ("only", second))]);

        var detail = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync($"/operator/v1/rollouts/{one.RolloutId!.Value.Value}"));
        var item = Assert.Single(detail["nodes"]!.AsArray())!;
        Assert.Equal("superseded", item["state"]!.GetValue<string>());
        Assert.Equal(1, detail["summary"]!["superseded"]!.GetValue<int>());
        var target = Assert.Single(item["targets"]!.AsArray())!;
        Assert.Equal("superseded", target["state"]!.GetValue<string>());
        Assert.NotNull(item["firstAttemptAt"]);
        Assert.NotNull(target["updatedAt"]);
    }

    [Fact]
    public async Task A_rollout_lists_at_most_500_Nodes_by_name_and_counts_every_Assignment_in_its_summary()
    {
        var revisionId = Guid.NewGuid();
        var rolloutId = Guid.NewGuid();
        var workspaceId = Guid.Parse("ecf620df-4637-490d-95b3-a9f81ca4c353");
        var prefix = Unique("cap").Replace("-", "");
        // The oldest possible revision, so that it never becomes the previous revision of a test's own revisions.
        var accepted = new DateTimeOffset(2000, 1, 1, 0, 0, 0, TimeSpan.Zero);
        using (var scope = fixture.Scope())
        {
            var db = scope.ServiceProvider.GetRequiredService<FleetDbContext>();
            await scope.ServiceProvider.GetRequiredService<IFleetCoordinator>().GetLatestSourceScanAsync();
            await db.Database.ExecuteSqlInterpolatedAsync($$"""
                INSERT INTO desired_revisions ("Id", "WorkspaceId", "SourceRevision", "AcceptedAt") VALUES ({{revisionId}}, {{workspaceId}}, {{prefix}}, {{accepted}});
                INSERT INTO rollouts ("Id", "DesiredRevisionId", "CreatedAt") VALUES ({{rolloutId}}, {{revisionId}}, {{accepted}});
                INSERT INTO nodes ("Id", "WorkspaceId", "Name", "Platform", "EnrolledAt")
                    SELECT gen_random_uuid(), {{workspaceId}}, {{prefix}} || '-' || lpad(i::text, 4, '0'), 'linux', {{DateTimeOffset.UtcNow}} FROM generate_series(0, 500) i;
                INSERT INTO assignments ("Id", "RolloutId", "DesiredRevisionId", "NodeId", "TargetName", "TargetBase", "TargetPath", "IsCurrent", "State", "CreatedAt")
                    SELECT gen_random_uuid(), {{rolloutId}}, {{revisionId}}, n."Id", 'skills', 'home', '.agents/skills', false, 2, {{accepted}}
                    FROM nodes n WHERE n."Name" LIKE {{prefix + "-%"}};
                """);
        }

        var detail = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync($"/operator/v1/rollouts/{rolloutId}"));
        var nodes = detail["nodes"]!.AsArray().Select(x => x!["nodeName"]!.GetValue<string>()).ToArray();
        Assert.Equal(500, nodes.Length);
        Assert.Equal(Enumerable.Range(0, 500).Select(i => $"{prefix}-{i:D4}"), nodes);
        Assert.Equal(501, detail["summary"]!["succeeded"]!.GetValue<int>());
        Assert.All(detail["nodes"]!.AsArray(), x => Assert.Null(x!["firstAttemptAt"]));
    }

    [Fact]
    public async Task An_unknown_rollout_is_a_404_with_a_message_and_a_poll_response_is_unchanged()
    {
        foreach (var id in new[] { Guid.NewGuid().ToString(), "nope" })
        {
            var missing = await OperatorApiFixture.ReadAsync(await fixture.Reader.GetAsync("/operator/v1/rollouts/" + id), HttpStatusCode.NotFound);
            Assert.Equal("rollout_not_found", missing["code"]!.GetValue<string>());
            Assert.False(string.IsNullOrWhiteSpace(missing["message"]!.GetValue<string>()));
        }
        Assert.NotNull(ErrorCatalog.Find("rollout_not_found"));
        // The rollouts attempts route still works next to the new detail route.
        Assert.Equal(HttpStatusCode.OK, (await fixture.Reader.GetAsync($"/operator/v1/rollouts/{Guid.NewGuid()}/attempts")).StatusCode);

        // Polling carries no new field.
        var node = await fixture.EnrollAsync(Unique("poll"));
        await fixture.PublishAsync(node, Unique("rev-poll"));
        var poll = await fixture.SendNodeAsync("/agent/v1/poll", node.Certificate, null);
        Assert.Equal(200, poll.Response.StatusCode);
        var body = await JsonSerializer.DeserializeAsync<JsonElement>(poll.Response.Body);
        Assert.Equal(["workspaceId", "nodeId", "assignment", "nextPollSeconds"], body.EnumerateObject().Select(x => x.Name));
        Assert.Equal(["assignmentId", "attemptId", "rolloutId", "desiredRevisionId", "targetName", "target", "skills", "file"],
            body.GetProperty("assignment").EnumerateObject().Select(x => x.Name));
    }

    private async Task<NodeAuthentication> Authenticate(EnrolledNode node)
    {
        using var scope = fixture.Scope();
        return (await scope.ServiceProvider.GetRequiredService<IFleetCoordinator>().FindActiveNodeByCertificateAsync(
            node.Certificate.GetCertHashString(System.Security.Cryptography.HashAlgorithmName.SHA256).ToLowerInvariant()))!;
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
