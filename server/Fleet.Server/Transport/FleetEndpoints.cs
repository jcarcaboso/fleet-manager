using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
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

    private static NodeAuthentication Node(HttpContext context) =>
        (NodeAuthentication)context.Items[FleetAuthenticationHandler.NodeIdentityKey]!;
}
