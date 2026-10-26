//! `fleet doctor`: issues joined with the error catalog.

use crate::error::CliError;
use serde_json::{Map, Value, json};
use std::collections::HashMap;

fn invalid_response() -> CliError {
    CliError::transport(
        "invalid_response",
        "Fleet Server response had an unexpected shape",
    )
}

/// The state of an issue: `open`, `acknowledged` or `snoozed`. A Server before phase 4 sends none, and a state this CLI does not
/// know is treated as open, so an issue is never hidden by a word it cannot read.
fn state_of(issue: &Map<String, Value>) -> &'static str {
    match issue.get("state").and_then(Value::as_str) {
        Some("acknowledged") => "acknowledged",
        Some("snoozed") => "snoozed",
        _ => "open",
    }
}

/// Builds the doctor document and reports whether a counted issue has severity `error`.
///
/// Every issue is the Server's object plus `explanation`, so `diagnostic`, `path` and `step` (the phase 2 attempt detail of a
/// failed Target) pass through unchanged. They are `null` when the Agent sent none and absent from a Server that predates phase 2.
/// Every issue is listed with its `state`. The summary, `ok` and the result count only open issues, unless `all` is set: an
/// acknowledged or snoozed error must not fail the check, and `states` still says how many issues are in each state.
///
/// `issues` is the `GET issues` response and `catalog` the `GET errors` response.
pub(crate) fn report(
    issues: &Value,
    catalog: &Value,
    all: bool,
) -> Result<(Value, bool), CliError> {
    let items = issues
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(invalid_response)?;
    let mut entries: HashMap<&str, &Value> = HashMap::new();
    if !items.is_empty() {
        for entry in catalog
            .get("items")
            .and_then(Value::as_array)
            .ok_or_else(invalid_response)?
        {
            if let Some(code) = entry.get("code").and_then(Value::as_str) {
                entries.entry(code).or_insert(entry);
            }
        }
    }
    let (mut errors, mut warnings) = (0_u64, 0_u64);
    let (mut open, mut acknowledged, mut snoozed) = (0_u64, 0_u64, 0_u64);
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let mut issue: Map<String, Value> = item.as_object().ok_or_else(invalid_response)?.clone();
        let state = state_of(&issue);
        match state {
            "acknowledged" => acknowledged += 1,
            "snoozed" => snoozed += 1,
            _ => open += 1,
        }
        issue.insert("state".to_owned(), Value::from(state));
        if all || state == "open" {
            match issue.get("severity").and_then(Value::as_str) {
                Some("error") => errors += 1,
                Some("warning") => warnings += 1,
                _ => {}
            }
        }
        // The specific agent/server error code explains best; fall back to the issue code.
        let entry = ["errorCode", "code"]
            .into_iter()
            .filter_map(|key| issue.get(key).and_then(Value::as_str))
            .find_map(|code| entries.get(code));
        let explanation = entry.map_or(Value::Null, |entry| {
            json!({
                "title": entry.get("title").cloned().unwrap_or(Value::Null),
                "explanation": entry.get("explanation").cloned().unwrap_or(Value::Null),
                "fix": entry.get("fix").cloned().unwrap_or(Value::Null),
            })
        });
        issue.insert("explanation".to_owned(), explanation);
        out.push(Value::Object(issue));
    }
    Ok((
        json!({
            "ok": errors == 0,
            "counted": if all { "all" } else { "open" },
            "issues": out,
            "summary": {"errors": errors, "warnings": warnings},
            "states": {"open": open, "acknowledged": acknowledged, "snoozed": snoozed},
        }),
        errors > 0,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> Value {
        json!({"items": [
            {"code": "lock_failed", "source": "agent", "title": "Locked", "explanation": "e1", "fix": ["a", "b"]},
            {"code": "assignment_failed", "source": "issue", "title": "Failed", "explanation": "e2", "fix": []},
            {"code": "node_not_contacting", "source": "issue", "title": "Silent", "explanation": "e3", "fix": ["c"]}
        ]})
    }

    #[test]
    fn joins_error_code_then_issue_code() {
        let issues = json!({"items": [
            {"id": "1", "code": "assignment_failed", "severity": "error", "errorCode": "lock_failed"},
            {"id": "2", "code": "node_not_contacting", "severity": "warning", "errorCode": null},
            {"id": "3", "code": "mystery", "severity": "warning", "errorCode": "also_unknown"}
        ]});
        let (doc, failed) = report(&issues, &catalog(), false).unwrap();
        assert!(failed);
        assert_eq!(doc["ok"], false);
        assert_eq!(doc["summary"], json!({"errors": 1, "warnings": 2}));
        assert_eq!(
            doc["issues"][0]["explanation"],
            json!({"title": "Locked", "explanation": "e1", "fix": ["a", "b"]})
        );
        assert_eq!(doc["issues"][0]["id"], "1");
        assert_eq!(doc["issues"][1]["explanation"]["title"], "Silent");
        assert_eq!(doc["issues"][2]["explanation"], Value::Null);
    }

    #[test]
    fn keeps_the_attempt_detail_of_an_issue() {
        let issues = json!({"items": [
            {"id": "1", "code": "assignment_failed", "severity": "error", "errorCode": "lock_failed",
             "diagnostic": "lock is held by process 4121", "path": ".claude/settings.json", "step": "lock"},
            {"id": "2", "code": "assignment_failed", "severity": "error", "errorCode": "lock_failed",
             "diagnostic": null, "path": null, "step": null},
            {"id": "3", "code": "node_not_contacting", "severity": "warning", "errorCode": null}
        ]});
        let (doc, _) = report(&issues, &catalog(), false).unwrap();
        let first = &doc["issues"][0];
        assert_eq!(first["diagnostic"], "lock is held by process 4121");
        assert_eq!(first["path"], ".claude/settings.json");
        assert_eq!(first["step"], "lock");
        assert_eq!(first["explanation"]["title"], "Locked");
        let second = doc["issues"][1].as_object().unwrap();
        for key in ["diagnostic", "path", "step"] {
            assert_eq!(second.get(key), Some(&Value::Null), "{key}");
        }
        // Nothing is invented for an issue (or a Server) that has no detail.
        let third = doc["issues"][2].as_object().unwrap();
        for key in ["diagnostic", "path", "step"] {
            assert!(!third.contains_key(key), "{key}");
        }
    }

    #[test]
    fn passes_an_outdated_agent_issue_through() {
        let catalog = json!({"items": [
            {"code": "agent_outdated", "source": "issue", "title": "Agent is out of date", "explanation": "e4", "fix": ["upgrade"]}
        ]});
        let issues = json!({"items": [
            {"id": "agent_outdated:n1", "code": "agent_outdated", "severity": "warning", "errorCode": null,
             "title": "studio-mini: Agent 0.8.1 is out of date", "detail": "Agent 0.8.1 is running; 0.9.0 is the latest release.",
             "action": "Upgrade the Agent with `brew upgrade fleet-agent`, then restart its service.",
             "nodeId": "n1", "nodeName": "studio-mini", "target": null, "since": "2026-10-26T08:00:00Z",
             "commands": ["fleet nodes show studio-mini"]}
        ]});
        let (doc, failed) = report(&issues, &catalog, false).unwrap();
        // A warning: the document is ok and the command exits 0.
        assert!(!failed);
        assert_eq!(doc["ok"], true);
        assert_eq!(doc["summary"], json!({"errors": 0, "warnings": 1}));
        let issue = &doc["issues"][0];
        assert_eq!(issue["code"], "agent_outdated");
        assert_eq!(issue["explanation"]["title"], "Agent is out of date");
        assert_eq!(issue["commands"], json!(["fleet nodes show studio-mini"]));
        assert_eq!(
            issue["action"],
            "Upgrade the Agent with `brew upgrade fleet-agent`, then restart its service."
        );
        assert_eq!(issue["detail"], issues["items"][0]["detail"]);
        assert_eq!(issue["since"], "2026-10-26T08:00:00Z");
    }

    #[test]
    fn warnings_only_and_empty_are_ok() {
        let warnings = json!({"items": [{"code": "node_not_contacting", "severity": "warning"}]});
        let (doc, failed) = report(&warnings, &catalog(), false).unwrap();
        assert!(!failed);
        assert_eq!(doc["ok"], true);
        let (doc, failed) = report(&json!({"items": []}), &Value::Null, false).unwrap();
        assert!(!failed);
        assert_eq!(
            doc,
            json!({"ok": true, "counted": "open", "issues": [], "summary": {"errors": 0, "warnings": 0},
                   "states": {"open": 0, "acknowledged": 0, "snoozed": 0}})
        );
    }

    #[test]
    fn rejects_unexpected_shapes() {
        assert!(report(&json!({}), &catalog(), false).is_err());
        assert!(report(&json!({"items": [1]}), &catalog(), false).is_err());
        assert!(report(&json!({"items": [{"code": "x"}]}), &json!({}), false).is_err());
    }

    fn mixed() -> Value {
        json!({"items": [
            {"id": "a", "code": "assignment_failed", "severity": "error", "errorCode": "lock_failed", "state": "open",
             "stateBy": null, "stateAt": null, "snoozedUntil": null},
            {"id": "b", "code": "assignment_failed", "severity": "error", "errorCode": "lock_failed", "state": "acknowledged",
             "stateBy": "joan", "stateAt": "2026-10-26T10:00:00Z", "snoozedUntil": null},
            {"id": "c", "code": "node_not_contacting", "severity": "warning", "errorCode": null, "state": "snoozed",
             "stateBy": "ana", "stateAt": "2026-10-26T10:05:00Z", "snoozedUntil": "2026-10-26T14:05:00Z"},
            {"id": "d", "code": "node_not_contacting", "severity": "warning", "errorCode": null, "state": "open"}
        ]})
    }

    #[test]
    fn counts_only_open_issues_by_default_but_lists_every_one_with_its_state() {
        let (doc, failed) = report(&mixed(), &catalog(), false).unwrap();
        assert!(failed);
        assert_eq!(doc["counted"], "open");
        assert_eq!(doc["summary"], json!({"errors": 1, "warnings": 1}));
        assert_eq!(
            doc["states"],
            json!({"open": 2, "acknowledged": 1, "snoozed": 1})
        );
        let listed: Vec<_> = doc["issues"]
            .as_array()
            .unwrap()
            .iter()
            .map(|issue| {
                (
                    issue["id"].as_str().unwrap(),
                    issue["state"].as_str().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            listed,
            [
                ("a", "open"),
                ("b", "acknowledged"),
                ("c", "snoozed"),
                ("d", "open")
            ]
        );
        // The Server's state fields pass through, and the explanation is still joined.
        assert_eq!(doc["issues"][1]["stateBy"], "joan");
        assert_eq!(doc["issues"][2]["snoozedUntil"], "2026-10-26T14:05:00Z");
        assert_eq!(doc["issues"][1]["explanation"]["title"], "Locked");
    }

    #[test]
    fn an_acknowledged_or_snoozed_error_does_not_fail_the_check() {
        let issues = json!({"items": [
            {"id": "b", "code": "assignment_failed", "severity": "error", "errorCode": "lock_failed", "state": "acknowledged"},
            {"id": "c", "code": "assignment_failed", "severity": "error", "errorCode": "lock_failed", "state": "snoozed"}
        ]});
        let (doc, failed) = report(&issues, &catalog(), false).unwrap();
        assert!(!failed);
        assert_eq!(doc["ok"], true);
        assert_eq!(doc["summary"], json!({"errors": 0, "warnings": 0}));
        assert_eq!(doc["issues"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn all_counts_every_issue() {
        let (doc, failed) = report(&mixed(), &catalog(), true).unwrap();
        assert!(failed);
        assert_eq!(doc["counted"], "all");
        assert_eq!(doc["summary"], json!({"errors": 2, "warnings": 2}));
        let issues = json!({"items": [
            {"id": "b", "code": "assignment_failed", "severity": "error", "errorCode": "lock_failed", "state": "acknowledged"}
        ]});
        let (doc, failed) = report(&issues, &catalog(), true).unwrap();
        assert!(failed, "--all fails on an acknowledged error");
        assert_eq!(doc["ok"], false);
    }

    #[test]
    fn a_server_without_issue_state_means_every_issue_is_open() {
        let issues = json!({"items": [
            {"id": "1", "code": "assignment_failed", "severity": "error", "errorCode": "lock_failed"},
            {"id": "2", "code": "node_not_contacting", "severity": "warning", "state": "something-new"}
        ]});
        let (doc, failed) = report(&issues, &catalog(), false).unwrap();
        assert!(failed);
        assert_eq!(doc["issues"][0]["state"], "open");
        assert_eq!(doc["issues"][1]["state"], "open");
        assert_eq!(
            doc["states"],
            json!({"open": 2, "acknowledged": 0, "snoozed": 0})
        );
        assert_eq!(doc["summary"], json!({"errors": 1, "warnings": 1}));
    }
}
