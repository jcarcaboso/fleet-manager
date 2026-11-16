namespace Fleet.Core.Coordination;

/// <summary>Operator actions that change the Workspace.</summary>
public interface IOperatorCommands
{
    Task<EnrollmentAuthorization> CreateEnrollmentAuthorizationAsync(
        CreateEnrollmentAuthorization command,
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

    Task<NodeAliasResult> RenameNodeAliasAsOperatorAsync(
        OperatorRenameNodeAlias command,
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
    /// Acknowledges, snoozes or reopens an issue and writes the audit event, in one transaction. Returns the stored state, or null
    /// after a reopen. Also deletes expired snoozes and acknowledgements of issues that are no longer current.
    /// </summary>
    Task<IssueStateEntry?> ChangeIssueStateAsync(
        ChangeIssueState command,
        CancellationToken cancellationToken = default);

    Task<RetryResult> RetryAssignmentAsync(
        RetryAssignment command,
        CancellationToken cancellationToken = default);
}
