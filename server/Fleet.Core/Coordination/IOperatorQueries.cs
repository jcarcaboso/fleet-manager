namespace Fleet.Core.Coordination;

/// <summary>Operator read models: Nodes, desired revisions, rollouts, Attempts, warnings, source scans, audit, enrollment links and issue states.</summary>
public interface IOperatorQueries
{
    Task<SourceScanStatus?> GetLatestSourceScanAsync(CancellationToken cancellationToken = default);

    /// <summary>Nodes that are not revoked and reported an Agent older than <paramref name="latest"/>, by alias (at most 500).</summary>
    Task<IReadOnlyList<NodeAliasResult>> GetOutdatedNodesAsync(
        SemanticVersion latest,
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
}
