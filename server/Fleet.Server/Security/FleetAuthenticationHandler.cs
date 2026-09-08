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
            return Success(actor);
        }

        if (!Request.IsHttps)
        {
            return AuthenticateResult.NoResult();
        }
        var certificate = await Context.Connection.GetClientCertificateAsync(Context.RequestAborted);
        if (certificate is null || !issuer.ValidateChain(certificate))
        {
            return AuthenticateResult.NoResult();
        }
        var digest = certificate.GetCertHashString(HashAlgorithmName.SHA256).ToLowerInvariant();
        var identity = await coordinator.FindActiveNodeByCertificateAsync(digest, Context.RequestAborted);
        if (identity is null)
        {
            return AuthenticateResult.Fail("invalid_credential");
        }
        Context.Items[NodeIdentityKey] = identity;
        return Success(identity.NodeId.Value.ToString("D"));
    }

    private AuthenticateResult Success(string name) => AuthenticateResult.Success(new AuthenticationTicket(
        new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, name)], Scheme.Name)), Scheme.Name));
}
