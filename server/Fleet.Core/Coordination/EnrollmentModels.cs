namespace Fleet.Core.Coordination;

// Enrollment, Node credentials and Node aliases, and the Operator's view of enrollment links.

public sealed record CreateEnrollmentAuthorization(
    string CreatedBy,
    DateTimeOffset ExpiresAt,
    TimeSpan RetryWindow,
    string? BoundAlias = null);

public sealed record EnrollmentAuthorization(
    string Token,
    DateTimeOffset ExpiresAt,
    Guid Id = default,
    string? BoundAlias = null);

public sealed record IssuedNodeCredential(
    NodeId NodeId,
    CredentialId CredentialId,
    string CertificateSha256,
    DateTimeOffset NotBefore,
    DateTimeOffset NotAfter,
    byte[] DeliveryPayload);

public sealed record CompleteEnrollment(
    string Token,
    string CertificateRequestSha256,
    string NodeName,
    string Platform,
    IssuedNodeCredential IssuedCredential);

public enum EnrollmentOutcome
{
    Enrolled,
    Retry,
}

public sealed record EnrollmentResult(
    EnrollmentOutcome Outcome,
    NodeId NodeId,
    CredentialId CredentialId,
    byte[] DeliveryPayload);

public sealed record NodeAuthentication(
    NodeId NodeId,
    CredentialId CredentialId,
    string CertificateSha256);

public sealed record RenewNodeCredential(
    NodeAuthentication Authentication,
    IssuedNodeCredential IssuedCredential);

public sealed record RenameNodeAlias(
    NodeAuthentication Authentication,
    string Alias);

public sealed record NodeAliasResult(
    NodeId NodeId,
    string Alias);

public sealed record OperatorRenameNodeAlias(
    string CurrentAlias,
    string Alias,
    string RequestedBy);

public enum EnrollmentLinkState { Active, Consumed, Expired, Revoked }

public sealed record EnrollmentLinkStatus(
    Guid Id,
    string? Alias,
    DateTimeOffset ExpiresAt,
    DateTimeOffset? ConsumedAt,
    DateTimeOffset? RevokedAt,
    string? RevokedBy,
    NodeId? NodeId,
    EnrollmentLinkState State);
