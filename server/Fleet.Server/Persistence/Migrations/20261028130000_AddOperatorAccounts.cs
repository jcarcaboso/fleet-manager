using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Fleet.Server.Persistence.Migrations;

/// <summary>
/// Dashboard sign-in accounts. The Server creates the default <c>fleet</c> account on first use, so the migration adds no rows.
/// Audit events gain the account an account.* event is about and a short detail.
/// </summary>
[DbContext(typeof(FleetDbContext))]
[Migration("20261028130000_AddOperatorAccounts")]
public sealed class AddOperatorAccounts : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "operator_accounts",
            columns: table => new
            {
                Id = table.Column<Guid>(type: "uuid", nullable: false),
                WorkspaceId = table.Column<Guid>(type: "uuid", nullable: false),
                Name = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                PasswordHash = table.Column<string>(type: "text", nullable: false),
                Scope = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                MustChangePassword = table.Column<bool>(type: "boolean", nullable: false),
                SecurityStamp = table.Column<Guid>(type: "uuid", nullable: false),
                CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
            },
            constraints: table =>
            {
                table.PrimaryKey("PK_operator_accounts", x => x.Id);
                table.ForeignKey(
                    name: "FK_operator_accounts_workspaces_WorkspaceId",
                    column: x => x.WorkspaceId,
                    principalTable: "workspaces",
                    principalColumn: "Id",
                    onDelete: ReferentialAction.Cascade);
            });
        migrationBuilder.CreateIndex(
            name: "IX_operator_accounts_WorkspaceId_Name",
            table: "operator_accounts",
            columns: ["WorkspaceId", "Name"],
            unique: true);
        migrationBuilder.AddColumn<string>(
            name: "Account",
            table: "audit_events",
            type: "character varying(64)",
            maxLength: 64,
            nullable: true);
        migrationBuilder.AddColumn<string>(
            name: "Detail",
            table: "audit_events",
            type: "character varying(64)",
            maxLength: 64,
            nullable: true);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropColumn(name: "Detail", table: "audit_events");
        migrationBuilder.DropColumn(name: "Account", table: "audit_events");
        migrationBuilder.DropTable(name: "operator_accounts");
    }
}
