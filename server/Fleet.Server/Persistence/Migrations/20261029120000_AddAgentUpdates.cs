using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Fleet.Server.Persistence.Migrations;

/// <summary>
/// Agent self-update: the latest update of each Node, and whether the Node's Agent announced the agent-update capability on its
/// latest poll. Existing Nodes start without the capability until their next poll.
/// </summary>
[DbContext(typeof(FleetDbContext))]
[Migration("20261029120000_AddAgentUpdates")]
public sealed class AddAgentUpdates : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<bool>(
            name: "AgentSelfUpdate",
            table: "nodes",
            type: "boolean",
            nullable: false,
            defaultValue: false);
        migrationBuilder.CreateTable(
            name: "agent_updates",
            columns: table => new
            {
                NodeId = table.Column<Guid>(type: "uuid", nullable: false),
                FromVersion = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                TargetVersion = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                State = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                ErrorCode = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: true),
                RequestedBy = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                RequestedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                FinishedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_agent_updates", x => x.NodeId);
                table.ForeignKey(
                    name: "FK_agent_updates_nodes_NodeId",
                    column: x => x.NodeId,
                    principalTable: "nodes",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Cascade);
            });
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable(name: "agent_updates");
        migrationBuilder.DropColumn(name: "AgentSelfUpdate", table: "nodes");
    }
}
