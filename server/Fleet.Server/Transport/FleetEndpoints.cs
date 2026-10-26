using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.RateLimiting;
using Fleet.Core.Coordination;
using Fleet.Server.Hosting;
using Fleet.Server.Security;
using Microsoft.Extensions.Options;

namespace Fleet.Server.Transport;

public static class FleetEndpoints
{
    public static void MapFleetEndpoints(this WebApplication app)
    {
        var operators = app.MapGroup("/operator/v1").RequireAuthorization("Operator").WithGroupName("operator");
        var operatorApi = OperatorApi.Map(operators, TimeSpan.FromSeconds(app.Configuration.GetValue("Source:ScanTimeoutSeconds", 180) + 30));
        operatorApi.MapGet("/metrics", (FleetMetrics metrics) => Results.Ok(metrics.Snapshot()))
            .WithMetadata(new RequiredScope(OperatorScope.Read));

        app.MapPost("/agent/v1/enroll", async (EnrollmentRequest request, HttpContext context, NodeCertificateIssuer issuer,
            IFleetCoordinator coordinator, IOptions<FleetOptions> options, TimeProvider time, CancellationToken ct) =>
        {
            var verified = NodeCertificateIssuer.ValidateRequest(request.CertificateRequestPem);
            var nodeId = Guid.NewGuid();
            var credentialId = Guid.NewGuid();
            var issued = issuer.Issue(verified, nodeId);
            var response = new EnrollmentResponse(options.Value.WorkspaceId, nodeId, credentialId, issued.CertificatePem,
                issued.ExpiresAt, options.Value.PollIntervalSeconds);
            var result = await coordinator.CompleteEnrollmentAsync(new(request.Token,
                Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(request.CertificateRequestPem))),
                request.NodeName, request.Platform,
                new(new(nodeId), new(credentialId), issued.Sha256, time.GetUtcNow().AddMinutes(-1), issued.ExpiresAt,
                    JsonSerializer.SerializeToUtf8Bytes(response, JsonSerializerOptions.Web))), ct);
            context.Response.Headers.CacheControl = "no-store";
            return Results.Bytes(result.DeliveryPayload, "application/json");
        }).RequireRateLimiting("enrollment").WithGroupName("agent");

        var agents = app.MapGroup("/agent/v1").RequireAuthorization("Node").WithGroupName("agent");
        agents.MapPost("/poll", async (HttpContext context, IFleetCoordinator coordinator, IOptions<FleetOptions> options,
            TimeProvider time, CancellationToken ct) =>
        {
            var result = await coordinator.PollAsync(Node(context), time.GetUtcNow(), ct);
            // Agents that predate disk usage reject unknown fields, so the field exists only for Agents that announce the capability.
            if (result.DiskUsageRequested && HasCapability(context, DiskUsageCapability))
                return Results.Ok(new
                {
                    workspaceId = options.Value.WorkspaceId,
                    nodeId = Node(context).NodeId.Value,
                    assignment = result.Assignment,
                    nextPollSeconds = options.Value.PollIntervalSeconds,
                    diskUsageRequested = true
                });
            return Results.Ok(new
            {
                workspaceId = options.Value.WorkspaceId,
                nodeId = Node(context).NodeId.Value,
                assignment = result.Assignment,
                nextPollSeconds = options.Value.PollIntervalSeconds
            });
        });
        agents.MapGet("/bundles/{digest}", async (string digest, HttpContext context, IFleetCoordinator coordinator, CancellationToken ct) =>
        {
            var bundle = await coordinator.GetBundleAsync(Node(context), digest, ct);
            context.Response.Headers.ETag = $"\"{bundle.Digest}\"";
            context.Response.Headers["X-Fleet-Bundle-Schema"] = bundle.Schema;
            context.Response.Headers.CacheControl = "private, no-store";
            return Results.Bytes(bundle.Content, "application/octet-stream");
        });
        agents.MapGet("/cliproxy/credential", async (HttpContext context, IFleetCoordinator coordinator,
            IOptions<FleetOptions> options, CancellationToken ct) =>
        {
            await coordinator.AuthorizeCliProxyCredentialAsync(Node(context), ct);
            var credential = options.Value.CliProxyApiKey;
            context.Response.Headers.CacheControl = "no-store";
            return credential.Length == 0
                ? Results.Json(new { code = "cliproxy_credential_unavailable" }, statusCode: StatusCodes.Status503ServiceUnavailable)
                : Results.Bytes(Encoding.UTF8.GetBytes(credential), "application/octet-stream");
        });
        agents.MapGet("/cliproxy/models", async (HttpContext context, IFleetCoordinator coordinator,
            CliProxySelectionStore selection, CancellationToken ct) =>
        {
            var baseUrl = await coordinator.AuthorizeCliProxyCredentialAsync(Node(context), ct);
            context.Response.Headers.CacheControl = "no-store";
            var catalog = await selection.GetSelectedCatalogAsync(baseUrl, ct);
            return catalog is null
                ? Results.Json(new { code = "cliproxy_models_unavailable" }, statusCode: StatusCodes.Status503ServiceUnavailable)
                : Results.Ok(catalog);
        });
        agents.MapPost("/reports", async (ReportRequest request, HttpContext context, IFleetCoordinator coordinator,
            TimeProvider time, CancellationToken ct) =>
            await coordinator.ReportAttemptAsync(Node(context), new(new(request.AttemptId), request.State,
                request.ErrorCode, null, time.GetUtcNow()), ct));
        // The Agent sends why a failed Attempt failed after its report is accepted. One conditional UPDATE that skips unchanged values.
        agents.MapPost("/attempts/{attemptId:guid}/detail", async (Guid attemptId, AttemptDetailRequest request, HttpContext context,
            IFleetCoordinator coordinator, CancellationToken ct) =>
        {
            await coordinator.RecordAttemptDetailAsync(Node(context), new(attemptId),
                new(request.Diagnostic, request.Path, request.Step), ct);
            return Results.NoContent();
        }).LimitPerNode();
        // The Agent reports the latest disk usage of its volumes. A report replaces the stored volumes and clears a refresh request.
        agents.MapPut("/disk-usage", async (DiskUsageRequest request, HttpContext context, IFleetCoordinator coordinator,
            CancellationToken ct) =>
        {
            if (request.Volumes is null) throw new CoordinationException("invalid_request", "volumes is required.");
            var volumes = request.Volumes.Select(x => x is { Label: not null, TotalBytes: { } total, UsedBytes: { } used, AvailableBytes: { } available }
                ? new DiskVolume(x.Label, total, used, available)
                : throw new CoordinationException("invalid_request", "label, totalBytes, usedBytes and availableBytes are required.")).ToList();
            await coordinator.RecordDiskUsageAsync(Node(context), new(volumes), ct);
            return Results.NoContent();
        }).LimitPerNode();
        agents.MapPost("/credentials/renew", async (RenewalRequest request, HttpContext context, IFleetCoordinator coordinator,
            NodeCertificateIssuer issuer, TimeProvider time, CancellationToken ct) =>
        {
            var verified = NodeCertificateIssuer.ValidateRequest(request.CertificateRequestPem);
            var identity = Node(context);
            var issued = issuer.Issue(verified, identity.NodeId.Value);
            var credentialId = Guid.NewGuid();
            var response = new { credentialId, issued.CertificatePem, issued.ExpiresAt };
            await coordinator.RenewCredentialAsync(new(identity, new(identity.NodeId, new(credentialId), issued.Sha256,
                time.GetUtcNow().AddMinutes(-1), issued.ExpiresAt, JsonSerializer.SerializeToUtf8Bytes(response, JsonSerializerOptions.Web))), ct);
            context.Response.Headers.CacheControl = "no-store";
            return Results.Ok(response);
        }).RequireRateLimiting("enrollment").WithMetadata(new AllowExpiredNodeCertificate());
        agents.MapPut("/alias", async (AliasRequest request, HttpContext context, IFleetCoordinator coordinator,
            CancellationToken ct) => Results.Ok(await coordinator.RenameNodeAliasAsync(new(Node(context), request.Alias), ct)));
    }

    public const string DiskUsageCapability = "disk-usage";

    /// <summary>True when <c>X-Fleet-Agent-Capabilities</c> lists the token: comma-separated, trimmed, case-insensitive.</summary>
    public static bool HasCapability(HttpContext context, string capability) =>
        context.Request.Headers.TryGetValue("X-Fleet-Agent-Capabilities", out var values) &&
        values.Any(value => value is not null && value.Split(',').Any(token => token.Trim().Equals(capability, StringComparison.OrdinalIgnoreCase)));

    // Limits the route per authenticated Node, sharing one bucket with the other limited routes. The limiter runs as an endpoint
    // filter because the global rate limiter runs before authentication. Errors carry { code, message }.
    private static RouteHandlerBuilder LimitPerNode(this RouteHandlerBuilder builder) => builder.AddEndpointFilter(async (invocation, next) =>
    {
        var context = invocation.HttpContext;
        using var lease = await context.RequestServices.GetRequiredService<NodeRequestRateLimit>()
            .Limiter.AcquireAsync(Node(context).NodeId.Value, 1, context.RequestAborted);
        if (lease.IsAcquired) return await next(invocation);
        if (lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
            context.Response.Headers.RetryAfter = Math.Ceiling(retryAfter.TotalSeconds).ToString(System.Globalization.CultureInfo.InvariantCulture);
        return Results.Json(new { code = "rate_limited", message = "Too many requests from this Node. Retry later." },
            statusCode: StatusCodes.Status429TooManyRequests);
    }).WithMetadata(ErrorMessages.Instance);

    private static NodeAuthentication Node(HttpContext context) =>
        (NodeAuthentication)context.Items[FleetAuthenticationHandler.NodeIdentityKey]!;
}

/// <summary>
/// Per-Node limit shared by <c>POST /agent/v1/attempts/{attemptId}/detail</c> and <c>PUT /agent/v1/disk-usage</c>: a bucket of 30
/// that refills one request every 2 seconds (30 a minute sustained), with no queue. A healthy Agent sends one detail per failed
/// Attempt plus retries, and one disk report every few hours, far below this. Partitions exist only for authenticated Nodes
/// and the framework removes idle ones.
/// </summary>
public sealed class NodeRequestRateLimit(PartitionedRateLimiter<Guid> limiter)
{
    public const int Burst = 30;
    public static readonly TimeSpan RefillEvery = TimeSpan.FromSeconds(2);

    public PartitionedRateLimiter<Guid> Limiter { get; } = limiter;

    public static NodeRequestRateLimit Create() => new(PartitionedRateLimiter.Create<Guid, Guid>(nodeId =>
        RateLimitPartition.GetTokenBucketLimiter(nodeId, _ => new TokenBucketRateLimiterOptions
        {
            TokenLimit = Burst,
            TokensPerPeriod = 1,
            ReplenishmentPeriod = RefillEvery,
            AutoReplenishment = true,
            QueueLimit = 0
        })));
}
