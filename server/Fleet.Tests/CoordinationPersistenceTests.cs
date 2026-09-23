using System.Security.Cryptography;
using Fleet.Core.Coordination;
using Fleet.Server.Persistence;
using Microsoft.EntityFrameworkCore;
using Testcontainers.PostgreSql;
using Xunit.Abstractions;

namespace Fleet.Tests;

public sealed class CoordinationPersistenceTests : IAsyncLifetime
{
    private readonly ITestOutputHelper output;
    private readonly PostgreSqlContainer postgres = new PostgreSqlBuilder("postgres:17.5-alpine").Build();
    private readonly FixedTimeProvider clock = new(new DateTimeOffset(2026, 9, 7, 12, 0, 0, TimeSpan.Zero));
    private FleetCoordinationOptions settings = null!;

    public CoordinationPersistenceTests(ITestOutputHelper output) => this.output = output;

    public async Task InitializeAsync()
    {
        await postgres.StartAsync();
        settings = new() { WorkspaceId = new(Guid.NewGuid()), WorkspaceName = "test" };
        await using var db = Database();
        await db.Database.MigrateAsync();
    }

    public async Task DisposeAsync() => await postgres.DisposeAsync();

    [Fact]
    public async Task Enrollment_is_single_use_but_exact_retry_returns_original_delivery()
    {
        await using var db = Database();
        var coordinator = Coordinator(db);
        var authorization = await coordinator.CreateEnrollmentAuthorizationAsync(
            new("operator", clock.GetUtcNow() + TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(2)));
        var issued = Credential();
        var request = new CompleteEnrollment(authorization.Token, Sha("csr-one"), "linux-one", "linux", issued);

        var first = await coordinator.CompleteEnrollmentAsync(request);
        var retry = await coordinator.CompleteEnrollmentAsync(request with
        {
            IssuedCredential = issued with { DeliveryPayload = "attacker replacement"u8.ToArray() }
        });

        Assert.Equal(EnrollmentOutcome.Enrolled, first.Outcome);
        Assert.Equal(EnrollmentOutcome.Retry, retry.Outcome);
        Assert.Equal(issued.DeliveryPayload, retry.DeliveryPayload);
        var mismatch = await Assert.ThrowsAsync<CoordinationException>(() => coordinator.CompleteEnrollmentAsync(
            request with { CertificateRequestSha256 = Sha("different-csr") }));
        Assert.Equal("invalid_enrollment", mismatch.Code);
    }

    [Fact]
    public async Task Revoked_credential_no_longer_authenticates_while_another_node_stays_active()
    {
        await using var db = Database();
        var coordinator = Coordinator(db);
        var first = await Enroll(coordinator, "first");
        var second = await Enroll(coordinator, "second");

        await coordinator.RevokeCredentialAsync(first.CredentialId, "operator");

        Assert.Null(await coordinator.FindActiveNodeByCertificateAsync(first.CertificateSha256));
        Assert.NotNull(await coordinator.FindActiveNodeByCertificateAsync(second.CertificateSha256));
    }

    [Fact]
    public async Task Publication_changes_only_affected_targets_and_stale_report_cannot_replace_current_state()
    {
        await using var db = Database();
        var coordinator = Coordinator(db);
        var first = await Enroll(coordinator, "first");
        var second = await Enroll(coordinator, "second");
        var bundleA = Bundle("A");
        var initial = Snapshot("source-1", [bundleA],
            Target(first.NodeId, "skills", bundleA.Digest), Target(second.NodeId, "skills", bundleA.Digest));

        var publication = await coordinator.AcceptSourceSnapshotAsync(initial);
        var oldWork = (await coordinator.PollAsync(first.Authentication, clock.GetUtcNow())).Assignment!;
        var bundleB = Bundle("B");
        clock.Advance(TimeSpan.FromMinutes(1));
        var changed = await coordinator.AcceptSourceSnapshotAsync(Snapshot("source-2", [bundleA, bundleB],
            Target(first.NodeId, "skills", bundleB.Digest), Target(second.NodeId, "skills", bundleA.Digest)));

        Assert.Equal(2, publication.ChangedAssignmentCount);
        Assert.Equal(1, changed.ChangedAssignmentCount);
        var stale = await coordinator.ReportAttemptAsync(first.Authentication,
            new(oldWork.AttemptId, ConvergenceState.Succeeded, null, null, clock.GetUtcNow()));
        Assert.Equal(ReportOutcome.Stale, stale.Outcome);
        var current = (await coordinator.PollAsync(first.Authentication, clock.GetUtcNow())).Assignment!;
        Assert.NotEqual(oldWork.AssignmentId, current.AssignmentId);
        Assert.Equal(bundleB.Digest, Assert.Single(current.Skills).BundleDigest);
        var unaffected = (await coordinator.PollAsync(second.Authentication, clock.GetUtcNow())).Assignment!;
        Assert.Equal(publication.RolloutId, unaffected.RolloutId);
    }

    [Fact]
    public async Task Duplicate_terminal_report_is_idempotent_and_operator_queries_are_bounded()
    {
        await using var db = Database();
        var coordinator = Coordinator(db);
        var enrolled = await Enroll(coordinator, "node");
        var bundle = Bundle("content");
        await coordinator.AcceptSourceSnapshotAsync(Snapshot("source", [bundle], Target(enrolled.NodeId, "skills", bundle.Digest)));
        var work = (await coordinator.PollAsync(enrolled.Authentication, clock.GetUtcNow())).Assignment!;
        var report = new AttemptReport(work.AttemptId, ConvergenceState.Succeeded, null, null, clock.GetUtcNow());

        Assert.Equal(ReportOutcome.Recorded, (await coordinator.ReportAttemptAsync(enrolled.Authentication, report)).Outcome);
        Assert.Equal(ReportOutcome.Duplicate, (await coordinator.ReportAttemptAsync(enrolled.Authentication, report)).Outcome);
        var page = await coordinator.GetNodesAsync(new(1), clock.GetUtcNow(), TimeSpan.FromMinutes(5));
        Assert.Single(page.Items);
        Assert.Equal(FreshnessState.Fresh, page.Items[0].Freshness);
        await Assert.ThrowsAsync<CoordinationException>(() => coordinator.GetNodesAsync(
            new(PageRequest.MaximumLimit + 1), clock.GetUtcNow(), TimeSpan.FromMinutes(5)));
    }

    [Fact]
    public async Task Failed_ai_configuration_retries_after_backoff_without_a_new_source_revision()
    {
        await using var db = Database();
        var coordinator = Coordinator(db);
        var node = await Enroll(coordinator, "retry-ai");
        var target = new SnapshotTarget(node.NodeId, "ai-client/codex", new("home", ".codex"), [],
            AiClient: new("fleet.ai-client/v1", "codex", "cliproxy", "https://proxy.example/v1"));
        await coordinator.AcceptSourceSnapshotAsync(Snapshot("same-source", [], target));
        var first = (await coordinator.PollAsync(node.Authentication, clock.GetUtcNow())).Assignment!;
        var failure = new AttemptReport(first.AttemptId, ConvergenceState.Failed, "ai_client_reconcile_failed", null, clock.GetUtcNow());
        await coordinator.ReportAttemptAsync(node.Authentication, failure);
        clock.Advance(TimeSpan.FromSeconds(59));
        Assert.Null((await coordinator.PollAsync(node.Authentication, clock.GetUtcNow())).Assignment);
        clock.Advance(TimeSpan.FromSeconds(1));
        // Concurrent polls must share one new attempt.
        var retries = await Task.WhenAll(Enumerable.Range(0, 2).Select(async _ =>
        {
            await using var other = Database();
            return (await Coordinator(other).PollAsync(node.Authentication, clock.GetUtcNow())).Assignment!;
        }));
        var retry = retries[0];
        Assert.Equal(retry.AttemptId, retries[1].AttemptId);
        Assert.NotEqual(first.AttemptId, retry.AttemptId);
        Assert.Equal(first.AssignmentId, retry.AssignmentId);
        Assert.Equal(first.DesiredRevisionId, retry.DesiredRevisionId);
        db.ChangeTracker.Clear();
        Assert.Equal(ReportOutcome.Duplicate, (await coordinator.ReportAttemptAsync(node.Authentication, failure)).Outcome);
        var terminal = await Assert.ThrowsAsync<CoordinationException>(() => coordinator.ReportAttemptAsync(node.Authentication,
            failure with { State = ConvergenceState.Applying }));
        Assert.Equal("terminal_attempt", terminal.Code);
        await coordinator.ReportAttemptAsync(node.Authentication,
            new(retry.AttemptId, ConvergenceState.Succeeded, null, null, clock.GetUtcNow()));
        Assert.Null((await coordinator.PollAsync(node.Authentication, clock.GetUtcNow())).Assignment);
        Assert.Equal(2, await db.Attempts.CountAsync());
        Assert.Equal((int)ConvergenceState.Succeeded, (await db.Assignments.SingleAsync()).State);
    }

    [Fact]
    public async Task AI_client_assignments_persist_poll_and_narrow_credential_authorization()
    {
        await using var db = Database();
        var coordinator = Coordinator(db);
        var assigned = await Enroll(coordinator, "assigned");
        var unassigned = await Enroll(coordinator, "unassigned");
        var cliproxy = new SnapshotTarget(assigned.NodeId, "ai-client/codex", new("home", ".codex"), [],
            AiClient: new("fleet.ai-client/v1", "codex", "cliproxy", "https://proxy.example/v1", "gpt-6-astra"));
        await coordinator.AcceptSourceSnapshotAsync(Snapshot("ai-source-1", [], cliproxy));

        var work = (await coordinator.PollTargetAsync(assigned.Authentication, "ai-client/codex", clock.GetUtcNow())).Assignment!;

        Assert.Equal(cliproxy.AiClient, work.AiClient);
        await coordinator.AuthorizeCliProxyCredentialAsync(assigned.Authentication);
        var denied = await Assert.ThrowsAsync<CoordinationException>(
            () => coordinator.AuthorizeCliProxyCredentialAsync(unassigned.Authentication));
        Assert.Equal("cliproxy_credential_not_authorized", denied.Code);
        var stored = await db.AssignmentAiClients.SingleAsync();
        Assert.Equal(("codex", "cliproxy", "https://proxy.example/v1", "gpt-6-astra"),
            (stored.Client, stored.Mode, stored.BaseUrl, stored.Model));

        var native = cliproxy with { AiClient = new("fleet.ai-client/v1", "codex", "native") };
        await coordinator.AcceptSourceSnapshotAsync(Snapshot("ai-source-2", [], native));
        denied = await Assert.ThrowsAsync<CoordinationException>(
            () => coordinator.AuthorizeCliProxyCredentialAsync(assigned.Authentication));
        Assert.Equal("cliproxy_credential_not_authorized", denied.Code);

        var invalid = cliproxy with
        {
            AiClient = new("fleet.ai-client/v1", "codex", "cliproxy", "https://proxy.example/v1", "gpt model")
        };
        var rejected = await Assert.ThrowsAsync<CoordinationException>(
            () => coordinator.AcceptSourceSnapshotAsync(Snapshot("ai-source-3", [], invalid)));
        Assert.Equal("invalid_ai_client", rejected.Code);

        invalid = cliproxy with
        {
            AiClient = new("fleet.ai-client/v1", "codex", "cliproxy", "http://user:password@proxy.example/unsafe", "gpt-6-astra")
        };
        rejected = await Assert.ThrowsAsync<CoordinationException>(
            () => coordinator.AcceptSourceSnapshotAsync(Snapshot("ai-source-4", [], invalid)));
        Assert.Equal("invalid_ai_client", rejected.Code);
    }

    [Fact]
    public async Task Concurrent_exact_enrollment_consumption_creates_one_node_and_returns_one_retry()
    {
        EnrollmentAuthorization authorization;
        await using (var setup = Database())
            authorization = await Coordinator(setup).CreateEnrollmentAuthorizationAsync(
                new("operator", clock.GetUtcNow() + TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(2)));
        var issued = Credential();
        var command = new CompleteEnrollment(authorization.Token, Sha("same-csr"), "racing-node", "linux", issued);
        await using var firstDb = Database();
        await using var secondDb = Database();

        var results = await Task.WhenAll(Coordinator(firstDb).CompleteEnrollmentAsync(command),
            Coordinator(secondDb).CompleteEnrollmentAsync(command));

        Assert.Contains(results, x => x.Outcome == EnrollmentOutcome.Enrolled);
        Assert.Contains(results, x => x.Outcome == EnrollmentOutcome.Retry);
        await using var verify = Database();
        Assert.Equal(1, await verify.Nodes.CountAsync(x => x.Name == "racing-node"));
    }

    [Fact]
    public async Task Concurrent_conflicting_terminal_reports_preserve_the_first_result()
    {
        Enrolled enrolled;
        AgentAssignment work;
        await using (var setup = Database())
        {
            var coordinator = Coordinator(setup);
            enrolled = await Enroll(coordinator, "terminal-race");
            var bundle = Bundle("race");
            await coordinator.AcceptSourceSnapshotAsync(Snapshot("race-source", [bundle], Target(enrolled.NodeId, "skills", bundle.Digest)));
            work = (await coordinator.PollAsync(enrolled.Authentication, clock.GetUtcNow())).Assignment!;
        }
        await using var firstDb = Database();
        await using var secondDb = Database();
        var first = Coordinator(firstDb).ReportAttemptAsync(enrolled.Authentication,
            new(work.AttemptId, ConvergenceState.Succeeded, null, null, clock.GetUtcNow()));
        var second = Coordinator(secondDb).ReportAttemptAsync(enrolled.Authentication,
            new(work.AttemptId, ConvergenceState.Failed, "io", "failed", clock.GetUtcNow()));

        var outcomes = await Task.WhenAll(Capture(first), Capture(second));

        Assert.Single(outcomes, x => x.Result?.Outcome == ReportOutcome.Recorded);
        Assert.Single(outcomes, x => x.Error?.Code == "terminal_attempt");
    }

    [Fact]
    public async Task Thousand_node_fixture_polls_and_pages_through_bounded_queries()
    {
        var authentications = new List<NodeAuthentication>(1_000);
        await using (var setup = Database())
        {
            setup.Workspaces.Add(new WorkspaceRow { Id = settings.WorkspaceId.Value, Name = settings.WorkspaceName });
            for (var index = 0; index < 1_000; index++)
            {
                var nodeId = Guid.NewGuid();
                var credentialId = Guid.NewGuid();
                var certificate = Sha("load-certificate-" + index);
                setup.Nodes.Add(new NodeRow
                {
                    Id = nodeId,
                    WorkspaceId = settings.WorkspaceId.Value,
                    Name = "load-node-" + index,
                    Platform = "linux",
                    EnrolledAt = clock.GetUtcNow()
                });
                setup.Credentials.Add(new CredentialRow
                {
                    Id = credentialId,
                    NodeId = nodeId,
                    CertificateSha256 = certificate,
                    NotBefore = clock.GetUtcNow() - TimeSpan.FromMinutes(1),
                    NotAfter = clock.GetUtcNow() + TimeSpan.FromHours(1)
                });
                authentications.Add(new(new(nodeId), new(credentialId), certificate));
            }
            await setup.SaveChangesAsync();
        }

        var timer = System.Diagnostics.Stopwatch.StartNew();
        foreach (var batch in authentications.Chunk(50))
            await Task.WhenAll(batch.Select(Poll));
        var pollElapsed = timer.Elapsed;

        var listed = 0;
        string? cursor = null;
        await using (var query = Database())
        {
            var coordinator = Coordinator(query);
            do
            {
                var page = await coordinator.GetNodesAsync(new(200, cursor), clock.GetUtcNow(), TimeSpan.FromMinutes(5));
                listed += page.Items.Count;
                cursor = page.NextCursor;
            } while (cursor is not null);
        }
        timer.Stop();
        output.WriteLine("1,000 authenticated no-work polls in {0}; five 200-row status pages in {1} total.",
            pollElapsed, timer.Elapsed);
        Assert.Equal(1_000, listed);

        async Task Poll(NodeAuthentication authentication)
        {
            await using var context = Database();
            Assert.Null((await Coordinator(context).PollAsync(authentication, clock.GetUtcNow())).Assignment);
        }
    }

    private static async Task<(ReportResult? Result, CoordinationException? Error)> Capture(Task<ReportResult> operation)
    {
        try { return (await operation, null); }
        catch (CoordinationException error) { return (null, error); }
    }

    private FleetDbContext Database() => new(new DbContextOptionsBuilder<FleetDbContext>()
        .UseNpgsql(postgres.GetConnectionString()).Options);
    private PostgresFleetCoordinator Coordinator(FleetDbContext db) => new(db, clock, settings);

    private async Task<Enrolled> Enroll(IFleetCoordinator coordinator, string name)
    {
        var auth = await coordinator.CreateEnrollmentAuthorizationAsync(
            new("operator", clock.GetUtcNow() + TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(2)));
        var issued = Credential();
        await coordinator.CompleteEnrollmentAsync(new(auth.Token, Sha("csr-" + name), name, "linux", issued));
        return new(issued.NodeId, issued.CredentialId, issued.CertificateSha256,
            new(issued.NodeId, issued.CredentialId, issued.CertificateSha256));
    }

    private IssuedNodeCredential Credential() => new(new(Guid.NewGuid()), new(Guid.NewGuid()), Sha(Guid.NewGuid().ToString()),
        clock.GetUtcNow() - TimeSpan.FromMinutes(1), clock.GetUtcNow() + TimeSpan.FromHours(1), "public certificate"u8.ToArray());
    private static SnapshotBundle Bundle(string value)
    {
        var bytes = System.Text.Encoding.UTF8.GetBytes(value);
        return new(Sha(bytes), "fleet.bundle/v1", bytes.Length, bytes);
    }
    private AcceptedSourceSnapshot Snapshot(string source, IReadOnlyList<SnapshotBundle> bundles, params SnapshotTarget[] targets) =>
        new(source, bundles, targets, [new("duplicate_skill", "A duplicate was resolved.", ["a", "b"])], clock.GetUtcNow());
    private static SnapshotTarget Target(NodeId node, string target, string digest) =>
        new(node, target, new("home", ".agents/skills"), [new("review", digest)]);
    private static string Sha(string value) => Sha(System.Text.Encoding.UTF8.GetBytes(value));
    private static string Sha(byte[] value) => Convert.ToHexString(SHA256.HashData(value)).ToLowerInvariant();

    private sealed record Enrolled(NodeId NodeId, CredentialId CredentialId, string CertificateSha256, NodeAuthentication Authentication);
    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
        public void Advance(TimeSpan duration) => now += duration;
    }
}
