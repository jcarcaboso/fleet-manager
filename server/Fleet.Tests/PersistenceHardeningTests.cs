using System.Security.Cryptography;
using Fleet.Core.Coordination;
using Fleet.Server.Persistence;
using Microsoft.EntityFrameworkCore;
using Testcontainers.PostgreSql;

namespace Fleet.Tests;

public sealed class PersistenceHardeningTests : IAsyncLifetime
{
    private readonly PostgreSqlContainer postgres = new PostgreSqlBuilder("postgres:17.5-alpine").Build();
    private readonly MutableTimeProvider clock = new(new(2026, 9, 7, 12, 0, 0, TimeSpan.Zero));
    private FleetCoordinationOptions settings = null!;

    public async Task InitializeAsync()
    {
        await postgres.StartAsync();
        settings = new() { WorkspaceId = new(Guid.NewGuid()), WorkspaceName = "hardening" };
        await using var db = Database();
        await db.Database.MigrateAsync();
    }

    public async Task DisposeAsync() => await postgres.DisposeAsync();

    [Fact]
    public async Task Concurrent_workspace_initialization_is_singleton_and_other_configuration_is_rejected()
    {
        await using var first = Database();
        await using var second = Database();
        await Task.WhenAll(Coordinator(first).GetNodesAsync(new(1), clock.GetUtcNow(), TimeSpan.FromMinutes(5)),
            Coordinator(second).GetNodesAsync(new(1), clock.GetUtcNow(), TimeSpan.FromMinutes(5)));

        await using var verify = Database();
        Assert.Equal(1, await verify.Workspaces.CountAsync());
        var wrong = new PostgresFleetCoordinator(verify, clock,
            new() { WorkspaceId = new(Guid.NewGuid()), WorkspaceName = "wrong" });
        var error = await Assert.ThrowsAsync<CoordinationException>(() =>
            wrong.GetNodesAsync(new(1), clock.GetUtcNow(), TimeSpan.FromMinutes(5)));
        Assert.Equal("workspace_mismatch", error.Code);
    }

    [Fact]
    public async Task Maintenance_always_scrubs_expired_delivery_and_deletes_history_only_when_opted_in()
    {
        await using var db = Database();
        var coordinator = Coordinator(db);
        await Enroll(coordinator, "retained");
        await coordinator.RecordSourceScanAsync(new("old", SourceScanOutcome.Failed, "git", "bounded", clock.GetUtcNow()));
        clock.Advance(TimeSpan.FromMinutes(3));

        var scrubOnly = await coordinator.MaintainPersistenceAsync(new(null, null, 1));

        Assert.Equal(1, scrubOnly.EnrollmentPayloadsScrubbed);
        Assert.Equal(0, scrubOnly.AuditEventsDeleted);
        Assert.Equal(0, scrubOnly.SourceScansDeleted);
        Assert.Null(await db.Enrollments.Select(x => x.DeliveryPayload).SingleAsync());
        Assert.True(await db.AuditEvents.AnyAsync());
        Assert.True(await db.SourceScans.AnyAsync());

        var retainedBatch = await coordinator.MaintainPersistenceAsync(
            new(TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(1), 1));
        Assert.Equal(1, retainedBatch.AuditEventsDeleted);
        Assert.Equal(1, retainedBatch.SourceScansDeleted);
    }

    [Fact]
    public async Task Concurrent_contacts_keep_the_newest_freshness_timestamp()
    {
        Enrolled enrolled;
        await using (var setup = Database()) enrolled = await Enroll(Coordinator(setup), "freshness");
        var older = clock.GetUtcNow() + TimeSpan.FromMinutes(1);
        var newer = clock.GetUtcNow() + TimeSpan.FromMinutes(2);
        await using var first = Database();
        await using var second = Database();

        await Task.WhenAll(Coordinator(first).PollAsync(enrolled.Authentication, newer),
            Coordinator(second).PollAsync(enrolled.Authentication, older));

        await using var verify = Database();
        Assert.Equal(newer, await verify.Nodes.Where(x => x.Id == enrolled.NodeId.Value).Select(x => x.LastContactAt).SingleAsync());
    }

    [Fact]
    public async Task Credential_renewal_and_node_revocation_are_linearized()
    {
        Enrolled enrolled;
        await using (var setup = Database()) enrolled = await Enroll(Coordinator(setup), "rotation");
        var replacement = Credential(enrolled.NodeId);
        await using var renewDb = Database();
        await using var revokeDb = Database();

        var outcomes = await Task.WhenAll(Capture(Coordinator(renewDb).RenewCredentialAsync(
            new(enrolled.Authentication, replacement))), Capture(Coordinator(revokeDb).RevokeNodeAsync(enrolled.NodeId, "operator")));

        Assert.All(outcomes, Assert.Null);
        await using var verify = Database();
        Assert.Null(await Coordinator(verify).FindActiveNodeByCertificateAsync(replacement.CertificateSha256));
        Assert.All(await verify.Credentials.Where(x => x.NodeId == enrolled.NodeId.Value).ToListAsync(),
            credential => Assert.NotNull(credential.RevokedAt));
    }

    [Fact]
    public async Task Concurrent_publications_leave_one_current_assignment_and_stale_report_cannot_win()
    {
        Enrolled enrolled;
        AgentAssignment original;
        await using (var setup = Database())
        {
            var coordinator = Coordinator(setup);
            enrolled = await Enroll(coordinator, "publication");
            var initial = Bundle("initial");
            await coordinator.AcceptSourceSnapshotAsync(Snapshot("initial", enrolled.NodeId, initial));
            original = (await coordinator.PollAsync(enrolled.Authentication, clock.GetUtcNow())).Assignment!;
        }
        var one = Bundle("one");
        var two = Bundle("two");
        await using var first = Database();
        await using var second = Database();
        await Task.WhenAll(Coordinator(first).AcceptSourceSnapshotAsync(Snapshot("one", enrolled.NodeId, one)),
            Coordinator(second).AcceptSourceSnapshotAsync(Snapshot("two", enrolled.NodeId, two)));

        await using var reportDb = Database();
        var stale = await Coordinator(reportDb).ReportAttemptAsync(enrolled.Authentication,
            new(original.AttemptId, ConvergenceState.Succeeded, null, null, clock.GetUtcNow()));
        Assert.Equal(ReportOutcome.Stale, stale.Outcome);
        await using var verify = Database();
        Assert.Equal(1, await verify.Assignments.CountAsync(x => x.NodeId == enrolled.NodeId.Value && x.IsCurrent));
    }

    [Fact]
    public async Task Snapshot_warning_and_future_contact_limits_fail_before_mutation()
    {
        await using var db = Database();
        var coordinator = Coordinator(db);
        var enrolled = await Enroll(coordinator, "bounds");
        var bundle = Bundle("bounded");
        var bad = Snapshot("bad", enrolled.NodeId, bundle) with
        {
            Warnings = [new("code", new string('x', 2_049), [])]
        };

        await Assert.ThrowsAsync<CoordinationException>(() => coordinator.AcceptSourceSnapshotAsync(bad));
        await Assert.ThrowsAsync<CoordinationException>(() => coordinator.PollAsync(
            enrolled.Authentication, clock.GetUtcNow() + TimeSpan.FromMinutes(6)));
        Assert.False(await db.DesiredRevisions.AnyAsync(x => x.SourceRevision == "bad"));
    }

    private FleetDbContext Database() => new(new DbContextOptionsBuilder<FleetDbContext>().UseNpgsql(postgres.GetConnectionString()).Options);
    private PostgresFleetCoordinator Coordinator(FleetDbContext db) => new(db, clock, settings);

    private async Task<Enrolled> Enroll(IFleetCoordinator coordinator, string name)
    {
        var authorization = await coordinator.CreateEnrollmentAuthorizationAsync(
            new("operator", clock.GetUtcNow() + TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(2)));
        var issued = Credential(new(Guid.NewGuid()));
        await coordinator.CompleteEnrollmentAsync(new(authorization.Token, Sha("csr-" + name), name, "linux", issued));
        return new(issued.NodeId, new(issued.NodeId, issued.CredentialId, issued.CertificateSha256));
    }

    private IssuedNodeCredential Credential(NodeId nodeId) => new(nodeId, new(Guid.NewGuid()), Sha(Guid.NewGuid().ToString()),
        clock.GetUtcNow() - TimeSpan.FromMinutes(1), clock.GetUtcNow() + TimeSpan.FromHours(1), "certificate"u8.ToArray());
    private AcceptedSourceSnapshot Snapshot(string source, NodeId nodeId, SnapshotBundle bundle) => new(source, [bundle],
        [new(nodeId, "skills", new("home", ".agents/skills"), [new("review", bundle.Digest)])], [], clock.GetUtcNow());
    private static SnapshotBundle Bundle(string text)
    {
        var bytes = System.Text.Encoding.UTF8.GetBytes(text);
        return new(Sha(bytes), "fleet.bundle/v1", bytes.Length, bytes);
    }
    private static string Sha(string text) => Sha(System.Text.Encoding.UTF8.GetBytes(text));
    private static string Sha(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    private static async Task<Exception?> Capture(Task operation)
    {
        try { await operation; return null; }
        catch (CoordinationException) { return null; }
        catch (Exception error) { return error; }
    }

    private sealed record Enrolled(NodeId NodeId, NodeAuthentication Authentication);
    private sealed class MutableTimeProvider(DateTimeOffset current) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => current;
        public void Advance(TimeSpan amount) => current += amount;
    }
}
