//! Read-only commands: `status`, `targets`, `check` and `disk`.
//!
//! They run while the background service holds the state lock, so they never
//! take it. They also never create a directory or file and never change a
//! permission, and they make no Server request. That is safe because every
//! file they read is replaced atomically (a temporary file renamed over the old
//! one, see `state::write_bytes` and the credential store), so a reader sees
//! the old or the new content, never a mixture. Files are read one at a time,
//! so two files can come from either side of an update; each is consistent.

use std::{
    collections::BTreeMap,
    path::Path,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::{
    RunState,
    credentials::{CredentialStore, StoredIdentity},
    detail, disk, managed, service, state,
};

/// A certificate expiring sooner than this is reported as a warning.
const EXPIRY_WARNING: time::Duration = time::Duration::days(2);

/// Longest `check` waits for the home directory to answer a `stat`.
const HOME_WAIT: Duration = Duration::from_secs(2);

pub fn print(value: &Value) -> Result<()> {
    println!("{value}");
    Ok(())
}

/// Fails with "not configured" when the state directory does not exist, and
/// never creates it.
fn require_directory(directory: &Path) -> Result<()> {
    if !state::existing_private_directory(directory)? {
        bail!("Agent is not configured");
    }
    Ok(())
}

fn load_config(directory: &Path) -> Result<state::Config> {
    state::read_json::<state::Config>(&directory.join("config.json"))?
        .context("Agent is not configured")
}

fn load_identity(directory: &Path) -> std::io::Result<Option<StoredIdentity>> {
    match CredentialStore::open_read_only(directory.join("credentials"))? {
        Some(store) => store.load_identity(),
        None => Ok(None),
    }
}

/// Whether the state directory holds a configured and enrolled Agent.
pub fn enrolled(directory: &Path) -> Result<bool> {
    Ok(state::existing_private_directory(directory)?
        && state::read_json::<state::Config>(&directory.join("config.json"))?.is_some()
        && load_identity(directory)?.is_some())
}

fn load_run(directory: &Path) -> Result<RunState> {
    let mut run = state::read_json::<RunState>(&directory.join("run.json"))?.unwrap_or_default();
    crate::migrate_run_state(&mut run);
    Ok(run)
}

pub fn status(directory: &Path) -> Result<Value> {
    require_directory(directory)?;
    let config = load_config(directory)?;
    let identity = load_identity(directory)?.context("Agent enrollment is incomplete")?;
    let run = load_run(directory)?;
    let active_assignments = run
        .targets
        .iter()
        .filter_map(|(name, target)| {
            target
                .active
                .as_ref()
                .map(|assignment| (name.clone(), assignment.assignment_id))
        })
        .collect::<BTreeMap<_, _>>();
    let active_assignment = active_assignments.get("skills").copied();
    Ok(
        json!({"nodeId":identity.node_id,"workspaceId":identity.workspace_id,
        "alias":config.node_alias,"expiresAt":identity.expires_at,"stateDirectory":directory,
        "pendingReport":run.pending_report.is_some(),
        "pendingDetail":detail::is_pending(directory),"activeAssignment":active_assignment,
        "activeAssignments":active_assignments,
        "service":service_status(directory)?}),
    )
}

/// `running` says whether an Agent holds the state lock, whichever service
/// manager started it. `manager` and `label` name the installed service
/// definition (`fleet-agent` for `fleet-agent service install`, `homebrew`
/// for `brew services`), and `logs` is the log file of the former on macOS.
/// `version` is the installed version the fleet-agent service runs.
fn service_status(directory: &Path) -> Result<Value> {
    let installed = dirs::home_dir()
        .map(|home| service::installed(&home))
        .unwrap_or_default();
    let manager = installed.first();
    let logs = (cfg!(target_os = "macos") && manager == Some(&service::Manager::FleetAgent))
        .then(|| directory.join("logs").join(service::LOG_FILE));
    Ok(json!({"running":state::lock_is_held(directory)?,
        "manager":manager.map(|manager| manager.name()),
        "label":manager.map(|manager| manager.label()),
        "logs":logs,
        "version":managed::active_version(directory).ok().flatten()}))
}

/// How to start the installed service, for `check`.
fn service_hint() -> &'static str {
    match dirs::home_dir()
        .map(|home| service::installed(&home))
        .unwrap_or_default()
        .first()
    {
        Some(service::Manager::Homebrew(_)) => {
            "not running; move it to the fleet-agent service with `fleet-agent service install`"
        }
        Some(service::Manager::FleetAgent) => {
            "not running; start it with `fleet-agent service start`"
        }
        None => "not running; no service is installed",
    }
}

fn assignment_summary(assignment: &crate::Assignment) -> Value {
    json!({"assignmentId":assignment.assignment_id,"attemptId":assignment.attempt_id,
        "revision":assignment.desired_revision_id,
        "target":{"base":assignment.target.base,"path":assignment.target.path}})
}

pub fn targets(directory: &Path) -> Result<Value> {
    require_directory(directory)?;
    load_config(directory)?;
    let run = load_run(directory)?;
    let report = run.pending_report.as_ref();
    let targets = run
        .targets
        .iter()
        .map(|(name, target)| {
            let state = if target.pending_assignment.is_some() {
                "pending"
            } else if target.active.is_some() {
                "active"
            } else {
                "idle"
            };
            let report_attempt = report.map(|report| report.attempt_id);
            let pending_report = report_attempt.is_some()
                && target
                    .active
                    .iter()
                    .chain(target.pending_assignment.iter())
                    .any(|assignment| Some(assignment.attempt_id) == report_attempt);
            json!({"name":name,"kind":crate::actions::kind_name(name),"state":state,
                "active":target.active.as_ref().map(assignment_summary),
                "pendingAssignment":target.pending_assignment.as_ref().map(assignment_summary),
                "pendingReport":pending_report})
        })
        .collect::<Vec<_>>();
    // A failed Attempt leaves no Assignment to match, so the report is shown whole.
    let pending_report = report.map(|report| {
        json!({"attemptId":report.attempt_id,"succeeded":report.succeeded,
            "errorCode":report.error_code})
    });
    Ok(json!({"targets":targets,"pendingReport":pending_report}))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Level {
    Ok,
    Warn,
    Fail,
}

struct Check {
    name: &'static str,
    level: Level,
    detail: String,
}

/// The result of `check`. Only a failed check makes it not ok; warnings do not.
pub struct Report {
    checks: Vec<Check>,
}

impl Report {
    fn add(&mut self, name: &'static str, level: Level, detail: impl Into<String>) {
        self.checks.push(Check {
            name,
            level,
            detail: detail.into(),
        });
    }

    pub fn ok(&self) -> bool {
        self.checks.iter().all(|check| check.level != Level::Fail)
    }

    /// 0 when no check failed, 1 otherwise.
    pub fn exit_code(&self) -> i32 {
        if self.ok() { 0 } else { 1 }
    }

    pub fn to_json(&self) -> Value {
        let checks = self.checks.iter().map(|check| {
            let status = match check.level {
                Level::Ok => "ok",
                Level::Warn => "warn",
                Level::Fail => "fail",
            };
            json!({"name":check.name,"status":status,"detail":check.detail})
        });
        json!({"ok":self.ok(),"checks":checks.collect::<Vec<_>>()})
    }
}

pub async fn check_command(directory: &Path) -> Result<()> {
    let report = diagnose(directory, HOME_WAIT).await;
    println!("{}", report.to_json());
    if !report.ok() {
        use std::io::Write;
        let _ = std::io::stdout().flush();
        std::process::exit(report.exit_code());
    }
    Ok(())
}

/// Describes a credential error without echoing file content: a malformed
/// identity's parse error can quote the value that was rejected.
fn credential_problem(error: &std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::InvalidData {
        "identity.json is not a small regular file or is not valid".to_owned()
    } else {
        error.to_string()
    }
}

pub async fn diagnose(directory: &Path, home_wait: Duration) -> Report {
    let mut report = Report { checks: Vec::new() };
    match state::inspect_directory(directory) {
        Ok(state::DirectoryState::Private) => report.add(
            "stateDirectory",
            Level::Ok,
            "exists, is private and is not a link",
        ),
        Ok(state::DirectoryState::Missing) => {
            report.add("stateDirectory", Level::Fail, "does not exist");
            return report;
        }
        Ok(state::DirectoryState::Unsafe(reason)) => {
            report.add("stateDirectory", Level::Fail, reason);
            return report;
        }
        Err(error) => {
            report.add("stateDirectory", Level::Fail, error.to_string());
            return report;
        }
    }

    let config = match state::read_json::<state::Config>(&directory.join("config.json")) {
        Ok(Some(config)) => {
            report.add("config", Level::Ok, "present and valid");
            Some(config)
        }
        Ok(None) => {
            report.add("config", Level::Fail, "config.json is missing; run enroll");
            None
        }
        Err(error) => {
            report.add("config", Level::Fail, error.to_string());
            None
        }
    };

    let identity = match load_identity(directory) {
        Ok(Some(identity)) => {
            report.add("identity", Level::Ok, "present");
            Some(identity)
        }
        Ok(None) => {
            report.add("identity", Level::Fail, "missing; enrollment is incomplete");
            None
        }
        Err(error) => {
            report.add("identity", Level::Fail, credential_problem(&error));
            None
        }
    };

    if let Some(identity) = &identity {
        match OffsetDateTime::parse(&identity.expires_at, &Rfc3339) {
            Err(_) => report.add("certificate", Level::Fail, "expiry is not a valid time"),
            Ok(expires) => {
                let left = expires - OffsetDateTime::now_utc();
                let (level, detail) = if left <= time::Duration::ZERO {
                    (Level::Fail, format!("expired at {}", identity.expires_at))
                } else if left < EXPIRY_WARNING {
                    (
                        Level::Warn,
                        format!("expires at {} (under 2 days)", identity.expires_at),
                    )
                } else {
                    (Level::Ok, format!("expires at {}", identity.expires_at))
                };
                report.add("certificate", level, detail);
            }
        }
    }

    if let Some(config) = config {
        match home_exists(config.home, home_wait).await {
            Some(true) => report.add("home", Level::Ok, "exists"),
            Some(false) => report.add("home", Level::Fail, "does not exist or is not a directory"),
            None => report.add("home", Level::Fail, "did not answer in time"),
        }
    }

    match state::lock_is_held(directory) {
        Ok(true) => report.add("service", Level::Ok, "running"),
        Ok(false) => report.add("service", Level::Warn, service_hint()),
        Err(error) => report.add("service", Level::Fail, error.to_string()),
    }

    match load_run(directory) {
        Ok(run) if run.pending_report.is_some() => report.add(
            "pendingReport",
            Level::Warn,
            "a terminal report waits to be sent to the Server",
        ),
        Ok(_) => report.add("pendingReport", Level::Ok, "none"),
        Err(error) => report.add("pendingReport", Level::Fail, error.to_string()),
    }
    if detail::is_pending(directory) {
        report.add(
            "pendingDetail",
            Level::Warn,
            "a failure detail waits to be sent to the Server",
        );
    } else {
        report.add("pendingDetail", Level::Ok, "none");
    }
    report
}

/// Whether `home` is a directory, asked on the bounded worker thread because a
/// hung network mount can block a `stat` for ever. `None` means no answer.
async fn home_exists(home: std::path::PathBuf, wait: Duration) -> Option<bool> {
    let style = disk::Style {
        thread: "fleet-check",
        what: "home directory check",
        stack_bytes: 256 * 1024,
    };
    let mut worker = disk::Worker::<bool>::styled(
        Box::new(move || Some(home.is_dir())),
        wait,
        Duration::from_secs(60),
        style,
    );
    worker.measure(Instant::now()).await
}

pub async fn disk(directory: &Path) -> Result<Value> {
    require_directory(directory)?;
    let config = load_config(directory)?;
    let mut worker = disk::Worker::new(config.home, directory.to_path_buf());
    Ok(measure_once(&mut worker).await)
}

/// One measurement with the worker's bounded wait. A measurement that is still
/// running afterwards is left on its detached thread, which never delays exit.
pub async fn measure_once(worker: &mut disk::Worker) -> Value {
    let usage = worker.measure(Instant::now()).await;
    json!({"diskUsage":usage,"timedOut":usage.is_none() && !worker.is_idle()})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        PendingReport, TargetRunState,
        protocol::{Assignment, DiskUsageReport, DiskVolume, EnrollmentResponse},
    };
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        path::PathBuf,
        sync::{Mutex, mpsc},
    };
    use uuid::Uuid;

    struct Fixture {
        root: PathBuf,
        directory: PathBuf,
        home: PathBuf,
    }

    impl Fixture {
        /// Only the parent exists; the state directory is not created.
        fn missing() -> Self {
            let root = std::env::temp_dir()
                .canonicalize()
                .unwrap()
                .join(format!("fleet-inspect-test-{}", Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
            let home = root.join("home");
            fs::create_dir(&home).unwrap();
            Self {
                directory: root.join("state"),
                root,
                home,
            }
        }

        /// An enrolled Agent whose certificate expires at `expires_at`.
        fn enrolled(expires_at: &str) -> Self {
            let fixture = Self::missing();
            state::private_directory(&fixture.directory).unwrap();
            state::write_json(
                &fixture.directory.join("config.json"),
                &state::Config {
                    server_url: "https://fleet.example".into(),
                    ca_pem: "ca".into(),
                    node_alias: "mini".into(),
                    home: fixture.home.clone(),
                },
            )
            .unwrap();
            let store = CredentialStore::open(fixture.directory.join("credentials")).unwrap();
            let pending = store.load_or_generate_pending().unwrap();
            store
                .complete_enrollment(
                    &pending,
                    &EnrollmentResponse {
                        workspace_id: Uuid::from_u128(1),
                        node_id: Uuid::from_u128(2),
                        credential_id: Uuid::from_u128(3),
                        certificate_pem: "certificate".into(),
                        expires_at: expires_at.into(),
                        poll_interval_seconds: 30,
                    },
                )
                .unwrap();
            fixture
        }

        fn in_days(days: i64) -> String {
            // The `time` crate is built without formatting here.
            let t = OffsetDateTime::now_utc() + time::Duration::days(days);
            format!(
                "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
                t.year(),
                t.month() as u8,
                t.day(),
                t.hour(),
                t.minute(),
                t.second()
            )
        }

        /// Every path under the root with its type, mode and modification time.
        fn snapshot(&self) -> BTreeMap<PathBuf, (bool, u32, std::time::SystemTime)> {
            fn walk(path: &Path, into: &mut BTreeMap<PathBuf, (bool, u32, std::time::SystemTime)>) {
                let metadata = fs::symlink_metadata(path).unwrap();
                into.insert(
                    path.to_owned(),
                    (
                        metadata.is_dir(),
                        metadata.permissions().mode(),
                        metadata.modified().unwrap(),
                    ),
                );
                if metadata.is_dir() {
                    for entry in fs::read_dir(path).unwrap() {
                        walk(&entry.unwrap().path(), into);
                    }
                }
            }
            let mut all = BTreeMap::new();
            walk(&self.root, &mut all);
            all
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn assignment(target_name: &str) -> Assignment {
        serde_json::from_value(json!({
            "assignmentId": Uuid::new_v4(), "attemptId": Uuid::new_v4(),
            "rolloutId": Uuid::new_v4(), "desiredRevisionId": Uuid::new_v4(),
            "targetName": target_name,
            "target": {"base": "home", "path": ".agents/skills"}, "skills": []
        }))
        .unwrap()
    }

    fn save_run(fixture: &Fixture, run: &RunState) {
        state::write_json(&fixture.directory.join("run.json"), run).unwrap();
    }

    fn statuses(report: &Report) -> BTreeMap<&'static str, &'static str> {
        report
            .checks
            .iter()
            .map(|check| {
                let level = match check.level {
                    Level::Ok => "ok",
                    Level::Warn => "warn",
                    Level::Fail => "fail",
                };
                (check.name, level)
            })
            .collect()
    }

    #[test]
    fn status_works_while_the_service_holds_the_lock() {
        let fixture = Fixture::enrolled(&Fixture::in_days(30));
        let before = status(&fixture.directory).unwrap();
        assert_eq!(before["service"]["running"], false);
        assert_eq!(before["alias"], "mini");
        assert_eq!(before["pendingReport"], false);
        assert_eq!(before["pendingDetail"], false);

        let held = state::lock(&fixture.directory).unwrap();
        for _ in 0..3 {
            let during = status(&fixture.directory).unwrap();
            assert_eq!(during["service"]["running"], true);
            assert_eq!(during["nodeId"], before["nodeId"]);
        }
        targets(&fixture.directory).unwrap();
        assert!(
            statuses(&run_check(&fixture))
                .values()
                .all(|s| *s != "fail")
        );
        drop(held);
        assert_eq!(
            status(&fixture.directory).unwrap()["service"]["running"],
            false
        );
    }

    /// Runs `diagnose` on a small current-thread runtime.
    fn run_check(fixture: &Fixture) -> Report {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(diagnose(&fixture.directory, Duration::from_secs(5)))
    }

    #[test]
    fn status_keeps_its_existing_fields() {
        let fixture = Fixture::enrolled(&Fixture::in_days(30));
        let value = status(&fixture.directory).unwrap();
        let mut keys = value
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        keys.sort();
        assert_eq!(
            keys,
            [
                "activeAssignment",
                "activeAssignments",
                "alias",
                "expiresAt",
                "nodeId",
                "pendingDetail",
                "pendingReport",
                "service",
                "stateDirectory",
                "workspaceId"
            ]
        );
    }

    #[test]
    fn read_only_commands_never_create_a_missing_state_directory() {
        let fixture = Fixture::missing();
        let before = fixture.snapshot();
        for error in [
            status(&fixture.directory).unwrap_err(),
            targets(&fixture.directory).unwrap_err(),
        ] {
            assert_eq!(error.to_string(), "Agent is not configured");
        }
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        let error = runtime.block_on(disk(&fixture.directory)).unwrap_err();
        assert_eq!(error.to_string(), "Agent is not configured");
        let report = run_check(&fixture);
        assert!(!report.ok());
        assert_eq!(report.exit_code(), 1);
        assert_eq!(report.to_json()["checks"][0]["name"], "stateDirectory");
        assert!(!state::lock_is_held(&fixture.directory).unwrap());
        assert_eq!(fixture.snapshot(), before);
        assert!(!fixture.directory.exists());

        // Missing ancestors are not created either.
        let deep = fixture.root.join("a/b/state");
        assert_eq!(
            status(&deep).unwrap_err().to_string(),
            "Agent is not configured"
        );
        assert!(!fixture.root.join("a").exists());
    }

    #[test]
    fn read_only_commands_change_nothing_in_an_existing_state_directory() {
        let fixture = Fixture::enrolled(&Fixture::in_days(30));
        save_run(&fixture, &RunState::default());
        // No lock file yet, and no credentials directory in a second case.
        let before = fixture.snapshot();
        assert!(!fixture.directory.join("agent.lock").exists());
        status(&fixture.directory).unwrap();
        targets(&fixture.directory).unwrap();
        run_check(&fixture);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        runtime.block_on(disk(&fixture.directory)).unwrap();
        assert_eq!(fixture.snapshot(), before);

        // Without credentials, the directory stays absent and status reports it.
        fs::remove_dir_all(fixture.directory.join("credentials")).unwrap();
        let before = fixture.snapshot();
        assert_eq!(
            status(&fixture.directory).unwrap_err().to_string(),
            "Agent enrollment is incomplete"
        );
        assert_eq!(fixture.snapshot(), before);
    }

    #[test]
    fn a_state_directory_with_loose_permissions_is_reported_and_left_alone() {
        let fixture = Fixture::enrolled(&Fixture::in_days(30));
        fs::set_permissions(&fixture.directory, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(status(&fixture.directory).is_err());
        assert!(
            run_check(&fixture).to_json()["checks"][0]["detail"]
                .as_str()
                .unwrap()
                .contains("chmod 700")
        );
        let mode = fs::metadata(&fixture.directory)
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o755);

        fs::set_permissions(&fixture.directory, fs::Permissions::from_mode(0o700)).unwrap();
        let credentials = fixture.directory.join("credentials");
        fs::set_permissions(&credentials, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(status(&fixture.directory).is_err());
        let mode = fs::metadata(&credentials).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755);
    }

    #[test]
    fn targets_come_from_the_saved_run_state() {
        let fixture = Fixture::enrolled(&Fixture::in_days(30));
        let skills = assignment("skills");
        let file = assignment("agent-file/codex");
        let pending = assignment("ai-client/codex");
        let mut run = RunState {
            pending_report: Some(PendingReport {
                attempt_id: file.attempt_id,
                succeeded: true,
                error_code: None,
            }),
            ..RunState::default()
        };
        run.targets.insert(
            "skills".into(),
            TargetRunState {
                active: Some(skills.clone()),
                pending_assignment: None,
            },
        );
        run.targets.insert(
            "agent-file/codex".into(),
            TargetRunState {
                active: Some(file.clone()),
                pending_assignment: None,
            },
        );
        run.targets.insert(
            "ai-client/codex".into(),
            TargetRunState {
                active: None,
                pending_assignment: Some(pending.clone()),
            },
        );
        save_run(&fixture, &run);

        let value = targets(&fixture.directory).unwrap();
        let list = value["targets"].as_array().unwrap();
        assert_eq!(list.len(), 3);
        let find = |name: &str| list.iter().find(|t| t["name"] == name).unwrap();
        let skills_json = find("skills");
        assert_eq!(skills_json["kind"], "skills");
        assert_eq!(skills_json["state"], "active");
        assert_eq!(
            skills_json["active"]["assignmentId"],
            json!(skills.assignment_id)
        );
        assert_eq!(
            skills_json["active"]["revision"],
            json!(skills.desired_revision_id)
        );
        assert_eq!(skills_json["active"]["target"]["path"], ".agents/skills");
        assert_eq!(skills_json["pendingAssignment"], Value::Null);
        assert_eq!(skills_json["pendingReport"], false);
        assert_eq!(find("agent-file/codex")["kind"], "managed-file");
        assert_eq!(find("agent-file/codex")["pendingReport"], true);
        let waiting = find("ai-client/codex");
        assert_eq!(waiting["kind"], "ai-client");
        assert_eq!(waiting["state"], "pending");
        assert_eq!(waiting["active"], Value::Null);
        assert_eq!(
            waiting["pendingAssignment"]["attemptId"],
            json!(pending.attempt_id)
        );
        assert_eq!(value["pendingReport"]["attemptId"], json!(file.attempt_id));
        assert_eq!(value["pendingReport"]["succeeded"], true);
    }

    #[test]
    fn targets_without_a_run_state_is_empty() {
        let fixture = Fixture::enrolled(&Fixture::in_days(30));
        let value = targets(&fixture.directory).unwrap();
        assert_eq!(value["targets"], json!([]));
        assert_eq!(value["pendingReport"], Value::Null);
    }

    #[test]
    fn check_passes_for_a_healthy_agent_and_warns_about_a_stopped_service() {
        let fixture = Fixture::enrolled(&Fixture::in_days(30));
        let report = run_check(&fixture);
        assert!(report.ok());
        assert_eq!(report.exit_code(), 0);
        let found = statuses(&report);
        assert_eq!(found["service"], "warn");
        for name in [
            "stateDirectory",
            "config",
            "identity",
            "certificate",
            "home",
        ] {
            assert_eq!(found[name], "ok", "{name}");
        }
        let held = state::lock(&fixture.directory).unwrap();
        assert_eq!(statuses(&run_check(&fixture))["service"], "ok");
        drop(held);
        assert_eq!(report.to_json()["ok"], true);
    }

    #[test]
    fn check_exit_code_follows_certificate_expiry() {
        let expiring = Fixture::enrolled(&Fixture::in_days(1));
        let report = run_check(&expiring);
        assert_eq!(statuses(&report)["certificate"], "warn");
        assert_eq!(report.exit_code(), 0);

        let expired = Fixture::enrolled(&Fixture::in_days(-1));
        let report = run_check(&expired);
        assert_eq!(statuses(&report)["certificate"], "fail");
        assert!(!report.ok());
        assert_eq!(report.exit_code(), 1);
        assert_eq!(report.to_json()["ok"], false);
    }

    #[test]
    fn check_fails_for_missing_config_identity_and_home() {
        let fixture = Fixture::enrolled(&Fixture::in_days(30));
        fs::remove_dir_all(&fixture.home).unwrap();
        assert_eq!(statuses(&run_check(&fixture))["home"], "fail");
        fs::remove_file(fixture.directory.join("credentials/identity.json")).unwrap();
        assert_eq!(statuses(&run_check(&fixture))["identity"], "fail");
        fs::remove_file(fixture.directory.join("config.json")).unwrap();
        let report = run_check(&fixture);
        assert_eq!(statuses(&report)["config"], "fail");
        assert_eq!(report.exit_code(), 1);
    }

    #[test]
    fn check_does_not_echo_a_malformed_identity() {
        let fixture = Fixture::enrolled(&Fixture::in_days(30));
        let path = fixture.directory.join("credentials/identity.json");
        state::write_bytes(&path, br#"{"workspaceId":"SECRET-VALUE"}"#).unwrap();
        let report = run_check(&fixture);
        assert_eq!(statuses(&report)["identity"], "fail");
        assert!(!report.to_json().to_string().contains("SECRET-VALUE"));
    }

    #[test]
    fn check_reports_pending_report_and_detail() {
        let fixture = Fixture::enrolled(&Fixture::in_days(30));
        save_run(
            &fixture,
            &RunState {
                pending_report: Some(PendingReport {
                    attempt_id: Uuid::nil(),
                    succeeded: false,
                    error_code: Some("io".into()),
                }),
                ..RunState::default()
            },
        );
        detail::save(
            &fixture.directory,
            Uuid::nil(),
            &crate::protocol::AttemptDetail {
                diagnostic: "cannot write".into(),
                path: None,
                step: None,
            },
            detail::now(),
        )
        .unwrap();
        let report = run_check(&fixture);
        let found = statuses(&report);
        assert_eq!(found["pendingReport"], "warn");
        assert_eq!(found["pendingDetail"], "warn");
        assert!(report.ok());
        assert_eq!(status(&fixture.directory).unwrap()["pendingDetail"], true);
    }

    fn report() -> DiskUsageReport {
        DiskUsageReport {
            volumes: vec![DiskVolume {
                label: "home",
                total_bytes: 10,
                used_bytes: 4,
                available_bytes: 6,
            }],
        }
    }

    #[tokio::test]
    async fn disk_prints_the_measurement() {
        let mut worker = disk::Worker::with_measurer(
            Box::new(|| Some(report())),
            Duration::from_secs(5),
            Duration::from_secs(60),
        );
        let value = measure_once(&mut worker).await;
        assert_eq!(value["timedOut"], false);
        assert_eq!(value["diskUsage"]["volumes"][0]["usedBytes"], 4);
    }

    #[tokio::test]
    async fn a_stuck_disk_measurement_times_out_without_waiting_for_the_thread() {
        let (release, blocked) = mpsc::channel::<()>();
        let blocked = Mutex::new(blocked);
        let mut worker = disk::Worker::with_measurer(
            Box::new(move || {
                let _ = blocked.lock().unwrap().recv();
                Some(report())
            }),
            Duration::from_millis(50),
            Duration::from_secs(60),
        );
        let began = Instant::now();
        let value = measure_once(&mut worker).await;
        assert!(began.elapsed() < Duration::from_secs(2));
        assert_eq!(value, json!({"diskUsage":null,"timedOut":true}));
        drop(release);
    }

    #[tokio::test]
    async fn an_unmeasurable_disk_is_null_but_not_a_timeout() {
        let mut worker = disk::Worker::with_measurer(
            Box::new(|| None),
            Duration::from_secs(5),
            Duration::from_secs(60),
        );
        assert_eq!(
            measure_once(&mut worker).await,
            json!({"diskUsage":null,"timedOut":false})
        );
    }
}
