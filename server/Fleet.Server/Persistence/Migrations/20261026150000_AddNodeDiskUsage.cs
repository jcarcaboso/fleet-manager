using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Fleet.Server.Persistence.Migrations;

/// <summary>
/// The latest disk usage report per Node (one row per volume, replaced by each report) and the pending refresh request.
/// The request is a nullable column on nodes, so poll reads it from the Node row it already loads.
/// </summary>
[DbContext(typeof(FleetDbContext))]
[Migration("20261026150000_AddNodeDiskUsage")]
public sealed class AddNodeDiskUsage : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<DateTimeOffset>(
            name: "DiskUsageRefreshRequestedAt",
            table: "nodes",
            type: "timestamp with time zone",
            nullable: true);
        migrationBuilder.CreateTable(
            name: "node_disk_usage",
            columns: table => new
            {
                NodeId = table.Column<Guid>(type: "uuid", nullable: false),
                Label = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                TotalBytes = table.Column<long>(type: "bigint", nullable: false),
                UsedBytes = table.Column<long>(type: "bigint", nullable: false),
                AvailableBytes = table.Column<long>(type: "bigint", nullable: false),
                MeasuredAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_node_disk_usage", x => new { x.NodeId, x.Label });
                table.ForeignKey(
                    name: "FK_node_disk_usage_nodes_NodeId",
                    column: x => x.NodeId,
                    principalTable: "nodes",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Cascade);
            });
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropTable("node_disk_usage");
        migrationBuilder.DropColumn(name: "DiskUsageRefreshRequestedAt", table: "nodes");
    }
}
