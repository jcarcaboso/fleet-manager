using System.Security.Claims;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using Fleet.Core.Coordination;
using Fleet.Server.Persistence;
using Fleet.Server.Security;
using Fleet.Server.Transport;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Options;

namespace Fleet.Server.Dashboard;

public static class DashboardEndpoints
{
    public const string Scheme = "Dashboard";
    private const string AccountIdClaim = "fleet:account-id";
    private const string StampClaim = "fleet:account-stamp";
    private const string MustChangeClaim = "fleet:must-change-password";

    public static void AddFleetDashboard(this IServiceCollection services)
    {
        // Sessions deliberately expire on restart, without writing keys into the read-only container.
        services.AddDataProtection().UseEphemeralDataProtectionProvider();
        services.AddAntiforgery(options =>
        {
            options.HeaderName = "X-Fleet-CSRF";
            options.Cookie.Name = "__Host-Fleet-CSRF";
            options.Cookie.SecurePolicy = CookieSecurePolicy.Always;
            options.Cookie.HttpOnly = true;
            options.Cookie.SameSite = SameSiteMode.Strict;
        });
        services.AddAuthentication().AddCookie(Scheme, options =>
        {
            options.Cookie.Name = "__Host-Fleet-Session";
            options.Cookie.SecurePolicy = CookieSecurePolicy.Always;
            options.Cookie.HttpOnly = true;
            options.Cookie.SameSite = SameSiteMode.Strict;
            options.ExpireTimeSpan = TimeSpan.FromMinutes(30);
            options.SlidingExpiration = false;
            options.Events.OnRedirectToLogin = context =>
            {
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                return FleetAuthenticationHandler.WriteUnauthorizedAsync(context.Response);
            };
            options.Events.OnRedirectToAccessDenied = context =>
            {
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
                return Task.CompletedTask;
            };
            // A session lasts only while its account exists with the same security stamp. Password, scope and deletion changes rotate it.
            options.Events.OnValidatePrincipal = async context =>
            {
                var principal = context.Principal;
                if (!Guid.TryParse(principal?.FindFirstValue(AccountIdClaim), out var id) ||
                    !Guid.TryParse(principal?.FindFirstValue(StampClaim), out var stamp))
                {
                    context.RejectPrincipal();
                    return;
                }
                var accounts = context.HttpContext.RequestServices.GetRequiredService<OperatorAccountStore>();
                var account = await accounts.FindAsync(id, context.HttpContext.RequestAborted);
                if (account is null || account.SecurityStamp != stamp || account.Name != principal!.FindFirstValue(ClaimTypes.NameIdentifier) ||
                    account.Scope != principal.FindFirstValue(OperatorScopeNames.ClaimType) ||
                    account.MustChangePassword != (principal.FindFirstValue(MustChangeClaim) == "true"))
                    context.RejectPrincipal();
            };
        });
        services.AddAuthorizationBuilder().AddPolicy(Scheme,
            policy => policy.AddAuthenticationSchemes(Scheme).RequireAuthenticatedUser());
    }

    private static readonly PathString ApiPath = new("/dashboard/api");
    private const string PageSecurityPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
    private const string ApiSecurityPolicy = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

    /// <summary>
    /// Security headers and CORS for <c>/dashboard/api</c>, as middleware so that they also cover the responses that never reach an
    /// endpoint filter: 401 from authentication, 429 from the rate limiter, 404 and 405 from routing, and preflights. It must run
    /// before the rate limiter, authentication and authorization. The dashboard is a separate origin, so the browser can read these
    /// responses only when they carry the CORS headers. Only <c>Fleet:DashboardOrigin</c> is allowed: no wildcard, no reflection.
    /// </summary>
    public static void UseDashboardApiHeaders(this WebApplication app)
    {
        var allowed = app.Services.GetRequiredService<DashboardSettings>();
        if (!allowed.ApiEnabled) return;
        app.Use(async (context, next) =>
        {
            if (!context.Request.Path.StartsWithSegments(ApiPath)) { await next(context); return; }
            var response = context.Response;
            response.Headers.Append("Vary", "Origin");
            response.Headers.ContentSecurityPolicy = ApiSecurityPolicy;
            response.Headers["Referrer-Policy"] = "no-referrer";
            response.Headers["X-Content-Type-Options"] = "nosniff";
            response.Headers.CacheControl = "no-store";
            var origin = context.Request.Headers.Origin;
            var matches = origin.Count == 1 && allowed.IsDashboardOrigin(origin[0]);
            if (matches)
            {
                response.Headers["Access-Control-Allow-Origin"] = allowed.Origin;
                response.Headers["Access-Control-Allow-Credentials"] = "true";
            }
            // A preflight is an OPTIONS request that carries Origin. It needs no session and no CSRF token.
            if (HttpMethods.IsOptions(context.Request.Method) && origin.Count > 0)
            {
                if (!matches)
                {
                    response.StatusCode = StatusCodes.Status403Forbidden;
                    await response.WriteAsJsonAsync(new { code = "invalid_origin", message = "The Origin header must be the configured dashboard origin." });
                    return;
                }
                response.StatusCode = StatusCodes.Status204NoContent;
                response.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
                response.Headers["Access-Control-Allow-Headers"] = "Content-Type, X-Fleet-CSRF";
                response.Headers["Access-Control-Max-Age"] = "600";
                return;
            }
            await next(context);
        });
    }

    /// <summary>
    /// The dashboard is a separate application. <c>GET /</c> and <c>GET /dashboard/...</c> (except <c>/dashboard/api</c>) only send an old
    /// bookmark there, or say that none is configured. This is middleware rather than a catch-all route on purpose: a route would take
    /// part in endpoint selection and turn, for example, a POST to <c>/dashboard/api/login</c> with a wrong content type from 415 into 404.
    /// </summary>
    public static void UseDashboardRedirect(this WebApplication app)
    {
        var dashboard = app.Services.GetRequiredService<DashboardSettings>();
        app.Use(async (context, next) =>
        {
            var path = context.Request.Path;
            var moved = path == "/" || (path.StartsWithSegments("/dashboard") && !path.StartsWithSegments(ApiPath));
            if (!moved || !(HttpMethods.IsGet(context.Request.Method) || HttpMethods.IsHead(context.Request.Method))) { await next(context); return; }
            if (dashboard.Origin is { } target) context.Response.Redirect(target);
            else
            {
                context.Response.StatusCode = StatusCodes.Status404NotFound;
                await context.Response.WriteAsJsonAsync(new
                {
                    code = "dashboard_not_configured",
                    message = "The dashboard is not configured. Set Fleet:DashboardOrigin to the address of the Fleet dashboard."
                });
            }
        });
    }

    public static void MapFleetDashboard(this WebApplication app)
    {
        var settings = app.Services.GetRequiredService<IOptions<FleetOptions>>().Value;
        var dashboard = app.Services.GetRequiredService<DashboardSettings>();

        if (string.IsNullOrEmpty(settings.PublicUrl)) return;
        var publicOrigin = app.Services.GetRequiredService<EnrollmentLinkSettings>().Origin!;

        // The Server's own pages and the dashboard API must be reached at the Server's public origin: the session cookie is
        // __Host- bound to that host, and enrollment links name it. The dashboard page itself lives elsewhere, so this is a
        // check of the Server's host, not of the caller.
        var pages = app.MapGroup("").AddEndpointFilter(async (context, next) =>
        {
            var http = context.HttpContext;
            if (!http.Request.IsHttps || !string.Equals($"https://{http.Request.Host}", publicOrigin, StringComparison.OrdinalIgnoreCase))
                return Results.BadRequest(new { code = "dashboard_origin_required", message = "Reach the Server at its public HTTPS origin." });
            if (!http.Request.Path.StartsWithSegments(ApiPath))
            {
                http.Response.Headers["Content-Security-Policy"] = PageSecurityPolicy;
                http.Response.Headers["Referrer-Policy"] = "no-referrer";
                http.Response.Headers["X-Content-Type-Options"] = "nosniff";
                http.Response.Headers.CacheControl = "no-store";
            }
            return await next(context);
        });
        pages.MapGet("/enroll", () => Asset("enroll.html"));
        pages.MapGet("/enroll/enroll.js", () => Asset("enroll.js"));
        pages.MapGet("/enroll/enroll.css", () => Asset("enroll.css"));
        if (!dashboard.ApiEnabled) return;
        var origin = dashboard.Origin!;

        var api = pages.MapGroup("/dashboard/api").WithMetadata(ErrorMessages.Instance).AddEndpointFilter(async (context, next) =>
        {
            var http = context.HttpContext;
            if (!HttpMethods.IsGet(http.Request.Method))
            {
                if (!string.Equals(http.Request.Headers.Origin, origin, StringComparison.OrdinalIgnoreCase))
                    return Results.BadRequest(new { code = "invalid_origin", message = "The Origin header must be the configured dashboard origin." });
                try { await http.RequestServices.GetRequiredService<IAntiforgery>().ValidateRequestAsync(http); }
                catch (AntiforgeryValidationException) { return Results.BadRequest(new { code = "invalid_csrf", message = "The CSRF token is missing or no longer valid." }); }
            }
            return await next(context);
        });
        api.MapGet("/csrf", (HttpContext http, IAntiforgery antiforgery) =>
            Results.Ok(new { token = antiforgery.GetAndStoreTokens(http).RequestToken }));
        // Dashboard sign-in uses accounts. Operator tokens authenticate only the bearer API at /operator/v1.
        api.MapPost("/login", async (LoginRequest request, HttpContext http, OperatorAccountStore accounts, CancellationToken ct) =>
        {
            var account = await accounts.AuthenticateAsync(request.Name, request.Password, ct);
            if (account is null) return LoginRejected();
            await SignInAsync(http, account);
            return Results.Ok(SessionOf(account));
        }).RequireRateLimiting("enrollment");
        var authenticated = api.MapGroup("").RequireAuthorization(Scheme);
        authenticated.MapGet("/session", (HttpContext http) => Results.Ok(new
        {
            actor = Actor(http),
            scope = http.User.FindFirstValue(OperatorScopeNames.ClaimType),
            mustChangePassword = MustChangePassword(http)
        }));
        authenticated.MapPost("/logout", async (HttpContext http) =>
        {
            await http.SignOutAsync(Scheme);
            return Results.Ok(new { signedOut = true });
        });
        // The signed-in account changes its own password. The session continues under a new cookie; other sessions of the account end.
        authenticated.MapPost("/account/password", async (ChangePasswordRequest request, HttpContext http, OperatorAccountStore accounts,
            CancellationToken ct) =>
        {
            var account = await accounts.ChangeOwnPasswordAsync(Guid.Parse(http.User.FindFirstValue(AccountIdClaim)!),
                request.CurrentPassword, request.NewPassword, ct);
            await SignInAsync(http, account);
            return Results.Ok(SessionOf(account));
        }).RequireRateLimiting("enrollment");

        // Everything else waits until a required password change is done.
        var ready = authenticated.MapGroup("").AddEndpointFilter(async (context, next) =>
            MustChangePassword(context.HttpContext)
                ? Results.Json(new { code = "password_change_required", message = "Change your password before continuing." },
                    statusCode: StatusCodes.Status403Forbidden)
                : await next(context));
        MapAccounts(ready);
        // Every Operator route is shared with /operator/v1, so the two surfaces cannot drift.
        OperatorApi.Map(ready, TimeSpan.FromSeconds(app.Configuration.GetValue("Source:ScanTimeoutSeconds", 180) + 30));
    }

    /// <summary>
    /// Account administration. Only admin sessions may list or change accounts. The store checks the session's account again once it
    /// holds the account lock, so a request that was already waiting cannot use rights that were removed meanwhile.
    /// </summary>
    private static void MapAccounts(RouteGroupBuilder group)
    {
        var accounts = group.MapGroup("/accounts").AddEndpointFilter(async (context, next) =>
            OperatorApi.HasScope(context.HttpContext, OperatorScope.Admin) ? await next(context) : OperatorApi.ScopeDenied(OperatorScope.Admin));
        accounts.MapGet("", async (OperatorAccountStore store, CancellationToken ct) => Results.Ok(new { items = await store.ListAsync(ct) }));
        accounts.MapPost("", async (CreateAccountRequest request, HttpContext http, OperatorAccountStore store, CancellationToken ct) =>
            Results.Json(await store.CreateAsync(AccountActorOf(http), request.Name, request.Password, request.Scope, ct), statusCode: StatusCodes.Status201Created));
        accounts.MapPost("/{name}/scope", async (string name, AccountScopeRequest request, HttpContext http, OperatorAccountStore store,
            CancellationToken ct) => Results.Ok(await store.SetScopeAsync(AccountActorOf(http), name, request.Scope, ct)));
        accounts.MapPost("/{name}/password", async (string name, ResetPasswordRequest request, HttpContext http, OperatorAccountStore store,
            CancellationToken ct) => Results.Ok(await store.ResetPasswordAsync(AccountActorOf(http), name, request.Password, ct)));
        accounts.MapPost("/{name}/delete", async (string name, HttpContext http, OperatorAccountStore store, CancellationToken ct) =>
        {
            await store.DeleteAsync(AccountActorOf(http), name, ct);
            return Results.Ok(new { deleted = true });
        });
    }

    private static Task SignInAsync(HttpContext http, OperatorAccountRow account) => http.SignInAsync(Scheme,
        new ClaimsPrincipal(new ClaimsIdentity([
            new Claim(ClaimTypes.NameIdentifier, account.Name), new Claim(AccountIdClaim, account.Id.ToString("D")),
            new Claim(StampClaim, account.SecurityStamp.ToString("D")), new Claim(OperatorScopeNames.ClaimType, account.Scope),
            new Claim(MustChangeClaim, account.MustChangePassword ? "true" : "false")], Scheme)),
        new AuthenticationProperties { IsPersistent = false, AllowRefresh = false });

    private static object SessionOf(OperatorAccountRow account) =>
        new { actor = account.Name, scope = account.Scope, mustChangePassword = account.MustChangePassword };

    private static bool MustChangePassword(HttpContext http) => http.User.FindFirstValue(MustChangeClaim) == "true";

    private static string Actor(HttpContext http) => http.User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    private static AccountActor AccountActorOf(HttpContext http) =>
        new(Guid.Parse(http.User.FindFirstValue(AccountIdClaim)!), Guid.Parse(http.User.FindFirstValue(StampClaim)!));

    private static IResult LoginRejected() => Results.Json(
        new { code = "unauthorized", message = "The name or password was not accepted." }, statusCode: StatusCodes.Status401Unauthorized);
    // Embedded files under Dashboard/Assets. Only the enrollment page and its two assets are ever served.
    private static readonly IReadOnlyDictionary<string, string> ContentTypes = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        [".js"] = "text/javascript; charset=utf-8",
        [".css"] = "text/css; charset=utf-8",
        [".html"] = "text/html; charset=utf-8",
        [".svg"] = "image/svg+xml"
    };

    private static IResult Asset(string name)
    {
        using var stream = typeof(DashboardEndpoints).Assembly.GetManifestResourceStream("Fleet.Server.Dashboard.Assets." + name);
        if (stream is null || !ContentTypes.TryGetValue(Path.GetExtension(name), out var contentType)) return Results.NotFound();
        using var reader = new StreamReader(stream);
        return Results.Text(reader.ReadToEnd(), contentType);
    }
    public sealed record LoginRequest(string? Name, string? Password);
    public sealed record ChangePasswordRequest(string? CurrentPassword, string? NewPassword);
    public sealed record CreateAccountRequest(string? Name, string? Password, string? Scope);
    public sealed record AccountScopeRequest(string? Scope);
    public sealed record ResetPasswordRequest(string? Password);
}

/// <summary>The separate dashboard's normalized origin. Empty when Fleet:DashboardOrigin is not set.</summary>
public sealed class DashboardSettings
{
    public string? Origin { get; private init; }
    /// <summary>The dashboard API needs both the dashboard origin and the Server's public origin.</summary>
    public bool ApiEnabled { get; private init; }

    public static DashboardSettings Load(FleetOptions settings) => string.IsNullOrEmpty(settings.DashboardOrigin) ? new() : new()
    {
        Origin = new Uri(settings.DashboardOrigin).GetLeftPart(UriPartial.Authority),
        ApiEnabled = !string.IsNullOrEmpty(settings.PublicUrl)
    };

    /// <summary>Exact match, case-insensitive. There is no wildcard and no suffix or prefix match.</summary>
    public bool IsDashboardOrigin(string? candidate) => Origin is not null && string.Equals(candidate, Origin, StringComparison.OrdinalIgnoreCase);
}
