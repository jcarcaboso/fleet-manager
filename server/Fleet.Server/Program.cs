using System.Net;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Threading.RateLimiting;
using Fleet.Core.Coordination;
using Fleet.Server.Hosting;
using Fleet.Server.Persistence;
using Fleet.Server.Security;
using Fleet.Server.Source;
using Fleet.Server.Transport;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Server.Kestrel.Https;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

var builder = WebApplication.CreateBuilder(args);
builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole();
builder.Logging.AddFilter("Microsoft.AspNetCore", LogLevel.Warning);
builder.Logging.AddFilter("Microsoft.EntityFrameworkCore", LogLevel.Warning);
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<FleetMetrics>();
builder.Services.AddSingleton<DatabaseMetricsInterceptor>();
builder.Services.AddRequestTimeouts(options => options.DefaultPolicy = new Microsoft.AspNetCore.Http.Timeouts.RequestTimeoutPolicy
{ Timeout = TimeSpan.FromSeconds(30), TimeoutStatusCode = StatusCodes.Status504GatewayTimeout });
builder.Services.AddOptions<MaintenanceOptions>().BindConfiguration("Maintenance").ValidateDataAnnotations().ValidateOnStart();
builder.Services.AddHostedService<MaintenanceService>();
builder.Services.AddOptions<FleetOptions>().BindConfiguration("Fleet").ValidateDataAnnotations()
    .Validate(x => x.WorkspaceId != Guid.Empty, "A stable WorkspaceId is required.")
    .Validate(x => x.HasValidOperators(), "Configure 1 to 100 uniquely named Operators with distinct SHA-256 token digests.")
    .ValidateOnStart();
builder.Services.AddSingleton<NodeCertificateIssuer>();
builder.Services.AddDbContext<FleetDbContext>((services, options) => options.UseNpgsql(
    builder.Configuration.GetConnectionString("Fleet") ?? throw new InvalidOperationException("ConnectionStrings:Fleet is required."),
    npgsql => npgsql.CommandTimeout(15)).AddInterceptors(services.GetRequiredService<DatabaseMetricsInterceptor>()));
builder.Services.AddScoped<IFleetCoordinator>(services => new PostgresFleetCoordinator(
    services.GetRequiredService<FleetDbContext>(), services.GetRequiredService<TimeProvider>(),
    new FleetCoordinationOptions { WorkspaceId = new WorkspaceId(services.GetRequiredService<IOptions<FleetOptions>>().Value.WorkspaceId) }));
builder.Services.AddSingleton<IEnrolledNodeSource, RegisteredNodeSource>();
builder.Services.AddSingleton<SourcePollingService>();
builder.Services.AddHostedService(services => services.GetRequiredService<SourcePollingService>());
builder.Services.ConfigureHttpJsonOptions(options => WireJson.Configure(options.SerializerOptions));
builder.Services.AddAuthentication()
    .AddScheme<AuthenticationSchemeOptions, FleetAuthenticationHandler>("Operator", _ => { })
    .AddScheme<AuthenticationSchemeOptions, FleetAuthenticationHandler>("Node", _ => { });
builder.Services.AddAuthorizationBuilder()
    .AddPolicy("Operator", policy => policy.AddAuthenticationSchemes("Operator").RequireAuthenticatedUser())
    .AddPolicy("Node", policy => policy.AddAuthenticationSchemes("Node").RequireAuthenticatedUser());
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(_ =>
        RateLimitPartition.GetConcurrencyLimiter("server", _ => new ConcurrencyLimiterOptions { PermitLimit = 128, QueueLimit = 0 }));
    options.AddPolicy("enrollment", context => RateLimitPartition.GetFixedWindowLimiter(
        context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        _ => new FixedWindowRateLimiterOptions { PermitLimit = 20, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 }));
});
builder.Services.AddOpenApi("agent", options => options.ShouldInclude = description => description.GroupName == "agent");
builder.Services.AddOpenApi("operator", options => options.ShouldInclude = description => description.GroupName == "operator");
builder.WebHost.ConfigureKestrel((context, options) =>
{
    options.AddServerHeader = false;
    options.Limits.MaxConcurrentConnections = 256;
    options.Limits.MaxConcurrentUpgradedConnections = 0;
    options.Limits.MaxRequestBodySize = 16 * 1024;
    options.Limits.RequestHeadersTimeout = TimeSpan.FromSeconds(10);
    options.Limits.KeepAliveTimeout = TimeSpan.FromSeconds(30);
    options.ConfigureHttpsDefaults(https =>
    {
        https.ClientCertificateMode = ClientCertificateMode.AllowCertificate;
        https.ClientCertificateValidation = (certificate, _, _) =>
        {
            // Chain trust and active credential authorization are checked again for every Node request.
            return options.ApplicationServices.GetRequiredService<NodeCertificateIssuer>().ValidateChain(certificate);
        };
    });
});
var app = builder.Build();

if (args.Contains("--migrate", StringComparer.Ordinal))
{
    using var scope = app.Services.CreateScope();
    await scope.ServiceProvider.GetRequiredService<FleetDbContext>().Database.MigrateAsync();
    return;
}

// Validate the issuing key and certificate before accepting any connections.
_ = app.Services.GetRequiredService<NodeCertificateIssuer>();
ListenerPolicy.Validate(app.Configuration, app.Services.GetRequiredService<IOptions<FleetOptions>>().Value.AllowLoopbackHttp);

app.Use(async (context, next) =>
{
    var started = Stopwatch.GetTimestamp();
    var path = context.Request.Path;
    var operation = path == "/agent/v1/poll" ? "poll" : path == "/agent/v1/reports" ? "report" :
        path.StartsWithSegments("/agent/v1/bundles") ? "bundle" : path == "/agent/v1/enroll" ? "enrollment" :
        path == "/agent/v1/credentials/renew" ? "renewal" : path.StartsWithSegments("/operator/v1") ? "operator" : "other";
    try { await next(context); }
    finally
    {
        context.RequestServices.GetRequiredService<FleetMetrics>().RecordRequest(operation,
            context.RequestAborted.IsCancellationRequested ? 499 : context.Response.StatusCode,
            Stopwatch.GetElapsedTime(started).TotalSeconds, context.Response.ContentLength ?? 0);
    }
});

app.Use(async (context, next) =>
{
    context.Response.Headers.CacheControl = "no-store";
    if (!context.Request.Path.StartsWithSegments("/health") && !context.Request.IsHttps)
    {
        var settings = context.RequestServices.GetRequiredService<IOptions<FleetOptions>>().Value;
        var remote = context.Connection.RemoteIpAddress;
        if (!settings.AllowLoopbackHttp || remote is null || !IPAddress.IsLoopback(remote))
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            await context.Response.WriteAsJsonAsync(new { code = "https_required" });
            return;
        }
    }
    try { await next(context); }
    catch (CoordinationException exception)
    {
        context.Response.StatusCode = exception.Code switch
        {
            "unauthorized" or "invalid_credential" or "node_unauthorized" or "bundle_not_authorized" => 403,
            "not_found" or "node_not_found" or "credential_not_found" or "attempt_not_found" => 404,
            _ => 400
        };
        await context.Response.WriteAsJsonAsync(new { code = exception.Code });
    }
    catch (BadHttpRequestException exception)
    {
        context.Response.StatusCode = exception.StatusCode;
        await context.Response.WriteAsJsonAsync(new { code = "invalid_request" });
    }
    catch (Exception exception) when (exception is ArgumentException or CryptographicException or System.Text.Json.JsonException)
    {
        context.Response.StatusCode = 400;
        await context.Response.WriteAsJsonAsync(new { code = "invalid_request" });
    }
    catch (Exception exception) when (!context.RequestAborted.IsCancellationRequested)
    {
        app.Logger.LogError("Request failed with {ErrorType}", exception.GetType().FullName);
        context.Response.StatusCode = 500;
        await context.Response.WriteAsJsonAsync(new { code = "internal_error" });
    }
});
app.UseRateLimiter();
app.UseRequestTimeouts();
app.UseAuthentication();
app.UseAuthorization();
app.MapGet("/health/live", () => Results.Ok(new { status = "live" }));
app.MapGet("/health/ready", async (FleetDbContext database, IOptions<FleetOptions> options, CancellationToken cancellationToken) =>
{
    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
    timeout.CancelAfter(TimeSpan.FromSeconds(2));
    try
    {
        if ((await database.Database.GetPendingMigrationsAsync(timeout.Token)).Any()) return Results.StatusCode(503);
        if (await database.Workspaces.AnyAsync(x => x.Id != options.Value.WorkspaceId, timeout.Token)) return Results.StatusCode(503);
        return Results.Ok(new { status = "ready" });
    }
    catch (Exception) { return Results.StatusCode(503); }
});
app.MapFleetEndpoints();
app.MapGet("/operator/v1/metrics", (FleetMetrics metrics) => Results.Ok(metrics.Snapshot()))
    .RequireAuthorization("Operator").WithGroupName("operator");
app.MapPost("/operator/v1/source/rescan", async (SourcePollingService source, HttpContext context, CancellationToken ct) =>
    Results.Ok(await source.ScanNowAsync(context.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)!.Value, ct)))
    .RequireAuthorization("Operator").WithGroupName("operator");
app.MapGet("/operator/v1/source/status", async (IFleetCoordinator coordinator, CancellationToken ct) =>
    Results.Ok(await coordinator.GetLatestSourceScanAsync(ct))).RequireAuthorization("Operator").WithGroupName("operator");
app.MapOpenApi().RequireAuthorization("Operator");
await app.RunAsync();

public partial class Program;
