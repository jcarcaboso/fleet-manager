//! Every JSON shape the Agent exchanges with the Server on `agent/v1`: request
//! bodies the Agent sends and responses it reads. Field names, serde
//! attributes and `deny_unknown_fields` are the wire contract; change them only
//! together with the Server.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnrollmentResponse {
    pub workspace_id: Uuid,
    pub node_id: Uuid,
    pub credential_id: Uuid,
    pub certificate_pem: String,
    pub expires_at: String,
    pub poll_interval_seconds: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenewalResponse {
    pub credential_id: Uuid,
    pub certificate_pem: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PollResponse {
    pub workspace_id: Uuid,
    pub node_id: Uuid,
    pub assignment: Option<Assignment>,
    pub next_poll_seconds: u64,
    /// Set by the Server only for Agents that sent the disk-usage capability.
    #[serde(default)]
    pub disk_usage_requested: bool,
    /// An Operator's update request. Set by the Server only for Agents that
    /// sent the agent-update capability.
    #[serde(default)]
    pub agent_update: Option<AgentUpdate>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentUpdate {
    pub version: String,
    /// Identifies this request; every report about it repeats it, so a late
    /// report about an earlier request of the same version changes nothing.
    pub update_id: Uuid,
}

/// States an Agent reports while it updates itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentUpdateState {
    Downloading,
    Restarting,
    Succeeded,
    Failed,
}

/// Body of `POST agent/v1/agent-update/report`. Every property is always
/// present; `errorCode` is `null` unless the state is `failed`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgentUpdateReport<'a> {
    pub(super) update_id: Uuid,
    pub(super) version: &'a str,
    pub(super) state: AgentUpdateState,
    pub(super) error_code: Option<&'a str>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Assignment {
    pub assignment_id: Uuid,
    pub attempt_id: Uuid,
    pub rollout_id: Uuid,
    pub desired_revision_id: Uuid,
    pub target_name: String,
    pub target: TargetDescriptor,
    pub skills: Vec<AssignmentSkill>,
    #[serde(default)]
    pub file: Option<AssignmentFile>,
    #[serde(default)]
    pub ai_client: Option<AiClientAssignment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiClientAssignment {
    pub schema: String,
    pub client: String,
    pub mode: String,
    pub base_url: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TargetDescriptor {
    pub base: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssignmentSkill {
    pub name: String,
    pub bundle_digest: String,
    pub size: i64,
    pub schema: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssignmentFile {
    pub name: String,
    pub bundle_digest: Option<String>,
    pub size: Option<i64>,
    pub schema: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceState {
    Pending,
    Applying,
    Succeeded,
    Failed,
    Superseded,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportResponse {
    pub outcome: ReportOutcome,
    pub state: ConvergenceState,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportOutcome {
    Recorded,
    Duplicate,
    Stale,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenameResponse {
    pub node_id: Uuid,
    pub alias: String,
}

/// Failure detail for one Attempt, as the Server's attempt-detail route
/// expects it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttemptDetail {
    pub diagnostic: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<fleet_reconcile::Step>,
}

/// Body of `PUT agent/v1/disk-usage`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiskUsageReport {
    pub volumes: Vec<DiskVolume>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskVolume {
    pub label: &'static str,
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub available_bytes: u64,
}

/// Body of `PUT agent/v1/telemetry`. Every property is always present; a value
/// that could not be read is `null`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryReport {
    pub agent_version: String,
    pub os: TelemetryOs,
    pub arch: Option<String>,
    pub hostname: Option<String>,
    pub user: Option<String>,
    /// `homebrew`, `cargo` or `binary`.
    pub install_method: Option<&'static str>,
    /// `systemd`, `launchd` or `none`.
    pub service_manager: &'static str,
    pub state_directory: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TelemetryOs {
    pub name: Option<String>,
    pub version: Option<String>,
    pub kernel: Option<String>,
}

/// Body of `POST agent/v1/drift`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DriftReport {
    pub target: String,
    pub files: Vec<String>,
}

/// One Target the Agent failed to repair.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairFailure {
    pub target: String,
    pub assignment_id: Uuid,
    pub error_code: String,
    pub diagnostic: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<fleet_reconcile::Step>,
}

/// Body of `PUT agent/v1/repair-failures`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RepairFailuresReport {
    pub failures: Vec<RepairFailure>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct EnrollmentRequest<'a> {
    pub(super) token: &'a str,
    pub(super) certificate_request_pem: &'a str,
    pub(super) node_name: &'a str,
    pub(super) platform: &'a str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RenewalRequest<'a> {
    pub(super) certificate_request_pem: &'a str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReportRequest<'a> {
    pub(super) attempt_id: Uuid,
    pub(super) state: ConvergenceState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) error_code: Option<&'a str>,
}
#[derive(Serialize)]
pub(super) struct AliasRequest<'a> {
    pub(super) alias: &'a str,
}
