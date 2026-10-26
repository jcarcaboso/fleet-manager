using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Fleet.Server.Persistence.Migrations;

[DbContext(typeof(FleetDbContext))]
[Migration("20261026120000_AddNodeCheckins")]
public sealed class AddNodeCheckins : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "node_checkins",
            columns: table => new
            {
                NodeId = table.Column<Guid>(type: "uuid", nullable: false),
                Hour = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                Polls = table.Column<int>(type: "integer", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_node_checkins", x => new { x.NodeId, x.Hour });
                table.ForeignKey(
                    name: "FK_node_checkins_nodes_NodeId",
                    column: x => x.NodeId,
                    principalTable: "nodes",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Cascade);
            });
        migrationBuilder.CreateIndex(
            name: "IX_node_checkins_Hour",
            table: "node_checkins",
            column: "Hour");
    }

    protected override void Down(MigrationBuilder migrationBuilder) => migrationBuilder.DropTable("node_checkins");
}
