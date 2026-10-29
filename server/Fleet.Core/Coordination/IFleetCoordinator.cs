namespace Fleet.Core.Coordination;

public interface IFleetCoordinator
{
    Task<EnrollmentAuthorization> CreateEnrollmentAuthorizationAsync(
        CreateEnrollmentAuthorization command,
        CancellationToken cancellationToken = default);

    Task<EnrollmentResult> CompleteEnrollmentAsync(
        CompleteEnrollment command,
        CancellationToken cancellationToken = default);

    Task RevokeEnrollmentAuthorizationAsync(
        Guid id,
        string actor,
        CancellationToken cancellationToken = default);

    Task RevokeCredentialAsync(
        CredentialId credentialId,
        string revokedBy,
        CancellationToken cancellationToken = default);

    Task RevokeNodeAsync(
        NodeId nodeId,
        string revokedBy,
        CancellationToken cancellationToken = default);

    Task RemoveNodeAsync(
        NodeId nodeId,
        string expectedAlias,
        string removedBy,
        CancellationToken cancellationToken = default);

    Task RenewCredentialAsync(
        RenewNodeCredential command,
        CancellationToken cancellationToken = default);

    Task<NodeAliasResult> RenameNodeAliasAsync(
        RenameNodeAlias command,
        CancellationToken cancellationToken = default);

    Task<NodeAliasResult> RenameNodeAliasAsOperatorAsync(
        OperatorRenameNodeAlias command,
        CancellationToken cancellationToken = default);

    Task<NodeAuthentication?> FindActiveNodeByCertificateAsync(
        string certificateSha256,
        CancellationToken cancellationToken = default,
        bool allowExpired = false);

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

    /// <summary>
    /// A poll that also records whether the Agent can update itself. With <see cref="AgentCapabilities.AgentUpdate"/>, the result
    /// carries the version of a requested update.
    /// </summary>
    Task<PollResult> PollAsync(
        NodeAuthentication authentication,
        DateTimeOffset contactedAt,
        AgentCapabilities capabilities,
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

    Task<string> AuthorizeCliProxyCredentialAsync(
        NodeAuthentication authentication,
        CancellationToken cancellationToken = default);

    Task<ReportResult> ReportAttemptAsync(
        NodeAuthentication authentication,
        AttemptReport report,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Stores the detail of the Node's own failed Attempt, replacing earlier detail. The detail is sanitized and validated
    /// with <see cref="AttemptDetailRules"/>. Throws attempt_not_found (unknown or another Node's) or attempt_not_failed.
    /// </summary>
    Task RecordAttemptDetailAsync(
        NodeAuthentication authentication,
        AttemptId attemptId,
        AttemptDetail detail,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Replaces the Node's stored disk volumes with the report and clears a pending refresh request, in one transaction.
    /// The report is validated with <see cref="DiskUsageRules"/>; invalid reports throw invalid_request.
    /// </summary>
    Task RecordDiskUsageAsync(
        NodeAuthentication authentication,
        DiskUsageReport report,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Records that an Operator wants a fresh disk report. A repeat keeps the original timestamp until the Agent reports.
    /// Throws node_not_found, or node_revoked for a revoked Node.
    /// </summary>
    Task<DiskRefreshRequested> RequestDiskUsageRefreshAsync(
        NodeId nodeId,
        string requestedBy,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Requests that the Node's Agent update itself to <paramref name="targetVersion"/>, replacing a finished or abandoned update.
    /// Repeating a pending request for the same version returns it unchanged. Throws node_not_found, node_revoked,
    /// agent_update_unsupported (the Agent did not announce the capability), agent_update_current (it already runs that version
    /// or a newer one) or agent_update_in_progress. With <paramref name="checkOnly"/>, nothing is written.
    /// </summary>
    Task<AgentUpdateStatus> RequestAgentUpdateAsync(
        NodeId nodeId,
        SemanticVersion targetVersion,
        string requestedBy,
        bool checkOnly = false,
        CancellationToken cancellationToken = default);

    /// <summary>Cancels an update the Agent has not picked up. Throws node_not_found or agent_update_not_cancellable.</summary>
    Task<AgentUpdateStatus> CancelAgentUpdateAsync(
        NodeId nodeId,
        string cancelledBy,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Records an Agent's report about its update. Returns false, and changes nothing, when the Node has no update to that version
    /// in a state the report can follow. The report is validated with <see cref="AgentUpdateRules"/>.
    /// </summary>
    Task<bool> RecordAgentUpdateReportAsync(
        NodeAuthentication authentication,
        AgentUpdateReport report,
        CancellationToken cancellationToken = default);

    /// <summary>Nodes that are not revoked and reported an Agent older than <paramref name="latest"/>, by alias (at most 500).</summary>
    Task<IReadOnlyList<NodeAliasResult>> GetOutdatedNodesAsync(
        SemanticVersion latest,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Replaces the Node's stored telemetry with the report, in one transaction under the Node row lock.
    /// The report is validated with <see cref="AgentTelemetryRules"/>; invalid reports throw invalid_request.
    /// </summary>
    Task RecordAgentTelemetryAsync(
        NodeAuthentication authentication,
        AgentTelemetryReport report,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Stores a drift report of the Node in one transaction under the Node row lock and keeps only the newest
    /// <see cref="DriftRules.MaximumEvents"/> events of the Node. Invalid reports, and Targets that are not a current Assignment
    /// of the Node, throw invalid_request.
    /// </summary>
    Task RecordDriftAsync(
        NodeAuthentication authentication,
        DriftReport report,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Replaces the Node's stored repair failures with the report, in one transaction under the Node row lock. The report is validated
    /// and sanitized with <see cref="RepairFailureRules"/>; invalid reports throw invalid_request. Entries whose Assignment is not the
    /// Node's current Assignment of that Target are skipped. An unchanged failure (same Assignment and error code) keeps its first time.
    /// </summary>
    Task RecordRepairFailuresAsync(
        NodeAuthentication authentication,
        RepairFailureReport report,
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

    Task<Page<DesiredRevisionSummary>> GetDesiredRevisionsAsync(
        PageRequest page,
        CancellationToken cancellationToken = default);

    Task<Page<RolloutStatus>> GetRolloutsAsync(
        PageRequest page,
        CancellationToken cancellationToken = default);

    /// <summary>One desired revision with what changed since the previous one; <c>revision_not_found</c> if there is none.</summary>
    Task<DesiredRevisionDetail> GetDesiredRevisionAsync(
        DesiredRevisionId id,
        CancellationToken cancellationToken = default);

    /// <summary>Per-Node progress of one rollout (at most 500 Nodes, by name); <c>rollout_not_found</c> if there is none.</summary>
    Task<RolloutDetail> GetRolloutAsync(
        RolloutId id,
        CancellationToken cancellationToken = default);

    /// <summary>The stored states of the given issues. Whether a state still applies is up to the caller.</summary>
    Task<IReadOnlyDictionary<string, IssueStateEntry>> GetIssueStatesAsync(
        IReadOnlyCollection<string> issueIds,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Acknowledges, snoozes or reopens an issue and writes the audit event, in one transaction. Returns the stored state, or null
    /// after a reopen. Also deletes expired snoozes and acknowledgements of issues that are no longer current.
    /// </summary>
    Task<IssueStateEntry?> ChangeIssueStateAsync(
        ChangeIssueState command,
        CancellationToken cancellationToken = default);

    Task<Page<AuditEventStatus>> GetAuditEventsAsync(
        PageRequest page,
        NodeId? node = null,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Resolves a Node ID or exact alias; a UUID-shaped value is tried as an ID first. Revoked Nodes resolve.
    /// With <paramref name="allowRemovedId"/>, an unknown UUID is returned as is, so history of removed Nodes stays reachable.
    /// </summary>
    Task<NodeId> ResolveNodeAsync(
        string nodeOrAlias,
        bool allowRemovedId = false,
        CancellationToken cancellationToken = default);

    Task<NodeDetail> GetNodeDetailAsync(
        NodeId nodeId,
        DateTimeOffset now,
        TimeSpan staleAfter,
        CancellationToken cancellationToken = default);

    Task<Page<NodeAttemptStatus>> GetNodeAttemptsAsync(
        NodeId nodeId,
        string? targetName,
        PageRequest page,
        CancellationToken cancellationToken = default);

    Task<NodeCheckins> GetNodeCheckinsAsync(
        NodeId nodeId,
        int hours,
        CancellationToken cancellationToken = default);

    Task<RetryResult> RetryAssignmentAsync(
        RetryAssignment command,
        CancellationToken cancellationToken = default);

    Task<Page<SourceScanEntry>> GetSourceScansAsync(
        PageRequest page,
        CancellationToken cancellationToken = default);

    Task<Page<EnrollmentLinkStatus>> GetEnrollmentLinksAsync(
        PageRequest page,
        DateTimeOffset now,
        CancellationToken cancellationToken = default);

    /// <summary>One enrollment link in the shape of <see cref="GetEnrollmentLinksAsync"/>; <c>enrollment_link_not_found</c> if there is none.</summary>
    Task<EnrollmentLinkStatus> GetEnrollmentLinkAsync(
        Guid id,
        DateTimeOffset now,
        CancellationToken cancellationToken = default);

    Task<PersistenceMaintenanceResult> MaintainPersistenceAsync(
        PersistenceMaintenancePolicy policy,
        CancellationToken cancellationToken = default);
}
