namespace Fleet.Core.Coordination;

public interface IFleetCoordinator
{
    Task<EnrollmentAuthorization> CreateEnrollmentAuthorizationAsync(
        CreateEnrollmentAuthorization command,
        CancellationToken cancellationToken = default);

    Task<EnrollmentResult> CompleteEnrollmentAsync(
        CompleteEnrollment command,
        CancellationToken cancellationToken = default);

    Task RevokeCredentialAsync(
        CredentialId credentialId,
        string revokedBy,
        CancellationToken cancellationToken = default);

    Task RevokeNodeAsync(
        NodeId nodeId,
        string revokedBy,
        CancellationToken cancellationToken = default);

    Task RenewCredentialAsync(
        RenewNodeCredential command,
        CancellationToken cancellationToken = default);

    Task<NodeAuthentication?> FindActiveNodeByCertificateAsync(
        string certificateSha256,
        CancellationToken cancellationToken = default);

    Task<PublicationResult> AcceptSourceSnapshotAsync(
        AcceptedSourceSnapshot snapshot,
        CancellationToken cancellationToken = default);

    Task RecordSourceScanAsync(
        RecordSourceScan scan,
        CancellationToken cancellationToken = default);

    Task<SourceScanStatus?> GetLatestSourceScanAsync(CancellationToken cancellationToken = default);

    Task<PollResult> PollAsync(
        NodeAuthentication authentication,
        DateTimeOffset contactedAt,
        CancellationToken cancellationToken = default);

    Task<PollResult> PollTargetAsync(
        NodeAuthentication authentication,
        string targetName,
        DateTimeOffset contactedAt,
        CancellationToken cancellationToken = default);

    Task<BundleContent> GetBundleAsync(
        NodeAuthentication authentication,
        string digest,
        CancellationToken cancellationToken = default);

    Task<ReportResult> ReportAttemptAsync(
        NodeAuthentication authentication,
        AttemptReport report,
        CancellationToken cancellationToken = default);

    Task<Page<NodeStatus>> GetNodesAsync(
        PageRequest page,
        DateTimeOffset now,
        TimeSpan staleAfter,
        CancellationToken cancellationToken = default);

    Task<Page<AttemptStatus>> GetAttemptsAsync(
        RolloutId rolloutId,
        PageRequest page,
        CancellationToken cancellationToken = default);

    Task<Page<WarningStatus>> GetWarningsAsync(
        PageRequest page,
        CancellationToken cancellationToken = default);

    Task<Page<DesiredRevisionStatus>> GetDesiredRevisionsAsync(
        PageRequest page,
        CancellationToken cancellationToken = default);

    Task<Page<RolloutStatus>> GetRolloutsAsync(
        PageRequest page,
        CancellationToken cancellationToken = default);

    Task<Page<AuditEventStatus>> GetAuditEventsAsync(
        PageRequest page,
        CancellationToken cancellationToken = default);

    Task<PersistenceMaintenanceResult> MaintainPersistenceAsync(
        PersistenceMaintenancePolicy policy,
        CancellationToken cancellationToken = default);
}
