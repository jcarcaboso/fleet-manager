using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Fleet.Server.Persistence.Migrations;

[DbContext(typeof(FleetDbContext))]
[Migration("20260923120000_AddCliProxySelections")]
public sealed class AddCliProxySelections : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder) => migrationBuilder.CreateTable(
        name: "cliproxy_selections",
        columns: table => new
        {
            BaseUrl = table.Column<string>(type: "text", nullable: false),
            PolicyJson = table.Column<string>(type: "text", nullable: false),
            Version = table.Column<long>(type: "bigint", nullable: false)
        },
        constraints: table => table.PrimaryKey("PK_cliproxy_selections", x => x.BaseUrl));

    protected override void Down(MigrationBuilder migrationBuilder) => migrationBuilder.DropTable("cliproxy_selections");
}
