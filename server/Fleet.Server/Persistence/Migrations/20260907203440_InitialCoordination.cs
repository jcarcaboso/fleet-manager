using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Fleet.Server.Persistence.Migrations
{
    /// <inheritdoc />
    public partial class InitialCoordination : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "bundles",
                columns: table => new
                {
                    Digest = table.Column<string>(type: "text", nullable: false),
                    Schema = table.Column<string>(type: "text", nullable: false),
                    Size = table.Column<long>(type: "bigint", nullable: false),
                    Content = table.Column<byte[]>(type: "bytea", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_bundles", x => x.Digest);
                });

            migrationBuilder.CreateTable(
                name: "workspaces",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    Name = table.Column<string>(type: "text", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_workspaces", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "desired_revisions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    WorkspaceId = table.Column<Guid>(type: "uuid", nullable: false),
                    SourceRevision = table.Column<string>(type: "text", nullable: false),
                    AcceptedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_desired_revisions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_desired_revisions_workspaces_WorkspaceId",
                        column: x => x.WorkspaceId,
                        principalTable: "workspaces",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "enrollment_authorizations",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    WorkspaceId = table.Column<Guid>(type: "uuid", nullable: false),
                    TokenSha256 = table.Column<string>(type: "text", nullable: false),
                    CreatedBy = table.Column<string>(type: "text", nullable: false),
                    ExpiresAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    RetryWindowTicks = table.Column<long>(type: "bigint", nullable: false),
                    ConsumedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    RetryUntil = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    CertificateRequestSha256 = table.Column<string>(type: "text", nullable: true),
                    NodeId = table.Column<Guid>(type: "uuid", nullable: true),
                    CredentialId = table.Column<Guid>(type: "uuid", nullable: true),
                    DeliveryPayload = table.Column<byte[]>(type: "bytea", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_enrollment_authorizations", x => x.Id);
                    table.ForeignKey(
                        name: "FK_enrollment_authorizations_workspaces_WorkspaceId",
                        column: x => x.WorkspaceId,
                        principalTable: "workspaces",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "nodes",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    WorkspaceId = table.Column<Guid>(type: "uuid", nullable: false),
                    Name = table.Column<string>(type: "text", nullable: false),
                    Platform = table.Column<string>(type: "text", nullable: false),
                    EnrolledAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    RevokedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    LastContactAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_nodes", x => x.Id);
                    table.ForeignKey(
                        name: "FK_nodes_workspaces_WorkspaceId",
                        column: x => x.WorkspaceId,
                        principalTable: "workspaces",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "source_scans",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    WorkspaceId = table.Column<Guid>(type: "uuid", nullable: false),
                    SourceRevision = table.Column<string>(type: "text", nullable: true),
                    Outcome = table.Column<int>(type: "integer", nullable: false),
                    Code = table.Column<string>(type: "text", nullable: true),
                    Diagnostic = table.Column<string>(type: "text", nullable: true),
                    ObservedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    RequestedBy = table.Column<string>(type: "text", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_source_scans", x => x.Id);
                    table.ForeignKey(
                        name: "FK_source_scans_workspaces_WorkspaceId",
                        column: x => x.WorkspaceId,
                        principalTable: "workspaces",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "rollouts",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    DesiredRevisionId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_rollouts", x => x.Id);
                    table.ForeignKey(
                        name: "FK_rollouts_desired_revisions_DesiredRevisionId",
                        column: x => x.DesiredRevisionId,
                        principalTable: "desired_revisions",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "source_warnings",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    DesiredRevisionId = table.Column<Guid>(type: "uuid", nullable: false),
                    Code = table.Column<string>(type: "text", nullable: false),
                    Message = table.Column<string>(type: "text", nullable: false),
                    SourceLocations = table.Column<string>(type: "jsonb", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_source_warnings", x => x.Id);
                    table.ForeignKey(
                        name: "FK_source_warnings_desired_revisions_DesiredRevisionId",
                        column: x => x.DesiredRevisionId,
                        principalTable: "desired_revisions",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "node_credentials",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    NodeId = table.Column<Guid>(type: "uuid", nullable: false),
                    CertificateSha256 = table.Column<string>(type: "text", nullable: false),
                    NotBefore = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    NotAfter = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    RevokedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    RevokedBy = table.Column<string>(type: "text", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_node_credentials", x => x.Id);
                    table.ForeignKey(
                        name: "FK_node_credentials_nodes_NodeId",
                        column: x => x.NodeId,
                        principalTable: "nodes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "assignments",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    RolloutId = table.Column<Guid>(type: "uuid", nullable: false),
                    DesiredRevisionId = table.Column<Guid>(type: "uuid", nullable: false),
                    NodeId = table.Column<Guid>(type: "uuid", nullable: false),
                    TargetName = table.Column<string>(type: "text", nullable: false),
                    TargetBase = table.Column<string>(type: "text", nullable: false),
                    TargetPath = table.Column<string>(type: "text", nullable: false),
                    IsCurrent = table.Column<bool>(type: "boolean", nullable: false),
                    State = table.Column<int>(type: "integer", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_assignments", x => x.Id);
                    table.ForeignKey(
                        name: "FK_assignments_desired_revisions_DesiredRevisionId",
                        column: x => x.DesiredRevisionId,
                        principalTable: "desired_revisions",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_assignments_nodes_NodeId",
                        column: x => x.NodeId,
                        principalTable: "nodes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_assignments_rollouts_RolloutId",
                        column: x => x.RolloutId,
                        principalTable: "rollouts",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "assignment_skills",
                columns: table => new
                {
                    AssignmentId = table.Column<Guid>(type: "uuid", nullable: false),
                    Name = table.Column<string>(type: "text", nullable: false),
                    BundleDigest = table.Column<string>(type: "text", nullable: false),
                    Ordinal = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_assignment_skills", x => new { x.AssignmentId, x.Name });
                    table.ForeignKey(
                        name: "FK_assignment_skills_assignments_AssignmentId",
                        column: x => x.AssignmentId,
                        principalTable: "assignments",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_assignment_skills_bundles_BundleDigest",
                        column: x => x.BundleDigest,
                        principalTable: "bundles",
                        principalColumn: "Digest",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "attempts",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    AssignmentId = table.Column<Guid>(type: "uuid", nullable: false),
                    RolloutId = table.Column<Guid>(type: "uuid", nullable: false),
                    NodeId = table.Column<Guid>(type: "uuid", nullable: false),
                    State = table.Column<int>(type: "integer", nullable: false),
                    ErrorCode = table.Column<string>(type: "text", nullable: true),
                    Diagnostic = table.Column<string>(type: "text", nullable: true),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_attempts", x => x.Id);
                    table.ForeignKey(
                        name: "FK_attempts_assignments_AssignmentId",
                        column: x => x.AssignmentId,
                        principalTable: "assignments",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_attempts_nodes_NodeId",
                        column: x => x.NodeId,
                        principalTable: "nodes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_attempts_rollouts_RolloutId",
                        column: x => x.RolloutId,
                        principalTable: "rollouts",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_assignment_skills_BundleDigest",
                table: "assignment_skills",
                column: "BundleDigest");

            migrationBuilder.CreateIndex(
                name: "IX_assignments_DesiredRevisionId",
                table: "assignments",
                column: "DesiredRevisionId");

            migrationBuilder.CreateIndex(
                name: "IX_assignments_NodeId_TargetName_IsCurrent",
                table: "assignments",
                columns: new[] { "NodeId", "TargetName", "IsCurrent" },
                unique: true,
                filter: "\"IsCurrent\"");

            migrationBuilder.CreateIndex(
                name: "IX_assignments_RolloutId_Id",
                table: "assignments",
                columns: new[] { "RolloutId", "Id" });

            migrationBuilder.CreateIndex(
                name: "IX_attempts_AssignmentId_Id",
                table: "attempts",
                columns: new[] { "AssignmentId", "Id" });

            migrationBuilder.CreateIndex(
                name: "IX_attempts_NodeId",
                table: "attempts",
                column: "NodeId");

            migrationBuilder.CreateIndex(
                name: "IX_attempts_RolloutId_Id",
                table: "attempts",
                columns: new[] { "RolloutId", "Id" });

            migrationBuilder.CreateIndex(
                name: "IX_desired_revisions_WorkspaceId_SourceRevision",
                table: "desired_revisions",
                columns: new[] { "WorkspaceId", "SourceRevision" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_enrollment_authorizations_TokenSha256",
                table: "enrollment_authorizations",
                column: "TokenSha256",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_enrollment_authorizations_WorkspaceId",
                table: "enrollment_authorizations",
                column: "WorkspaceId");

            migrationBuilder.CreateIndex(
                name: "IX_node_credentials_CertificateSha256",
                table: "node_credentials",
                column: "CertificateSha256",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_node_credentials_NodeId_RevokedAt",
                table: "node_credentials",
                columns: new[] { "NodeId", "RevokedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_nodes_WorkspaceId_LastContactAt",
                table: "nodes",
                columns: new[] { "WorkspaceId", "LastContactAt" });

            migrationBuilder.CreateIndex(
                name: "IX_nodes_WorkspaceId_Name",
                table: "nodes",
                columns: new[] { "WorkspaceId", "Name" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_rollouts_DesiredRevisionId",
                table: "rollouts",
                column: "DesiredRevisionId");

            migrationBuilder.CreateIndex(
                name: "IX_source_scans_WorkspaceId_ObservedAt",
                table: "source_scans",
                columns: new[] { "WorkspaceId", "ObservedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_source_warnings_DesiredRevisionId",
                table: "source_warnings",
                column: "DesiredRevisionId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "assignment_skills");

            migrationBuilder.DropTable(
                name: "attempts");

            migrationBuilder.DropTable(
                name: "enrollment_authorizations");

            migrationBuilder.DropTable(
                name: "node_credentials");

            migrationBuilder.DropTable(
                name: "source_scans");

            migrationBuilder.DropTable(
                name: "source_warnings");

            migrationBuilder.DropTable(
                name: "bundles");

            migrationBuilder.DropTable(
                name: "assignments");

            migrationBuilder.DropTable(
                name: "nodes");

            migrationBuilder.DropTable(
                name: "rollouts");

            migrationBuilder.DropTable(
                name: "desired_revisions");

            migrationBuilder.DropTable(
                name: "workspaces");
        }
    }
}
