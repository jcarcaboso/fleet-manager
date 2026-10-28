using System.Data;
using System.Security.Cryptography;
using System.Text;
using Fleet.Server.Persistence;
using Fleet.Server.Transport;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Fleet.Server.Security;

/// <summary>An account as the dashboard API returns it. The password hash and security stamp never leave the Server.</summary>
public sealed record OperatorAccountView(string Name, string Scope, bool MustChangePassword, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt)
{
    public static OperatorAccountView From(OperatorAccountRow row) => new(row.Name, row.Scope, row.MustChangePassword, row.CreatedAt, row.UpdatedAt);
}

/// <summary>The signed-in account that makes an account change, as its session names it: the ID and the security stamp.</summary>
public readonly record struct AccountActor(Guid Id, Guid Stamp);

/// <summary>PBKDF2-SHA256 password hashes in the form <c>pbkdf2-sha256$iterations$salt$hash</c> (salt and hash in base64).</summary>
public static class PasswordHashing
{
    private const string Algorithm = "pbkdf2-sha256";
    public const int Iterations = 600_000;
    private const int SaltBytes = 16;
    private const int KeyBytes = 32;

    // Verified against when the name is unknown, so a missing account costs as much time as a wrong password.
    private static readonly Lazy<string> Decoy = new(() => Hash(Convert.ToHexString(RandomNumberGenerator.GetBytes(16))));

    public static string Hash(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(SaltBytes);
        var key = Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(password), salt, Iterations, HashAlgorithmName.SHA256, KeyBytes);
        return $"{Algorithm}${Iterations}${Convert.ToBase64String(salt)}${Convert.ToBase64String(key)}";
    }

    public static bool Verify(string password, string encoded)
    {
        var parts = encoded.Split('$');
        if (parts.Length != 4 || parts[0] != Algorithm || !int.TryParse(parts[1], out var iterations) || iterations is < 1 or > 10_000_000)
            return false;
        byte[] salt, expected;
        try
        {
            salt = Convert.FromBase64String(parts[2]);
            expected = Convert.FromBase64String(parts[3]);
        }
        catch (FormatException) { return false; }
        var actual = Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(password), salt, iterations, HashAlgorithmName.SHA256, expected.Length);
        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }

    /// <summary>Spends the time of one verification without an account.</summary>
    public static void VerifyDecoy(string password) => Verify(password, Decoy.Value);
}

/// <summary>
/// Dashboard sign-in accounts of the Workspace. When there is none, the default <c>fleet</c> account (password <c>fleet</c>, admin) is
/// created and must change its password before it can do anything else. Every change that affects a signed-in account rotates its
/// security stamp, which ends that account's sessions.
/// </summary>
public sealed class OperatorAccountStore(FleetDbContext db, IOptions<FleetOptions> options, TimeProvider clock)
{
    public const string DefaultName = "fleet";
    public const string DefaultPassword = "fleet";
    public const int MinimumPasswordLength = 10;
    public const int MaximumPasswordLength = 256;
    public const int MaximumNameLength = 64;
    // Serializes account changes of the Workspace, so the last-admin check and default creation cannot race.
    private const long LockKey = 0x466C656574416363; // "FleetAcc"

    private Guid WorkspaceId => options.Value.WorkspaceId;

    public static string Normalize(string? name) => (name ?? "").Trim().ToLowerInvariant();

    // It starts with a letter or digit, so a name is never "." or "..", which URLs would read as a path segment.
    public static bool IsValidName(string name) => name.Length is > 0 and <= MaximumNameLength && char.IsAsciiLetterOrDigit(name[0]) &&
        name.All(c => c is >= 'a' and <= 'z' or >= '0' and <= '9' or '.' or '_' or '-');

    /// <summary>
    /// Returns the account when the name and password match, after creating the default account if there is none. Every attempt is
    /// audited: <c>account.signed_in</c>, or <c>account.sign_in_failed</c> with the name that was tried (<c>unknown</c> if it is not a
    /// valid name) and the account when it exists.
    /// </summary>
    public async Task<OperatorAccountRow?> AuthenticateAsync(string? name, string? password, CancellationToken ct)
    {
        await EnsureDefaultAsync(ct);
        password ??= "";
        var normalized = Normalize(name);
        var valid = IsValidName(normalized);
        var row = password.Length > MaximumPasswordLength || !valid ? null
            : await db.OperatorAccounts.AsNoTracking().SingleOrDefaultAsync(x => x.WorkspaceId == WorkspaceId && x.Name == normalized, ct);
        bool accepted;
        if (row is null)
        {
            PasswordHashing.VerifyDecoy(password);
            accepted = false;
        }
        else accepted = PasswordHashing.Verify(password, row.PasswordHash);
        db.AuditEvents.Add(Audit(accepted ? "account.signed_in" : "account.sign_in_failed", valid ? normalized : "unknown", row?.Name));
        await db.SaveChangesAsync(ct);
        return accepted ? row : null;
    }

    public Task<OperatorAccountRow?> FindAsync(Guid id, CancellationToken ct) =>
        db.OperatorAccounts.AsNoTracking().SingleOrDefaultAsync(x => x.Id == id && x.WorkspaceId == WorkspaceId, ct);

    public async Task<IReadOnlyList<OperatorAccountView>> ListAsync(CancellationToken ct)
    {
        await EnsureDefaultAsync(ct);
        var rows = await db.OperatorAccounts.AsNoTracking().Where(x => x.WorkspaceId == WorkspaceId).OrderBy(x => x.Name).ToListAsync(ct);
        return rows.Select(OperatorAccountView.From).ToList();
    }

    /// <summary>The signed-in account changes its own password. Clears the must-change flag and rotates the stamp.</summary>
    public Task<OperatorAccountRow> ChangeOwnPasswordAsync(Guid id, string? currentPassword, string? newPassword, CancellationToken ct) =>
        InLockAsync(async () =>
        {
            var row = await db.OperatorAccounts.SingleOrDefaultAsync(x => x.Id == id && x.WorkspaceId == WorkspaceId, ct)
                ?? throw new OperatorApiException(401, "unauthorized", "The session's account no longer exists. Sign in again.");
            if ((currentPassword ?? "").Length > MaximumPasswordLength || !PasswordHashing.Verify(currentPassword ?? "", row.PasswordHash))
                throw new OperatorApiException(400, "invalid_current_password", "The current password is not correct.");
            ValidatePassword(newPassword);
            if (newPassword == currentPassword)
                throw new OperatorApiException(400, "invalid_password", "The new password must be different from the current password.");
            row.PasswordHash = PasswordHashing.Hash(newPassword!);
            row.MustChangePassword = false;
            Touch(row);
            db.AuditEvents.Add(Audit("account.password_changed", row.Name, row.Name));
            return row;
        }, ct);

    public Task<OperatorAccountView> CreateAsync(AccountActor actor, string? name, string? password, string? scope, CancellationToken ct) =>
        InLockAsync(async () =>
        {
            var admin = await RequireAdminAsync(actor, ct);
            var normalized = Normalize(name);
            if (!IsValidName(normalized))
                throw new OperatorApiException(400, "invalid_account_name",
                    $"An account name has 1 to {MaximumNameLength} characters: letters, digits, '.', '_' or '-', starting with a letter or digit.");
            ValidatePassword(password);
            var granted = ParseScope(scope);
            if (await db.OperatorAccounts.AnyAsync(x => x.WorkspaceId == WorkspaceId && x.Name == normalized, ct))
                throw new OperatorApiException(409, "account_exists", "An account with that name already exists.");
            var now = clock.GetUtcNow();
            var row = new OperatorAccountRow
            {
                Id = Guid.NewGuid(),
                WorkspaceId = WorkspaceId,
                Name = normalized,
                PasswordHash = PasswordHashing.Hash(password!),
                Scope = granted.Name(),
                MustChangePassword = true,
                SecurityStamp = Guid.NewGuid(),
                CreatedAt = now,
                UpdatedAt = now
            };
            db.OperatorAccounts.Add(row);
            db.AuditEvents.Add(Audit("account.created", admin.Name, row.Name, row.Scope));
            return OperatorAccountView.From(row);
        }, ct);

    public Task<OperatorAccountView> SetScopeAsync(AccountActor actor, string name, string? scope, CancellationToken ct) =>
        InLockAsync(async () =>
        {
            var admin = await RequireAdminAsync(actor, ct);
            var granted = ParseScope(scope);
            var row = await RequireAsync(name, ct);
            if (row.Scope == granted.Name()) return OperatorAccountView.From(row);
            if (row.Scope == OperatorScope.Admin.Name() && await IsLastAdminAsync(row, ct))
                throw new OperatorApiException(409, "last_admin", "At least one account must keep the admin scope.");
            var previous = row.Scope;
            row.Scope = granted.Name();
            Touch(row);
            db.AuditEvents.Add(Audit("account.scope_changed", admin.Name, row.Name, $"{previous} -> {row.Scope}"));
            return OperatorAccountView.From(row);
        }, ct);

    /// <summary>An admin sets a new password for an account. The account must change it at its next sign-in.</summary>
    public Task<OperatorAccountView> ResetPasswordAsync(AccountActor actor, string name, string? password, CancellationToken ct) =>
        InLockAsync(async () =>
        {
            var admin = await RequireAdminAsync(actor, ct);
            ValidatePassword(password);
            var row = await RequireAsync(name, ct);
            row.PasswordHash = PasswordHashing.Hash(password!);
            row.MustChangePassword = true;
            Touch(row);
            db.AuditEvents.Add(Audit("account.password_reset", admin.Name, row.Name));
            return OperatorAccountView.From(row);
        }, ct);

    public Task<bool> DeleteAsync(AccountActor actor, string name, CancellationToken ct) =>
        InLockAsync(async () =>
        {
            var admin = await RequireAdminAsync(actor, ct);
            var row = await RequireAsync(name, ct);
            if (row.Id == admin.Id)
                throw new OperatorApiException(409, "cannot_delete_self", "You cannot delete the account you are signed in with.");
            if (row.Scope == OperatorScope.Admin.Name() && await IsLastAdminAsync(row, ct))
                throw new OperatorApiException(409, "last_admin", "At least one account must keep the admin scope.");
            db.OperatorAccounts.Remove(row);
            db.AuditEvents.Add(Audit("account.deleted", admin.Name, row.Name, row.Scope));
            return true;
        }, ct);

    public static void ValidatePassword(string? password)
    {
        if (password is null || password.Length is < MinimumPasswordLength or > MaximumPasswordLength)
            throw new OperatorApiException(400, "invalid_password",
                $"A password must have {MinimumPasswordLength} to {MaximumPasswordLength} characters.");
        if (string.IsNullOrWhiteSpace(password))
            throw new OperatorApiException(400, "invalid_password", "A password must not be only spaces.");
    }

    private static OperatorScope ParseScope(string? scope) => OperatorScopeNames.TryParse(scope, out var granted) ? granted
        : throw new OperatorApiException(400, "invalid_scope", "scope must be read, operate or admin.");

    /// <summary>
    /// The session was checked before the request waited for the lock, so it is checked again under the lock: a change that committed
    /// in between (the actor demoted, deleted or given a new password) must not let an already-running request act with the old rights.
    /// </summary>
    private async Task<OperatorAccountRow> RequireAdminAsync(AccountActor actor, CancellationToken ct)
    {
        var row = await db.OperatorAccounts.AsNoTracking().SingleOrDefaultAsync(x => x.Id == actor.Id && x.WorkspaceId == WorkspaceId, ct);
        if (row is null || row.SecurityStamp != actor.Stamp)
            throw new OperatorApiException(401, "unauthorized", "The session ended because the account changed. Sign in again.");
        if (row.Scope != OperatorScope.Admin.Name() || row.MustChangePassword)
            throw new OperatorApiException(403, OperatorApi.ScopeDeniedCode, "This action needs the admin scope.");
        return row;
    }

    private async Task<OperatorAccountRow> RequireAsync(string name, CancellationToken ct)
    {
        var normalized = Normalize(name);
        return await db.OperatorAccounts.SingleOrDefaultAsync(x => x.WorkspaceId == WorkspaceId && x.Name == normalized, ct)
            ?? throw new OperatorApiException(404, "account_not_found", "No account has that name.");
    }

    private async Task<bool> IsLastAdminAsync(OperatorAccountRow row, CancellationToken ct) =>
        !await db.OperatorAccounts.AnyAsync(x => x.WorkspaceId == WorkspaceId && x.Id != row.Id && x.Scope == "admin", ct);

    private void Touch(OperatorAccountRow row)
    {
        row.SecurityStamp = Guid.NewGuid();
        row.UpdatedAt = clock.GetUtcNow();
    }

    private AuditEventRow Audit(string action, string actor, string? account, string? detail = null) => new()
    {
        Id = Guid.NewGuid(),
        WorkspaceId = WorkspaceId,
        RecordedAt = clock.GetUtcNow(),
        Action = action,
        Actor = actor,
        Account = account,
        Detail = detail
    };

    private async Task EnsureDefaultAsync(CancellationToken ct)
    {
        if (await db.OperatorAccounts.AnyAsync(x => x.WorkspaceId == WorkspaceId, ct)) return;
        await InLockAsync(async () =>
        {
            await EnsureWorkspaceAsync(ct);
            if (await db.OperatorAccounts.AnyAsync(x => x.WorkspaceId == WorkspaceId, ct)) return false;
            var now = clock.GetUtcNow();
            db.OperatorAccounts.Add(new OperatorAccountRow
            {
                Id = Guid.NewGuid(),
                WorkspaceId = WorkspaceId,
                Name = DefaultName,
                PasswordHash = PasswordHashing.Hash(DefaultPassword),
                Scope = OperatorScope.Admin.Name(),
                MustChangePassword = true,
                SecurityStamp = Guid.NewGuid(),
                CreatedAt = now,
                UpdatedAt = now
            });
            return true;
        }, ct);
    }

    // The same idempotent insert as the coordinator: the Workspace row may not exist yet on a fresh database.
    private async Task EnsureWorkspaceAsync(CancellationToken ct)
    {
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"INSERT INTO workspaces (\"Id\", \"SingletonKey\", \"Name\") VALUES ({WorkspaceId}, 1, {"default"}) ON CONFLICT (\"SingletonKey\") DO NOTHING", ct);
        if (await db.Workspaces.AsNoTracking().Select(x => x.Id).SingleAsync(ct) != WorkspaceId)
            throw new OperatorApiException(500, "workspace_mismatch", "The database belongs to a different Workspace.");
    }

    private async Task<T> InLockAsync<T>(Func<Task<T>> action, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await db.Database.ExecuteSqlInterpolatedAsync($"SELECT pg_advisory_xact_lock({LockKey})", ct);
        var result = await action();
        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
        return result;
    }
}
