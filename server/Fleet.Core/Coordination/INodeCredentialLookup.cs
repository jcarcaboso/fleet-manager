namespace Fleet.Core.Coordination;

/// <summary>Finds the Node behind a client certificate. Used by Node authentication.</summary>
public interface INodeCredentialLookup
{
    Task<NodeAuthentication?> FindActiveNodeByCertificateAsync(
        string certificateSha256,
        CancellationToken cancellationToken = default,
        bool allowExpired = false);
}
