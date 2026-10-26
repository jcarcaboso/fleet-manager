using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Fleet.Server.Persistence.Migrations;

/// <summary>The latest Agent and machine report per Node: one row, replaced by each report and deleted with the Node.</summary>
[DbContext(typeof(FleetDbContext))]
[Migration("20261026160000_AddNodeTelemetry")]
public sealed class AddNodeTelemetry : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "node_telemetry",
            columns: table => new
            {
                NodeId = table.Column<Guid>(type: "uuid", nullable: false),
                AgentVersion = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: false),
                OsName = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                OsVersion = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                OsKernel = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                Arch = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                Hostname = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                User = table.Column<string>(type: "character varying(128)", maxLength: 128, nullable: true),
                InstallMethod = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: true),
                ServiceManager = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: true),
                StateDirectory = table.Column<string>(type: "character varying(512)", maxLength: 512, nullable: true),
                ReportedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_node_telemetry", x => x.NodeId);
                table.ForeignKey(
                    name: "FK_node_telemetry_nodes_NodeId",
                    column: x => x.NodeId,
                    principalTable: "nodes",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Cascade);
            });
    }

    protected override void Down(MigrationBuilder migrationBuilder) => migrationBuilder.DropTable("node_telemetry");
}
