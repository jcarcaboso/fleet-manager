using System.Security.Cryptography;
using Fleet.Core.Coordination;
using Fleet.Server.Persistence;
using Microsoft.EntityFrameworkCore;
using Testcontainers.PostgreSql;

namespace Fleet.Tests;

public sealed class EnrollmentLinkPersistenceTests : IAsyncLifetime
{
    private readonly PostgreSqlContainer postgres = new PostgreSqlBuilder("postgres:17.5-alpine").Build();
    private readonly FixedTimeProvider clock = new(new DateTimeOffset(2026, 9, 8, 12, 0, 0, TimeSpan.Zero));
    private readonly FleetCoordinationOptions settings = new()
    {
        WorkspaceId = new(Guid.NewGuid()),
        WorkspaceName = "enrollment-link-tests"
    };

    public async Task InitializeAsync()
    {
        await postgres.StartAsync();
        await using var db = Database();
        await db.Database.MigrateAsync();
    }

    public async Task DisposeAsync() => await postgres.DisposeAsync();

    [Fact]
    public async Task Bound_alias_must_match_before_consumption()
    {
        await using var db = Database();
        var coordinator = Coordinator(db);
        var authorization = await Authorization(coordinator, "expected");

        var error = await Assert.ThrowsAsync<CoordinationException>(() => coordinator.CompleteEnrollmentAsync(
            Completion(authorization.Token, "wrong", "wrong-alias")));

        Assert.Equal("invalid_enrollment", error.Code);
        Assert.Null((await db.Enrollments.SingleAsync()).ConsumedAt);
    }

    [Fact]
    public async Task Expired_bound_authorization_is_rejected()
    {
        await using var db = Database();
        var coordinator = Coordinator(db);
        var authorization = await Authorization(coordinator, "expired");
        clock.Advance(TimeSpan.FromMinutes(6));

        var error = await Assert.ThrowsAsync<CoordinationException>(() => coordinator.CompleteEnrollmentAsync(
            Completion(authorization.Token, "expired", "expired")));

        Assert.Equal("invalid_enrollment", error.Code);
    }

    [Fact]
    public async Task Revocation_rejects_first_use_and_exact_retry()
    {
        await using var db = Database();
        var coordinator = Coordinator(db);
        var unused = await Authorization(coordinator, "unused");
        await coordinator.RevokeEnrollmentAuthorizationAsync(unused.Id, "operator");
        await AssertInvalid(coordinator.CompleteEnrollmentAsync(Completion(unused.Token, "unused", "unused")));

        var consumed = await Authorization(coordinator, "consumed");
        var command = Completion(consumed.Token, "consumed", "same-csr");
        await coordinator.CompleteEnrollmentAsync(command);
        await coordinator.RevokeEnrollmentAuthorizationAsync(consumed.Id, "operator");
        await AssertInvalid(coordinator.CompleteEnrollmentAsync(command));

        var rows = await db.Enrollments.OrderBy(x => x.BoundAlias).ToListAsync();
        Assert.All(rows, row => Assert.NotNull(row.RevokedAt));
        Assert.All(rows, row => Assert.Equal("operator", row.RevokedBy));
    }

    [Fact]
    public async Task Exact_csr_retry_for_bound_alias_returns_original_delivery()
    {
        await using var db = Database();
        var coordinator = Coordinator(db);
        var authorization = await Authorization(coordinator, "retry");
        var command = Completion(authorization.Token, "retry", "same-csr");
        var first = await coordinator.CompleteEnrollmentAsync(command);

        var retry = await coordinator.CompleteEnrollmentAsync(command with
        {
            IssuedCredential = command.IssuedCredential with { DeliveryPayload = "replacement"u8.ToArray() }
        });

        Assert.Equal(EnrollmentOutcome.Enrolled, first.Outcome);
        Assert.Equal(EnrollmentOutcome.Retry, retry.Outcome);
        Assert.Equal(first.DeliveryPayload, retry.DeliveryPayload);
    }

    [Fact]
    public async Task Alias_race_allows_only_one_bound_authorization_to_enroll()
    {
        EnrollmentAuthorization firstAuthorization;
        EnrollmentAuthorization secondAuthorization;
        await using (var setup = Database())
        {
            var coordinator = Coordinator(setup);
            firstAuthorization = await Authorization(coordinator, "racing-alias");
            secondAuthorization = await Authorization(coordinator, "racing-alias");
        }
        await using var firstDb = Database();
        await using var secondDb = Database();

        var results = await Task.WhenAll(
            Capture(Coordinator(firstDb).CompleteEnrollmentAsync(Completion(firstAuthorization.Token, "racing-alias", "first"))),
            Capture(Coordinator(secondDb).CompleteEnrollmentAsync(Completion(secondAuthorization.Token, "racing-alias", "second"))));

        Assert.Single(results, result => result.Result?.Outcome == EnrollmentOutcome.Enrolled);
        Assert.Single(results, result => result.Error?.Code == "node_alias_in_use");
        await using var verify = Database();
        Assert.Equal(1, await verify.Nodes.CountAsync(x => x.Name == "racing-alias"));
    }

    private Task<EnrollmentAuthorization> Authorization(IFleetCoordinator coordinator, string alias) =>
        coordinator.CreateEnrollmentAuthorizationAsync(new(
            "operator", clock.GetUtcNow() + TimeSpan.FromMinutes(5), TimeSpan.FromMinutes(2), alias));

    private CompleteEnrollment Completion(string token, string alias, string seed) => new(
        token,
        Sha("csr-" + seed),
        alias,
        "linux",
        new(new(Guid.NewGuid()), new(Guid.NewGuid()), Sha("certificate-" + seed),
            clock.GetUtcNow() - TimeSpan.FromMinutes(1), clock.GetUtcNow() + TimeSpan.FromHours(1),
            System.Text.Encoding.UTF8.GetBytes("delivery-" + seed)));

    private static async Task AssertInvalid(Task<EnrollmentResult> task)
    {
        var error = await Assert.ThrowsAsync<CoordinationException>(() => task);
        Assert.Equal("invalid_enrollment", error.Code);
    }

    private static async Task<(EnrollmentResult? Result, CoordinationException? Error)> Capture(Task<EnrollmentResult> task)
    {
        try { return (await task, null); }
        catch (CoordinationException error) { return (null, error); }
    }

    private FleetDbContext Database() => new(new DbContextOptionsBuilder<FleetDbContext>()
        .UseNpgsql(postgres.GetConnectionString()).Options);

    private IFleetCoordinator Coordinator(FleetDbContext database) => new PostgresFleetCoordinator(database, clock, settings);

    private static string Sha(string value) => Convert.ToHexString(
        SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
        public void Advance(TimeSpan duration) => now += duration;
    }
}
