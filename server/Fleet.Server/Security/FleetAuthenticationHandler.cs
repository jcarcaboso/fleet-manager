using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using Fleet.Core.Coordination;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

namespace Fleet.Server.Security;

public sealed class FleetAuthenticationHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder,
    IOptions<FleetOptions> fleetOptions,
    NodeCertificateIssuer issuer,
    IFleetCoordinator coordinator) : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string OperatorScheme = "Operator";
    public const string NodeScheme = "Node";
    public const string NodeIdentityKey = "Fleet.NodeAuthentication";

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        if (Scheme.Name == OperatorScheme)
        {
            var header = Request.Headers.Authorization.ToString();
            if (header.Length > 1024 || !header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
            {
                return AuthenticateResult.NoResult();
            }
            var token = header[7..];
            var actual = SHA256.HashData(Encoding.UTF8.GetBytes(token));
            string? actor = null;
            foreach (var candidate in fleetOptions.Value.OperatorCredentials())
            {
                if (CryptographicOperations.FixedTimeEquals(actual, Convert.FromHexString(candidate.Value))) actor = candidate.Key;
            }
            if (token.Length < 32 || actor is null)
            {
                return AuthenticateResult.Fail("invalid_credential");
            }
            return Success(actor, fleetOptions.Value.ScopeOf(actor));
        }

        if (!Request.IsHttps)
        {
            return AuthenticateResult.NoResult();
        }
        var allowExpired = Context.GetEndpoint()?.Metadata.GetMetadata<AllowExpiredNodeCertificate>() is not null;
        var certificate = await Context.Connection.GetClientCertificateAsync(Context.RequestAborted);
        if (certificate is null || !issuer.ValidateChain(certificate, allowExpired))
        {
            return AuthenticateResult.NoResult();
        }
        var digest = certificate.GetCertHashString(HashAlgorithmName.SHA256).ToLowerInvariant();
        var identity = await coordinator.FindActiveNodeByCertificateAsync(digest, Context.RequestAborted, allowExpired);
        if (identity is null)
        {
            return AuthenticateResult.Fail("invalid_credential");
        }
        Context.Items[NodeIdentityKey] = identity;
        return Success(identity.NodeId.Value.ToString("D"));
    }

    // Operator clients get the standard error body with the 401. The Agent scheme keeps its empty 401.
    protected override async Task HandleChallengeAsync(AuthenticationProperties properties)
    {
        Response.StatusCode = StatusCodes.Status401Unauthorized;
        if (Scheme.Name == OperatorScheme) await WriteUnauthorizedAsync(Response);
    }

    public static Task WriteUnauthorizedAsync(HttpResponse response) => response.WriteAsJsonAsync(new
    {
        code = "unauthorized",
        message = "A valid Operator token or dashboard session is required."
    });

    private AuthenticateResult Success(string name, OperatorScope? scope = null)
    {
        var claims = new List<Claim> { new(ClaimTypes.NameIdentifier, name) };
        if (scope is { } granted) claims.Add(new Claim(OperatorScopeNames.ClaimType, granted.Name()));
        return AuthenticateResult.Success(new AuthenticationTicket(
            new ClaimsPrincipal(new ClaimsIdentity(claims, Scheme.Name)), Scheme.Name));
    }
}

// Only the renewal endpoint may authenticate with an expired, non-revoked credential.
public sealed class AllowExpiredNodeCertificate;
