using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Fleet.Core.Coordination;
using Fleet.Server.Security;
using Microsoft.Extensions.Options;

namespace Fleet.Server.Transport;

public static class FleetEndpoints
{
    public static void MapFleetEndpoints(this WebApplication app)
    {
        var operators = app.MapGroup("/operator/v1").RequireAuthorization("Operator").WithGroupName("operator");
        operators.MapGet("/nodes", async (int? limit, string? after, IFleetCoordinator coordinator,
            IOptions<FleetOptions> options, TimeProvider time, CancellationToken ct) =>
            await coordinator.GetNodesAsync(new(limit ?? 100, after), time.GetUtcNow(), TimeSpan.FromSeconds(options.Value.StaleAfterSeconds), ct));
        operators.MapGet("/rollouts", async (int? limit, string? after, IFleetCoordinator coordinator, CancellationToken ct) =>
            await coordinator.GetRolloutsAsync(new(limit ?? 100, after), ct));
        operators.MapGet("/desired-revisions", async (int? limit, string? after, IFleetCoordinator coordinator, CancellationToken ct) =>
            await coordinator.GetDesiredRevisionsAsync(new(limit ?? 100, after), ct));
        operators.MapGet("/rollouts/{id:guid}/attempts", async (Guid id, int? limit, string? after, IFleetCoordinator coordinator, CancellationToken ct) =>
            await coordinator.GetAttemptsAsync(new(id), new(limit ?? 100, after), ct));
        operators.MapGet("/warnings", async (int? limit, string? after, IFleetCoordinator coordinator, CancellationToken ct) =>
            await coordinator.GetWarningsAsync(new(limit ?? 100, after), ct));
        operators.MapGet("/audit", async (int? limit, string? after, IFleetCoordinator coordinator, CancellationToken ct) =>
            await coordinator.GetAuditEventsAsync(new(limit ?? 100, after), ct));
        operators.MapPost("/enrollment-tokens", async (EnrollmentTokenRequest request, HttpContext context,
            IFleetCoordinator coordinator, IOptions<FleetOptions> options, TimeProvider time, CancellationToken ct) =>
        {
            if (request.ExpiresInSeconds is < 60 or > 3600) return Results.BadRequest(new { code = "invalid_expiry" });
            var result = await coordinator.CreateEnrollmentAuthorizationAsync(new(
                OperatorName(context), time.GetUtcNow().AddSeconds(request.ExpiresInSeconds),
                TimeSpan.FromSeconds(options.Value.EnrollmentDeliverySeconds)), ct);
            context.Response.Headers.CacheControl = "no-store";
            return Results.Ok(result);
        });
        operators.MapPost("/credentials/{id:guid}/revoke", async (Guid id, HttpContext context, IFleetCoordinator coordinator, CancellationToken ct) =>
        {
            await coordinator.RevokeCredentialAsync(new(id), OperatorName(context), ct);
            return Results.Ok(new { revoked = true });
        });
        operators.MapPost("/nodes/{id:guid}/revoke", async (Guid id, HttpContext context, IFleetCoordinator coordinator, CancellationToken ct) =>
        {
            await coordinator.RevokeNodeAsync(new(id), OperatorName(context), ct);
            return Results.Ok(new { revoked = true });
        });

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
        agents.MapPost("/reports", async (ReportRequest request, HttpContext context, IFleetCoordinator coordinator,
            TimeProvider time, CancellationToken ct) =>
            await coordinator.ReportAttemptAsync(Node(context), new(new(request.AttemptId), request.State,
                request.ErrorCode, null, time.GetUtcNow()), ct));
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
        }).RequireRateLimiting("enrollment");
    }

    private static NodeAuthentication Node(HttpContext context) =>
        (NodeAuthentication)context.Items[FleetAuthenticationHandler.NodeIdentityKey]!;

    private static string OperatorName(HttpContext context) => context.User.FindFirstValue(ClaimTypes.NameIdentifier)!;
}
