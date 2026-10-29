using Fleet.Core.Coordination;
using Microsoft.EntityFrameworkCore;

namespace Fleet.Server.Persistence;

public sealed class FleetDbContext(DbContextOptions<FleetDbContext> options) : DbContext(options)
{
    public DbSet<WorkspaceRow> Workspaces => Set<WorkspaceRow>();
    public DbSet<NodeRow> Nodes => Set<NodeRow>();
    public DbSet<NodeCheckinRow> NodeCheckins => Set<NodeCheckinRow>();
    public DbSet<NodeDiskUsageRow> NodeDiskUsages => Set<NodeDiskUsageRow>();
    public DbSet<NodeTelemetryRow> NodeTelemetries => Set<NodeTelemetryRow>();
    public DbSet<CredentialRow> Credentials => Set<CredentialRow>();
    public DbSet<EnrollmentRow> Enrollments => Set<EnrollmentRow>();
    public DbSet<BundleRow> Bundles => Set<BundleRow>();
    public DbSet<DesiredRevisionRow> DesiredRevisions => Set<DesiredRevisionRow>();
    public DbSet<WarningRow> Warnings => Set<WarningRow>();
    public DbSet<RolloutRow> Rollouts => Set<RolloutRow>();
    public DbSet<AssignmentRow> Assignments => Set<AssignmentRow>();
    public DbSet<AssignmentSkillRow> AssignmentSkills => Set<AssignmentSkillRow>();
    public DbSet<AssignmentFileRow> AssignmentFiles => Set<AssignmentFileRow>();
    public DbSet<AssignmentAiClientRow> AssignmentAiClients => Set<AssignmentAiClientRow>();
    public DbSet<AttemptRow> Attempts => Set<AttemptRow>();
    public DbSet<SourceScanRow> SourceScans => Set<SourceScanRow>();
    public DbSet<AuditEventRow> AuditEvents => Set<AuditEventRow>();
    public DbSet<CliProxySelectionRow> CliProxySelections => Set<CliProxySelectionRow>();
    public DbSet<NodeDriftEventRow> NodeDriftEvents => Set<NodeDriftEventRow>();
    public DbSet<NodeRepairFailureRow> NodeRepairFailures => Set<NodeRepairFailureRow>();
    public DbSet<IssueStateRow> IssueStates => Set<IssueStateRow>();
    public DbSet<OperatorAccountRow> OperatorAccounts => Set<OperatorAccountRow>();
    public DbSet<AgentUpdateRow> AgentUpdates => Set<AgentUpdateRow>();

    protected override void OnModelCreating(ModelBuilder model)
    {
        model.Entity<WorkspaceRow>().ToTable("workspaces").HasKey(x => x.Id);
        model.Entity<WorkspaceRow>().HasIndex(x => x.SingletonKey).IsUnique();
        model.Entity<WorkspaceRow>().ToTable(x => x.HasCheckConstraint("ck_workspaces_singleton", "\"SingletonKey\" = 1"));
        model.Entity<NodeRow>().ToTable("nodes").HasKey(x => x.Id);
        model.Entity<NodeRow>().HasIndex(x => new { x.WorkspaceId, x.Name }).IsUnique();
        model.Entity<NodeRow>().HasIndex(x => new { x.WorkspaceId, x.LastContactAt });
        model.Entity<NodeRow>().HasOne<WorkspaceRow>().WithMany().HasForeignKey(x => x.WorkspaceId).OnDelete(DeleteBehavior.Restrict);
        model.Entity<NodeCheckinRow>().ToTable("node_checkins").HasKey(x => new { x.NodeId, x.Hour });
        model.Entity<NodeCheckinRow>().HasIndex(x => x.Hour);
        model.Entity<NodeCheckinRow>().HasOne<NodeRow>().WithMany().HasForeignKey(x => x.NodeId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<NodeDiskUsageRow>().ToTable("node_disk_usage").HasKey(x => new { x.NodeId, x.Label });
        model.Entity<NodeDiskUsageRow>().Property(x => x.Label).HasMaxLength(16);
        model.Entity<NodeDiskUsageRow>().HasOne<NodeRow>().WithMany().HasForeignKey(x => x.NodeId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<NodeDriftEventRow>().ToTable("node_drift_events").HasKey(x => x.Id);
        model.Entity<NodeDriftEventRow>().Property(x => x.Target).HasMaxLength(100);
        model.Entity<NodeDriftEventRow>().Property(x => x.Files).HasColumnType("text[]");
        model.Entity<NodeDriftEventRow>().HasIndex(x => new { x.NodeId, x.DetectedAt, x.Id });
        model.Entity<NodeDriftEventRow>().HasOne<NodeRow>().WithMany().HasForeignKey(x => x.NodeId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<NodeRepairFailureRow>().ToTable("node_repair_failures").HasKey(x => new { x.NodeId, x.Target });
        model.Entity<NodeRepairFailureRow>().Property(x => x.Target).HasMaxLength(RepairFailureRules.MaximumTargetLength);
        model.Entity<NodeRepairFailureRow>().Property(x => x.ErrorCode).HasMaxLength(RepairFailureRules.MaximumErrorCodeLength);
        model.Entity<NodeRepairFailureRow>().Property(x => x.Path).HasMaxLength(AttemptDetailRules.MaximumPathLength);
        model.Entity<NodeRepairFailureRow>().Property(x => x.Step).HasMaxLength(AttemptDetailRules.MaximumStepLength);
        model.Entity<NodeRepairFailureRow>().HasOne<NodeRow>().WithMany().HasForeignKey(x => x.NodeId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<IssueStateRow>().ToTable("issue_states").HasKey(x => new { x.WorkspaceId, x.IssueId });
        model.Entity<IssueStateRow>().Property(x => x.IssueId).HasMaxLength(300);
        model.Entity<IssueStateRow>().Property(x => x.State).HasMaxLength(16);
        model.Entity<IssueStateRow>().Property(x => x.Actor).HasMaxLength(200);
        model.Entity<IssueStateRow>().HasOne<WorkspaceRow>().WithMany().HasForeignKey(x => x.WorkspaceId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<NodeTelemetryRow>().ToTable("node_telemetry").HasKey(x => x.NodeId);
        model.Entity<NodeTelemetryRow>().Property(x => x.AgentVersion).HasMaxLength(128);
        model.Entity<NodeTelemetryRow>().Property(x => x.OsName).HasMaxLength(128);
        model.Entity<NodeTelemetryRow>().Property(x => x.OsVersion).HasMaxLength(128);
        model.Entity<NodeTelemetryRow>().Property(x => x.OsKernel).HasMaxLength(128);
        model.Entity<NodeTelemetryRow>().Property(x => x.Arch).HasMaxLength(128);
        model.Entity<NodeTelemetryRow>().Property(x => x.Hostname).HasMaxLength(128);
        model.Entity<NodeTelemetryRow>().Property(x => x.User).HasMaxLength(128);
        model.Entity<NodeTelemetryRow>().Property(x => x.InstallMethod).HasMaxLength(16);
        model.Entity<NodeTelemetryRow>().Property(x => x.ServiceManager).HasMaxLength(16);
        model.Entity<NodeTelemetryRow>().Property(x => x.StateDirectory).HasMaxLength(512);
        model.Entity<NodeTelemetryRow>().HasOne<NodeRow>().WithMany().HasForeignKey(x => x.NodeId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<AgentUpdateRow>().ToTable("agent_updates").HasKey(x => x.NodeId);
        model.Entity<AgentUpdateRow>().Property(x => x.FromVersion).HasMaxLength(AgentTelemetryRules.MaximumLength);
        model.Entity<AgentUpdateRow>().Property(x => x.TargetVersion).HasMaxLength(AgentUpdateRules.MaximumVersionLength);
        model.Entity<AgentUpdateRow>().Property(x => x.State).HasMaxLength(AgentUpdateRules.MaximumStateLength);
        model.Entity<AgentUpdateRow>().Property(x => x.ErrorCode).HasMaxLength(AgentUpdateRules.MaximumErrorCodeLength);
        model.Entity<AgentUpdateRow>().Property(x => x.RequestedBy).HasMaxLength(200);
        model.Entity<AgentUpdateRow>().HasOne<NodeRow>().WithMany().HasForeignKey(x => x.NodeId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<CredentialRow>().ToTable("node_credentials").HasKey(x => x.Id);
        model.Entity<CredentialRow>().HasIndex(x => x.CertificateSha256).IsUnique();
        model.Entity<CredentialRow>().HasIndex(x => new { x.NodeId, x.RevokedAt });
        model.Entity<CredentialRow>().HasOne<NodeRow>().WithMany().HasForeignKey(x => x.NodeId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<EnrollmentRow>().ToTable("enrollment_authorizations").HasKey(x => x.Id);
        model.Entity<EnrollmentRow>().HasIndex(x => x.TokenSha256).IsUnique();
        model.Entity<EnrollmentRow>().HasIndex(x => x.RetryUntil).HasFilter("\"DeliveryPayload\" IS NOT NULL");
        model.Entity<EnrollmentRow>().Property(x => x.DeliveryPayload).HasColumnType("bytea");
        model.Entity<EnrollmentRow>().HasOne<WorkspaceRow>().WithMany().HasForeignKey(x => x.WorkspaceId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<BundleRow>().ToTable("bundles").HasKey(x => x.Digest);
        model.Entity<BundleRow>().Property(x => x.Content).HasColumnType("bytea");
        model.Entity<DesiredRevisionRow>().ToTable("desired_revisions").HasKey(x => x.Id);
        model.Entity<DesiredRevisionRow>().Property(x => x.CommitSubject).HasMaxLength(CommitMetadataRules.MaximumSubjectLength);
        model.Entity<DesiredRevisionRow>().Property(x => x.CommitAuthor).HasMaxLength(CommitMetadataRules.MaximumAuthorLength);
        model.Entity<DesiredRevisionRow>().HasIndex(x => new { x.WorkspaceId, x.SourceRevision }).IsUnique();
        model.Entity<DesiredRevisionRow>().HasIndex(x => new { x.WorkspaceId, x.AcceptedAt, x.Id });
        model.Entity<DesiredRevisionRow>().HasOne<WorkspaceRow>().WithMany().HasForeignKey(x => x.WorkspaceId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<WarningRow>().ToTable("source_warnings").HasKey(x => x.Id);
        model.Entity<WarningRow>().Property(x => x.SourceLocations).HasColumnType("jsonb");
        model.Entity<WarningRow>().HasOne<DesiredRevisionRow>().WithMany().HasForeignKey(x => x.DesiredRevisionId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<RolloutRow>().ToTable("rollouts").HasKey(x => x.Id);
        model.Entity<RolloutRow>().HasIndex(x => new { x.CreatedAt, x.Id });
        model.Entity<RolloutRow>().HasOne<DesiredRevisionRow>().WithMany().HasForeignKey(x => x.DesiredRevisionId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<AssignmentRow>().ToTable("assignments").HasKey(x => x.Id);
        model.Entity<AssignmentRow>().HasIndex(x => new { x.NodeId, x.TargetName, x.IsCurrent }).HasFilter("\"IsCurrent\"").IsUnique();
        model.Entity<AssignmentRow>().HasIndex(x => new { x.RolloutId, x.Id });
        // The history of one Target of one Node, for the previous Assignment in the revision diff.
        model.Entity<AssignmentRow>().HasIndex(x => new { x.NodeId, x.TargetName, x.CreatedAt });
        model.Entity<AssignmentRow>().HasOne<RolloutRow>().WithMany().HasForeignKey(x => x.RolloutId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<AssignmentRow>().HasOne<DesiredRevisionRow>().WithMany().HasForeignKey(x => x.DesiredRevisionId).OnDelete(DeleteBehavior.Restrict);
        model.Entity<AssignmentRow>().HasOne<NodeRow>().WithMany().HasForeignKey(x => x.NodeId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<AssignmentSkillRow>().ToTable("assignment_skills").HasKey(x => new { x.AssignmentId, x.Name });
        model.Entity<AssignmentSkillRow>().HasIndex(x => x.BundleDigest);
        model.Entity<AssignmentSkillRow>().HasOne<AssignmentRow>().WithMany().HasForeignKey(x => x.AssignmentId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<AssignmentSkillRow>().HasOne<BundleRow>().WithMany().HasForeignKey(x => x.BundleDigest).OnDelete(DeleteBehavior.Restrict);
        model.Entity<AssignmentFileRow>().ToTable("assignment_files").HasKey(x => x.AssignmentId);
        model.Entity<AssignmentFileRow>().HasIndex(x => x.BundleDigest);
        model.Entity<AssignmentFileRow>().HasOne<AssignmentRow>().WithOne().HasForeignKey<AssignmentFileRow>(x => x.AssignmentId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<AssignmentFileRow>().HasOne<BundleRow>().WithMany().HasForeignKey(x => x.BundleDigest).OnDelete(DeleteBehavior.Restrict);
        model.Entity<AssignmentAiClientRow>().ToTable("assignment_ai_clients").HasKey(x => x.AssignmentId);
        model.Entity<AssignmentAiClientRow>().HasOne<AssignmentRow>().WithOne().HasForeignKey<AssignmentAiClientRow>(x => x.AssignmentId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<AttemptRow>().ToTable("attempts").HasKey(x => x.Id);
        model.Entity<AttemptRow>().Property(x => x.FailurePath).HasMaxLength(512);
        model.Entity<AttemptRow>().Property(x => x.FailureStep).HasMaxLength(32);
        model.Entity<AttemptRow>().HasIndex(x => new { x.AssignmentId, x.Id });
        model.Entity<AttemptRow>().HasIndex(x => new { x.RolloutId, x.Id });
        // Latest Attempt of an Assignment, and the first/latest/count of its failed Attempts, without reading them all.
        model.Entity<AttemptRow>().HasIndex(x => new { x.AssignmentId, x.UpdatedAt, x.Id });
        model.Entity<AttemptRow>().HasIndex(x => new { x.AssignmentId, x.UpdatedAt }).HasFilter("\"State\" = 3");
        model.Entity<AttemptRow>().HasOne<AssignmentRow>().WithMany().HasForeignKey(x => x.AssignmentId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<AttemptRow>().HasOne<RolloutRow>().WithMany().HasForeignKey(x => x.RolloutId).OnDelete(DeleteBehavior.Restrict);
        model.Entity<AttemptRow>().HasOne<NodeRow>().WithMany().HasForeignKey(x => x.NodeId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<SourceScanRow>().ToTable("source_scans").HasKey(x => x.Id);
        model.Entity<SourceScanRow>().HasIndex(x => new { x.WorkspaceId, x.ObservedAt });
        model.Entity<SourceScanRow>().HasOne<WorkspaceRow>().WithMany().HasForeignKey(x => x.WorkspaceId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<AuditEventRow>().ToTable("audit_events").HasKey(x => x.Id);
        model.Entity<AuditEventRow>().HasIndex(x => new { x.WorkspaceId, x.Id });
        model.Entity<AuditEventRow>().HasIndex(x => new { x.WorkspaceId, x.RecordedAt, x.Id });
        model.Entity<AuditEventRow>().Property(x => x.Account).HasMaxLength(64);
        model.Entity<AuditEventRow>().Property(x => x.Detail).HasMaxLength(64);
        model.Entity<AuditEventRow>().HasOne<WorkspaceRow>().WithMany().HasForeignKey(x => x.WorkspaceId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<CliProxySelectionRow>().ToTable("cliproxy_selections").HasKey(x => x.BaseUrl);
        model.Entity<OperatorAccountRow>().ToTable("operator_accounts").HasKey(x => x.Id);
        model.Entity<OperatorAccountRow>().Property(x => x.Name).HasMaxLength(64);
        model.Entity<OperatorAccountRow>().Property(x => x.Scope).HasMaxLength(16);
        model.Entity<OperatorAccountRow>().HasIndex(x => new { x.WorkspaceId, x.Name }).IsUnique();
        model.Entity<OperatorAccountRow>().HasOne<WorkspaceRow>().WithMany().HasForeignKey(x => x.WorkspaceId).OnDelete(DeleteBehavior.Cascade);
    }
}

public sealed class WorkspaceRow { public Guid Id { get; set; } public int SingletonKey { get; set; } = 1; public required string Name { get; set; } }
public sealed class NodeRow
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    public required string Name { get; set; }
    public required string Platform { get; set; }
    public DateTimeOffset EnrolledAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
    public DateTimeOffset? LastContactAt { get; set; }
    // Set by an Operator's disk refresh request, cleared by the next disk report. Poll reads it from the Node row it already loads.
    public DateTimeOffset? DiskUsageRefreshRequestedAt { get; set; }
    // Whether the Agent announced the agent-update capability on its latest poll. Written by every poll with the contact time.
    public bool AgentSelfUpdate { get; set; }
}
// The latest report only: one row per Node and volume label, replaced as a whole by each report.
public sealed class NodeDiskUsageRow
{
    public Guid NodeId { get; set; }
    public required string Label { get; set; }
    public long TotalBytes { get; set; }
    public long UsedBytes { get; set; }
    public long AvailableBytes { get; set; }
    public DateTimeOffset MeasuredAt { get; set; }
}
// The latest Agent and machine report only: one row per Node, replaced as a whole by each report. Hostname and user identify people and machines.
public sealed class NodeTelemetryRow
{
    public Guid NodeId { get; set; }
    public required string AgentVersion { get; set; }
    public string? OsName { get; set; }
    public string? OsVersion { get; set; }
    public string? OsKernel { get; set; }
    public string? Arch { get; set; }
    public string? Hostname { get; set; }
    public string? User { get; set; }
    public string? InstallMethod { get; set; }
    public string? ServiceManager { get; set; }
    public string? StateDirectory { get; set; }
    public DateTimeOffset ReportedAt { get; set; }
}
public sealed class NodeCheckinRow
{
    public Guid NodeId { get; set; }
    // Start of the UTC hour in which the polls arrived.
    public DateTimeOffset Hour { get; set; }
    public int Polls { get; set; }
}
public sealed class CredentialRow
{
    public Guid Id { get; set; }
    public Guid NodeId { get; set; }
    public required string CertificateSha256 { get; set; }
    public DateTimeOffset NotBefore { get; set; }
    public DateTimeOffset NotAfter { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
    public string? RevokedBy { get; set; }
}
public sealed class EnrollmentRow
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    public required string TokenSha256 { get; set; }
    public required string CreatedBy { get; set; }
    public string? BoundAlias { get; set; }
    public DateTimeOffset ExpiresAt { get; set; }
    public long RetryWindowTicks { get; set; }
    public DateTimeOffset? ConsumedAt { get; set; }
    public DateTimeOffset? RetryUntil { get; set; }
    public string? CertificateRequestSha256 { get; set; }
    public Guid? NodeId { get; set; }
    public Guid? CredentialId { get; set; }
    public byte[]? DeliveryPayload { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
    public string? RevokedBy { get; set; }
}
public sealed class BundleRow
{
    public required string Digest { get; set; }
    public required string Schema { get; set; }
    public long Size { get; set; }
    public required byte[] Content { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}
public sealed class DesiredRevisionRow
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    public required string SourceRevision { get; set; }
    public DateTimeOffset AcceptedAt { get; set; }
    // The tip commit, read when the scan accepted the revision. Null for older revisions and when Git could not be read. No email.
    public string? CommitSubject { get; set; }
    public string? CommitAuthor { get; set; }
    public DateTimeOffset? CommittedAt { get; set; }
}
public sealed class WarningRow
{
    public Guid Id { get; set; }
    public Guid DesiredRevisionId { get; set; }
    public required string Code { get; set; }
    public required string Message { get; set; }
    public required string SourceLocations { get; set; }
}
public sealed class RolloutRow { public Guid Id { get; set; } public Guid DesiredRevisionId { get; set; } public DateTimeOffset CreatedAt { get; set; } }
public sealed class AssignmentRow
{
    public Guid Id { get; set; }
    public Guid RolloutId { get; set; }
    public Guid DesiredRevisionId { get; set; }
    public Guid NodeId { get; set; }
    public required string TargetName { get; set; }
    public required string TargetBase { get; set; }
    public required string TargetPath { get; set; }
    public bool IsCurrent { get; set; }
    public int State { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}
public sealed class AssignmentSkillRow
{
    public Guid AssignmentId { get; set; }
    public required string Name { get; set; }
    public required string BundleDigest { get; set; }
    public int Ordinal { get; set; }
}
public sealed class AssignmentFileRow
{
    public Guid AssignmentId { get; set; }
    public required string Name { get; set; }
    public string? BundleDigest { get; set; }
}
public sealed class AssignmentAiClientRow
{
    public Guid AssignmentId { get; set; }
    public required string Schema { get; set; }
    public required string Client { get; set; }
    public required string Mode { get; set; }
    public string? BaseUrl { get; set; }
    public string? Model { get; set; }
}
public sealed class AttemptRow
{
    public Guid Id { get; set; }
    public Guid AssignmentId { get; set; }
    public Guid RolloutId { get; set; }
    public Guid NodeId { get; set; }
    public int State { get; set; }
    public string? ErrorCode { get; set; }
    public string? Diagnostic { get; set; }
    public string? FailurePath { get; set; }
    public string? FailureStep { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}
public sealed class SourceScanRow
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    public string? SourceRevision { get; set; }
    public int Outcome { get; set; }
    public string? Code { get; set; }
    public string? Diagnostic { get; set; }
    public DateTimeOffset ObservedAt { get; set; }
    public string? RequestedBy { get; set; }
}
public sealed class AuditEventRow
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    public DateTimeOffset RecordedAt { get; set; }
    public required string Action { get; set; }
    public required string Actor { get; set; }
    public Guid? NodeId { get; set; }
    public Guid? CredentialId { get; set; }
    // The dashboard account an account.* event is about, and a short detail such as "operate -> read" for a scope change.
    public string? Account { get; set; }
    public string? Detail { get; set; }
}
public sealed class CliProxySelectionRow
{
    public required string BaseUrl { get; set; }
    public required string PolicyJson { get; set; }
    public long Version { get; set; }
}
// Files an Agent repaired in a Target because they were changed outside Fleet. The newest 20 per Node are kept.
public sealed class NodeDriftEventRow
{
    public Guid Id { get; set; }
    public Guid NodeId { get; set; }
    public required string Target { get; set; }
    public required string[] Files { get; set; }
    public DateTimeOffset DetectedAt { get; set; }
}
// An idle repair of a current Assignment that fails on the Node. The Agent's latest report replaces all rows of the Node.
public sealed class NodeRepairFailureRow
{
    public Guid NodeId { get; set; }
    public required string Target { get; set; }
    public Guid AssignmentId { get; set; }
    public required string ErrorCode { get; set; }
    public required string Diagnostic { get; set; }
    public string? Path { get; set; }
    public string? Step { get; set; }
    public DateTimeOffset FailedSince { get; set; }
    public DateTimeOffset ReportedAt { get; set; }
}
// The latest Agent update of a Node. Requesting again replaces a finished row; the audit log keeps the history.
public sealed class AgentUpdateRow
{
    public Guid NodeId { get; set; }
    // New for each request, so the Agent's reports about an earlier request of the same version cannot change a later one.
    public Guid UpdateId { get; set; }
    public string? FromVersion { get; set; }
    public required string TargetVersion { get; set; }
    public required string State { get; set; }
    public string? ErrorCode { get; set; }
    public required string RequestedBy { get; set; }
    public DateTimeOffset RequestedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset? FinishedAt { get; set; }
}
// An Operator's acknowledgement or snooze of one issue. Expired and obsolete rows are deleted lazily by the next change.
public sealed class IssueStateRow
{
    public Guid WorkspaceId { get; set; }
    public required string IssueId { get; set; }
    public required string State { get; set; }
    public DateTimeOffset? Since { get; set; }
    public DateTimeOffset? SnoozedUntil { get; set; }
    public required string Actor { get; set; }
    public DateTimeOffset At { get; set; }
}
// A dashboard sign-in account. Bearer Operator tokens stay in configuration; accounts only sign in to the dashboard.
public sealed class OperatorAccountRow
{
    public Guid Id { get; set; }
    public Guid WorkspaceId { get; set; }
    // Lowercase, unique within the Workspace. It is the actor recorded in audit events.
    public required string Name { get; set; }
    public required string PasswordHash { get; set; }
    public required string Scope { get; set; }
    public bool MustChangePassword { get; set; }
    // Rotated by every password, scope or deletion change, which ends the account's existing sessions.
    public Guid SecurityStamp { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}
