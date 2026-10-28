using System.Security.Claims;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using System.Text.RegularExpressions;
using Fleet.Core.Coordination;
using Fleet.Server.Hosting;
using Fleet.Server.Persistence;
using Fleet.Server.Security;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Options;

namespace Fleet.Server.Transport;

/// <summary>An Operator API failure with the standard <c>{ code, message }</c> body.</summary>
public sealed class OperatorApiException(int status, string code, string message) : Exception(message)
{
    public int Status { get; } = status;
    public string Code { get; } = code;
}

/// <summary>Endpoint metadata: errors from this endpoint include the safe <c>message</c> next to the code.</summary>
public sealed class ErrorMessages
{
    public static ErrorMessages Instance { get; } = new();
}

/// <summary>Endpoint metadata: the minimum Operator scope. Endpoints without it require <c>admin</c>.</summary>
public sealed record RequiredScope(OperatorScope Scope);

public sealed record RetryRequest(string? Target);
public sealed record RemoveNodeRequest(string Alias);
public sealed record LinkRequest(string Alias, int ExpiresInSeconds = 900);
public sealed record SelectionRequest(string BaseUrl, long Version, CliProxySelectionPolicy? Policy);

/// <summary>Public origin and enrollment CA used to build enrollment links. Empty when Fleet:PublicUrl is not set.</summary>
public sealed class EnrollmentLinkSettings
{
    public string? Origin { get; private init; }
    public string? CaPem { get; private init; }

    public static EnrollmentLinkSettings Load(FleetOptions settings)
    {
        if (string.IsNullOrEmpty(settings.PublicUrl)) return new();
        var caPath = string.IsNullOrEmpty(settings.EnrollmentCaCertificatePath)
            ? settings.IssuerCertificatePath : settings.EnrollmentCaCertificatePath;
        var caText = File.ReadAllText(caPath);
        if (caText.Length > 8192 || caText.Contains("PRIVATE KEY", StringComparison.Ordinal))
            throw new InvalidOperationException("Enrollment CA must contain only a bounded public certificate.");
        using var ca = X509Certificate2.CreateFromPem(caText);
        if (!ca.Extensions.OfType<X509BasicConstraintsExtension>().Any(x => x.CertificateAuthority))
            throw new InvalidOperationException("Enrollment trust must be a CA certificate.");
        return new() { Origin = new Uri(settings.PublicUrl).GetLeftPart(UriPartial.Authority), CaPem = ca.ExportCertificatePem() };
    }
}

public static partial class OperatorApi
{
    public const string ScopeDeniedCode = "insufficient_scope";

    public static bool HasScope(HttpContext http, OperatorScope required) =>
        OperatorScopeNames.TryParse(http.User.FindFirstValue(OperatorScopeNames.ClaimType), out var granted) && granted >= required;

    public static IResult ScopeDenied(OperatorScope required) => Results.Json(new
    {
        code = ScopeDeniedCode,
        message = $"This credential does not have the {required.Name()} scope required for this action."
    }, statusCode: StatusCodes.Status403Forbidden);

    /// <summary>
    /// Maps every Operator route once. The bearer group (<c>/operator/v1</c>) and the dashboard session group
    /// (<c>/dashboard/api</c>) both call this, so they cannot drift. The caller supplies authentication. Returns the scoped group.
    /// </summary>
    public static RouteGroupBuilder Map(RouteGroupBuilder group, TimeSpan rescanTimeout)
    {
        // A nested group, so the scope check covers exactly the Operator routes and not siblings such as the session routes.
        var api = group.MapGroup("");
        // Every Operator route, new or legacy, reports errors as { code, message }.
        api.WithMetadata(ErrorMessages.Instance);
        api.AddEndpointFilter(async (context, next) =>
        {
            var http = context.HttpContext;
            var required = http.GetEndpoint()?.Metadata.GetMetadata<RequiredScope>()?.Scope ?? OperatorScope.Admin;
            return HasScope(http, required) ? await next(context) : ScopeDenied(required);
        });

        // Nodes
        api.MapGet("/nodes", async (int? limit, string? after, IFleetCoordinator coordinator, IOptions<FleetOptions> options,
            TimeProvider time, CancellationToken ct) =>
            await coordinator.GetNodesAsync(new(limit ?? 100, after), time.GetUtcNow(), Stale(options), ct)).Scope(OperatorScope.Read);
        api.MapGet("/nodes/{node}", async (string node, HttpContext http, IFleetCoordinator coordinator, IOptions<FleetOptions> options,
            TimeProvider time, CancellationToken ct) =>
            await coordinator.GetNodeDetailAsync(await ResolveNodeAsync(http, node, coordinator, false, ct), time.GetUtcNow(), Stale(options), ct))
            .Scope(OperatorScope.Read);
        api.MapGet("/nodes/{node}/attempts", async (string node, string? target, int? limit, string? after, HttpContext http,
            IFleetCoordinator coordinator, CancellationToken ct) =>
            await coordinator.GetNodeAttemptsAsync(await ResolveNodeAsync(http, node, coordinator, false, ct), target,
                new(limit ?? 100, after), ct)).Scope(OperatorScope.Read);
        api.MapGet("/nodes/{node}/checkins", async (string node, int? hours, HttpContext http, IFleetCoordinator coordinator, CancellationToken ct) =>
            await coordinator.GetNodeCheckinsAsync(await ResolveNodeAsync(http, node, coordinator, false, ct), hours ?? 168, ct))
            .Scope(OperatorScope.Read);
        api.MapPost("/nodes/{node}/retry", async (string node, RetryRequest request, HttpContext http,
            IFleetCoordinator coordinator, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(request.Target))
                throw new OperatorApiException(400, "invalid_request", "target is required.");
            return await coordinator.RetryAssignmentAsync(
                new(await ResolveNodeAsync(http, node, coordinator, false, ct), request.Target, Actor(http)), ct);
        }).Scope(OperatorScope.Operate);
        // Records the request; the Agent answers on its next poll if it supports disk usage. Repeats keep the first timestamp.
        api.MapPost("/nodes/{node}/disk-usage/refresh", async (string node, HttpContext http, IFleetCoordinator coordinator,
            CancellationToken ct) =>
            Results.Json(await coordinator.RequestDiskUsageRefreshAsync(await ResolveNodeAsync(http, node, coordinator, false, ct), Actor(http), ct),
                statusCode: StatusCodes.Status202Accepted)).Scope(OperatorScope.Operate);
        api.MapPost("/nodes/rename", async (OperatorRenameAliasRequest request, HttpContext http,
            IFleetCoordinator coordinator, CancellationToken ct) =>
            await coordinator.RenameNodeAliasAsOperatorAsync(new(request.CurrentAlias, request.Alias, Actor(http)), ct))
            .Scope(OperatorScope.Admin);
        api.MapPost("/nodes/{id:guid}/revoke", async (Guid id, HttpContext http, IFleetCoordinator coordinator, CancellationToken ct) =>
        {
            await coordinator.RevokeNodeAsync(new(id), Actor(http), ct);
            return Results.Ok(new { revoked = true });
        }).Scope(OperatorScope.Admin);
        api.MapPost("/nodes/{id:guid}/remove", async (Guid id, RemoveNodeRequest request, HttpContext http,
            IFleetCoordinator coordinator, CancellationToken ct) =>
        {
            await coordinator.RemoveNodeAsync(new(id), request.Alias, Actor(http), ct);
            return Results.Ok(new { removed = true });
        }).Scope(OperatorScope.Admin);

        // Issues and errors
        api.MapGet("/issues", async (FleetDbContext db, IFleetCoordinator coordinator, CliProxyCatalog catalog,
            IOptions<FleetOptions> options, IConfiguration configuration, TimeProvider time, LatestAgentVersion latest,
            CancellationToken ct) =>
            new { items = await OperatorIssues.ReadAsync(db, coordinator, catalog, options, configuration, time, latest.Value, ct) })
            .Scope(OperatorScope.Read);
        // Acknowledges or snoozes an issue of the current list, or reopens it. Answers with the updated issue.
        api.MapPost("/issues/state", async (IssueStateRequest request, HttpContext http, FleetDbContext db, IFleetCoordinator coordinator,
            CliProxyCatalog catalog, IOptions<FleetOptions> options, IConfiguration configuration, TimeProvider time, LatestAgentVersion latest,
            CancellationToken ct) =>
        {
            if (string.IsNullOrEmpty(request.Id) || request.Id.Length > IssueStateRules.MaximumIdLength)
                throw new OperatorApiException(400, "invalid_request", $"id is required, at most {IssueStateRules.MaximumIdLength} characters.");
            var action = request.Action switch
            {
                "acknowledge" => IssueStateAction.Acknowledge,
                "snooze" => IssueStateAction.Snooze,
                "reopen" => IssueStateAction.Reopen,
                _ => throw new OperatorApiException(400, "invalid_request", "action must be acknowledge, snooze or reopen.")
            };
            IssueStateRules.ValidateHours(action, request.Hours);
            var issues = await OperatorIssues.ReadAsync(db, coordinator, catalog, options, configuration, time, latest.Value, ct);
            var issue = issues.FirstOrDefault(x => string.Equals(x.Id, request.Id, StringComparison.Ordinal))
                ?? throw new OperatorApiException(404, "issue_not_found", "No current issue has that ID.");
            var entry = await coordinator.ChangeIssueStateAsync(new(issue.Id, action, request.Hours, issue.Since, issue.NodeId, Actor(http),
                issues.Select(x => x.Id).ToList()), ct);
            return OperatorIssues.WithState(issue, entry, time.GetUtcNow());
        }).Scope(OperatorScope.Operate);
        api.MapGet("/errors", () => new { items = ErrorCatalog.All }).Scope(OperatorScope.Read);
        api.MapGet("/errors/{code}", (string code) => ErrorCatalog.Find(code) ?? throw new OperatorApiException(404, "invalid_request",
            "No error catalog entry exists for that code.")).Scope(OperatorScope.Read);

        // Source, rollouts and audit
        api.MapGet("/source/status", async (IFleetCoordinator coordinator, CancellationToken ct) =>
            Results.Ok(await coordinator.GetLatestSourceScanAsync(ct))).Scope(OperatorScope.Read);
        api.MapGet("/source/scans", async (int? limit, string? after, IFleetCoordinator coordinator, CancellationToken ct) =>
            await coordinator.GetSourceScansAsync(new(limit ?? 100, after), ct)).Scope(OperatorScope.Read);
        api.MapPost("/source/rescan", async (SourcePollingService source, HttpContext http, CancellationToken ct) =>
            Results.Ok(await source.ScanNowAsync(Actor(http), ct))).Scope(OperatorScope.Operate).WithRequestTimeout(rescanTimeout);
        api.MapGet("/desired-revisions", async (int? limit, string? after, string? order, IFleetCoordinator coordinator, CancellationToken ct) =>
            await coordinator.GetDesiredRevisionsAsync(new(limit ?? 100, after, Order(order)), ct)).Scope(OperatorScope.Read);
        api.MapGet("/rollouts", async (int? limit, string? after, string? order, IFleetCoordinator coordinator, CancellationToken ct) =>
            await coordinator.GetRolloutsAsync(new(limit ?? 100, after, Order(order)), ct)).Scope(OperatorScope.Read);
        api.MapGet("/desired-revisions/{id}", async (string id, IFleetCoordinator coordinator, CancellationToken ct) =>
            await coordinator.GetDesiredRevisionAsync(new(Guid.TryParse(id, out var revision) ? revision : Guid.Empty), ct)).Scope(OperatorScope.Read);
        api.MapGet("/rollouts/{id}", async (string id, IFleetCoordinator coordinator, CancellationToken ct) =>
            await coordinator.GetRolloutAsync(new(Guid.TryParse(id, out var rollout) ? rollout : Guid.Empty), ct)).Scope(OperatorScope.Read);
        api.MapGet("/rollouts/{id:guid}/attempts", async (Guid id, int? limit, string? after, IFleetCoordinator coordinator, CancellationToken ct) =>
            await coordinator.GetAttemptsAsync(new(id), new(limit ?? 100, after), ct)).Scope(OperatorScope.Read);
        api.MapGet("/warnings", async (int? limit, string? after, IFleetCoordinator coordinator, CancellationToken ct) =>
            await coordinator.GetWarningsAsync(new(limit ?? 100, after), ct)).Scope(OperatorScope.Read);
        api.MapGet("/audit", async (string? node, int? limit, string? after, string? order, IFleetCoordinator coordinator, CancellationToken ct) =>
            await coordinator.GetAuditEventsAsync(new(limit ?? 100, after, Order(order)),
                node is null ? null : await coordinator.ResolveNodeAsync(node, true, ct), ct)).Scope(OperatorScope.Read);

        // Enrollment and credentials
        api.MapGet("/enrollment-links", async (int? limit, string? after, IFleetCoordinator coordinator, TimeProvider time, CancellationToken ct) =>
            await coordinator.GetEnrollmentLinksAsync(new(limit ?? 100, after), time.GetUtcNow(), ct)).Scope(OperatorScope.Read);
        api.MapGet("/enrollment-links/{id}", async (string id, IFleetCoordinator coordinator, TimeProvider time, CancellationToken ct) =>
            await coordinator.GetEnrollmentLinkAsync(Guid.TryParse(id, out var link) ? link : Guid.Empty, time.GetUtcNow(), ct))
            .Scope(OperatorScope.Read);
        api.MapPost("/enrollment-links", async (LinkRequest request, HttpContext http, IFleetCoordinator coordinator,
            EnrollmentLinkSettings link, IOptions<FleetOptions> options, TimeProvider time, CancellationToken ct) =>
        {
            if (request.ExpiresInSeconds is < 60 or > 3600) throw InvalidExpiry();
            if (string.IsNullOrWhiteSpace(request.Alias) || request.Alias.Length > 200)
                throw new OperatorApiException(400, "invalid_alias", "alias must not be blank and may be at most 200 characters.");
            if (link.Origin is null || link.CaPem is null)
                return Results.Json(new { code = "public_url_not_configured", message = "Fleet:PublicUrl must be configured to create enrollment links." },
                    statusCode: StatusCodes.Status409Conflict);
            var result = await coordinator.CreateEnrollmentAuthorizationAsync(new(Actor(http),
                time.GetUtcNow().AddSeconds(request.ExpiresInSeconds), TimeSpan.FromSeconds(options.Value.EnrollmentDeliverySeconds), request.Alias), ct);
            var payload = JsonSerializer.SerializeToUtf8Bytes(new
            {
                version = 1,
                serverUrl = link.Origin,
                token = result.Token,
                alias = request.Alias,
                caPem = link.CaPem,
                expiresAt = result.ExpiresAt
            });
            http.Response.Headers.CacheControl = "no-store";
            return Results.Ok(new { id = result.Id, result.ExpiresAt, link = link.Origin + "/enroll#fleet-v1=" + WebEncoders.Base64UrlEncode(payload) });
        }).Scope(OperatorScope.Admin);
        api.MapPost("/enrollment-links/{id:guid}/revoke", async (Guid id, HttpContext http, IFleetCoordinator coordinator, CancellationToken ct) =>
        {
            await coordinator.RevokeEnrollmentAuthorizationAsync(id, Actor(http), ct);
            return Results.Ok(new { revoked = true });
        }).Scope(OperatorScope.Admin);
        api.MapPost("/enrollment-tokens", async (EnrollmentTokenRequest request, HttpContext http,
            IFleetCoordinator coordinator, IOptions<FleetOptions> options, TimeProvider time, CancellationToken ct) =>
        {
            if (request.ExpiresInSeconds is < 60 or > 3600) throw InvalidExpiry();
            var result = await coordinator.CreateEnrollmentAuthorizationAsync(new(
                Actor(http), time.GetUtcNow().AddSeconds(request.ExpiresInSeconds),
                TimeSpan.FromSeconds(options.Value.EnrollmentDeliverySeconds)), ct);
            http.Response.Headers.CacheControl = "no-store";
            return Results.Ok(result);
        }).Scope(OperatorScope.Admin);
        api.MapPost("/credentials/{id:guid}/revoke", async (Guid id, HttpContext http, IFleetCoordinator coordinator, CancellationToken ct) =>
        {
            await coordinator.RevokeCredentialAsync(new(id), Actor(http), ct);
            return Results.Ok(new { revoked = true });
        }).Scope(OperatorScope.Admin);

        // CLIProxy
        api.MapGet("/cliproxy/status", (CliProxyCatalog catalog) => Results.Ok(catalog.Status())).Scope(OperatorScope.Read);
        api.MapGet("/cliproxy/selection", (CliProxySelectionStore selection, CancellationToken ct) => selection.ListAsync(ct))
            .Scope(OperatorScope.Read);
        api.MapPost("/cliproxy/selection", async (SelectionRequest request, CliProxySelectionStore selection, CancellationToken ct) =>
        {
            var (status, body) = await selection.SaveAsync(request.BaseUrl, request.Version, request.Policy, ct);
            return Results.Json(body, statusCode: status);
        }).Scope(OperatorScope.Operate);
        api.MapPost("/cliproxy/refresh", async (CliProxySyncService sync, CancellationToken ct) =>
            Results.Ok(await sync.SyncNowAsync(true, ct))).Scope(OperatorScope.Operate);
        return api;
    }

    private static RouteHandlerBuilder Scope(this RouteHandlerBuilder builder, OperatorScope scope) =>
        builder.WithMetadata(new RequiredScope(scope));

    private static OperatorApiException InvalidExpiry() =>
        new(400, "invalid_expiry", "expiresInSeconds must be between 60 and 3600.");

    private static PageOrder Order(string? order) => order switch
    {
        null => PageOrder.Id,
        "newest" => PageOrder.Newest,
        _ => throw new OperatorApiException(400, "invalid_request", "order must be newest or omitted.")
    };

    private static async Task<NodeId> ResolveNodeAsync(HttpContext http, string routeValue, IFleetCoordinator coordinator,
        bool allowRemovedId, CancellationToken ct) =>
        await coordinator.ResolveNodeAsync(NodeSegment(http, routeValue), allowRemovedId, ct);

    /// <summary>
    /// The decoded <c>{node}</c> path segment. ASP.NET leaves <c>%2F</c> encoded in route values and decodes the rest, so the
    /// route value cannot tell <c>rack%2FA</c> from <c>rack%252FA</c> reliably. The segment is read from the raw request
    /// target and decoded exactly once: <c>rack%2FA</c> is the alias <c>rack/A</c> and <c>a%252Fb</c> is <c>a%2Fb</c>.
    /// The raw target must decode to the path the router matched; otherwise (dot segments, for example) the request is
    /// rejected, so the resolved Node can never differ from the matched route.
    /// </summary>
    public static string NodeSegment(HttpContext http, string routeValue)
    {
        var target = http.Features.Get<IHttpRequestFeature>()?.RawTarget;
        if (string.IsNullOrEmpty(target)) return routeValue;
        if (target[0] != '/')
        {
            // Absolute form: scheme://authority/path.
            var authority = target.IndexOf("://", StringComparison.Ordinal);
            var slash = authority < 0 ? -1 : target.IndexOf('/', authority + 3);
            if (slash < 0) throw AmbiguousPath();
            target = target[slash..];
        }
        var end = target.IndexOfAny(['?', '#']);
        var raw = (end < 0 ? target : target[..end]).Split('/');
        // Decode the way the server builds Request.Path (everything except %2F), then require an exact match.
        var matched = (http.Request.PathBase + http.Request.Path).Value ?? "";
        if (!string.Equals(string.Join('/', raw.Select(PathDecode)), matched, StringComparison.Ordinal)) throw AmbiguousPath();
        // "", "operator" | "dashboard", "v1" | "api", "nodes", "{node}" after any path base.
        var index = (http.Request.PathBase.Value?.Split('/', StringSplitOptions.RemoveEmptyEntries).Length ?? 0) + 4;
        return index < raw.Length && PathDecode(raw[index - 1]) == "nodes" ? Uri.UnescapeDataString(raw[index]) : throw AmbiguousPath();
    }

    private static string PathDecode(string segment) => string.Concat(EncodedSlash().Split(segment)
        .Select(part => EncodedSlash().IsMatch(part) ? part : Uri.UnescapeDataString(part)));

    [GeneratedRegex("(%2[Ff])")]
    private static partial Regex EncodedSlash();

    private static OperatorApiException AmbiguousPath() =>
        new(400, "invalid_request", "The request path is not in canonical form.");

    private static TimeSpan Stale(IOptions<FleetOptions> options) => TimeSpan.FromSeconds(options.Value.StaleAfterSeconds);

    private static string Actor(HttpContext http) => http.User.FindFirstValue(ClaimTypes.NameIdentifier)!;
}
