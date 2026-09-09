using System.Security.Claims;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using Fleet.Core.Coordination;
using Fleet.Server.Hosting;
using Fleet.Server.Security;
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
                return Task.CompletedTask;
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
                    string.Equals(x.Value, digest, StringComparison.OrdinalIgnoreCase))) context.RejectPrincipal();
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
        var origin = new Uri(settings.PublicUrl).GetLeftPart(UriPartial.Authority);
        var caPath = string.IsNullOrEmpty(settings.EnrollmentCaCertificatePath)
            ? settings.IssuerCertificatePath : settings.EnrollmentCaCertificatePath;
        var caText = File.ReadAllText(caPath);
        if (caText.Length > 8192 || caText.Contains("PRIVATE KEY", StringComparison.Ordinal))
            throw new InvalidOperationException("Enrollment CA must contain only a bounded public certificate.");
        using var ca = X509Certificate2.CreateFromPem(caText);
        if (!ca.Extensions.OfType<X509BasicConstraintsExtension>().Any(x => x.CertificateAuthority))
            throw new InvalidOperationException("Enrollment trust must be a CA certificate.");
        var caPem = ca.ExportCertificatePem();

        var pages = app.MapGroup("").AddEndpointFilter(async (context, next) =>
        {
            var http = context.HttpContext;
            if (!http.Request.IsHttps || !string.Equals($"https://{http.Request.Host}", origin, StringComparison.OrdinalIgnoreCase))
                return Results.BadRequest(new { code = "dashboard_origin_required" });
            http.Response.Headers["Content-Security-Policy"] = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
            http.Response.Headers["Referrer-Policy"] = "no-referrer";
            http.Response.Headers["X-Content-Type-Options"] = "nosniff";
            http.Response.Headers.CacheControl = "no-store";
            return await next(context);
        });
        pages.MapGet("/", () => Results.Redirect("/dashboard"));
        pages.MapGet("/dashboard", () => Asset("index.html", "text/html; charset=utf-8"));
        pages.MapGet("/enroll", () => Asset("enroll.html", "text/html; charset=utf-8"));
        pages.MapGet("/dashboard/app.js", () => Asset("app.js", "text/javascript; charset=utf-8"));
        pages.MapGet("/dashboard/enroll.js", () => Asset("enroll.js", "text/javascript; charset=utf-8"));
        pages.MapGet("/dashboard/style.css", () => Asset("style.css", "text/css; charset=utf-8"));

        var api = pages.MapGroup("/dashboard/api").AddEndpointFilter(async (context, next) =>
        {
            var http = context.HttpContext;
            if (!HttpMethods.IsGet(http.Request.Method))
            {
                if (!string.Equals(http.Request.Headers.Origin, origin, StringComparison.OrdinalIgnoreCase))
                    return Results.BadRequest(new { code = "invalid_origin" });
                try { await http.RequestServices.GetRequiredService<IAntiforgery>().ValidateRequestAsync(http); }
                catch (AntiforgeryValidationException) { return Results.BadRequest(new { code = "invalid_csrf" }); }
            }
            return await next(context);
        });
        api.MapGet("/csrf", (HttpContext http, IAntiforgery antiforgery) =>
            Results.Ok(new { token = antiforgery.GetAndStoreTokens(http).RequestToken }));
        api.MapPost("/login", async (LoginRequest request, HttpContext http, IOptions<FleetOptions> options) =>
        {
            if (request.Token is null || request.Token.Length is < 32 or > 1024) return Results.Unauthorized();
            var digest = SHA256.HashData(Encoding.UTF8.GetBytes(request.Token));
            string? actor = null;
            foreach (var candidate in options.Value.OperatorCredentials())
                if (CryptographicOperations.FixedTimeEquals(digest, Convert.FromHexString(candidate.Value))) actor = candidate.Key;
            if (actor is null) return Results.Unauthorized();
            var principal = new ClaimsPrincipal(new ClaimsIdentity([
                new Claim(ClaimTypes.NameIdentifier, actor), new Claim(DigestClaim, Convert.ToHexStringLower(digest))], Scheme));
            await http.SignInAsync(Scheme, principal, new AuthenticationProperties { IsPersistent = false, AllowRefresh = false });
            return Results.Ok(new { actor });
        }).RequireRateLimiting("enrollment");
        var authenticated = api.MapGroup("").RequireAuthorization(Scheme);
        authenticated.MapPost("/source/rescan", async (SourcePollingService source, HttpContext http, CancellationToken ct) =>
            Results.Ok(await source.ScanNowAsync(Actor(http), ct)))
            .WithRequestTimeout(TimeSpan.FromSeconds(app.Configuration.GetValue("Source:ScanTimeoutSeconds", 180) + 30));
        authenticated.MapGet("/session", (HttpContext http) => Results.Ok(new { actor = Actor(http) }));
        authenticated.MapPost("/logout", async (HttpContext http) =>
        {
            await http.SignOutAsync(Scheme);
            return Results.Ok(new { signedOut = true });
        });
        authenticated.MapGet("/nodes", async (string? after, IFleetCoordinator coordinator, TimeProvider time, CancellationToken ct) =>
            await coordinator.GetNodesAsync(new(100, after), time.GetUtcNow(), TimeSpan.FromSeconds(settings.StaleAfterSeconds), ct));
        authenticated.MapPost("/nodes/rename", async (RenameRequest request, HttpContext http, IFleetCoordinator coordinator, CancellationToken ct) =>
            await coordinator.RenameNodeAliasAsOperatorAsync(new(request.CurrentAlias, request.Alias, Actor(http)), ct));
        authenticated.MapPost("/nodes/{id:guid}/revoke", async (Guid id, HttpContext http, IFleetCoordinator coordinator, CancellationToken ct) =>
        {
            await coordinator.RevokeNodeAsync(new(id), Actor(http), ct);
            return Results.Ok(new { revoked = true });
        });
        authenticated.MapPost("/nodes/{id:guid}/remove", async (Guid id, RemoveNodeRequest request, HttpContext http, IFleetCoordinator coordinator, CancellationToken ct) =>
        {
            await coordinator.RemoveNodeAsync(new(id), request.Alias, Actor(http), ct);
            return Results.Ok(new { removed = true });
        });
        authenticated.MapPost("/enrollment-links", async (LinkRequest request, HttpContext http, IFleetCoordinator coordinator, TimeProvider time, CancellationToken ct) =>
        {
            if (request.ExpiresInSeconds is < 60 or > 3600) return Results.BadRequest(new { code = "invalid_expiry" });
            if (string.IsNullOrWhiteSpace(request.Alias) || request.Alias.Length > 200)
                return Results.BadRequest(new { code = "invalid_alias" });
            var result = await coordinator.CreateEnrollmentAuthorizationAsync(new(Actor(http),
                time.GetUtcNow().AddSeconds(request.ExpiresInSeconds), TimeSpan.FromSeconds(settings.EnrollmentDeliverySeconds), request.Alias), ct);
            var payload = JsonSerializer.SerializeToUtf8Bytes(new
            {
                version = 1,
                serverUrl = origin,
                token = result.Token,
                alias = request.Alias,
                caPem,
                expiresAt = result.ExpiresAt
            });
            return Results.Ok(new { id = result.Id, result.ExpiresAt, link = origin + "/enroll#fleet-v1=" + WebEncoders.Base64UrlEncode(payload) });
        });
        authenticated.MapPost("/enrollment-links/{id:guid}/revoke", async (Guid id, HttpContext http, IFleetCoordinator coordinator, CancellationToken ct) =>
        {
            await coordinator.RevokeEnrollmentAuthorizationAsync(id, Actor(http), ct);
            return Results.Ok(new { revoked = true });
        });
    }

    private static string Actor(HttpContext http) => http.User.FindFirstValue(ClaimTypes.NameIdentifier)!;
    private static IResult Asset(string name, string contentType)
    {
        using var stream = typeof(DashboardEndpoints).Assembly.GetManifestResourceStream("Fleet.Server.Dashboard.Assets." + name)!;
        using var reader = new StreamReader(stream);
        return Results.Text(reader.ReadToEnd(), contentType);
    }
    public sealed record LoginRequest(string Token);
    public sealed record RenameRequest(string CurrentAlias, string Alias);
    public sealed record RemoveNodeRequest(string Alias);
    public sealed record LinkRequest(string Alias, int ExpiresInSeconds = 900);
}
