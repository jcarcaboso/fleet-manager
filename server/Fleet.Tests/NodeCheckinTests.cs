using System.Security.Cryptography;
using Fleet.Core.Coordination;
using Fleet.Server.Persistence;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Testcontainers.PostgreSql;

namespace Fleet.Tests;

public sealed class NodeCheckinTests : IAsyncLifetime
{
    private readonly PostgreSqlContainer postgres = new PostgreSqlBuilder("postgres:17.5-alpine").Build();
    private readonly FixedClock clock = new(new DateTimeOffset(2026, 10, 26, 10, 30, 0, TimeSpan.Zero));
    private readonly FleetCoordinationOptions settings = new() { WorkspaceId = new(Guid.NewGuid()), WorkspaceName = "test" };

    public async Task InitializeAsync()
    {
        await postgres.StartAsync();
        await using var db = Database();
        await db.Database.MigrateAsync();
    }

    public async Task DisposeAsync() => await postgres.DisposeAsync();

    [Fact]
    public async Task The_model_snapshot_matches_the_migrations()
    {
        await using var db = Database();
        Assert.False(db.Database.HasPendingModelChanges());
        Assert.Contains("node_checkins", await db.Database.SqlQueryRaw<string>(
            "SELECT table_name AS \"Value\" FROM information_schema.tables WHERE table_name = 'node_checkins'").ToListAsync());
    }

    [Fact]
    public async Task Polls_are_counted_per_UTC_hour_even_when_concurrent_and_only_successful_polls_count()
    {
        NodeAuthentication node;
        await using (var setup = Database()) node = await Enroll(Coordinator(setup), "counted");

        await Task.WhenAll(Enumerable.Range(0, 20).Select(async _ =>
        {
            await using var db = Database();
            await Coordinator(db).PollAsync(node, clock.GetUtcNow());
        }));
        clock.Advance(TimeSpan.FromMinutes(45));
        await using (var db = Database())
        {
            var coordinator = Coordinator(db);
            await coordinator.PollAsync(node, clock.GetUtcNow());
            await coordinator.PollAsync(node, clock.GetUtcNow());
            var wrong = node with { CertificateSha256 = Sha("not the certificate") };
            await Assert.ThrowsAsync<CoordinationException>(() => coordinator.PollAsync(wrong, clock.GetUtcNow()));
            await Assert.ThrowsAsync<CoordinationException>(() => coordinator.PollAsync(node, clock.GetUtcNow() + TimeSpan.FromHours(1)));

            var checkins = await coordinator.GetNodeCheckinsAsync(node.NodeId, 4);
            Assert.Equal(4, checkins.Hours);
            Assert.Equal([new DateTimeOffset(2026, 10, 26, 8, 0, 0, TimeSpan.Zero), new DateTimeOffset(2026, 10, 26, 9, 0, 0, TimeSpan.Zero),
                new DateTimeOffset(2026, 10, 26, 10, 0, 0, TimeSpan.Zero), new DateTimeOffset(2026, 10, 26, 11, 0, 0, TimeSpan.Zero)],
                checkins.Buckets.Select(x => x.Hour));
            Assert.Equal([0, 0, 20, 2], checkins.Buckets.Select(x => x.Polls));
            Assert.Equal(168, (await coordinator.GetNodeCheckinsAsync(node.NodeId, 168)).Buckets.Count);
            Assert.Equal("invalid_request", (await Assert.ThrowsAsync<CoordinationException>(() => coordinator.GetNodeCheckinsAsync(node.NodeId, 169))).Code);
            Assert.Equal("node_not_found", (await Assert.ThrowsAsync<CoordinationException>(() => coordinator.GetNodeCheckinsAsync(new(Guid.NewGuid()), 2))).Code);
        }
    }

    [Fact]
    public async Task Maintenance_prunes_check_ins_older_than_seven_days_even_without_a_retention_policy()
    {
        NodeAuthentication node;
        await using var db = Database();
        var coordinator = Coordinator(db);
        node = await Enroll(coordinator, "pruned");
        await coordinator.PollAsync(node, clock.GetUtcNow());
        var now = clock.GetUtcNow();
        db.NodeCheckins.AddRange(
            new NodeCheckinRow { NodeId = node.NodeId.Value, Hour = new DateTimeOffset(2026, 10, 19, 9, 0, 0, TimeSpan.Zero), Polls = 5 },
            new NodeCheckinRow { NodeId = node.NodeId.Value, Hour = new DateTimeOffset(2026, 10, 12, 9, 0, 0, TimeSpan.Zero), Polls = 7 },
            new NodeCheckinRow { NodeId = node.NodeId.Value, Hour = new DateTimeOffset(2026, 10, 19, 11, 0, 0, TimeSpan.Zero), Polls = 9 });
        await db.SaveChangesAsync();

        // 2026-10-19 10:30 is exactly seven days before the clock: hours before that are pruned.
        var first = await coordinator.MaintainPersistenceAsync(new(null, null, 1));
        Assert.Equal(1, first.CheckinsDeleted);
        var second = await coordinator.MaintainPersistenceAsync(new(null, null, 10));
        Assert.Equal(1, second.CheckinsDeleted);
        Assert.Equal(0, (await coordinator.MaintainPersistenceAsync(new(null, null, 10))).CheckinsDeleted);
        var remaining = await db.NodeCheckins.AsNoTracking().OrderBy(x => x.Hour).Select(x => x.Polls).ToListAsync();
        Assert.Equal([9, 1], remaining);
        Assert.Equal(now, clock.GetUtcNow());
    }

    [Fact]
    public async Task Removing_a_Node_removes_its_check_ins()
    {
        await using var db = Database();
        var coordinator = Coordinator(db);
        var node = await Enroll(coordinator, "removed");
        await coordinator.PollAsync(node, clock.GetUtcNow());
        Assert.Equal(1, await db.NodeCheckins.CountAsync());
        await coordinator.RemoveNodeAsync(node.NodeId, "removed", "operator");
        Assert.Equal(0, await db.NodeCheckins.CountAsync());
    }

    [Fact]
    public async Task A_failing_check_in_write_never_fails_the_poll_or_hides_the_Assignment()
    {
        await using var setup = Database();
        var coordinator = Coordinator(setup);
        var node = await Enroll(coordinator, "failing-checkin");
        await Publish(coordinator, node, "rev-a");
        // The check-in table is unusable, as when the foreign key fails against a Node that is being removed.
        await setup.Database.ExecuteSqlRawAsync("ALTER TABLE node_checkins RENAME TO node_checkins_unavailable");

        await using var db = Database();
        var poll = await Coordinator(db).PollAsync(node, clock.GetUtcNow());

        Assert.Equal("skills", poll.Assignment!.TargetName);
        await setup.Database.ExecuteSqlRawAsync("ALTER TABLE node_checkins_unavailable RENAME TO node_checkins");
        Assert.Equal(0, await setup.NodeCheckins.CountAsync());
        // The poll itself still counts as contact, and the next poll records its check-in again.
        Assert.NotNull((await setup.Nodes.AsNoTracking().SingleAsync(x => x.Id == node.NodeId.Value)).LastContactAt);
        await Coordinator(db).PollAsync(node, clock.GetUtcNow());
        Assert.Equal(1, await setup.NodeCheckins.SumAsync(x => x.Polls));
    }

    [Fact]
    public async Task A_locked_check_in_table_delays_a_poll_only_briefly_and_still_delivers_the_Assignment()
    {
        await using var setup = Database();
        var coordinator = Coordinator(setup);
        var node = await Enroll(coordinator, "locked-checkin");
        await Publish(coordinator, node, "rev-b");

        await using var blocker = new NpgsqlConnection(postgres.GetConnectionString());
        await blocker.OpenAsync();
        await using (var transaction = await blocker.BeginTransactionAsync())
        {
            await new NpgsqlCommand("LOCK TABLE node_checkins IN ACCESS EXCLUSIVE MODE", blocker, transaction).ExecuteNonQueryAsync();

            await using var db = Database();
            var started = System.Diagnostics.Stopwatch.GetTimestamp();
            var poll = await Coordinator(db).PollAsync(node, clock.GetUtcNow());
            var waited = System.Diagnostics.Stopwatch.GetElapsedTime(started);

            Assert.Equal("skills", poll.Assignment!.TargetName);
            Assert.True(waited < TimeSpan.FromSeconds(5), $"The poll waited {waited} for the check-in lock.");
            await transaction.RollbackAsync();
        }
        Assert.Equal(0, await setup.NodeCheckins.CountAsync());
    }

    private async Task Publish(IFleetCoordinator coordinator, NodeAuthentication node, string revision)
    {
        var bytes = System.Text.Encoding.UTF8.GetBytes("skill " + revision);
        var bundle = new SnapshotBundle(Sha("skill " + revision), "fleet.bundle/v1", bytes.Length, bytes);
        await coordinator.AcceptSourceSnapshotAsync(new(revision, [bundle],
            [new SnapshotTarget(node.NodeId, "skills", new("home", ".agents/skills"), [new("review", bundle.Digest)])], [], clock.GetUtcNow()));
    }

    private FleetDbContext Database() => new(new DbContextOptionsBuilder<FleetDbContext>().UseNpgsql(postgres.GetConnectionString()).Options);
    private PostgresFleetCoordinator Coordinator(FleetDbContext db) => new(db, clock, settings);

    private async Task<NodeAuthentication> Enroll(IFleetCoordinator coordinator, string name)
    {
        var authorization = await coordinator.CreateEnrollmentAuthorizationAsync(
            new("operator", clock.GetUtcNow() + TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(2)));
        var node = new NodeId(Guid.NewGuid());
        var credential = new CredentialId(Guid.NewGuid());
        var certificate = Sha(Guid.NewGuid().ToString());
        await coordinator.CompleteEnrollmentAsync(new(authorization.Token, Sha("csr-" + name), name, "linux",
            new(node, credential, certificate, clock.GetUtcNow() - TimeSpan.FromMinutes(1), clock.GetUtcNow() + TimeSpan.FromDays(2),
                "public certificate"u8.ToArray())));
        return new(node, credential, certificate);
    }

    private static string Sha(string value) => Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private sealed class FixedClock(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
        public void Advance(TimeSpan duration) => now += duration;
    }
}
