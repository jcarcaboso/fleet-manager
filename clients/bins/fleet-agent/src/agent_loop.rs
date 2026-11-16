//! The `run` command: the Agent loop.
//!
//! Each iteration runs one cycle (recover, renew the credential when it is
//! close to expiry, send a saved terminal report, poll, then apply a pending
//! Assignment or repair the active ones), then the best-effort side reports in
//! [`SideReports`], then the self-update, which may end the process. Under
//! `--once` it stops after the first cycle that makes no progress and waits
//! for the side reports in flight, or returns the error of a failed cycle.

use std::{
    collections::BTreeMap,
    io::{self, Write},
    path::Path,
    time::{Duration, Instant},
};

use anyhow::{Context as _, Result, bail};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::{
    actions,
    credentials::{CredentialStore, StoredIdentity},
    detail, disk, drift,
    protocol::{
        self, Api, Assignment, ConvergenceState, DiskUsageReport, PollResponse, TelemetryReport,
    },
    repair,
    run_state::{self, PendingReport, RunState},
    service, state, telemetry, updater,
    worker::Worker,
};

/// Runs the Agent loop until interrupted, or once with `once`. The caller
/// holds the state lock.
pub async fn run(
    directory: &Path,
    store: &CredentialStore,
    config_path: &Path,
    once: bool,
) -> Result<()> {
    let config =
        state::read_json::<state::Config>(config_path)?.context("Agent is not configured")?;
    let mut identity = store.load_identity()?.context("Agent is not enrolled")?;
    let cache = directory.join("bundles");
    state::private_directory(&cache)?;
    let reconciler = fleet_reconcile::Reconciler::new(&config.home, directory.join("targets"))?;
    let ai_reconciler =
        crate::ai_client::Reconciler::new(&config.home, directory.join("ai-clients"))?;
    let actions = actions::Registry::new(&reconciler, &ai_reconciler, &cache);
    let path = directory.join("run.json");
    let mut run = run_state::load(&path)?;
    let mut side = SideReports::new(&config, directory);
    // Before anything else: a new version in trial counts its starts and may roll back.
    let mut update = if once {
        updater::Session::inactive(directory)
    } else {
        match updater::Session::start(directory)? {
            updater::Startup::Continue(session) => *session,
            updater::Startup::Restart => restart(),
        }
    };
    let self_updater = updater::Updater::new(directory);
    let context = Context {
        config: &config,
        store,
        directory,
        path: &path,
        actions: &actions,
    };
    loop {
        service::trim_log(directory);
        let result = cycle(&context, &mut identity, &mut run, &mut side, &mut update).await;
        // One client for everything after the cycle. Renewal happens only
        // inside the cycle and `identity` is final once it returns, so this is
        // the certificate every send below used when each built its own.
        let client = api(&config, &identity);
        // After the cycle, so the report and reconciliation never wait for it.
        side.after_cycle(&client, directory, &run).await;
        // Last, after the cycle and its reports: the update may end this process.
        if !once {
            if update.trial_expired()? {
                restart();
            }
            if let Ok(client) = &client {
                update.deliver(client).await;
                if let Some(request) = update.take_request() {
                    let outcome = self_updater.apply(client, &request).await;
                    if update.applied(request, outcome) {
                        restart();
                    }
                }
            }
        }
        let outcome = match result {
            Ok(outcome) => outcome,
            Err(error) if once => return Err(error),
            Err(error) => {
                let rejected = error
                    .downcast_ref::<protocol::ProtocolError>()
                    .is_some_and(|e| e.is_auth_failure());
                eprintln!("Agent cycle failed: {error}");
                CycleOutcome {
                    next_poll_seconds: if rejected { 300 } else { 30 },
                    progressed: false,
                }
            }
        };
        if outcome.progressed {
            continue;
        }
        if once {
            break;
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(outcome.next_poll_seconds.clamp(5, 3600))) => {},
            result = tokio::signal::ctrl_c() => { result?; break; }
        }
    }
    if once {
        side.finish().await?;
    }
    Ok(())
}

/// Ends the process so the service manager starts the version `current`
/// names. The state lock is released with the process.
fn restart() -> ! {
    eprintln!(
        "exiting with code {} so the service manager starts the active Agent version",
        updater::RESTART_EXIT_CODE
    );
    let _ = io::stdout().flush();
    std::process::exit(updater::RESTART_EXIT_CODE)
}

/// A Server client that presents this Node's certificate. It is built from
/// the identity in memory, never from the files.
pub fn api(config: &state::Config, identity: &StoredIdentity) -> Result<Api> {
    Ok(Api::new(
        &config.server_url,
        config.ca_pem.as_bytes(),
        Some(&identity.identity_pem()),
    )?)
}

/// What a cycle reads and never changes.
struct Context<'a> {
    config: &'a state::Config,
    store: &'a CredentialStore,
    directory: &'a Path,
    /// The run state file, `run.json`.
    path: &'a Path,
    actions: &'a actions::Registry<'a>,
}

struct CycleOutcome {
    next_poll_seconds: u64,
    progressed: bool,
}

/// The best-effort reports sent after each cycle and what they keep between
/// cycles. None of them can fail or noticeably delay a cycle. Their rules
/// differ on purpose: disk usage and drift drop a report while the previous
/// one is still being sent, machine information remembers what the Server
/// accepted, and repair failures are sent again after a 429 or 5xx.
struct SideReports {
    disk_schedule: disk::Schedule,
    disk_worker: Worker<DiskUsageReport>,
    disk_report: Option<tokio::task::JoinHandle<()>>,
    telemetry_schedule: telemetry::Schedule,
    telemetry_worker: Worker<TelemetryReport>,
    telemetry_report: Option<telemetry::Task>,
    /// The drift repaired by the current cycle, sent after it.
    drifted: Vec<drift::Report>,
    drift_report: Option<drift::Task>,
    repairs: repair::Tracker,
}

impl SideReports {
    fn new(config: &state::Config, directory: &Path) -> Self {
        Self {
            disk_schedule: disk::Schedule::default(),
            disk_worker: disk::worker(config.home.clone(), directory.to_path_buf()),
            disk_report: None,
            telemetry_schedule: telemetry::Schedule::default(),
            telemetry_worker: telemetry::worker(directory.to_path_buf(), config.home.clone()),
            telemetry_report: None,
            drifted: Vec::new(),
            drift_report: None,
            repairs: repair::Tracker::default(),
        }
    }

    /// A poll succeeded: the disk usage and machine information schedules
    /// start with the first one, and the Server may ask for disk usage.
    fn poll_succeeded(&mut self, poll: &PollResponse) {
        self.disk_schedule.poll_succeeded(poll.disk_usage_requested);
        self.telemetry_schedule.poll_succeeded();
    }

    /// Runs after every cycle, whether it succeeded or not, in this order:
    /// attempt detail, disk usage, machine information, drift, repair
    /// failures. `client` is built once for all of them; if it could not be
    /// built, each report that has something to send logs why.
    async fn after_cycle(&mut self, client: &Result<Api>, directory: &Path, run: &RunState) {
        let unacknowledged = run.pending_report.as_ref().map(|report| report.attempt_id);
        detail::after_cycle(client, directory, unacknowledged).await;
        self.send_disk_usage(client).await;
        self.send_telemetry(client).await;
        self.send_drift(client);
        self.send_repair_failures(client).await;
    }

    /// Sends the disk usage when the schedule says so. Like attempt detail it is
    /// best effort and runs after reconciliation: nothing here can fail a cycle.
    /// The attempt is recorded first, so a failure waits for the next slot or the
    /// next Server request instead of being retried.
    async fn send_disk_usage(&mut self, client: &Result<Api>) {
        disk::step(
            &mut self.disk_schedule,
            &mut self.disk_worker,
            &mut self.disk_report,
            |report| {
                let client = owned(client);
                async move {
                    match client {
                        Ok(client) => disk::deliver(&client, &report).await,
                        Err(error) => eprintln!("could not send disk usage: {error}"),
                    }
                }
            },
        )
        .await;
    }

    /// Sends the machine information when the schedule says so. Like disk usage it
    /// is best effort, runs after reconciliation and cannot fail a cycle.
    async fn send_telemetry(&mut self, client: &Result<Api>) {
        telemetry::step(
            Instant::now(),
            &mut self.telemetry_schedule,
            &mut self.telemetry_worker,
            &mut self.telemetry_report,
            |report| {
                let client = owned(client);
                async move {
                    match client {
                        Ok(client) => telemetry::deliver(&client, &report).await,
                        Err(error) => {
                            eprintln!("could not send machine information: {error}");
                            false
                        }
                    }
                }
            },
        )
        .await;
    }

    /// Sends the drift repaired in this cycle as a best-effort side task. It runs
    /// after reconciliation and can neither fail nor delay a cycle.
    fn send_drift(&mut self, client: &Result<Api>) {
        let reports = std::mem::take(&mut self.drifted);
        if reports.is_empty() {
            return;
        }
        let client = match client {
            Ok(client) => client.clone(),
            Err(error) => {
                eprintln!("dropped a drift report: {error}");
                return;
            }
        };
        drift::step(reports, &mut self.drift_report, move |report| {
            let client = client.clone();
            async move { drift::deliver(&client, &report).await }
        });
    }

    /// Sends the current idle repair failures when they changed. Best effort
    /// like drift: nothing here can fail or delay a cycle.
    async fn send_repair_failures(&mut self, client: &Result<Api>) {
        self.repairs
            .step(|report| {
                let client = owned(client);
                async move {
                    match client {
                        Ok(client) => repair::deliver(&client, &report).await,
                        Err(error) => {
                            eprintln!("could not send repair failures: {error}");
                            repair::Delivery::Retry
                        }
                    }
                }
            })
            .await;
    }

    /// `--once` is a one-shot: let a report in flight finish (its own
    /// 10 s timeout bounds this). Otherwise it ends with the process. Fails
    /// when a Target could not be repaired.
    async fn finish(mut self) -> Result<()> {
        if let Some(report) = self.disk_report {
            let _ = report.await;
        }
        if let Some(report) = self.telemetry_report {
            let _ = report.await;
        }
        if let Some(report) = self.drift_report {
            let _ = report.await;
        }
        self.repairs.finish().await;
        if let Some(report) = self.repairs.report()
            && !report.failures.is_empty()
        {
            let targets = report
                .failures
                .iter()
                .map(|failure| failure.target.as_str())
                .collect::<Vec<_>>();
            bail!("could not repair {}", targets.join(", "));
        }
        Ok(())
    }
}

/// A copy of the shared client for a side task that outlives the borrow. The
/// error keeps its message, which is all a report logs of it.
fn owned(client: &Result<Api>) -> std::result::Result<Api, String> {
    match client {
        Ok(client) => Ok(client.clone()),
        Err(error) => Err(error.to_string()),
    }
}

async fn cycle(
    context: &Context<'_>,
    identity: &mut StoredIdentity,
    run: &mut RunState,
    side: &mut SideReports,
    update: &mut updater::Session,
) -> Result<CycleOutcome> {
    let Context {
        config,
        store,
        directory,
        path,
        actions,
    } = *context;
    for assignment in run.assignments() {
        actions.recover(assignment)?;
    }
    let expires = OffsetDateTime::parse(&identity.expires_at, &Rfc3339)
        .context("invalid credential expiration")?;
    if expires - OffsetDateTime::now_utc() < time::Duration::days(1) {
        let pending = store.load_or_generate_pending()?;
        let renewed = api(config, identity)?.renew(&pending.csr_pem).await?;
        store.complete_renewal(&pending, &renewed)?;
        store.clear_pending()?;
        *identity = store
            .load_identity()?
            .context("renewed identity was not saved")?;
    }
    let client = api(config, identity)?;
    deliver_report(&client, run, path).await?;
    let poll = client.poll().await?;
    if poll.node_id != identity.node_id || poll.workspace_id != identity.workspace_id {
        bail!("Server returned another Node or Workspace identity");
    }
    side.poll_succeeded(&poll);
    update.poll_succeeded(poll.agent_update.as_ref());
    let delay = poll.next_poll_seconds;
    if let Some(assignment) = poll.assignment {
        actions.validate(&assignment)?;
        let target_state = run
            .targets
            .entry(assignment.target_name.clone())
            .or_default();
        if let Some(active) = &target_state.active
            && active.target.path != assignment.target.path
        {
            bail!("Target path cannot change after installation");
        }
        target_state.pending_assignment = Some(assignment);
        state::write_json(path, run)?;
    }
    actions.clean_cache(run.assignments())?;
    let pending = run
        .targets
        .values()
        .find_map(|target| target.pending_assignment.clone());
    let progressed = pending.is_some();
    if let Some(assignment) = pending {
        actions.prepare(&client, &assignment).await?;
        let applying = client
            .report(assignment.attempt_id, ConvergenceState::Applying, None)
            .await?;
        if matches!(applying.outcome, protocol::ReportOutcome::Stale) {
            run.targets
                .entry(assignment.target_name.clone())
                .or_default()
                .pending_assignment = None;
            run.pending_report = Some(PendingReport {
                attempt_id: assignment.attempt_id,
                succeeded: false,
                error_code: Some("assignment_superseded".to_owned()),
            });
            state::write_json(path, run)?;
            deliver_report(&client, run, path).await?;
            return Ok(CycleOutcome {
                next_poll_seconds: 5,
                progressed: true,
            });
        }
        if applying.state != ConvergenceState::Applying {
            bail!("Server did not acknowledge applying state");
        }
        let outcome = actions.apply(&client, &assignment).await;
        side.repairs.applied(&assignment.target_name);
        let attempt_id = assignment.attempt_id;
        let error_code = outcome.as_ref().err().map(|error| error.code().to_owned());
        if let Ok(repaired) = &outcome {
            side.drifted.extend(drift::Report::new(
                &assignment.target_name,
                repaired.clone(),
            ));
        }
        let failure_detail = outcome.as_ref().err().map(|error| {
            detail::build(
                error,
                &detail::Redactor::new(&state::home_prefixes(&config.home), directory),
            )
        });
        let target_state = run
            .targets
            .entry(assignment.target_name.clone())
            .or_default();
        target_state.pending_assignment = None;
        run.pending_report = Some(PendingReport {
            attempt_id: assignment.attempt_id,
            succeeded: outcome.is_ok(),
            error_code,
        });
        if outcome.is_ok() {
            target_state.active = Some(assignment);
        }
        state::write_json(path, run)?;
        if let Some(failure_detail) = failure_detail
            && let Err(error) = detail::save(directory, attempt_id, &failure_detail, detail::now())
        {
            eprintln!("could not save attempt detail: {error}");
        }
        deliver_report(&client, run, path).await?;
        actions.clean_cache(run.assignments())?;
        outcome.map_err(anyhow::Error::new)?;
        println!("{{\"outcome\":\"succeeded\"}}");
    } else {
        let active = run
            .targets
            .values()
            .filter_map(|target| target.active.clone())
            .collect::<Vec<_>>();
        let redactor = detail::Redactor::new(&state::home_prefixes(&config.home), directory);
        side.repairs.idle_cycle(
            repair_active(actions, &client, &active, &redactor, &mut side.drifted).await,
        );
    }
    Ok(CycleOutcome {
        next_poll_seconds: delay,
        progressed,
    })
}

async fn deliver_report(client: &Api, run: &mut RunState, path: &Path) -> Result<()> {
    if let Some(report) = &run.pending_report {
        let expected = if report.succeeded {
            ConvergenceState::Succeeded
        } else {
            ConvergenceState::Failed
        };
        let acknowledged = client
            .report(report.attempt_id, expected, report.error_code.as_deref())
            .await?;
        if !matches!(acknowledged.outcome, protocol::ReportOutcome::Stale)
            && acknowledged.state != expected
        {
            bail!("Server did not acknowledge the saved terminal state");
        }
        run.pending_report = None;
        state::write_json(path, run)?;
    }
    Ok(())
}

/// Applies every active Assignment again to repair changes made outside
/// Fleet. A failing Target never stops the others: each failure is logged and
/// returned for the Server (see [`repair`]).
async fn repair_active<A: Actions>(
    actions: &A,
    client: &Api,
    active: &[Assignment],
    redactor: &detail::Redactor,
    drifted: &mut Vec<drift::Report>,
) -> BTreeMap<String, repair::Failure> {
    let mut failures = BTreeMap::new();
    for assignment in active {
        let outcome = match actions.prepare(client, assignment).await {
            Ok(()) => actions.apply(client, assignment).await,
            Err(error) => Err(actions::ActionError::prepare(error)),
        };
        match outcome {
            Ok(repaired) => drifted.extend(drift::Report::new(&assignment.target_name, repaired)),
            Err(error) => {
                eprintln!(
                    "could not repair {}: {}",
                    assignment.target_name,
                    actions::describe(&error)
                );
                failures.insert(
                    assignment.target_name.clone(),
                    repair::Failure::new(
                        &assignment.target_name,
                        assignment.assignment_id,
                        &error,
                        redactor,
                    ),
                );
            }
        }
    }
    failures
}

/// What [`repair_active`] needs from [`actions::Registry`], so tests can fail
/// one Target on purpose.
trait Actions {
    async fn prepare(&self, api: &Api, assignment: &Assignment) -> Result<()>;
    async fn apply(
        &self,
        api: &Api,
        assignment: &Assignment,
    ) -> std::result::Result<Vec<String>, actions::ActionError>;
}

impl Actions for actions::Registry<'_> {
    async fn prepare(&self, api: &Api, assignment: &Assignment) -> Result<()> {
        actions::Registry::prepare(self, api, assignment).await
    }

    async fn apply(
        &self,
        api: &Api,
        assignment: &Assignment,
    ) -> std::result::Result<Vec<String>, actions::ActionError> {
        actions::Registry::apply(self, api, assignment).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::{Path, PathBuf},
    };
    use uuid::Uuid;

    fn test_directory() -> PathBuf {
        let path = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("fleet-main-{}", Uuid::new_v4()));
        state::private_directory(&path).unwrap();
        path
    }

    #[tokio::test]
    async fn detail_is_sent_only_after_the_failed_report_is_accepted() {
        let directory = test_directory();
        let path = directory.join("run.json");
        let attempt_id = Uuid::new_v4();
        let mut run = RunState {
            pending_report: Some(PendingReport {
                attempt_id,
                succeeded: false,
                error_code: Some("ownership_conflict".to_owned()),
            }),
            ..RunState::default()
        };
        state::write_json(&path, &run).unwrap();
        let detail = protocol::AttemptDetail {
            diagnostic: "Skill alpha exists without Fleet ownership".to_owned(),
            path: Some(".agents/skills/alpha".to_owned()),
            step: Some(fleet_reconcile::Step::Validate),
        };
        detail::save(&directory, attempt_id, &detail, detail::now()).unwrap();
        let server = crate::test_support::MockServer::start(vec![
            (500, ""),
            (200, r#"{"outcome":"recorded","state":"failed"}"#),
            (204, ""),
        ]);
        let client = Api::for_loopback_test(&server.url());
        let pending = || detail::load(&directory).unwrap();
        let unacknowledged = |run: &RunState| run.pending_report.as_ref().map(|r| r.attempt_id);

        // The Server rejects the report: the detail must not be sent.
        assert!(deliver_report(&client, &mut run, &path).await.is_err());
        let outcome = detail::deliver(
            &client,
            &directory,
            &pending(),
            unacknowledged(&run),
            detail::now(),
        )
        .await;
        assert_eq!(outcome, detail::Delivery::Waiting);
        assert_eq!(server.requests().len(), 1);

        // The report is accepted, then the detail follows.
        deliver_report(&client, &mut run, &path).await.unwrap();
        assert!(run.pending_report.is_none());
        let outcome = detail::deliver(
            &client,
            &directory,
            &pending(),
            unacknowledged(&run),
            detail::now(),
        )
        .await;
        assert_eq!(outcome, detail::Delivery::Sent);

        let requests = server.requests();
        let routes: Vec<_> = requests
            .iter()
            .map(|r| (r.method.as_str(), r.path.as_str()))
            .collect();
        let detail_route = format!("/agent/v1/attempts/{attempt_id}/detail");
        assert_eq!(
            routes,
            [
                ("POST", "/agent/v1/reports"),
                ("POST", "/agent/v1/reports"),
                ("POST", detail_route.as_str())
            ]
        );
        assert!(!directory.join("pending-detail.json").exists());
        fs::remove_dir_all(directory).unwrap();
    }

    struct FailingActions {
        calls: std::sync::Mutex<Vec<String>>,
    }

    impl Actions for FailingActions {
        async fn prepare(&self, _api: &Api, assignment: &Assignment) -> Result<()> {
            if assignment.target_name == "agent-file/codex" {
                bail!("download failed");
            }
            Ok(())
        }

        async fn apply(
            &self,
            _api: &Api,
            assignment: &Assignment,
        ) -> std::result::Result<Vec<String>, actions::ActionError> {
            self.calls
                .lock()
                .unwrap()
                .push(assignment.target_name.clone());
            match assignment.target_name.as_str() {
                "ai-client/codex" => Err(actions::ActionError::test_error(
                    "ai_client_reconcile_failed",
                    anyhow::anyhow!("Codex config is not UTF-8"),
                )),
                "skills" => Ok(vec![".agents/skills/a/SKILL.md".to_owned()]),
                _ => Ok(Vec::new()),
            }
        }
    }

    fn idle_assignment(target_name: &str) -> Assignment {
        serde_json::from_value(serde_json::json!({
            "assignmentId": Uuid::new_v4(), "attemptId": Uuid::new_v4(),
            "rolloutId": Uuid::new_v4(), "desiredRevisionId": Uuid::new_v4(),
            "targetName": target_name, "target": {"base": "home", "path": ".x"}, "skills": []
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn idle_repair_continues_past_failing_targets_and_reports_them() {
        // BTreeMap order: the failing ai-client Target comes first, as on the Node.
        let active = [
            "agent-file/codex",
            "ai-client/codex",
            "ai-client/opencode",
            "skills",
        ]
        .map(idle_assignment);
        let actions = FailingActions {
            calls: Default::default(),
        };
        let mut drifted = Vec::new();
        let redactor = detail::Redactor::new(&[PathBuf::from("/home/me")], Path::new("/state"));
        let failures = repair_active(
            &actions,
            &Api::for_loopback_test("http://127.0.0.1:9/"),
            &active,
            &redactor,
            &mut drifted,
        )
        .await;
        assert_eq!(
            *actions.calls.lock().unwrap(),
            ["ai-client/codex", "ai-client/opencode", "skills"]
        );
        assert_eq!(
            failures.keys().collect::<Vec<_>>(),
            ["agent-file/codex", "ai-client/codex"]
        );
        let codex = &failures["ai-client/codex"];
        assert_eq!(codex.assignment_id, active[1].assignment_id);
        assert_eq!(codex.error_code, "ai_client_reconcile_failed");
        assert_eq!(codex.diagnostic, "Codex config is not UTF-8");
        assert_eq!(
            failures["agent-file/codex"].error_code,
            "bundle_download_failed"
        );
        assert_eq!(
            failures["agent-file/codex"].step,
            Some(fleet_reconcile::Step::Download)
        );
        assert_eq!(drifted.len(), 1);
        assert_eq!(drifted[0].target, "skills");

        let mut tracker = repair::Tracker::default();
        tracker.idle_cycle(failures);
        let report = tracker.report().unwrap();
        assert_eq!(report.failures.len(), 2);
    }
}
