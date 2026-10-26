using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Fleet.Server.Persistence.Migrations;

/// <summary>
/// Phase 4 of the device dashboard: commit metadata on desired revisions, drift events per Node, Operator issue states, and an
/// index for the previous Assignment of a Target.
/// </summary>
[DbContext(typeof(FleetDbContext))]
[Migration("20261027120000_AddDeploymentsDriftAndIssueState")]
public sealed class AddDeploymentsDriftAndIssueState : Migration
{
    private const string AssignmentHistoryIndex = "IX_assignments_NodeId_TargetName_CreatedAt";

    protected override void Up(MigrationBuilder migrationBuilder)
    {
        // Run the nontransactional index build first. If it is interrupted, no schema additions have committed without the
        // migration history row; rerunning can drop an invalid index and retry. The remaining DDL and history commit together.
        migrationBuilder.Sql($"DROP INDEX CONCURRENTLY IF EXISTS \"{AssignmentHistoryIndex}\";", suppressTransaction: true);
        migrationBuilder.Sql($"CREATE INDEX CONCURRENTLY \"{AssignmentHistoryIndex}\" ON assignments (\"NodeId\", \"TargetName\", \"CreatedAt\");",
            suppressTransaction: true);

        migrationBuilder.AddColumn<string>(
            name: "CommitSubject",
            table: "desired_revisions",
            type: "character varying(200)",
            maxLength: 200,
            nullable: true);
        migrationBuilder.AddColumn<string>(
            name: "CommitAuthor",
            table: "desired_revisions",
            type: "character varying(128)",
            maxLength: 128,
            nullable: true);
        migrationBuilder.AddColumn<DateTimeOffset>(
            name: "CommittedAt",
            table: "desired_revisions",
            type: "timestamp with time zone",
            nullable: true);

        migrationBuilder.CreateTable(
            name: "node_drift_events",
            columns: table => new
            {
                Id = table.Column<Guid>(type: "uuid", nullable: false),
                NodeId = table.Column<Guid>(type: "uuid", nullable: false),
                Target = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                Files = table.Column<string[]>(type: "text[]", nullable: false),
                DetectedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_node_drift_events", x => x.Id);
                table.ForeignKey(
                    name: "FK_node_drift_events_nodes_NodeId",
                    column: x => x.NodeId,
                    principalTable: "nodes",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Cascade);
            });
        migrationBuilder.CreateIndex(
            name: "IX_node_drift_events_NodeId_DetectedAt_Id",
            table: "node_drift_events",
            columns: ["NodeId", "DetectedAt", "Id"]);

        migrationBuilder.CreateTable(
            name: "issue_states",
            columns: table => new
            {
                WorkspaceId = table.Column<Guid>(type: "uuid", nullable: false),
                IssueId = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                State = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                Since = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                SnoozedUntil = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                Actor = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                At = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_issue_states", x => new { x.WorkspaceId, x.IssueId });
                table.ForeignKey(
                    name: "FK_issue_states_workspaces_WorkspaceId",
                    column: x => x.WorkspaceId,
                    principalTable: "workspaces",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Cascade);
            });

    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql($"DROP INDEX CONCURRENTLY IF EXISTS \"{AssignmentHistoryIndex}\";", suppressTransaction: true);
        migrationBuilder.DropTable(name: "issue_states");
        migrationBuilder.DropTable(name: "node_drift_events");
        migrationBuilder.DropColumn(name: "CommittedAt", table: "desired_revisions");
        migrationBuilder.DropColumn(name: "CommitAuthor", table: "desired_revisions");
        migrationBuilder.DropColumn(name: "CommitSubject", table: "desired_revisions");
    }
}
