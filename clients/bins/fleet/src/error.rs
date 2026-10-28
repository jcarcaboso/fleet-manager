//! Structured CLI errors.
//!
//! Every failure reaches stderr as one JSON line. Messages are owned by the CLI:
//! response bodies from the Server are never echoed, only a validated `code`.

use serde_json::{Value, json};
use std::fmt;

pub(crate) const EXIT_USAGE: u8 = 2;
pub(crate) const EXIT_AUTH: u8 = 3;
pub(crate) const EXIT_NOT_FOUND: u8 = 4;
pub(crate) const EXIT_CONFLICT: u8 = 5;
pub(crate) const EXIT_SERVER: u8 = 6;
pub(crate) const EXIT_DOCTOR_ERRORS: u8 = 10;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CliError {
    pub(crate) code: String,
    pub(crate) message: String,
    pub(crate) status: Option<u16>,
    pub(crate) exit: u8,
}

impl CliError {
    /// A rejected argument or missing local configuration. Exit 2.
    pub(crate) fn usage(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
            status: None,
            exit: EXIT_USAGE,
        }
    }

    /// A resource the CLI looked up itself (through list requests) is absent. Exit 4.
    pub(crate) fn not_found(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
            status: None,
            exit: EXIT_NOT_FOUND,
        }
    }

    /// A connection, timeout or response-shape failure. Exit 6.
    pub(crate) fn transport(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
            status: None,
            exit: EXIT_SERVER,
        }
    }

    /// A non-success HTTP status. `code` is the Server's validated error code,
    /// if it sent one; `message` is always CLI-owned text.
    pub(crate) fn http(status: u16, code: Option<String>, message: impl Into<String>) -> Self {
        let (default_code, exit) = match status {
            401 => ("unauthorized", EXIT_AUTH),
            403 => ("forbidden", EXIT_AUTH),
            404 => ("not_found", EXIT_NOT_FOUND),
            409 => ("conflict", EXIT_CONFLICT),
            400 => ("invalid_request", EXIT_SERVER),
            500..=599 => ("server_error", EXIT_SERVER),
            _ => ("request_failed", EXIT_SERVER),
        };
        Self {
            code: code.unwrap_or_else(|| default_code.to_owned()),
            message: message.into(),
            status: Some(status),
            exit,
        }
    }

    pub(crate) fn to_json(&self) -> Value {
        json!({"error": {"code": self.code, "message": self.message, "status": self.status}})
    }
}

impl fmt::Display for CliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CliError {}

/// `^[a-z][a-z0-9_]{0,63}$`
pub(crate) fn is_error_code(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes.next().is_some_and(|first| first.is_ascii_lowercase())
        && value.len() <= 64
        && bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

/// CLI-owned text for Server error codes the contract defines.
pub(crate) fn known_code_message(code: &str) -> Option<&'static str> {
    Some(match code {
        "insufficient_scope" => "operator token scope does not allow this command",
        "node_not_found" => "no node matches that alias or ID",
        "target_not_found" => "the node has no such target",
        "target_not_failed" => "the target's current assignment has not failed",
        "node_revoked" => "the node is revoked",
        "node_alias_in_use" => "the alias is already in use",
        "invalid_request" => "Fleet Server rejected the request as invalid",
        "invalid_selection" => "Fleet Server rejected the model selection as invalid",
        "stale_selection" => "the model selection changed since it was read; run it again",
        "pinned_model_excluded" => "the selection would exclude a model an assignment pins",
        "catalog_unavailable" => "no CLIProxy catalog is available for that base URL",
        "agent_update_unsupported" => {
            "the node's Agent cannot update itself; upgrade it once by hand and run `fleet-agent service install`"
        }
        "agent_update_current" => "the node's Agent already runs the Server's version",
        "agent_update_in_progress" => "the node's Agent is already updating",
        "agent_update_not_cancellable" => {
            "only an update the Agent has not started can be cancelled"
        }
        "agent_release_unavailable" => {
            "the Server could not get its Agent release; it may not be published yet (see `fleet explain agent_release_unavailable`)"
        }
        "agent_release_invalid" => {
            "the Agent release failed signature or digest verification on the Server"
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_code_pattern() {
        for good in ["a", "node_not_found", "x1_2", &"a".repeat(64)] {
            assert!(is_error_code(good), "{good}");
        }
        for bad in ["", "1a", "_a", "A", "a-b", "a b", "a\n", &"a".repeat(65)] {
            assert!(!is_error_code(bad), "{bad:?}");
        }
    }

    #[test]
    fn status_maps_to_exit_codes() {
        for (status, exit) in [
            (401, 3),
            (403, 3),
            (404, 4),
            (409, 5),
            (400, 6),
            (302, 6),
            (500, 6),
        ] {
            assert_eq!(CliError::http(status, None, "m").exit, exit, "{status}");
        }
        let error = CliError::http(403, Some("insufficient_scope".into()), "m");
        assert_eq!(error.code, "insufficient_scope");
        assert_eq!(error.exit, 3);
        assert_eq!(
            error.to_json(),
            json!({"error":{"code":"insufficient_scope","message":"m","status":403}})
        );
        assert_eq!(
            CliError::usage("c", "m").to_json()["error"]["status"],
            Value::Null
        );
    }
}
