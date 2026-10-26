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
