using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Fleet.Server.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class HardenPersistenceTransactions : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "SingletonKey",
                table: "workspaces",
                type: "integer",
                nullable: false,
                defaultValue: 1);

            migrationBuilder.CreateIndex(
                name: "IX_workspaces_SingletonKey",
                table: "workspaces",
                column: "SingletonKey",
                unique: true);

            migrationBuilder.AddCheckConstraint(
                name: "ck_workspaces_singleton",
                table: "workspaces",
                sql: "\"SingletonKey\" = 1");

            migrationBuilder.CreateIndex(
                name: "IX_enrollment_authorizations_RetryUntil",
                table: "enrollment_authorizations",
                column: "RetryUntil",
                filter: "\"DeliveryPayload\" IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_audit_events_WorkspaceId_RecordedAt",
                table: "audit_events",
                columns: new[] { "WorkspaceId", "RecordedAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_workspaces_SingletonKey",
                table: "workspaces");

            migrationBuilder.DropCheckConstraint(
                name: "ck_workspaces_singleton",
                table: "workspaces");

            migrationBuilder.DropIndex(
                name: "IX_enrollment_authorizations_RetryUntil",
                table: "enrollment_authorizations");

            migrationBuilder.DropIndex(
                name: "IX_audit_events_WorkspaceId_RecordedAt",
                table: "audit_events");

            migrationBuilder.DropColumn(
                name: "SingletonKey",
                table: "workspaces");
        }
    }
}
