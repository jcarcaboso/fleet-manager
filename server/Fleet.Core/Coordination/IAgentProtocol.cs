namespace Fleet.Core.Coordination;

/// <summary>What an Agent does with the Server: enrollment, credential renewal, its alias, polls, Bundles and reports.</summary>
public interface IAgentProtocol
{
    Task<EnrollmentResult> CompleteEnrollmentAsync(
        CompleteEnrollment command,
        CancellationToken cancellationToken = default);

    Task RenewCredentialAsync(
        RenewNodeCredential command,
        CancellationToken cancellationToken = default);

    Task<NodeAliasResult> RenameNodeAliasAsync(
        RenameNodeAlias command,
        CancellationToken cancellationToken = default);

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
    /// Records an Agent's report about its update. Returns false, and changes nothing, when the Node has no update to that version
    /// in a state the report can follow. The report is validated with <see cref="AgentUpdateRules"/>.
    /// </summary>
    Task<bool> RecordAgentUpdateReportAsync(
        NodeAuthentication authentication,
        AgentUpdateReport report,
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
}
