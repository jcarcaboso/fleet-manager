//! End-to-end tests: run the real `fleet` binary against a loopback mock Server.

use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;

#[derive(Clone, Debug)]
struct Seen {
    line: String,
    body: String,
}

struct Mock {
    url: String,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Mock {
    fn requests(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }
    fn lines(&self) -> Vec<String> {
        self.requests().into_iter().map(|seen| seen.line).collect()
    }
}

/// Serves every request from `handler(request line) -> (status, body)` on a detached thread.
fn mock(handler: impl Fn(&str) -> (u16, String) + Send + 'static) -> Mock {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let mut data = Vec::new();
            let mut buffer = [0_u8; 4096];
            let (line, body) = loop {
                let size = stream.read(&mut buffer).unwrap_or(0);
                data.extend_from_slice(&buffer[..size]);
                let text = String::from_utf8_lossy(&data).into_owned();
                if let Some((head, rest)) = text.split_once("\r\n\r\n") {
                    let length = head
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .map(|value| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if rest.len() >= length || size == 0 {
                        break (head.lines().next().unwrap().to_owned(), rest.to_owned());
                    }
                } else if size == 0 {
                    break (String::new(), String::new());
                }
            };
            let (status, reply) = handler(&line);
            log.lock().unwrap().push(Seen { line, body });
            let response = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{reply}",
                reply.len()
            );
            let _ = stream.write_all(response.as_bytes());
        }
    });
    Mock { url, seen }
}

struct Run {
    code: i32,
    stdout: String,
    stderr: String,
}

impl Run {
    fn out(&self) -> Value {
        serde_json::from_str(&self.stdout).unwrap_or_else(|_| panic!("stdout: {:?}", self.stdout))
    }
    fn err(&self) -> Value {
        assert_eq!(
            self.stderr.trim_end().lines().count(),
            1,
            "{:?}",
            self.stderr
        );
        serde_json::from_str(self.stderr.trim()).unwrap()
    }
}

fn fleet_at(url: &str, args: &[&str]) -> Run {
    let output = Command::new(env!("CARGO_BIN_EXE_fleet"))
        .args(["--server-url", url, "--allow-http"])
        .args(args)
        .env("FLEET_OPERATOR_TOKEN", "test-token")
        .env_remove("FLEET_SERVER_URL")
        .output()
        .unwrap();
    Run {
        code: output.status.code().unwrap(),
        stdout: String::from_utf8(output.stdout).unwrap(),
        stderr: String::from_utf8(output.stderr).unwrap(),
    }
}

const NODE_ID: &str = "00000000-0000-0000-0000-000000000001";

fn node_json() -> String {
    json!({
        "nodeId": NODE_ID, "name": "studio mini/1", "platform": "macos", "freshness": "fresh",
        "revoked": false, "lastContactAt": "2026-10-25T14:29:10Z",
        "summary": {"pending": 0, "applying": 0, "succeeded": 4, "failed": 1, "superseded": 0},
        "targets": []
    })
    .to_string()
}

fn node_server() -> Mock {
    mock(|line| {
        if line.starts_with("GET /operator/v1/nodes/") {
            (200, node_json())
        } else {
            (200, r#"{"ok":true}"#.to_owned())
        }
    })
}

#[test]
fn doctor_reports_errors_with_explanations_and_exits_10() {
    let server = mock(|line| {
        if line.starts_with("GET /operator/v1/issues") {
            (200, json!({"items": [
                {"id": "assignment_failed:n:skills", "code": "assignment_failed", "severity": "error",
                 "errorCode": "lock_failed", "nodeName": "studio-mini", "target": "skills",
                 "diagnostic": "lock is held by process 4121 since 2026-10-25T13:14:58Z",
                 "path": ".agents/skills/incident-runbook/SKILL.md", "step": "lock",
                 "commands": ["fleet retry studio-mini skills"]},
                {"id": "stale:n", "code": "node_not_contacting", "severity": "warning", "errorCode": null},
                {"id": "x", "code": "unknown_issue", "severity": "warning", "errorCode": null}
            ]}).to_string())
        } else if line.starts_with("GET /operator/v1/errors") {
            (200, json!({"items": [
                {"code": "lock_failed", "source": "agent", "title": "Locked", "explanation": "e", "fix": ["wait"]},
                {"code": "node_not_contacting", "source": "issue", "title": "Silent", "explanation": "s", "fix": []}
            ]}).to_string())
        } else {
            (404, "{}".to_owned())
        }
    });
    let run = fleet_at(&server.url, &["doctor"]);
    assert_eq!(run.code, 10, "{}", run.stderr);
    assert_eq!(run.stderr, "");
    let doc = run.out();
    assert_eq!(doc["ok"], false);
    assert_eq!(doc["summary"], json!({"errors": 1, "warnings": 2}));
    assert_eq!(doc["issues"][0]["explanation"]["title"], "Locked");
    assert_eq!(doc["issues"][0]["explanation"]["fix"], json!(["wait"]));
    assert_eq!(
        doc["issues"][0]["commands"][0],
        "fleet retry studio-mini skills"
    );
    // The attempt detail from GET issues is in the doctor output; an issue without it gets nothing added.
    assert_eq!(
        doc["issues"][0]["diagnostic"],
        "lock is held by process 4121 since 2026-10-25T13:14:58Z"
    );
    assert_eq!(
        doc["issues"][0]["path"],
        ".agents/skills/incident-runbook/SKILL.md"
    );
    assert_eq!(doc["issues"][0]["step"], "lock");
    assert!(doc["issues"][1].get("diagnostic").is_none());
    assert_eq!(doc["issues"][1]["explanation"]["title"], "Silent");
    assert_eq!(doc["issues"][2]["explanation"], Value::Null);
    // GET issues once, GET errors once, indexed locally.
    assert_eq!(server.lines().len(), 2, "{:?}", server.lines());
}

#[test]
fn doctor_exits_zero_for_warnings_and_for_a_clean_fleet() {
    let warnings = mock(|line| {
        if line.contains("/issues") {
            (200, r#"{"items":[{"code":"node_not_contacting","severity":"warning","errorCode":null}]}"#.into())
        } else {
            (200, r#"{"items":[]}"#.into())
        }
    });
    let run = fleet_at(&warnings.url, &["doctor"]);
    assert_eq!(run.code, 0, "{}", run.stderr);
    assert_eq!(run.out()["ok"], true);
    assert_eq!(run.out()["summary"], json!({"errors": 0, "warnings": 1}));

    let clean = mock(|_| (200, r#"{"items":[]}"#.into()));
    let run = fleet_at(&clean.url, &["doctor"]);
    assert_eq!(run.code, 0);
    assert_eq!(
        run.out(),
        json!({"ok": true, "issues": [], "summary": {"errors": 0, "warnings": 0}})
    );
    assert_eq!(clean.lines().len(), 1);
}

#[test]
fn failures_are_json_on_stderr_with_status_exit_codes_and_no_server_text() {
    let leak = "SECRET-LEAK token=abc";
    let cases: Vec<(u16, String, i32, &str)> = vec![
        (401, leak.to_owned(), 3, "unauthorized"),
        (
            403,
            json!({"code": "insufficient_scope", "message": leak}).to_string(),
            3,
            "insufficient_scope",
        ),
        (
            403,
            json!({"code": "node_unauthorized", "message": leak}).to_string(),
            3,
            "node_unauthorized",
        ),
        (
            404,
            json!({"code": "node_not_found", "message": leak}).to_string(),
            4,
            "node_not_found",
        ),
        (404, leak.to_owned(), 4, "not_found"),
        (
            409,
            json!({"code": "node_revoked", "message": leak}).to_string(),
            5,
            "node_revoked",
        ),
        (409, leak.to_owned(), 5, "conflict"),
        (
            400,
            json!({"code": "invalid_request", "message": leak}).to_string(),
            6,
            "invalid_request",
        ),
        (
            500,
            json!({"code": "internal_error", "message": leak}).to_string(),
            6,
            "internal_error",
        ),
        (502, leak.to_owned(), 6, "server_error"),
        // The code must match ^[a-z][a-z0-9_]{0,63}$; anything else is dropped.
        (
            404,
            json!({"code": "Not Found!", "message": leak}).to_string(),
            4,
            "not_found",
        ),
        (
            404,
            json!({"code": leak, "message": leak}).to_string(),
            4,
            "not_found",
        ),
        (409, json!({"code": 7}).to_string(), 5, "conflict"),
        // Bodies over 4 KiB are ignored entirely.
        (
            409,
            format!(
                "{{\"code\":\"node_revoked\",\"pad\":\"{}\"}}",
                "x".repeat(5000)
            ),
            5,
            "conflict",
        ),
    ];
    for (status, body, exit, code) in cases {
        let reply = body.clone();
        let server = mock(move |_| (status, reply.clone()));
        let run = fleet_at(&server.url, &["nodes", "show", "studio-mini"]);
        assert_eq!(run.stdout, "", "{status} {body}");
        assert_eq!(run.code, exit, "{status} {body:.40}");
        let error = run.err();
        assert_eq!(error["error"]["code"], code, "{status} {body:.40}");
        assert_eq!(error["error"]["status"], status, "{status}");
        let message = error["error"]["message"].as_str().unwrap();
        assert!(!message.is_empty());
        assert!(
            !run.stderr.contains("SECRET") && !run.stderr.contains("abc"),
            "{}",
            run.stderr
        );
    }
}

#[test]
fn scope_error_message_is_owned_by_the_cli() {
    let server = mock(|_| {
        (
            403,
            r#"{"code":"insufficient_scope","message":"Server wording"}"#.into(),
        )
    });
    let run = fleet_at(&server.url, &["retry", "studio-mini", "skills"]);
    assert_eq!(run.code, 3);
    let error = run.err();
    assert_eq!(error["error"]["code"], "insufficient_scope");
    assert_eq!(
        error["error"]["message"],
        "operator token scope does not allow this command"
    );
    assert!(!run.stderr.contains("Server wording"));
}

#[test]
fn transport_failures_and_missing_configuration_use_json_errors() {
    let dead = {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}", listener.local_addr().unwrap())
    };
    let run = fleet_at(&dead, &["nodes", "list"]);
    assert_eq!(run.code, 6);
    assert_eq!(run.err()["error"]["code"], "transport_error");
    assert_eq!(run.err()["error"]["status"], Value::Null);

    let output = Command::new(env!("CARGO_BIN_EXE_fleet"))
        .args(["--server-url", "https://fleet.example", "nodes", "list"])
        .env_remove("FLEET_OPERATOR_TOKEN")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    let error: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["error"]["code"], "missing_token");

    let output = Command::new(env!("CARGO_BIN_EXE_fleet"))
        .args(["nodes", "list"])
        .env_remove("FLEET_SERVER_URL")
        .env("FLEET_OPERATOR_TOKEN", "t")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2), "clap usage errors exit 2");
}

#[test]
fn destructive_commands_refuse_without_yes_and_send_nothing() {
    let id = "550e8400-e29b-41d4-a716-446655440000";
    let server = node_server();
    for args in [
        vec!["nodes", "revoke", "studio-mini"],
        vec!["nodes", "remove", "studio-mini"],
        vec!["credentials", "revoke", id],
        vec!["enrollment", "links", "revoke", id],
    ] {
        let run = fleet_at(&server.url, &args);
        assert_eq!(run.code, 2, "{args:?}");
        assert_eq!(run.stdout, "");
        let error = run.err();
        assert_eq!(error["error"]["code"], "confirmation_required");
        assert!(
            error["error"]["message"]
                .as_str()
                .unwrap()
                .contains("--yes")
        );
    }
    assert!(server.requests().is_empty(), "{:?}", server.lines());
}

#[test]
fn dry_run_makes_only_get_requests() {
    let id = "550e8400-e29b-41d4-a716-446655440000";
    let server = mock(move |line| {
        if line.starts_with("GET /operator/v1/nodes/") {
            (200, node_json())
        } else if line.contains("/enrollment-links") && line.contains("after=p2") {
            (200, json!({"items": [{"id": id, "alias": "laptop", "state": "active"}], "nextCursor": null}).to_string())
        } else if line.contains("/enrollment-links") {
            (
                200,
                json!({"items": [{"id": "other"}], "nextCursor": "p2"}).to_string(),
            )
        } else {
            (500, "{}".to_owned())
        }
    });
    let run = fleet_at(
        &server.url,
        &["nodes", "revoke", "studio mini/1", "--dry-run"],
    );
    assert_eq!(run.code, 0, "{}", run.stderr);
    let doc = run.out();
    assert_eq!(doc["dryRun"], true);
    assert_eq!(doc["action"], "nodes revoke");
    assert_eq!(doc["target"]["nodeId"], NODE_ID);
    assert_eq!(doc["target"]["name"], "studio mini/1");
    assert_eq!(doc["request"]["path"], format!("nodes/{NODE_ID}/revoke"));

    let run = fleet_at(
        &server.url,
        &["nodes", "remove", NODE_ID, "--dry-run", "--yes"],
    );
    assert_eq!(run.code, 0, "{}", run.stderr);
    assert_eq!(
        run.out()["request"]["body"],
        json!({"alias": "studio mini/1"})
    );

    let run = fleet_at(
        &server.url,
        &["enrollment", "links", "revoke", id, "--dry-run"],
    );
    assert_eq!(run.code, 0, "{}", run.stderr);
    assert_eq!(run.out()["target"]["alias"], "laptop");

    let run = fleet_at(&server.url, &["credentials", "revoke", id, "--dry-run"]);
    assert_eq!(run.code, 0, "{}", run.stderr);
    assert_eq!(run.out()["target"]["credentialId"], id);

    let missing = "11111111-1111-1111-1111-111111111111";
    let run = fleet_at(
        &server.url,
        &["enrollment", "links", "revoke", missing, "--dry-run"],
    );
    assert_eq!(run.code, 4);
    assert_eq!(run.err()["error"]["code"], "enrollment_link_not_found");

    assert!(
        server.lines().iter().all(|line| line.starts_with("GET ")),
        "{:?}",
        server.lines()
    );
    assert!(server.lines()[0].starts_with("GET /operator/v1/nodes/studio%20mini%2F1 "));
}

#[test]
fn confirmed_destructive_commands_resolve_the_node_then_mutate() {
    let server = node_server();
    let run = fleet_at(&server.url, &["nodes", "revoke", "studio mini/1", "--yes"]);
    assert_eq!(run.code, 0, "{}", run.stderr);
    let run = fleet_at(&server.url, &["nodes", "remove", "studio mini/1", "--yes"]);
    assert_eq!(run.code, 0, "{}", run.stderr);
    let id = "550e8400-e29b-41d4-a716-446655440000";
    assert_eq!(
        fleet_at(&server.url, &["credentials", "revoke", id, "--yes"]).code,
        0
    );
    assert_eq!(
        fleet_at(&server.url, &["enrollment", "links", "revoke", id, "--yes"]).code,
        0
    );
    let requests = server.requests();
    let lines: Vec<&str> = requests.iter().map(|r| r.line.as_str()).collect();
    assert_eq!(
        lines,
        [
            "GET /operator/v1/nodes/studio%20mini%2F1 HTTP/1.1".to_owned(),
            format!("POST /operator/v1/nodes/{NODE_ID}/revoke HTTP/1.1"),
            "GET /operator/v1/nodes/studio%20mini%2F1 HTTP/1.1".to_owned(),
            format!("POST /operator/v1/nodes/{NODE_ID}/remove HTTP/1.1"),
            format!("POST /operator/v1/credentials/{id}/revoke HTTP/1.1"),
            format!("POST /operator/v1/enrollment-links/{id}/revoke HTTP/1.1"),
        ]
    );
    let confirmation: Value = serde_json::from_str(&requests[3].body).unwrap();
    assert_eq!(confirmation, json!({"alias": "studio mini/1"}));
}

#[test]
fn read_and_operate_commands_send_the_contract_requests() {
    let server = mock(|line| {
        if line.contains("limit=100") {
            (200, r#"{"items":[],"nextCursor":null}"#.into())
        } else {
            (200, r#"{"ok":true}"#.into())
        }
    });
    let rollout = "550e8400-e29b-41d4-a716-446655440000";
    let run = |args: &[&str]| {
        let run = fleet_at(&server.url, args);
        assert_eq!(run.code, 0, "{args:?}: {}", run.stderr);
        run.out()
    };
    run(&["nodes", "--after", "legacy", "list"]);
    run(&[
        "nodes",
        "attempts",
        "studio-mini",
        "--target",
        "ai-client/claude",
        "--after",
        "c",
    ]);
    run(&["nodes", "checkins", "studio-mini", "--hours", "24"]);
    run(&["nodes", "checkins", "studio-mini"]);
    run(&["retry", "studio-mini", "ai-client/claude"]);
    run(&["issues", "list"]);
    run(&["errors", "list"]);
    run(&["explain", "lock_failed"]);
    run(&["rollouts", "list", "--after", "c"]);
    run(&["rollouts", "list", "--newest"]);
    run(&["rollouts", "list", "--newest", "--after", "d"]);
    run(&["rollouts", "attempts", rollout]);
    run(&["revisions", "list"]);
    run(&["revisions", "list", "--newest"]);
    run(&["scans", "list"]);
    run(&["source", "status"]);
    run(&["source", "rescan"]);
    run(&["audit", "list", "--node", "a b", "--after", "c"]);
    run(&["audit", "list", "--newest"]);
    run(&["audit", "list", "--newest", "--node", "a b", "--after", "c"]);
    run(&["enrollment", "create", "--expires-in-seconds", "60"]);
    run(&["enrollment", "links", "list"]);
    run(&[
        "enrollment",
        "links",
        "create",
        "my laptop",
        "--expires-in-seconds",
        "120",
    ]);
    run(&["models", "status"]);
    run(&["models", "selection"]);
    run(&["models", "refresh"]);
    let requests = server.requests();
    let lines: Vec<&str> = requests
        .iter()
        .map(|r| r.line.trim_end_matches(" HTTP/1.1"))
        .collect();
    let expected = [
        "GET /operator/v1/nodes?limit=100&after=legacy",
        "GET /operator/v1/nodes/studio-mini/attempts?limit=100&target=ai-client%2Fclaude&after=c",
        "GET /operator/v1/nodes/studio-mini/checkins?hours=24",
        "GET /operator/v1/nodes/studio-mini/checkins",
        "POST /operator/v1/nodes/studio-mini/retry",
        "GET /operator/v1/issues",
        "GET /operator/v1/errors",
        "GET /operator/v1/errors/lock_failed",
        "GET /operator/v1/rollouts?limit=100&after=c",
        "GET /operator/v1/rollouts?limit=100&order=newest",
        "GET /operator/v1/rollouts?limit=100&order=newest&after=d",
        &format!("GET /operator/v1/rollouts/{rollout}/attempts?limit=100"),
        "GET /operator/v1/desired-revisions?limit=100",
        "GET /operator/v1/desired-revisions?limit=100&order=newest",
        "GET /operator/v1/source/scans?limit=100",
        "GET /operator/v1/source/status",
        "POST /operator/v1/source/rescan",
        "GET /operator/v1/audit?limit=100&node=a+b&after=c",
        "GET /operator/v1/audit?limit=100&order=newest",
        "GET /operator/v1/audit?limit=100&node=a+b&order=newest&after=c",
        "POST /operator/v1/enrollment-tokens",
        "GET /operator/v1/enrollment-links?limit=100",
        "POST /operator/v1/enrollment-links",
        "GET /operator/v1/cliproxy/status",
        "GET /operator/v1/cliproxy/selection",
        "POST /operator/v1/cliproxy/refresh",
    ];
    assert_eq!(lines, expected);
    let resolve = |line: &str| lines.iter().position(|l| *l == line).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(
            &requests[resolve("POST /operator/v1/nodes/studio-mini/retry")].body
        )
        .unwrap(),
        json!({"target": "ai-client/claude"})
    );
    assert_eq!(
        serde_json::from_str::<Value>(
            &requests[resolve("POST /operator/v1/enrollment-tokens")].body
        )
        .unwrap(),
        json!({"expiresInSeconds": 60})
    );
    assert_eq!(
        serde_json::from_str::<Value>(
            &requests[resolve("POST /operator/v1/enrollment-links")].body
        )
        .unwrap(),
        json!({"alias": "my laptop", "expiresInSeconds": 120})
    );
}

fn selection_json() -> String {
    json!({"catalogs": [{
        "baseUrl": "https://proxy.home.arpa",
        "models": [],
        "policy": {
            "includeNew": true, "disabledFamilies": ["gemini"], "enabledFamilies": ["gpt-5"],
            "modelOverrides": {"gpt-5-codex": false, "claude-x": true},
            "skipClaudeModelsForOtherClients": true
        },
        "version": 4
    }]})
    .to_string()
}

#[test]
fn models_select_applies_changes_to_the_current_policy_with_its_version() {
    let server = mock(|line| {
        if line.starts_with("GET /operator/v1/cliproxy/selection") {
            (200, selection_json())
        } else {
            (200, r#"{"catalog":{}}"#.into())
        }
    });
    let run = fleet_at(
        &server.url,
        &[
            "models",
            "select",
            "--include-new",
            "false",
            "--enable-family",
            "gemini",
            "--disable-family",
            "claude",
            "--disable-model",
            "gpt-5.1",
            "--clear-model-override",
            "claude-x",
        ],
    );
    assert_eq!(run.code, 0, "{}", run.stderr);
    let requests = server.requests();
    assert_eq!(requests.len(), 2);
    assert!(
        requests[1]
            .line
            .starts_with("POST /operator/v1/cliproxy/selection ")
    );
    assert_eq!(
        serde_json::from_str::<Value>(&requests[1].body).unwrap(),
        json!({
            "baseUrl": "https://proxy.home.arpa",
            "version": 4,
            "policy": {
                "includeNew": false,
                "disabledFamilies": ["claude"],
                "enabledFamilies": ["gemini", "gpt-5"],
                "modelOverrides": {"gpt-5-codex": false, "gpt-5.1": false},
                "skipClaudeModelsForOtherClients": true
            }
        })
    );
}

#[test]
fn models_select_dry_run_conflicts_and_stale_versions() {
    let server = mock(|line| {
        if line.starts_with("GET ") {
            (200, selection_json())
        } else {
            (409, r#"{"code":"stale_selection"}"#.into())
        }
    });
    let run = fleet_at(
        &server.url,
        &[
            "models",
            "select",
            "--selection-version",
            "9",
            "--enable-model",
            "m",
            "--dry-run",
        ],
    );
    assert_eq!(run.code, 0, "{}", run.stderr);
    assert_eq!(run.out()["request"]["body"]["version"], 9);
    assert_eq!(server.lines().len(), 1);

    let run = fleet_at(&server.url, &["models", "select"]);
    assert_eq!(
        (
            run.code,
            run.err()["error"]["code"].as_str().map(str::to_owned)
        ),
        (2, Some("no_changes".into()))
    );
    let run = fleet_at(
        &server.url,
        &[
            "models",
            "select",
            "--enable-family",
            "x",
            "--disable-family",
            "x",
        ],
    );
    assert_eq!(
        (
            run.code,
            run.err()["error"]["code"].as_str().map(str::to_owned)
        ),
        (2, Some("conflicting_flags".into()))
    );
    let run = fleet_at(
        &server.url,
        &[
            "models",
            "select",
            "--base-url",
            "https://other",
            "--include-new",
            "true",
        ],
    );
    assert_eq!(run.code, 5);
    assert_eq!(run.err()["error"]["code"], "stale_selection");
}

#[test]
fn models_select_needs_a_base_url_when_several_catalogs_exist() {
    let server = mock(|_| {
        (
            200,
            json!({"catalogs": [{"baseUrl": "https://a", "policy": {}, "version": 1},
                                  {"baseUrl": "https://b", "policy": {}, "version": 1}]})
            .to_string(),
        )
    });
    let run = fleet_at(&server.url, &["models", "select", "--include-new", "false"]);
    assert_eq!(run.code, 2);
    assert_eq!(run.err()["error"]["code"], "base_url_required");
}

#[test]
fn legacy_after_is_rejected_for_other_node_commands() {
    let server = node_server();
    let run = fleet_at(&server.url, &["nodes", "--after", "x", "show", "n"]);
    assert_eq!(run.code, 2);
    assert!(server.requests().is_empty());
}

fn disk_json() -> Value {
    json!({
        "measuredAt": "2026-10-26T09:48:00Z", "refreshRequestedAt": null,
        "volumes": [{
            "label": "home", "totalBytes": 994_662_584_320_u64, "usedBytes": 871_203_905_536_u64,
            "availableBytes": 72_818_462_720_u64, "usedPercent": 92.3
        }]
    })
}

#[test]
fn nodes_disk_reads_the_node_and_prints_only_its_alias_and_disk() {
    let with_disk = mock(|line| {
        assert!(
            line.starts_with("GET /operator/v1/nodes/studio%20mini%2F1 "),
            "{line}"
        );
        let mut node: Value = serde_json::from_str(&node_json()).unwrap();
        node["disk"] = disk_json();
        (200, node.to_string())
    });
    let run = fleet_at(&with_disk.url, &["nodes", "disk", "studio mini/1"]);
    assert_eq!(run.code, 0, "{}", run.stderr);
    assert_eq!(
        run.out(),
        json!({"node": "studio mini/1", "disk": disk_json()})
    );
    assert_eq!(with_disk.requests().len(), 1);

    // A node that never reported (or an Agent before 0.9.0) has no disk: null, not an error.
    for body in [
        node_json(),
        json!({"nodeId": NODE_ID, "name": "old", "disk": null}).to_string(),
    ] {
        let name = serde_json::from_str::<Value>(&body).unwrap()["name"].clone();
        let server = mock(move |_| (200, body.clone()));
        let run = fleet_at(&server.url, &["nodes", "disk", "x"]);
        assert_eq!(run.code, 0, "{}", run.stderr);
        assert_eq!(run.out(), json!({"node": name, "disk": null}));
    }
}

#[test]
fn nodes_disk_refresh_posts_the_request_and_prints_the_202_reply() {
    let server = mock(|line| {
        if line.starts_with("POST /operator/v1/nodes/studio%20mini%2F1/disk-usage/refresh ") {
            (
                202,
                json!({"refreshRequestedAt": "2026-10-26T10:00:00Z"}).to_string(),
            )
        } else {
            (500, String::new())
        }
    });
    let run = fleet_at(
        &server.url,
        &["nodes", "disk", "studio mini/1", "--refresh"],
    );
    assert_eq!(run.code, 0, "{}", run.stderr);
    assert_eq!(
        run.out(),
        json!({"refreshRequestedAt": "2026-10-26T10:00:00Z"})
    );
    // Exactly one request: the refresh is not preceded by a read, and nothing is polled.
    assert_eq!(server.requests().len(), 1);
}

#[test]
fn nodes_disk_refresh_reports_a_low_scope_and_a_revoked_node_with_their_exit_codes() {
    let denied = mock(|_| {
        (
            403,
            json!({"code": "insufficient_scope", "message": "Server wording"}).to_string(),
        )
    });
    let run = fleet_at(&denied.url, &["nodes", "disk", "studio-mini", "--refresh"]);
    assert_eq!(run.stdout, "");
    assert_eq!(run.code, 3);
    let error = run.err();
    assert_eq!(error["error"]["code"], "insufficient_scope");
    assert_eq!(
        error["error"]["message"],
        "operator token scope does not allow this command"
    );
    assert!(!run.stderr.contains("Server wording"));
    // A revoked node and an unknown node are the Server's answers; the CLI maps them to their exit codes.
    let revoked = mock(|_| {
        (
            409,
            json!({"code": "node_revoked", "message": "x"}).to_string(),
        )
    });
    let run = fleet_at(&revoked.url, &["nodes", "disk", "studio-mini", "--refresh"]);
    assert_eq!(run.code, 5);
    assert_eq!(run.err()["error"]["code"], "node_revoked");
    let missing = mock(|_| {
        (
            404,
            json!({"code": "node_not_found", "message": "x"}).to_string(),
        )
    });
    let run = fleet_at(&missing.url, &["nodes", "disk", "nobody"]);
    assert_eq!(run.code, 4);
    assert_eq!(run.err()["error"]["code"], "node_not_found");
}
