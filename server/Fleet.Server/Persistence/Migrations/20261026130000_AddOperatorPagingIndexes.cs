using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Fleet.Server.Persistence.Migrations;

/// <summary>Indexes for newest-first paging of revisions, rollouts and audit events, and for per-Assignment Attempt summaries.</summary>
[DbContext(typeof(FleetDbContext))]
[Migration("20261026130000_AddOperatorPagingIndexes")]
public sealed class AddOperatorPagingIndexes : Migration
{
    // Each index is built CONCURRENTLY outside the migration transaction, so Agents and Operators can keep reading and
    // writing these tables during an upgrade. A build interrupted part-way leaves an invalid index; dropping it first
    // lets a rerun of the migration recover.
    private static readonly (string Name, string Definition)[] Indexes =
    [
        ("IX_desired_revisions_WorkspaceId_AcceptedAt_Id", "desired_revisions (\"WorkspaceId\", \"AcceptedAt\", \"Id\")"),
        ("IX_rollouts_CreatedAt_Id", "rollouts (\"CreatedAt\", \"Id\")"),
        ("IX_audit_events_WorkspaceId_RecordedAt_Id", "audit_events (\"WorkspaceId\", \"RecordedAt\", \"Id\")"),
        ("IX_attempts_AssignmentId_UpdatedAt_Id", "attempts (\"AssignmentId\", \"UpdatedAt\", \"Id\")"),
        ("IX_attempts_AssignmentId_UpdatedAt", "attempts (\"AssignmentId\", \"UpdatedAt\") WHERE \"State\" = 3"),
    ];

    protected override void Up(MigrationBuilder migrationBuilder)
    {
        foreach (var (name, definition) in Indexes)
        {
            migrationBuilder.Sql($"DROP INDEX CONCURRENTLY IF EXISTS \"{name}\";", suppressTransaction: true);
            migrationBuilder.Sql($"CREATE INDEX CONCURRENTLY \"{name}\" ON {definition};", suppressTransaction: true);
        }
        // The old (WorkspaceId, RecordedAt) index is a prefix of the new one, which also serves retention deletes.
        migrationBuilder.Sql("DROP INDEX CONCURRENTLY IF EXISTS \"IX_audit_events_WorkspaceId_RecordedAt\";", suppressTransaction: true);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("CREATE INDEX CONCURRENTLY IF NOT EXISTS \"IX_audit_events_WorkspaceId_RecordedAt\" ON audit_events (\"WorkspaceId\", \"RecordedAt\");",
            suppressTransaction: true);
        foreach (var (name, _) in Indexes.Reverse())
            migrationBuilder.Sql($"DROP INDEX CONCURRENTLY IF EXISTS \"{name}\";", suppressTransaction: true);
    }
}
