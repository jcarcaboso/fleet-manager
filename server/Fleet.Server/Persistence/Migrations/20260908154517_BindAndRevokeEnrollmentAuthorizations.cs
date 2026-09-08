using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Fleet.Server.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class BindAndRevokeEnrollmentAuthorizations : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "BoundAlias",
                table: "enrollment_authorizations",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<DateTimeOffset>(
                name: "RevokedAt",
                table: "enrollment_authorizations",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "RevokedBy",
                table: "enrollment_authorizations",
                type: "text",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "BoundAlias",
                table: "enrollment_authorizations");

            migrationBuilder.DropColumn(
                name: "RevokedAt",
                table: "enrollment_authorizations");

            migrationBuilder.DropColumn(
                name: "RevokedBy",
                table: "enrollment_authorizations");
        }
    }
}
