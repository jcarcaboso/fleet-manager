using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Threading.RateLimiting;
using Fleet.Core.Coordination;
using Fleet.Server.AgentReleases;
using Fleet.Server.CliProxy;
using Fleet.Server.Dashboard;
using Fleet.Server.Http;
using Fleet.Server.Metrics;
using Fleet.Server.Persistence;
using Fleet.Server.Security;
using Fleet.Server.Source;
using Fleet.Server.Transport;
using Microsoft.AspNetCore.Authentication;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Fleet.Server.Hosting;

public static class FleetServerHosting
{
    public static void AddFleetServer(this WebApplicationBuilder builder)
    {
        builder.Logging.ClearProviders();
        builder.Logging.AddJsonConsole();
        builder.Logging.AddFilter("Microsoft.AspNetCore", LogLevel.Warning);
        builder.Logging.AddFilter("Microsoft.EntityFrameworkCore", LogLevel.Warning);
        builder.Services.AddSingleton(TimeProvider.System);
        builder.Services.AddSingleton<FleetMetrics>();
        // Minimal APIs throw on a malformed body only in Development by default and otherwise answer an empty 400. Throwing everywhere
        // lets the error handler below answer { code: "invalid_request", message } in production as well.
        builder.Services.Configure<Microsoft.AspNetCore.Routing.RouteHandlerOptions>(options => options.ThrowOnBadRequest = true);
        builder.Services.AddSingleton<DatabaseMetricsInterceptor>();
        builder.Services.AddRequestTimeouts(options => options.DefaultPolicy = new Microsoft.AspNetCore.Http.Timeouts.RequestTimeoutPolicy
        { Timeout = TimeSpan.FromSeconds(30), TimeoutStatusCode = StatusCodes.Status504GatewayTimeout });
        builder.Services.AddOptions<MaintenanceOptions>().BindConfiguration("Maintenance").ValidateDataAnnotations().ValidateOnStart();
        builder.Services.AddHostedService<MaintenanceService>();
        builder.Services.AddOptions<FleetOptions>().BindConfiguration("Fleet").ValidateDataAnnotations()
            .Validate(x => x.WorkspaceId != Guid.Empty, "A stable WorkspaceId is required.")
            .Validate(x => x.HasValidOperators(), "Configure 1 to 100 uniquely named Operators with distinct SHA-256 token digests.")
            .Validate(x => x.HasValidOperatorScopes(), "Fleet:OperatorScopes values must be read, operate or admin.")
            .Validate(x => x.HasValidPublicUrl(), "Fleet:PublicUrl must be an HTTPS origin without a path, credentials, query, or fragment.")
            .Validate(x => x.HasValidDashboardOrigin(), "Fleet:DashboardOrigin must be an HTTPS origin of at most 200 characters without a path, credentials, query, or fragment.")
            .Validate(x => x.HasValidCliProxyApiKey(), "Fleet:CliProxyApiKey must be empty or contain at most 4096 printable ASCII characters.")
            .Validate(x => x.TlsCertificateRenewBeforeDays < x.TlsCertificateLifetimeDays, "Fleet:TlsCertificateRenewBeforeDays must be less than Fleet:TlsCertificateLifetimeDays.")
            .ValidateOnStart();
        builder.Services.AddSingleton<NodeCertificateIssuer>();
        builder.Services.AddSingleton<TlsCertificateRenewal>();
        builder.Services.AddHostedService(services => services.GetRequiredService<TlsCertificateRenewal>());
        builder.Services.AddHttpClient("cliproxy", client => client.Timeout = TimeSpan.FromSeconds(15))
            .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false });
        builder.Services.AddOptions<AgentReleaseOptions>().BindConfiguration("Fleet:AgentReleases").ValidateDataAnnotations()
            .Validate(x => x.HasValidBaseUrl(), "Fleet:AgentReleases:BaseUrl must be an absolute HTTPS URL without credentials, query, or fragment.")
            .Validate(x => Path.IsPathFullyQualified(x.CacheDirectory), "Fleet:AgentReleases:CacheDirectory must be an absolute path.")
            .Validate(x => x.HasValidPublicKeys(), "Fleet:AgentReleases:PublicKeys must hold at most two PEM Ed25519 public keys.")
            .ValidateOnStart();
        // No redirects: the mirror follows only GitHub's release-asset redirect itself. Its own time limit covers a whole mirror run.
        builder.Services.AddHttpClient(AgentReleaseMirror.HttpClientName, client => client.Timeout = Timeout.InfiniteTimeSpan)
            .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false });
        builder.Services.AddSingleton<AgentReleaseMirror>();
        builder.Services.AddSingleton<CliProxyCatalog>();
        builder.Services.AddSingleton<CliProxySyncService>();
        builder.Services.AddHostedService(services => services.GetRequiredService<CliProxySyncService>());
        builder.Services.AddDbContext<FleetDbContext>((services, options) => options.UseNpgsql(
            builder.Configuration.GetConnectionString("Fleet") ?? throw new InvalidOperationException("ConnectionStrings:Fleet is required."),
            npgsql => npgsql.CommandTimeout(15)).AddInterceptors(services.GetRequiredService<DatabaseMetricsInterceptor>()));
        builder.Services.AddScoped<CliProxySelectionStore>();
        builder.Services.AddScoped<OperatorAccountStore>();
        builder.Services.AddScoped<IFleetCoordinator>(services => new PostgresFleetCoordinator(
            services.GetRequiredService<FleetDbContext>(), services.GetRequiredService<TimeProvider>(),
            new FleetCoordinationOptions
            {
                WorkspaceId = new WorkspaceId(services.GetRequiredService<IOptions<FleetOptions>>().Value.WorkspaceId),
                LatestAgentVersion = services.GetRequiredService<LatestAgentVersion>().Value
            }));
        // Each role resolves to the scope's one coordinator, which owns the scope's FleetDbContext and its transactions.
        builder.Services.AddScoped<INodeCredentialLookup>(services => services.GetRequiredService<IFleetCoordinator>());
        builder.Services.AddScoped<IAgentProtocol>(services => services.GetRequiredService<IFleetCoordinator>());
        builder.Services.AddScoped<ISourcePublication>(services => services.GetRequiredService<IFleetCoordinator>());
        builder.Services.AddScoped<IOperatorCommands>(services => services.GetRequiredService<IFleetCoordinator>());
        builder.Services.AddScoped<IOperatorQueries>(services => services.GetRequiredService<IFleetCoordinator>());
        builder.Services.AddScoped<IPersistenceMaintenance>(services => services.GetRequiredService<IFleetCoordinator>());
        builder.Services.AddSingleton(new LatestAgentVersion(ServerVersion.Current));
        builder.Services.AddSingleton<IEnrolledNodeSource, RegisteredNodeSource>();
        builder.Services.AddSingleton<SourcePollingService>();
        builder.Services.AddHostedService(services => services.GetRequiredService<SourcePollingService>());
        builder.Services.ConfigureHttpJsonOptions(options => WireJson.Configure(options.SerializerOptions));
        builder.Services.AddSingleton(services => EnrollmentLinkSettings.Load(services.GetRequiredService<IOptions<FleetOptions>>().Value));
        builder.Services.AddSingleton(services => DashboardSettings.Load(services.GetRequiredService<IOptions<FleetOptions>>().Value));
        builder.Services.AddFleetDashboard();
        builder.Services.AddAuthentication(options => options.DefaultAuthenticateScheme = DashboardEndpoints.Scheme)
            .AddScheme<AuthenticationSchemeOptions, FleetAuthenticationHandler>(FleetAuthenticationHandler.OperatorScheme, _ => { })
            .AddScheme<AuthenticationSchemeOptions, FleetAuthenticationHandler>(FleetAuthenticationHandler.NodeScheme, _ => { });
        builder.Services.AddAuthorizationBuilder()
            .AddPolicy(FleetAuthenticationHandler.OperatorPolicy, policy =>
                policy.AddAuthenticationSchemes(FleetAuthenticationHandler.OperatorScheme).RequireAuthenticatedUser())
            .AddPolicy(FleetAuthenticationHandler.NodePolicy, policy =>
                policy.AddAuthenticationSchemes(FleetAuthenticationHandler.NodeScheme).RequireAuthenticatedUser());
        builder.Services.AddRateLimiter(options =>
        {
            options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(_ =>
                RateLimitPartition.GetConcurrencyLimiter("server", _ => new ConcurrencyLimiterOptions { PermitLimit = 128, QueueLimit = 0 }));
            options.AddPolicy("enrollment", context => RateLimitPartition.GetFixedWindowLimiter(
                context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                _ => new FixedWindowRateLimiterOptions { PermitLimit = 20, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 }));
        });
        builder.Services.AddSingleton(NodeRequestRateLimit.Create());
        builder.Services.AddOpenApi("agent", options => options.ShouldInclude = description => description.GroupName == "agent");
        builder.Services.AddOpenApi("operator", options => options.ShouldInclude = description => description.GroupName == "operator");
    }

    public static void UseFleetServer(this WebApplication app)
    {
        app.UseRequestMetrics();
        app.UseHttpsAndErrorResponses();
        // Before the rate limiter and authentication so preflights are answered without a session and 401/429 responses still carry CORS headers.
        app.UseDashboardApiHeaders();
        app.UseDashboardRedirect();
        app.UseRateLimiter();
        app.UseRequestTimeouts();
        app.UseAuthentication();
        app.UseAuthorization();
    }

    private static void UseRequestMetrics(this WebApplication app) =>
        app.Use(async (context, next) =>
        {
            var started = Stopwatch.GetTimestamp();
            var path = context.Request.Path;
            var operation = path == "/agent/v1/poll" ? "poll" : path == "/agent/v1/reports" ? "report" :
                path.StartsWithSegments("/agent/v1/bundles") ? "bundle" : path == "/agent/v1/enroll" ? "enrollment" :
                path == "/agent/v1/credentials/renew" ? "renewal" : path == "/agent/v1/cliproxy/credential" ? "cliproxy_credential" :
                path.StartsWithSegments("/operator/v1") ? "operator" : "other";
            try { await next(context); }
            finally
            {
                context.RequestServices.GetRequiredService<FleetMetrics>().RecordRequest(operation,
                    context.RequestAborted.IsCancellationRequested ? 499 : context.Response.StatusCode,
                    Stopwatch.GetElapsedTime(started).TotalSeconds, context.Response.ContentLength ?? 0);
            }
        });

    // Rejects plain HTTP except loopback when allowed and /health, then maps exceptions to error responses.
    private static void UseHttpsAndErrorResponses(this WebApplication app) =>
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
                context.Response.StatusCode = ApiErrors.CoordinationErrorStatus(exception.Code);
                await ApiErrors.WriteError(context, exception.Code, exception.Message);
            }
            catch (OperatorApiException exception)
            {
                context.Response.StatusCode = exception.Status;
                await context.Response.WriteAsJsonAsync(new { code = exception.Code, message = exception.Message });
            }
            catch (BadHttpRequestException exception)
            {
                context.Response.StatusCode = exception.StatusCode;
                await ApiErrors.WriteError(context, "invalid_request", "The request is malformed or a parameter is invalid.");
            }
            catch (Exception exception) when (exception is ArgumentException or CryptographicException or System.Text.Json.JsonException)
            {
                context.Response.StatusCode = 400;
                await ApiErrors.WriteError(context, "invalid_request", "The request is malformed or a parameter is invalid.");
            }
            catch (Exception exception) when (!context.RequestAborted.IsCancellationRequested)
            {
                app.Logger.LogError("Request failed with {ErrorType}", exception.GetType().FullName);
                context.Response.StatusCode = 500;
                await ApiErrors.WriteError(context, "internal_error", "The Server could not complete the request.");
            }
        });

    public static void MapFleetServer(this WebApplication app)
    {
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
        // Fail fast on an unusable enrollment CA, as the dashboard did before bearer routes could create links.
        _ = app.Services.GetRequiredService<EnrollmentLinkSettings>();
        app.MapFleetEndpoints();
        app.MapFleetDashboard();
        app.MapOpenApi().RequireAuthorization(FleetAuthenticationHandler.OperatorPolicy);
    }
}
