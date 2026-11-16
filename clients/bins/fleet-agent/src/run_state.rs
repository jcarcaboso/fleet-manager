//! The run state, `run.json`: each Target's active and pending Assignment and
//! the terminal report that waits to be sent.
//!
//! It is written by deployed Agents and read by newer and older ones, so the
//! shapes below are an on-disk format. They reject unknown fields, which
//! protects a downgrade, and they keep the legacy single-Target fields
//! `active` and `pending_assignment` so a run written before Targets existed
//! still loads; [`load`] moves those into `targets`.

use std::{collections::BTreeMap, path::Path};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{protocol::Assignment, state};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PendingReport {
    pub attempt_id: Uuid,
    pub succeeded: bool,
    pub error_code: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<Assignment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_assignment: Option<Assignment>,
    #[serde(default)]
    pub targets: BTreeMap<String, TargetRunState>,
    #[serde(default)]
    pub pending_report: Option<PendingReport>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TargetRunState {
    #[serde(default)]
    pub active: Option<Assignment>,
    #[serde(default)]
    pub pending_assignment: Option<Assignment>,
}

/// Reads the run state at `path`, empty when the file does not exist, with
/// the legacy fields moved into `targets`. Only this function deserializes a
/// [`RunState`], so the legacy fields are always empty afterwards.
pub fn load(path: &Path) -> Result<RunState> {
    let mut run = state::read_json::<RunState>(path)?.unwrap_or_default();
    migrate(&mut run);
    Ok(run)
}

fn migrate(run: &mut RunState) {
    if let Some(assignment) = run.active.take() {
        let target_name = assignment.target_name.clone();
        run.targets.entry(target_name).or_default().active = Some(assignment);
    }
    if let Some(assignment) = run.pending_assignment.take() {
        let target_name = assignment.target_name.clone();
        run.targets
            .entry(target_name)
            .or_default()
            .pending_assignment = Some(assignment);
    }
}

impl RunState {
    /// Every Assignment the run state holds: each Target's active and pending one.
    pub fn assignments(&self) -> impl Iterator<Item = &Assignment> {
        self.targets
            .values()
            .flat_map(|target| target.active.iter().chain(target.pending_assignment.iter()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};

    fn test_directory() -> PathBuf {
        let path = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("fleet-main-{}", Uuid::new_v4()));
        state::private_directory(&path).unwrap();
        path
    }

    const OLD_RUN_STATE: &str = r#"{
        "active": {"assignmentId":"00000000-0000-0000-0000-000000000003",
            "attemptId":"00000000-0000-0000-0000-000000000004",
            "rolloutId":"00000000-0000-0000-0000-000000000005",
            "desiredRevisionId":"00000000-0000-0000-0000-000000000006",
            "targetName":"skills","target":{"base":"home","path":".agents/skills"},"skills":[]},
        "targets": {"agent-file/codex": {"active": null, "pending_assignment": null}},
        "pending_report": {"attempt_id":"00000000-0000-0000-0000-000000000004",
            "succeeded":false,"error_code":"lock_failed"}
    }"#;

    #[test]
    fn run_state_written_before_attempt_detail_still_loads() {
        let directory = test_directory();
        let path = directory.join("run.json");
        state::write_bytes(&path, OLD_RUN_STATE.as_bytes()).unwrap();
        let mut run = state::read_json::<RunState>(&path).unwrap().unwrap();
        migrate(&mut run);
        assert!(run.targets.contains_key("skills"));
        assert_eq!(
            run.pending_report.as_ref().unwrap().error_code.as_deref(),
            Some("lock_failed")
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn run_state_has_no_fields_for_attempt_detail() {
        // Older Agents reject unknown fields, so a downgrade needs these exact shapes.
        let run = RunState {
            pending_report: Some(PendingReport {
                attempt_id: Uuid::nil(),
                succeeded: false,
                error_code: Some("lock_failed".to_owned()),
            }),
            ..RunState::default()
        };
        assert_eq!(
            serde_json::to_string(&run).unwrap(),
            r#"{"targets":{},"pending_report":{"attempt_id":"00000000-0000-0000-0000-000000000000","succeeded":false,"error_code":"lock_failed"}}"#
        );
        assert_eq!(
            serde_json::to_string(&TargetRunState::default()).unwrap(),
            r#"{"active":null,"pending_assignment":null}"#
        );
    }
}
