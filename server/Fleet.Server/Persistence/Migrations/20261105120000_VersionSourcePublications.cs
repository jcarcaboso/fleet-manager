using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Fleet.Server.Persistence.Migrations;

[DbContext(typeof(FleetDbContext))]
[Migration("20261105120000_VersionSourcePublications")]
public sealed class VersionSourcePublications : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<int>(
            name: "PublicationVersion",
            table: "desired_revisions",
            type: "integer",
            nullable: false,
            defaultValue: 1);
        migrationBuilder.DropIndex(
            name: "IX_desired_revisions_WorkspaceId_SourceRevision",
            table: "desired_revisions");
        migrationBuilder.CreateIndex(
            name: "IX_desired_revisions_SourcePublication",
            table: "desired_revisions",
            columns: ["WorkspaceId", "SourceRevision", "PublicationVersion"],
            unique: true);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropIndex(
            name: "IX_desired_revisions_SourcePublication",
            table: "desired_revisions");
        migrationBuilder.DropColumn(name: "PublicationVersion", table: "desired_revisions");
        migrationBuilder.CreateIndex(
            name: "IX_desired_revisions_WorkspaceId_SourceRevision",
            table: "desired_revisions",
            columns: ["WorkspaceId", "SourceRevision"],
            unique: true);
    }
}
