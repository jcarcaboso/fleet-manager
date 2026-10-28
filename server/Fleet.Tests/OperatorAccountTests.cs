using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Fleet.Server.Persistence;
using Fleet.Server.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Fleet.Tests;

/// <summary>Password hashing and account names, without a database.</summary>
public sealed class OperatorAccountRulesTests
{
    [Fact]
    public void Password_hashes_are_salted_PBKDF2_and_verify_only_the_same_password()
    {
        var first = PasswordHashing.Hash("correct horse battery");
        var second = PasswordHashing.Hash("correct horse battery");
        Assert.StartsWith($"pbkdf2-sha256${PasswordHashing.Iterations}$", first);
        Assert.NotEqual(first, second);
        Assert.True(PasswordHashing.Verify("correct horse battery", first));
        Assert.False(PasswordHashing.Verify("correct horse batterY", first));
        Assert.False(PasswordHashing.Verify("correct horse battery", first.Replace("pbkdf2-sha256", "md5")));
        Assert.False(PasswordHashing.Verify("correct horse battery", "pbkdf2-sha256$600000$not base64$x"));
        Assert.False(PasswordHashing.Verify("correct horse battery", ""));
    }

    [Theory]
    [InlineData("fleet", true)]
    [InlineData("alice.smith-2_x", true)]
    [InlineData("", false)]
    [InlineData("has space", false)]
    [InlineData("ünicode", false)]
    [InlineData("slash/name", false)]
    [InlineData(".", false)]
    [InlineData("..", false)]
    [InlineData(".hidden", false)]
    [InlineData("-dash", false)]
    [InlineData("2nd.admin", true)]
    public void Account_names_are_short_lowercase_identifiers(string name, bool valid) =>
        Assert.Equal(valid, OperatorAccountStore.IsValidName(name));

    [Fact]
    public void Account_names_are_normalized_to_lowercase_and_limited_to_64_characters()
    {
        Assert.Equal("alice", OperatorAccountStore.Normalize("  Alice "));
        Assert.True(OperatorAccountStore.IsValidName(new string('a', 64)));
        Assert.False(OperatorAccountStore.IsValidName(new string('a', 65)));
    }

    [Fact]
    public void The_model_snapshot_includes_operator_accounts()
    {
        using var db = new FleetDbContextFactory().CreateDbContext([]);
        Assert.False(db.Database.HasPendingModelChanges());
        Assert.Contains(db.Database.GetMigrations(), x => x.EndsWith("_AddOperatorAccounts", StringComparison.Ordinal));
    }
}

/// <summary>A fresh database has no accounts: the first sign-in creates fleet/fleet, which must change its password first.</summary>
public sealed class DefaultOperatorAccountTests(OperatorApiFixture fixture) : IClassFixture<OperatorApiFixture>
{
    [Fact]
    public async Task The_default_fleet_account_must_change_its_password_before_anything_else()
    {
        using (var scope = fixture.Scope())
            await scope.ServiceProvider.GetRequiredService<FleetDbContext>().OperatorAccounts.ExecuteDeleteAsync();

        using var browser = await AccountClient.SignInAsync(fixture, "fleet", "fleet");
        var session = await OperatorApiFixture.ReadAsync(await browser.GetAsync("/dashboard/api/session"));
        Assert.Equal("fleet", session["actor"]!.GetValue<string>());
        Assert.Equal("admin", session["scope"]!.GetValue<string>());
        Assert.True(session["mustChangePassword"]!.GetValue<bool>());

        foreach (var blocked in new[] { "/dashboard/api/nodes", "/dashboard/api/accounts", "/dashboard/api/issues" })
        {
            var body = await OperatorApiFixture.ReadAsync(await browser.GetAsync(blocked), HttpStatusCode.Forbidden);
            Assert.Equal("password_change_required", body["code"]!.GetValue<string>());
            Assert.False(string.IsNullOrWhiteSpace(body["message"]!.GetValue<string>()));
        }

        var wrong = await OperatorApiFixture.ReadAsync(await browser.PostAsJsonAsync("/dashboard/api/account/password",
            new { currentPassword = "not-fleet", newPassword = "a-new-long-password" }), HttpStatusCode.BadRequest);
        Assert.Equal("invalid_current_password", wrong["code"]!.GetValue<string>());
        var weak = await OperatorApiFixture.ReadAsync(await browser.PostAsJsonAsync("/dashboard/api/account/password",
            new { currentPassword = "fleet", newPassword = "short" }), HttpStatusCode.BadRequest);
        Assert.Equal("invalid_password", weak["code"]!.GetValue<string>());

        var changed = await OperatorApiFixture.ReadAsync(await browser.PostAsJsonAsync("/dashboard/api/account/password",
            new { currentPassword = "fleet", newPassword = "a-new-long-password" }));
        Assert.False(changed["mustChangePassword"]!.GetValue<bool>());
        Assert.Equal(HttpStatusCode.OK, (await browser.GetAsync("/dashboard/api/nodes")).StatusCode);
        var accounts = await OperatorApiFixture.ReadAsync(await browser.GetAsync("/dashboard/api/accounts"));
        var only = Assert.Single(accounts["items"]!.AsArray())!;
        Assert.Equal("fleet", only["name"]!.GetValue<string>());
        Assert.False(only["mustChangePassword"]!.GetValue<bool>());
        Assert.Null(only["passwordHash"]);

        await AccountClient.SignInAsync(fixture, "fleet", "fleet", HttpStatusCode.Unauthorized);
        using var again = await AccountClient.SignInAsync(fixture, "FLEET", "a-new-long-password");
        Assert.False((await OperatorApiFixture.ReadAsync(await again.GetAsync("/dashboard/api/session")))["mustChangePassword"]!.GetValue<bool>());

        // The default account is created only while there is no account at all.
        Assert.Equal(1, await CountAsync());
    }

    private async Task<int> CountAsync()
    {
        using var scope = fixture.Scope();
        return await scope.ServiceProvider.GetRequiredService<FleetDbContext>().OperatorAccounts.CountAsync();
    }
}

/// <summary>Admins add and change accounts. Every change to an account ends that account's sessions.</summary>
public sealed class OperatorAccountTests(OperatorApiFixture fixture) : IClassFixture<OperatorApiFixture>
{
    private const string AlicePassword = "alice-first-password";

    [Fact]
    public async Task Admins_create_accounts_that_must_change_their_password_and_keep_their_scope()
    {
        using var admin = await AccountClient.SignInAsync(fixture, "operator", OperatorApiFixture.AccountPassword);
        var created = await OperatorApiFixture.ReadAsync(await admin.PostAsJsonAsync("/dashboard/api/accounts",
            new { name = "Alice", password = AlicePassword, scope = "read" }), HttpStatusCode.Created);
        Assert.Equal("alice", created["name"]!.GetValue<string>());
        Assert.Equal("read", created["scope"]!.GetValue<string>());
        Assert.True(created["mustChangePassword"]!.GetValue<bool>());

        foreach (var (body, status, code) in new (object, HttpStatusCode, string)[]
        {
            (new { name = "alice", password = AlicePassword, scope = "read" }, HttpStatusCode.Conflict, "account_exists"),
            (new { name = "not valid", password = AlicePassword, scope = "read" }, HttpStatusCode.BadRequest, "invalid_account_name"),
            (new { name = "bob", password = "short", scope = "read" }, HttpStatusCode.BadRequest, "invalid_password"),
            (new { name = "bob", password = AlicePassword, scope = "owner" }, HttpStatusCode.BadRequest, "invalid_scope")
        })
        {
            var rejected = await OperatorApiFixture.ReadAsync(await admin.PostAsJsonAsync("/dashboard/api/accounts", body), status);
            Assert.Equal(code, rejected["code"]!.GetValue<string>());
            Assert.NotNull(Fleet.Server.Transport.ErrorCatalog.Find(code));
        }

        var names = (await OperatorApiFixture.ReadAsync(await admin.GetAsync("/dashboard/api/accounts")))["items"]!.AsArray()
            .Select(x => x!["name"]!.GetValue<string>()).ToArray();
        Assert.Equal(names.Order(StringComparer.Ordinal), names);
        Assert.Contains("alice", names);

        using var alice = await AccountClient.SignInAsync(fixture, "alice", AlicePassword);
        Assert.Equal(HttpStatusCode.Forbidden, (await alice.GetAsync("/dashboard/api/nodes")).StatusCode);
        await ChangePasswordAsync(alice, AlicePassword, "alice-second-password");
        Assert.Equal(HttpStatusCode.OK, (await alice.GetAsync("/dashboard/api/nodes")).StatusCode);
        var denied = await OperatorApiFixture.ReadAsync(await alice.GetAsync("/dashboard/api/accounts"), HttpStatusCode.Forbidden);
        Assert.Equal("insufficient_scope", denied["code"]!.GetValue<string>());
        Assert.Equal(HttpStatusCode.Forbidden, (await alice.PostAsJsonAsync("/dashboard/api/accounts",
            new { name = "mallory", password = AlicePassword, scope = "admin" })).StatusCode);

        foreach (var token in new[] { OperatorApiFixture.OperateToken, OperatorApiFixture.ReadToken })
        {
            using var lower = await fixture.BrowserAsync(token);
            Assert.Equal(HttpStatusCode.Forbidden, (await lower.GetAsync("/dashboard/api/accounts")).StatusCode);
        }

        var audit = await fixture.Admin.GetStringAsync("/operator/v1/audit?limit=100&order=newest");
        Assert.DoesNotContain(AlicePassword, audit);
        Assert.DoesNotContain("alice-second-password", audit);
        var events = JsonNode.Parse(audit)!["items"]!.AsArray();
        JsonNode Event(string action, string actor) =>
            events.First(x => x!["action"]!.GetValue<string>() == action && x["actor"]!.GetValue<string>() == actor)!;
        var added = Event("account.created", "operator");
        Assert.Equal("alice", added["account"]!.GetValue<string>());
        Assert.Equal("read", added["detail"]!.GetValue<string>());
        Assert.Equal("alice", Event("account.password_changed", "alice")["account"]!.GetValue<string>());
        Assert.Equal("alice", Event("account.signed_in", "alice")["account"]!.GetValue<string>());
    }

    [Fact]
    public async Task Sign_in_attempts_are_audited_without_the_password()
    {
        await AccountClient.SignInAsync(fixture, "operator", "a-wrong-password-1", HttpStatusCode.Unauthorized);
        await AccountClient.SignInAsync(fixture, "nobody-here", "a-wrong-password-2", HttpStatusCode.Unauthorized);
        await AccountClient.SignInAsync(fixture, "../etc", "a-wrong-password-3", HttpStatusCode.Unauthorized);
        var audit = await fixture.Admin.GetStringAsync("/operator/v1/audit?limit=100&order=newest");
        Assert.DoesNotContain("a-wrong-password", audit);
        var failed = JsonNode.Parse(audit)!["items"]!.AsArray().Where(x => x!["action"]!.GetValue<string>() == "account.sign_in_failed")
            .Select(x => (x!["actor"]!.GetValue<string>(), x["account"]?.GetValue<string>())).ToArray();
        Assert.Contains(("operator", "operator"), failed);
        Assert.Contains(("nobody-here", null), failed);
        Assert.Contains(("unknown", null), failed);
    }

    [Fact]
    public async Task An_account_change_rechecks_the_admin_under_the_lock()
    {
        // A request that passed the session check and then waited for the lock while its account was demoted or changed.
        await OperatorApiFixture.SeedAccountAsync(fixture.Factory.Services, "racing-admin", "admin");
        using var scope = fixture.Scope();
        var store = scope.ServiceProvider.GetRequiredService<OperatorAccountStore>();
        var db = scope.ServiceProvider.GetRequiredService<FleetDbContext>();
        var racer = await db.OperatorAccounts.AsNoTracking().SingleAsync(x => x.Name == "racing-admin");
        var signedIn = new AccountActor(racer.Id, racer.SecurityStamp);

        await db.OperatorAccounts.Where(x => x.Id == racer.Id)
            .ExecuteUpdateAsync(x => x.SetProperty(a => a.Scope, "read").SetProperty(a => a.SecurityStamp, Guid.NewGuid()));
        var stale = await Assert.ThrowsAsync<Fleet.Server.Transport.OperatorApiException>(() =>
            store.SetScopeAsync(signedIn, "racing-admin", "admin", CancellationToken.None));
        Assert.Equal(401, stale.Status);

        var demoted = await db.OperatorAccounts.AsNoTracking().SingleAsync(x => x.Id == racer.Id);
        var denied = await Assert.ThrowsAsync<Fleet.Server.Transport.OperatorApiException>(() =>
            store.SetScopeAsync(new AccountActor(demoted.Id, demoted.SecurityStamp), "racing-admin", "admin", CancellationToken.None));
        Assert.Equal(403, denied.Status);
        Assert.Equal("read", (await db.OperatorAccounts.AsNoTracking().SingleAsync(x => x.Id == racer.Id)).Scope);
    }

    [Fact]
    public async Task Scope_changes_password_resets_and_password_changes_end_existing_sessions()
    {
        using var admin = await AccountClient.SignInAsync(fixture, "operator", OperatorApiFixture.AccountPassword);
        await OperatorApiFixture.ReadAsync(await admin.PostAsJsonAsync("/dashboard/api/accounts",
            new { name = "carol", password = "carol-first-password", scope = "read" }), HttpStatusCode.Created);
        using (var first = await AccountClient.SignInAsync(fixture, "carol", "carol-first-password"))
            await ChangePasswordAsync(first, "carol-first-password", "carol-own-password");

        using var carol = await AccountClient.SignInAsync(fixture, "carol", "carol-own-password");
        var promoted = await OperatorApiFixture.ReadAsync(await admin.PostAsJsonAsync("/dashboard/api/accounts/carol/scope", new { scope = "operate" }));
        Assert.Equal("operate", promoted["scope"]!.GetValue<string>());
        var scoped = JsonNode.Parse(await fixture.Admin.GetStringAsync("/operator/v1/audit?limit=100&order=newest"))!["items"]!.AsArray()
            .First(x => x!["action"]!.GetValue<string>() == "account.scope_changed" && x["account"]?.GetValue<string>() == "carol")!;
        Assert.Equal("read -> operate", scoped["detail"]!.GetValue<string>());
        Assert.Equal(HttpStatusCode.Unauthorized, (await carol.GetAsync("/dashboard/api/session")).StatusCode);

        using var promotedCarol = await AccountClient.SignInAsync(fixture, "carol", "carol-own-password");
        Assert.Equal("operate", (await OperatorApiFixture.ReadAsync(await promotedCarol.GetAsync("/dashboard/api/session")))["scope"]!.GetValue<string>());
        var reset = await OperatorApiFixture.ReadAsync(await admin.PostAsJsonAsync("/dashboard/api/accounts/carol/password", new { password = "carol-reset-password" }));
        Assert.True(reset["mustChangePassword"]!.GetValue<bool>());
        Assert.Equal(HttpStatusCode.Unauthorized, (await promotedCarol.GetAsync("/dashboard/api/session")).StatusCode);
        await AccountClient.SignInAsync(fixture, "carol", "carol-own-password", HttpStatusCode.Unauthorized);

        // A user's own change keeps the session that made it and ends the others.
        using var one = await AccountClient.SignInAsync(fixture, "carol", "carol-reset-password");
        using var two = await AccountClient.SignInAsync(fixture, "carol", "carol-reset-password");
        await ChangePasswordAsync(one, "carol-reset-password", "carol-final-password");
        Assert.Equal(HttpStatusCode.OK, (await one.GetAsync("/dashboard/api/nodes")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await two.GetAsync("/dashboard/api/session")).StatusCode);
        var same = await OperatorApiFixture.ReadAsync(await one.PostAsJsonAsync("/dashboard/api/account/password",
            new { currentPassword = "carol-final-password", newPassword = "carol-final-password" }), HttpStatusCode.BadRequest);
        Assert.Equal("invalid_password", same["code"]!.GetValue<string>());

        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync("/dashboard/api/accounts/carol/delete", new { })).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await one.GetAsync("/dashboard/api/session")).StatusCode);
        var missing = await OperatorApiFixture.ReadAsync(await admin.PostAsJsonAsync("/dashboard/api/accounts/carol/delete", new { }), HttpStatusCode.NotFound);
        Assert.Equal("account_not_found", missing["code"]!.GetValue<string>());
    }

    [Fact]
    public async Task The_last_admin_cannot_be_demoted_or_deleted_and_nobody_deletes_themselves()
    {
        using var admin = await AccountClient.SignInAsync(fixture, "operator", OperatorApiFixture.AccountPassword);
        var self = await OperatorApiFixture.ReadAsync(await admin.PostAsJsonAsync("/dashboard/api/accounts/operator/delete", new { }), HttpStatusCode.Conflict);
        Assert.Equal("cannot_delete_self", self["code"]!.GetValue<string>());
        var last = await OperatorApiFixture.ReadAsync(await admin.PostAsJsonAsync("/dashboard/api/accounts/operator/scope", new { scope = "read" }), HttpStatusCode.Conflict);
        Assert.Equal("last_admin", last["code"]!.GetValue<string>());

        await OperatorApiFixture.SeedAccountAsync(fixture.Factory.Services, "second-admin", "admin");
        using var second = await AccountClient.SignInAsync(fixture, "second-admin", OperatorApiFixture.AccountPassword);
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync("/dashboard/api/accounts/second-admin/scope", new { scope = "operate" })).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await second.GetAsync("/dashboard/api/session")).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await admin.PostAsJsonAsync("/dashboard/api/accounts/operator/scope", new { scope = "operate" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await admin.PostAsJsonAsync("/dashboard/api/accounts/second-admin/delete", new { })).StatusCode);
    }

    private static async Task ChangePasswordAsync(HttpClient browser, string current, string next)
    {
        var changed = await OperatorApiFixture.ReadAsync(await browser.PostAsJsonAsync("/dashboard/api/account/password",
            new { currentPassword = current, newPassword = next }));
        Assert.False(changed["mustChangePassword"]!.GetValue<bool>());
    }
}

internal static class AccountClient
{
    /// <summary>A browser-like client from the dashboard origin, signed in with a name and password, with a fresh CSRF token.</summary>
    public static async Task<HttpClient> SignInAsync(OperatorApiFixture fixture, string name, string password,
        HttpStatusCode expected = HttpStatusCode.OK)
    {
        var browser = fixture.NewClient(cookies: true);
        browser.DefaultRequestHeaders.Add("Origin", OperatorApiFixture.DashboardOrigin);
        await OperatorApiFixture.RefreshCsrfAsync(browser);
        var login = await browser.PostAsJsonAsync("/dashboard/api/login", new { name, password });
        var body = await OperatorApiFixture.ReadAsync(login, expected);
        if (expected == HttpStatusCode.OK)
            Assert.Equal(OperatorAccountStore.Normalize(name), body["actor"]!.GetValue<string>());
        else
            Assert.Equal("unauthorized", body["code"]!.GetValue<string>());
        await OperatorApiFixture.RefreshCsrfAsync(browser);
        return browser;
    }
}
