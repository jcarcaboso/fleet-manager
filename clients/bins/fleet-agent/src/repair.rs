//! Idle repair failures.
//!
//! When no new Assignment is pending, each cycle applies every active
//! Assignment again to repair changes made outside Fleet. Those Assignments
//! already succeeded, so a failure there cannot change their Attempt. Instead
//! the Agent tells the Server which Targets it currently fails to repair, with
//! `PUT agent/v1/repair-failures`: the body is the complete list, and an empty
//! list clears it. The Server shows each one as a `repair_failed` issue.
//!
//! Like drift, it is a best-effort side task after the cycle, with at most one
//! request in flight. The list is sent again only when it changes, or when a
//! transport error, a 429 or a 5xx response kept the Server from storing it.
//! Any other response (including 404 from an older Server) counts as done
//! until the list changes. The first list after a start is always sent, so a
//! failure that was fixed while the Agent was stopped is cleared too.

use crate::{
    actions::ActionError,
    detail::{self, Redactor},
    protocol::{Api, ProtocolError},
};
use reqwest::StatusCode;
use serde::Serialize;
use std::{collections::BTreeMap, future::Future};
use uuid::Uuid;

/// Most Targets in one report.
pub const MAX_FAILURES: usize = 50;

/// One Target the Agent failed to repair.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub target: String,
    pub assignment_id: Uuid,
    pub error_code: String,
    pub diagnostic: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<fleet_reconcile::Step>,
}

impl Failure {
    pub fn new(
        target: &str,
        assignment_id: Uuid,
        error: &ActionError,
        redactor: &Redactor,
    ) -> Self {
        let detail = detail::build(error, redactor);
        Self {
            target: target.to_owned(),
            assignment_id,
            error_code: error.code().to_owned(),
            diagnostic: detail.diagnostic,
            path: detail.path,
            step: detail.step,
        }
    }
}

/// Body of `PUT agent/v1/repair-failures`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Report {
    pub failures: Vec<Failure>,
}

/// Whether the Server needs to see the same list again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    Done,
    Retry,
}

/// The repair failures of the running Agent and what the Server last stored.
#[derive(Default)]
pub struct Tracker {
    /// Current failures by Target. `None` until the first idle cycle.
    current: Option<BTreeMap<String, Failure>>,
    sent: Option<Report>,
    in_flight: Option<tokio::task::JoinHandle<(Report, Delivery)>>,
}

impl Tracker {
    /// Replaces the failures after an idle cycle applied every active
    /// Assignment.
    pub fn idle_cycle(&mut self, failures: BTreeMap<String, Failure>) {
        self.current = Some(failures);
    }

    /// Forgets a Target whose new Assignment was just applied: its result is
    /// reported on the Attempt, and the next idle cycle checks it again.
    pub fn applied(&mut self, target: &str) {
        if let Some(current) = &mut self.current {
            current.remove(target);
        }
    }

    pub fn report(&self) -> Option<Report> {
        self.current.as_ref().map(|current| Report {
            failures: current.values().take(MAX_FAILURES).cloned().collect(),
        })
    }

    /// Sends the list as a side task when it differs from what the Server
    /// has. It never waits for the request.
    pub async fn step<F, Fut>(&mut self, send: F)
    where
        F: FnOnce(Report) -> Fut,
        Fut: Future<Output = Delivery> + Send + 'static,
    {
        if let Some(task) = self.in_flight.take_if(|task| task.is_finished())
            && let Ok((report, Delivery::Done)) = task.await
        {
            self.sent = Some(report);
        }
        let Some(report) = self.report() else {
            return;
        };
        if self.in_flight.is_some() || self.sent.as_ref() == Some(&report) {
            return;
        }
        let sending = send(report.clone());
        self.in_flight = Some(tokio::spawn(async move { (report, sending.await) }));
    }

    /// Waits for the request in flight, for `run --once`.
    pub async fn finish(&mut self) {
        if let Some(task) = self.in_flight.take() {
            let _ = task.await;
        }
    }
}

/// Sends one list. Errors are logged; see the module documentation for which
/// ones are retried.
pub async fn deliver(client: &Api, report: &Report) -> Delivery {
    match client.repair_failures(report).await {
        Ok(()) => Delivery::Done,
        Err(error) => {
            eprintln!("could not send repair failures: {error}");
            match error {
                ProtocolError::Http(status)
                    if status != StatusCode::TOO_MANY_REQUESTS && !status.is_server_error() =>
                {
                    Delivery::Done
                }
                _ => Delivery::Retry,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::detail::testing::MockServer;
    use std::path::{Path, PathBuf};

    fn failure(target: &str, message: &str) -> Failure {
        let error = ActionError::test_error(
            "ai_client_reconcile_failed",
            anyhow::anyhow!("{message} at /home/me/.codex/config.toml"),
        );
        Failure::new(
            target,
            Uuid::nil(),
            &error,
            &Redactor::new(&[PathBuf::from("/home/me")], Path::new("/state")),
        )
    }

    fn failures(items: &[(&str, &str)]) -> BTreeMap<String, Failure> {
        items
            .iter()
            .map(|(target, message)| (target.to_string(), failure(target, message)))
            .collect()
    }

    #[test]
    fn failures_carry_code_and_a_redacted_diagnostic() {
        let failure = failure("ai-client/codex", "broken");
        assert_eq!(failure.error_code, "ai_client_reconcile_failed");
        assert_eq!(failure.diagnostic, "broken at ~/.codex/config.toml");
        let body = serde_json::to_value(Report {
            failures: vec![failure],
        })
        .unwrap();
        assert_eq!(
            body,
            serde_json::json!({"failures": [{
                "target": "ai-client/codex",
                "assignmentId": Uuid::nil(),
                "errorCode": "ai_client_reconcile_failed",
                "diagnostic": "broken at ~/.codex/config.toml"
            }]})
        );
    }

    async fn settle(tracker: &mut Tracker) {
        if let Some(task) = &mut tracker.in_flight {
            while !task.is_finished() {
                tokio::task::yield_now().await;
            }
        }
    }

    #[tokio::test]
    async fn a_list_is_sent_once_per_change_and_retried_only_when_asked() {
        let sent = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let send = |delivery: Delivery| {
            let sent = sent.clone();
            move |report: Report| {
                sent.lock().unwrap().push(report.failures.len());
                async move { delivery }
            }
        };
        let mut tracker = Tracker::default();

        // Nothing is known before the first idle cycle.
        tracker.step(send(Delivery::Done)).await;
        assert!(sent.lock().unwrap().is_empty());

        // The first list is sent even when it is empty, to clear old failures.
        tracker.idle_cycle(BTreeMap::new());
        tracker.step(send(Delivery::Done)).await;
        settle(&mut tracker).await;
        tracker.step(send(Delivery::Done)).await;
        assert_eq!(*sent.lock().unwrap(), [0]);

        tracker.idle_cycle(failures(&[("ai-client/codex", "a"), ("skills", "b")]));
        tracker.step(send(Delivery::Retry)).await;
        settle(&mut tracker).await;
        tracker.step(send(Delivery::Done)).await;
        settle(&mut tracker).await;
        tracker.step(send(Delivery::Done)).await;
        assert_eq!(*sent.lock().unwrap(), [0, 2, 2]);

        // A Target whose new Assignment was applied is dropped from the list.
        tracker.applied("skills");
        tracker.step(send(Delivery::Done)).await;
        settle(&mut tracker).await;
        assert_eq!(*sent.lock().unwrap(), [0, 2, 2, 1]);
    }

    #[tokio::test]
    async fn the_report_is_put_and_only_transient_errors_are_retried() {
        let report = Report {
            failures: vec![failure("skills", "x")],
        };
        for (status, expected) in [
            (204, Delivery::Done),
            (404, Delivery::Done),
            (400, Delivery::Done),
            (429, Delivery::Retry),
            (503, Delivery::Retry),
        ] {
            let server = MockServer::start(vec![(status, "")]);
            let client = Api::for_loopback_test(&server.url());
            assert_eq!(deliver(&client, &report).await, expected, "{status}");
            let requests = server.requests();
            assert_eq!(requests[0].method, "PUT");
            assert_eq!(requests[0].path, "/agent/v1/repair-failures");
        }
        let client = Api::for_loopback_test("http://127.0.0.1:9/");
        assert_eq!(deliver(&client, &report).await, Delivery::Retry);
    }
}
