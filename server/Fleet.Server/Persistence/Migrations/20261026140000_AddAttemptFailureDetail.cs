using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Fleet.Server.Persistence.Migrations;

/// <summary>Where and in which step a failed Attempt failed, sent by the Agent on <c>POST /agent/v1/attempts/{id}/detail</c>.</summary>
[DbContext(typeof(FleetDbContext))]
[Migration("20261026140000_AddAttemptFailureDetail")]
public sealed class AddAttemptFailureDetail : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<string>(
            name: "FailurePath",
            table: "attempts",
            type: "character varying(512)",
            maxLength: 512,
            nullable: true);
        migrationBuilder.AddColumn<string>(
            name: "FailureStep",
            table: "attempts",
            type: "character varying(32)",
            maxLength: 32,
            nullable: true);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropColumn(name: "FailureStep", table: "attempts");
        migrationBuilder.DropColumn(name: "FailurePath", table: "attempts");
    }
}
