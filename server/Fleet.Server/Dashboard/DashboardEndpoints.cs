using System.Security.Claims;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using Fleet.Core.Coordination;
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
    private const string DigestClaim = "fleet:operator-digest";

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
            options.Events.OnValidatePrincipal = context =>
            {
                var settings = context.HttpContext.RequestServices.GetRequiredService<IOptions<FleetOptions>>().Value;
                var actor = context.Principal?.FindFirstValue(ClaimTypes.NameIdentifier);
                var digest = context.Principal?.FindFirstValue(DigestClaim);
                if (!settings.OperatorCredentials().Any(x => x.Key == actor &&
                    string.Equals(x.Value, digest, StringComparison.OrdinalIgnoreCase)) ||
                    context.Principal?.FindFirstValue(OperatorScopeNames.ClaimType) != settings.ScopeOf(actor!).Name())
                    context.RejectPrincipal();
                return Task.CompletedTask;
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
        api.MapPost("/login", async (LoginRequest request, HttpContext http, IOptions<FleetOptions> options) =>
        {
            if (request.Token is null || request.Token.Length is < 32 or > 1024) return LoginRejected();
            var digest = SHA256.HashData(Encoding.UTF8.GetBytes(request.Token));
            string? actor = null;
            foreach (var candidate in options.Value.OperatorCredentials())
                if (CryptographicOperations.FixedTimeEquals(digest, Convert.FromHexString(candidate.Value))) actor = candidate.Key;
            if (actor is null) return LoginRejected();
            var scope = options.Value.ScopeOf(actor);
            var principal = new ClaimsPrincipal(new ClaimsIdentity([
                new Claim(ClaimTypes.NameIdentifier, actor), new Claim(DigestClaim, Convert.ToHexStringLower(digest)),
                new Claim(OperatorScopeNames.ClaimType, scope.Name())], Scheme));
            await http.SignInAsync(Scheme, principal, new AuthenticationProperties { IsPersistent = false, AllowRefresh = false });
            return Results.Ok(new { actor, scope = scope.Name() });
        }).RequireRateLimiting("enrollment");
        var authenticated = api.MapGroup("").RequireAuthorization(Scheme);
        authenticated.MapGet("/session", (HttpContext http) => Results.Ok(new
        {
            actor = Actor(http),
            scope = http.User.FindFirstValue(OperatorScopeNames.ClaimType)
        }));
        authenticated.MapPost("/logout", async (HttpContext http) =>
        {
            await http.SignOutAsync(Scheme);
            return Results.Ok(new { signedOut = true });
        });
        // Every Operator route is shared with /operator/v1, so the two surfaces cannot drift.
        OperatorApi.Map(authenticated, TimeSpan.FromSeconds(app.Configuration.GetValue("Source:ScanTimeoutSeconds", 180) + 30));
    }

    private static string Actor(HttpContext http) => http.User.FindFirstValue(ClaimTypes.NameIdentifier)!;

    private static IResult LoginRejected() => Results.Json(
        new { code = "unauthorized", message = "The Operator token was not accepted." }, statusCode: StatusCodes.Status401Unauthorized);
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
    public sealed record LoginRequest(string Token);
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
