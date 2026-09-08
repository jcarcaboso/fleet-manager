using Microsoft.EntityFrameworkCore;

namespace Fleet.Server.Persistence;

public sealed class FleetDbContext(DbContextOptions<FleetDbContext> options) : DbContext(options)
{
    public DbSet<WorkspaceRow> Workspaces => Set<WorkspaceRow>();
    public DbSet<NodeRow> Nodes => Set<NodeRow>();
    public DbSet<CredentialRow> Credentials => Set<CredentialRow>();
    public DbSet<EnrollmentRow> Enrollments => Set<EnrollmentRow>();
    public DbSet<BundleRow> Bundles => Set<BundleRow>();
    public DbSet<DesiredRevisionRow> DesiredRevisions => Set<DesiredRevisionRow>();
    public DbSet<WarningRow> Warnings => Set<WarningRow>();
    public DbSet<RolloutRow> Rollouts => Set<RolloutRow>();
    public DbSet<AssignmentRow> Assignments => Set<AssignmentRow>();
    public DbSet<AssignmentSkillRow> AssignmentSkills => Set<AssignmentSkillRow>();
    public DbSet<AttemptRow> Attempts => Set<AttemptRow>();
    public DbSet<SourceScanRow> SourceScans => Set<SourceScanRow>();
    public DbSet<AuditEventRow> AuditEvents => Set<AuditEventRow>();

    protected override void OnModelCreating(ModelBuilder model)
    {
        model.Entity<WorkspaceRow>().ToTable("workspaces").HasKey(x => x.Id);
        model.Entity<WorkspaceRow>().HasIndex(x => x.SingletonKey).IsUnique();
        model.Entity<WorkspaceRow>().ToTable(x => x.HasCheckConstraint("ck_workspaces_singleton", "\"SingletonKey\" = 1"));
        model.Entity<NodeRow>().ToTable("nodes").HasKey(x => x.Id);
        model.Entity<NodeRow>().HasIndex(x => new { x.WorkspaceId, x.Name }).IsUnique();
        model.Entity<NodeRow>().HasIndex(x => new { x.WorkspaceId, x.LastContactAt });
        model.Entity<NodeRow>().HasOne<WorkspaceRow>().WithMany().HasForeignKey(x => x.WorkspaceId).OnDelete(DeleteBehavior.Restrict);
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
        model.Entity<DesiredRevisionRow>().HasIndex(x => new { x.WorkspaceId, x.SourceRevision }).IsUnique();
        model.Entity<DesiredRevisionRow>().HasOne<WorkspaceRow>().WithMany().HasForeignKey(x => x.WorkspaceId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<WarningRow>().ToTable("source_warnings").HasKey(x => x.Id);
        model.Entity<WarningRow>().Property(x => x.SourceLocations).HasColumnType("jsonb");
        model.Entity<WarningRow>().HasOne<DesiredRevisionRow>().WithMany().HasForeignKey(x => x.DesiredRevisionId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<RolloutRow>().ToTable("rollouts").HasKey(x => x.Id);
        model.Entity<RolloutRow>().HasOne<DesiredRevisionRow>().WithMany().HasForeignKey(x => x.DesiredRevisionId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<AssignmentRow>().ToTable("assignments").HasKey(x => x.Id);
        model.Entity<AssignmentRow>().HasIndex(x => new { x.NodeId, x.TargetName, x.IsCurrent }).HasFilter("\"IsCurrent\"").IsUnique();
        model.Entity<AssignmentRow>().HasIndex(x => new { x.RolloutId, x.Id });
        model.Entity<AssignmentRow>().HasOne<RolloutRow>().WithMany().HasForeignKey(x => x.RolloutId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<AssignmentRow>().HasOne<DesiredRevisionRow>().WithMany().HasForeignKey(x => x.DesiredRevisionId).OnDelete(DeleteBehavior.Restrict);
        model.Entity<AssignmentRow>().HasOne<NodeRow>().WithMany().HasForeignKey(x => x.NodeId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<AssignmentSkillRow>().ToTable("assignment_skills").HasKey(x => new { x.AssignmentId, x.Name });
        model.Entity<AssignmentSkillRow>().HasIndex(x => x.BundleDigest);
        model.Entity<AssignmentSkillRow>().HasOne<AssignmentRow>().WithMany().HasForeignKey(x => x.AssignmentId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<AssignmentSkillRow>().HasOne<BundleRow>().WithMany().HasForeignKey(x => x.BundleDigest).OnDelete(DeleteBehavior.Restrict);
        model.Entity<AttemptRow>().ToTable("attempts").HasKey(x => x.Id);
        model.Entity<AttemptRow>().HasIndex(x => new { x.AssignmentId, x.Id });
        model.Entity<AttemptRow>().HasIndex(x => new { x.RolloutId, x.Id });
        model.Entity<AttemptRow>().HasOne<AssignmentRow>().WithMany().HasForeignKey(x => x.AssignmentId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<AttemptRow>().HasOne<RolloutRow>().WithMany().HasForeignKey(x => x.RolloutId).OnDelete(DeleteBehavior.Restrict);
        model.Entity<AttemptRow>().HasOne<NodeRow>().WithMany().HasForeignKey(x => x.NodeId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<SourceScanRow>().ToTable("source_scans").HasKey(x => x.Id);
        model.Entity<SourceScanRow>().HasIndex(x => new { x.WorkspaceId, x.ObservedAt });
        model.Entity<SourceScanRow>().HasOne<WorkspaceRow>().WithMany().HasForeignKey(x => x.WorkspaceId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<AuditEventRow>().ToTable("audit_events").HasKey(x => x.Id);
        model.Entity<AuditEventRow>().HasIndex(x => new { x.WorkspaceId, x.Id });
        model.Entity<AuditEventRow>().HasIndex(x => new { x.WorkspaceId, x.RecordedAt });
        model.Entity<AuditEventRow>().HasOne<WorkspaceRow>().WithMany().HasForeignKey(x => x.WorkspaceId).OnDelete(DeleteBehavior.Cascade);
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
    public DateTimeOffset ExpiresAt { get; set; }
    public long RetryWindowTicks { get; set; }
    public DateTimeOffset? ConsumedAt { get; set; }
    public DateTimeOffset? RetryUntil { get; set; }
    public string? CertificateRequestSha256 { get; set; }
    public Guid? NodeId { get; set; }
    public Guid? CredentialId { get; set; }
    public byte[]? DeliveryPayload { get; set; }
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
public sealed class AttemptRow
{
    public Guid Id { get; set; }
    public Guid AssignmentId { get; set; }
    public Guid RolloutId { get; set; }
    public Guid NodeId { get; set; }
    public int State { get; set; }
    public string? ErrorCode { get; set; }
    public string? Diagnostic { get; set; }
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
}
