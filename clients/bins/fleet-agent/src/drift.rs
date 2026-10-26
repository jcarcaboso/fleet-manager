//! Drift reports.
//!
//! When reconciliation repairs files that were changed outside Fleet in a
//! Target the Agent owns, the Agent tells the Server which ones, once, with
//! `POST agent/v1/drift`. The report is a best-effort side task after the
//! cycle: nothing is saved, retried or waited for, one report is in flight at
//! most, and a failure (including 404 from an older Server) is only logged.

use crate::protocol::Api;
use serde::Serialize;
use std::{future::Future, path::Path};

/// Most files in one report.
pub const MAX_FILES: usize = fleet_reconcile::MAX_REPAIRED_PATHS;

/// Body of `POST agent/v1/drift`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Report {
    pub target: String,
    pub files: Vec<String>,
}

impl Report {
    /// The report for the files repaired in `target`: only safe relative
    /// paths, sorted, unique and at most [`MAX_FILES`]. `None` if no file is
    /// left.
    pub fn new(target: &str, files: Vec<String>) -> Option<Self> {
        let mut files: Vec<String> = files
            .into_iter()
            .filter(|file| fleet_reconcile::report_path(Path::new(file)).as_deref() == Some(file))
            .collect();
        files.sort();
        files.dedup();
        files.truncate(MAX_FILES);
        (!files.is_empty()).then(|| Self {
            target: target.to_owned(),
            files,
        })
    }
}

/// Drift reports being sent. The task ends when all of them are sent or
/// failed.
pub type Task = tokio::task::JoinHandle<()>;

/// Sends the reports of one cycle as a single side task, one at a time. If the
/// previous cycle's task is still running the new reports are dropped, so at
/// most one task and one request are ever in flight.
pub fn step<F, Fut>(reports: Vec<Report>, in_flight: &mut Option<Task>, send: F)
where
    F: Fn(Report) -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    if reports.is_empty() {
        return;
    }
    if in_flight.as_ref().is_some_and(|task| !task.is_finished()) {
        eprintln!("dropped a drift report: the previous one is still being sent");
        return;
    }
    *in_flight = Some(tokio::spawn(async move {
        for report in reports {
            send(report).await;
        }
    }));
}

/// Never retried: an error is logged and the report is gone.
pub async fn deliver(client: &Api, report: &Report) {
    if let Err(error) = client.drift(report).await {
        eprintln!("dropped a drift report: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::detail::testing::MockServer;
    use std::{
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::{Duration, Instant},
    };

    #[test]
    fn reports_hold_only_safe_sorted_unique_paths_up_to_the_cap() {
        let mut files: Vec<String> = (0..30)
            .rev()
            .map(|i| format!("skills/s/f{i:02}.md"))
            .collect();
        files.extend(
            [
                "/etc/passwd",
                "../escape",
                "a/../b",
                "",
                "a\\b",
                "a/\u{7}b",
                "skills/s/f03.md",
            ]
            .map(String::from),
        );
        files.push("x".repeat(513));
        let report = Report::new("skills", files).unwrap();
        assert_eq!(report.target, "skills");
        assert_eq!(report.files.len(), MAX_FILES);
        assert_eq!(report.files[0], "skills/s/f00.md");
        assert_eq!(report.files[19], "skills/s/f19.md");
        assert!(report.files.windows(2).all(|w| w[0] < w[1]));

        assert_eq!(
            Report::new("skills", vec!["../x".into(), String::new()]),
            None
        );
        assert_eq!(Report::new("skills", Vec::new()), None);
        assert!(Report::new("skills", vec!["x".repeat(512)]).is_some());
    }

    #[tokio::test]
    async fn a_report_is_posted_and_the_response_is_ignored() {
        let server = MockServer::start(vec![(204, ""), (200, "{\"unexpected\":true}")]);
        let client = Api::for_loopback_test(&server.url());
        let report = Report::new(
            "agent-file/codex",
            vec![".codex/AGENTS.md".into(), ".codex/AGENTS.md".into()],
        )
        .unwrap();

        deliver(&client, &report).await;
        deliver(&client, &report).await;

        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        for request in &requests {
            assert_eq!(request.method, "POST");
            assert_eq!(request.path, "/agent/v1/drift");
            assert_eq!(request.header("content-type"), Some("application/json"));
            let body: serde_json::Value = serde_json::from_str(&request.body).unwrap();
            assert_eq!(
                body,
                serde_json::json!({"target": "agent-file/codex", "files": [".codex/AGENTS.md"]})
            );
        }
    }

    #[tokio::test]
    async fn an_older_server_or_any_error_drops_the_report_without_retrying() {
        for status in [404, 400, 429, 500] {
            let server = MockServer::start(vec![(status, "")]);
            let client = Api::for_loopback_test(&server.url());
            let report = Report::new("skills", vec![".agents/skills/a/SKILL.md".into()]).unwrap();
            deliver(&client, &report).await;
            assert_eq!(server.requests().len(), 1, "status {status}");
        }
        // No Server at all.
        let client = Api::for_loopback_test("http://127.0.0.1:9/");
        let report = Report::new("skills", vec!["a".into()]).unwrap();
        deliver(&client, &report).await;
    }

    fn sample(target: &str) -> Report {
        Report::new(target, vec!["a/b".into()]).unwrap()
    }

    #[tokio::test]
    async fn the_report_is_a_side_task_and_one_is_in_flight_at_most() {
        let sent = Arc::new(AtomicUsize::new(0));
        let slow = |sent: Arc<AtomicUsize>| {
            move |_report: Report| {
                let sent = sent.clone();
                async move {
                    sent.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_secs(30)).await;
                }
            }
        };
        let mut in_flight = None;

        // Nothing to report: nothing spawned.
        step(Vec::new(), &mut in_flight, slow(sent.clone()));
        assert!(in_flight.is_none());

        // The cycle does not wait for the 30 s send.
        let began = Instant::now();
        step(vec![sample("skills")], &mut in_flight, slow(sent.clone()));
        assert!(began.elapsed() < Duration::from_secs(1));
        assert!(in_flight.as_ref().is_some_and(|task| !task.is_finished()));
        tokio::task::yield_now().await;
        assert_eq!(sent.load(Ordering::SeqCst), 1);

        // Reports of the next cycle are dropped while that one runs.
        step(
            vec![sample("agent-file/codex")],
            &mut in_flight,
            slow(sent.clone()),
        );
        tokio::task::yield_now().await;
        assert_eq!(sent.load(Ordering::SeqCst), 1);
        in_flight.take().unwrap().abort();
    }

    #[tokio::test]
    async fn a_finished_task_does_not_block_the_next_report() {
        let sent = Arc::new(AtomicUsize::new(0));
        let quick = |sent: Arc<AtomicUsize>| {
            move |_report: Report| {
                let sent = sent.clone();
                async move {
                    sent.fetch_add(1, Ordering::SeqCst);
                }
            }
        };
        let mut in_flight = None;
        step(
            vec![sample("skills"), sample("agent-file/codex")],
            &mut in_flight,
            quick(sent.clone()),
        );
        in_flight.as_mut().unwrap().await.unwrap();
        assert_eq!(sent.load(Ordering::SeqCst), 2);
        step(vec![sample("skills")], &mut in_flight, quick(sent.clone()));
        in_flight.take().unwrap().await.unwrap();
        assert_eq!(sent.load(Ordering::SeqCst), 3);
    }
}
