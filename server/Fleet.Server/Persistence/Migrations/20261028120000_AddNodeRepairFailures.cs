using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Fleet.Server.Persistence.Migrations;

/// <summary>
/// Idle repairs that fail on a Node after its Assignment succeeded. The Agent reports the whole set, which replaces the Node's rows.
/// </summary>
[DbContext(typeof(FleetDbContext))]
[Migration("20261028120000_AddNodeRepairFailures")]
public sealed class AddNodeRepairFailures : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "node_repair_failures",
            columns: table => new
            {
                NodeId = table.Column<Guid>(type: "uuid", nullable: false),
                Target = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                AssignmentId = table.Column<Guid>(type: "uuid", nullable: false),
                ErrorCode = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                Diagnostic = table.Column<string>(type: "text", nullable: false),
                Path = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: true),
                Step = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                FailedSince = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                ReportedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_node_repair_failures", x => new { x.NodeId, x.Target });
                table.ForeignKey(
                    name: "FK_node_repair_failures_nodes_NodeId",
                    column: x => x.NodeId,
                    principalTable: "nodes",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Cascade);
            });
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(name: "node_repair_failures");
    }
}
