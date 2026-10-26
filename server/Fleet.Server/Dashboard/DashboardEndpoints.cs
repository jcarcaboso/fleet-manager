using System.Security.Claims;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Fleet.Core.Coordination;
using Fleet.Server.Security;
using Fleet.Server.Transport;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Options;

namespace Fleet.Server.Dashboard;

public static partial class DashboardEndpoints
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

    public static void MapFleetDashboard(this WebApplication app)
    {
        var settings = app.Services.GetRequiredService<IOptions<FleetOptions>>().Value;
        if (string.IsNullOrEmpty(settings.PublicUrl)) return;
        var origin = app.Services.GetRequiredService<EnrollmentLinkSettings>().Origin!;

        var pages = app.MapGroup("").AddEndpointFilter(async (context, next) =>
        {
            var http = context.HttpContext;
            if (!http.Request.IsHttps || !string.Equals($"https://{http.Request.Host}", origin, StringComparison.OrdinalIgnoreCase))
                return Results.BadRequest(new { code = "dashboard_origin_required", message = "Open the dashboard at the Server's public HTTPS origin." });
            http.Response.Headers["Content-Security-Policy"] = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
            http.Response.Headers["Referrer-Policy"] = "no-referrer";
            http.Response.Headers["X-Content-Type-Options"] = "nosniff";
            http.Response.Headers.CacheControl = "no-store";
            return await next(context);
        });
        pages.MapGet("/", () => Results.Redirect("/dashboard"));
        pages.MapGet("/dashboard", () => Asset("index.html"));
        pages.MapGet("/enroll", () => Asset("enroll.html"));
        // Any embedded asset with a plain lower-case name. Other names return 404.
        pages.MapGet("/dashboard/{file}", (string file) => AssetName().IsMatch(file) ? Asset(file) : Results.NotFound());

        var api = pages.MapGroup("/dashboard/api").WithMetadata(ErrorMessages.Instance).AddEndpointFilter(async (context, next) =>
        {
            var http = context.HttpContext;
            if (!HttpMethods.IsGet(http.Request.Method))
            {
                if (!string.Equals(http.Request.Headers.Origin, origin, StringComparison.OrdinalIgnoreCase))
                    return Results.BadRequest(new { code = "invalid_origin", message = "The Origin header must be the Server's public origin." });
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
        authenticated.MapGet("/diagnostics", DashboardDiagnostics.ReadAsync);
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
    // Embedded files under Dashboard/Assets, keyed by file name, with the content type for their extension.
    [GeneratedRegex(@"^[a-z0-9][a-z0-9-]*\.(js|css|html|svg)\z")]
    private static partial Regex AssetName();

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
