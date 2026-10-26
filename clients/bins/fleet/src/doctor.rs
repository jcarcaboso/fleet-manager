//! `fleet doctor`: open issues joined with the error catalog.

use crate::error::CliError;
use serde_json::{Map, Value, json};
use std::collections::HashMap;

fn invalid_response() -> CliError {
    CliError::transport(
        "invalid_response",
        "Fleet Server response had an unexpected shape",
    )
}

/// Builds the doctor document and reports whether any issue has severity `error`.
///
/// Every issue is the Server's object plus `explanation`, so `diagnostic`, `path` and `step` (the phase 2 attempt detail of a
/// failed Target) pass through unchanged. They are `null` when the Agent sent none and absent from a Server that predates phase 2.
///
/// `issues` is the `GET issues` response and `catalog` the `GET errors` response.
pub(crate) fn report(issues: &Value, catalog: &Value) -> Result<(Value, bool), CliError> {
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
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let mut issue: Map<String, Value> = item.as_object().ok_or_else(invalid_response)?.clone();
        match issue.get("severity").and_then(Value::as_str) {
            Some("error") => errors += 1,
            Some("warning") => warnings += 1,
            _ => {}
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
            "issues": out,
            "summary": {"errors": errors, "warnings": warnings},
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
        let (doc, failed) = report(&issues, &catalog()).unwrap();
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
        let (doc, _) = report(&issues, &catalog()).unwrap();
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
        let (doc, failed) = report(&issues, &catalog).unwrap();
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
        let (doc, failed) = report(&warnings, &catalog()).unwrap();
        assert!(!failed);
        assert_eq!(doc["ok"], true);
        let (doc, failed) = report(&json!({"items": []}), &Value::Null).unwrap();
        assert!(!failed);
        assert_eq!(
            doc,
            json!({"ok": true, "issues": [], "summary": {"errors": 0, "warnings": 0}})
        );
    }

    #[test]
    fn rejects_unexpected_shapes() {
        assert!(report(&json!({}), &catalog()).is_err());
        assert!(report(&json!({"items": [1]}), &catalog()).is_err());
        assert!(report(&json!({"items": [{"code": "x"}]}), &json!({})).is_err());
    }
}
