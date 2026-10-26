mod api;
mod commands;
mod doctor;
mod error;
mod selection;

use api::Api;
use clap::Parser;
use commands::{Cli, Outcome};
use error::{CliError, EXIT_DOCTOR_ERRORS};
use std::process::ExitCode;

async fn execute(cli: Cli) -> Result<Outcome, CliError> {
    let token = std::env::var("FLEET_OPERATOR_TOKEN")
        .map_err(|_| CliError::usage("missing_token", "FLEET_OPERATOR_TOKEN must be set"))?;
    if token.is_empty() {
        return Err(CliError::usage(
            "missing_token",
            "FLEET_OPERATOR_TOKEN must not be empty",
        ));
    }
    let api = Api::new(&cli.server_url, token, cli.allow_http, cli.ca_cert.as_ref())?;
    commands::run(&api, cli.command).await
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    match execute(cli).await {
        Ok(Outcome::Done) => ExitCode::SUCCESS,
        Ok(Outcome::DoctorFoundErrors) => ExitCode::from(EXIT_DOCTOR_ERRORS),
        Err(error) => {
            eprintln!("{}", error.to_json());
            ExitCode::from(error.exit)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{Collection, MAX_RESPONSE_BYTES, REQUEST_TIMEOUT};
    use clap::error::ErrorKind;
    use serde_json::Value;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::thread;
    use std::time::Duration;
    use uuid::Uuid;

    #[test]
    fn help_forms_do_not_need_runtime_configuration() {
        for arguments in [
            vec!["fleet", "--help"],
            vec!["fleet", "-h"],
            vec!["fleet", "help"],
            vec!["fleet", "nodes", "--help"],
            vec!["fleet", "help", "nodes", "rename"],
        ] {
            let error = Cli::try_parse_from(&arguments).unwrap_err();
            assert_eq!(error.kind(), ErrorKind::DisplayHelp, "{arguments:?}");
        }
    }

    #[test]
    fn accepts_https_and_loopback_http_only_with_flag() {
        let token = "secret".to_owned();
        assert!(Api::new("https://fleet.example", token.clone(), false, None).is_ok());
        assert!(Api::new("http://127.0.0.1:8080", token.clone(), false, None).is_err());
        assert!(Api::new("http://127.0.0.1:8080", token.clone(), true, None).is_ok());
        assert!(Api::new("http://10.0.0.4:8080", token, true, None).is_err());
    }

    #[test]
    fn loopback_is_decided_by_the_parsed_host() {
        let token = || "secret".to_owned();
        // Url::host_str() returns "[::1]" with brackets, so only the parsed host can match it.
        for url in [
            "http://[::1]:8080",
            "http://[0:0:0:0:0:0:0:1]:8080",
            "http://127.0.0.1:8080",
            "http://127.0.0.2:8080",
            "http://localhost:8080",
            "http://LOCALHOST:8080",
        ] {
            assert!(Api::new(url, token(), true, None).is_ok(), "{url}");
            assert!(
                Api::new(url, token(), false, None).is_err(),
                "{url} without the flag"
            );
        }
        for url in [
            "http://[2001:db8::1]:8080",
            "http://[::]:8080",
            "http://[::ffff:10.0.0.4]:8080",
            "http://0.0.0.0:8080",
            "http://10.0.0.4:8080",
            "http://localhost.example:8080",
            "http://example.localhost.evil.test:8080",
        ] {
            assert!(Api::new(url, token(), true, None).is_err(), "{url}");
        }
        assert!(Api::new("https://[::1]:8443", token(), false, None).is_ok());
    }

    #[test]
    fn rejects_ambiguous_server_urls() {
        for url in [
            "https://user@fleet.example",
            "https://user:pass@fleet.example",
            "https://fleet.example/operator",
            "https://fleet.example?redirect=elsewhere",
            "https://fleet.example#fragment",
        ] {
            assert!(
                Api::new(url, "secret".into(), false, None).is_err(),
                "{url}"
            );
        }
        assert!(Api::new("https://fleet.example/", "secret".into(), false, None).is_ok());
        assert!(
            Api::new(
                "https://fleet.example",
                "secret".into(),
                false,
                Some(&PathBuf::from("/definitely/missing"))
            )
            .is_err()
        );
        assert_eq!(REQUEST_TIMEOUT, Duration::from_secs(30));
    }

    #[tokio::test]
    async fn sends_bearer_and_json_request_to_loopback_server() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0_u8; 4096];
            let size = stream.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..size]);
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("authorization: bearer test-token")
            );
            assert!(request.starts_with("GET /operator/v1/nodes?limit=100"));
            let body = r#"{"items":[{"id":"node-1"}],"nextCursor":null}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).unwrap();
        });
        let api = Api::new(
            &format!("http://{address}"),
            "test-token".into(),
            true,
            None,
        )
        .unwrap();
        api.get_collection("nodes", None).await.unwrap();
        server.join().unwrap();
    }

    #[tokio::test]
    async fn rename_sends_aliases_as_json_in_a_fixed_path() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0_u8; 4096];
            let size = stream.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..size]);
            let (headers, body) = request.split_once("\r\n\r\n").unwrap();
            assert!(headers.starts_with("POST /operator/v1/nodes/rename HTTP/1.1"));
            assert!(
                headers
                    .to_ascii_lowercase()
                    .contains("authorization: bearer test-token")
            );
            let json: Value = serde_json::from_str(body).unwrap();
            assert_eq!(
                json,
                serde_json::json!({
                    "currentAlias": "rack/A ?# \"snow\"",
                    "alias": "new/alias + ?&"
                })
            );
            let body =
                r#"{"nodeId":"550e8400-e29b-41d4-a716-446655440000","alias":"new/alias + ?&"}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).unwrap();
        });
        let api = Api::new(
            &format!("http://{address}"),
            "test-token".into(),
            true,
            None,
        )
        .unwrap();
        api.rename_node("rack/A ?# \"snow\"", "new/alias + ?&")
            .await
            .unwrap();
        server.join().unwrap();
    }

    #[test]
    fn rejects_non_uuid_credential_ids_at_parser_boundary() {
        assert!(Uuid::parse_str("not-a-uuid").is_err());
    }

    #[test]
    fn parses_all_operator_command_shapes_without_a_token_argument() {
        assert!(
            Cli::try_parse_from(["fleet", "--server-url", "https://fleet", "nodes", "list"])
                .is_ok()
        );
        assert!(
            Cli::try_parse_from(["fleet", "--server-url", "https://fleet", "rollouts", "list"])
                .is_ok()
        );
        assert!(
            Cli::try_parse_from(["fleet", "--server-url", "https://fleet", "warnings", "list"])
                .is_ok()
        );
        assert!(
            Cli::try_parse_from([
                "fleet",
                "--server-url",
                "https://fleet",
                "enrollment",
                "create"
            ])
            .is_ok()
        );
        assert!(
            Cli::try_parse_from([
                "fleet",
                "--server-url",
                "https://fleet",
                "nodes",
                "--after",
                "legacy-cursor",
                "list"
            ])
            .is_ok()
        );
        assert!(
            Cli::try_parse_from([
                "fleet",
                "--server-url",
                "https://fleet",
                "credentials",
                "revoke",
                "550e8400-e29b-41d4-a716-446655440000"
            ])
            .is_ok()
        );
        assert!(
            Cli::try_parse_from(["fleet", "--server-url", "https://fleet", "source", "rescan"])
                .is_ok()
        );
        assert!(
            Cli::try_parse_from([
                "fleet",
                "--server-url",
                "https://fleet",
                "nodes",
                "rename",
                "old alias",
                "new/alias?#"
            ])
            .is_ok()
        );
        assert!(
            Cli::try_parse_from([
                "fleet",
                "--server-url",
                "https://fleet",
                "nodes",
                "list",
                "--after",
                "cursor"
            ])
            .is_ok()
        );
        assert!(
            Cli::try_parse_from([
                "fleet",
                "--server-url",
                "https://fleet",
                "--token",
                "secret",
                "nodes",
                "list"
            ])
            .is_err()
        );
    }

    #[test]
    fn shared_operator_fixtures_match_cli_models() {
        let page: Collection = serde_json::from_str(include_str!(
            "../../../../contracts/operator/nodes-page.json"
        ))
        .unwrap();
        assert_eq!(page.items.len(), 1);
        assert!(page.next_cursor.is_none());
        let enrollment: Value = serde_json::from_str(include_str!(
            "../../../../contracts/operator/enrollment-token-response.json"
        ))
        .unwrap();
        assert_eq!(enrollment["token"], "enrollment-token-fixture");
    }

    #[tokio::test]
    async fn does_not_expose_error_response_body() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0_u8; 1024];
            let _ = stream.read(&mut buffer).unwrap();
            let body = "operator token secret must not escape";
            let response = format!(
                "HTTP/1.1 401 Unauthorized\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).unwrap();
        });
        let api = Api::new(
            &format!("http://{address}"),
            "test-token".into(),
            true,
            None,
        )
        .unwrap();
        let error = api
            .get_collection("nodes", None)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("operator authentication failed"));
        assert!(!error.contains("secret"));
        server.join().unwrap();
    }

    #[tokio::test]
    async fn rename_reports_conflict_without_exposing_response_body() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0_u8; 1024];
            let _ = stream.read(&mut buffer).unwrap();
            let body = "database detail and secret target metadata";
            let response = format!(
                "HTTP/1.1 409 Conflict\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).unwrap();
        });
        let api = Api::new(
            &format!("http://{address}"),
            "test-token".into(),
            true,
            None,
        )
        .unwrap();
        let error = api
            .rename_node("current", "target")
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("already in use or the node is revoked"));
        assert!(!error.contains("secret"));
        assert!(!error.contains("database"));
        server.join().unwrap();
    }

    #[tokio::test]
    async fn rejects_oversized_success_responses_without_reading_json() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request).unwrap();
            stream.write_all(b"HTTP/1.1 200 OK\r\n\r\n").unwrap();
            stream
                .write_all(&vec![b'x'; MAX_RESPONSE_BYTES + 1])
                .unwrap();
        });
        let api = Api::new(
            &format!("http://{address}"),
            "test-token".into(),
            true,
            None,
        )
        .unwrap();
        let error = api
            .get_collection("nodes", None)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("exceeds 1 MiB"));
        server.join().unwrap();
    }

    #[tokio::test]
    async fn does_not_follow_redirects() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request).unwrap();
            stream
                .write_all(b"HTTP/1.1 302 Found\r\nLocation: https://untrusted.example/operator/v1/nodes\r\nContent-Length: 0\r\n\r\n")
                .unwrap();
        });
        let api = Api::new(
            &format!("http://{address}"),
            "test-token".into(),
            true,
            None,
        )
        .unwrap();
        let error = api
            .get_collection("nodes", None)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("Fleet Server request failed"));
        server.join().unwrap();
    }

    fn parse(args: &[&str]) -> Result<Cli, clap::Error> {
        let mut full = vec!["fleet", "--server-url", "https://fleet"];
        full.extend_from_slice(args);
        Cli::try_parse_from(full)
    }

    #[test]
    fn parses_every_new_command_shape() {
        let id = "550e8400-e29b-41d4-a716-446655440000";
        for args in [
            vec!["nodes", "list"],
            vec!["nodes", "list", "--after", "c"],
            vec!["nodes", "show", "studio mini"],
            vec!["nodes", "attempts", "n"],
            vec![
                "nodes",
                "attempts",
                "n",
                "--target",
                "ai-client/claude",
                "--after",
                "c",
            ],
            vec!["nodes", "checkins", "n"],
            vec!["nodes", "checkins", "n", "--hours", "24"],
            vec!["nodes", "disk", "n"],
            vec!["nodes", "disk", "n", "--refresh"],
            vec!["nodes", "rename", "a", "b"],
            vec!["nodes", "revoke", "n"],
            vec!["nodes", "revoke", "n", "--yes"],
            vec!["nodes", "revoke", "n", "--dry-run"],
            vec!["nodes", "remove", "n", "--yes", "--dry-run"],
            vec!["retry", "n", "skills"],
            vec!["issues", "list"],
            vec!["errors", "list"],
            vec!["explain", "lock_failed"],
            vec!["doctor"],
            vec!["doctor", "--all"],
            vec!["issues", "ack", "disk_space_low:n"],
            vec!["issues", "acknowledge", "disk_space_low:n"],
            vec!["issues", "snooze", "node_not_contacting:n", "--hours", "4"],
            vec!["issues", "snooze", "x", "--hours", "168"],
            vec!["issues", "reopen", "x"],
            vec!["revisions", "show", id],
            vec!["rollouts", "show", id],
            vec!["rollouts", "list"],
            vec!["rollouts", "list", "--after", "c"],
            vec!["rollouts", "--after", "c", "list"],
            vec!["rollouts", "attempts", id],
            vec!["rollouts", "attempts", id, "--after", "c"],
            vec!["revisions", "list"],
            vec!["revisions", "list", "--after", "c"],
            vec!["warnings", "list", "--after", "c"],
            vec!["warnings", "--after", "c", "list"],
            vec!["scans", "list"],
            vec!["source", "status"],
            vec!["source", "rescan"],
            vec!["audit", "list"],
            vec!["audit", "list", "--node", "n", "--after", "c"],
            vec!["enrollment", "create", "--expires-in-seconds", "60"],
            vec!["enrollment", "links", "list"],
            vec!["enrollment", "links", "create", "laptop"],
            vec![
                "enrollment",
                "links",
                "create",
                "laptop",
                "--expires-in-seconds",
                "60",
            ],
            vec!["enrollment", "links", "revoke", id, "--yes"],
            vec!["credentials", "revoke", id, "--dry-run"],
            vec!["models", "status"],
            vec!["models", "selection"],
            vec!["models", "refresh"],
            vec!["models", "select", "--include-new", "false"],
            vec![
                "models",
                "select",
                "--base-url",
                "https://p",
                "--selection-version",
                "3",
                "--skip-claude-models-for-other-clients",
                "true",
                "--enable-family",
                "gpt-5",
                "--disable-family",
                "gemini",
                "--enable-model",
                "a",
                "--disable-model",
                "b",
                "--clear-model-override",
                "c",
                "--dry-run",
            ],
        ] {
            if let Err(error) = parse(&args) {
                panic!("{args:?}: {error}");
            }
        }
    }

    #[test]
    fn rejects_malformed_new_command_shapes() {
        for args in [
            vec!["nodes", "show"],
            vec!["nodes", "revoke"],
            vec!["nodes", "checkins", "n", "--hours", "0"],
            vec!["nodes", "checkins", "n", "--hours", "169"],
            vec!["nodes", "disk"],
            vec!["nodes", "disk", "n", "--refresh", "now"],
            vec!["retry", "n"],
            vec!["explain"],
            vec!["rollouts", "attempts", "not-a-uuid"],
            vec!["enrollment", "links", "revoke", "not-a-uuid"],
            vec!["enrollment", "links", "create"],
            vec!["credentials", "revoke", "not-a-uuid", "--yes"],
            vec!["models", "select", "--include-new", "maybe"],
            vec!["doctor", "extra"],
            vec!["issues", "ack"],
            vec!["issues", "snooze", "x"],
            vec!["issues", "snooze", "x", "--hours", "0"],
            vec!["issues", "snooze", "x", "--hours", "169"],
            vec!["issues", "ack", "x", "--hours", "1"],
            vec!["issues", "reopen"],
            vec!["revisions", "show"],
            vec!["revisions", "show", "a3f9c21"],
            vec!["rollouts", "show", "not-a-uuid"],
        ] {
            let error = parse(&args).unwrap_err();
            assert_eq!(error.exit_code(), 2, "{args:?}");
        }
    }

    #[test]
    fn every_command_has_an_about_and_examples() {
        use clap::CommandFactory;
        fn walk(command: &clap::Command, path: &str, seen: &mut usize) {
            for sub in command.get_subcommands().filter(|s| s.get_name() != "help") {
                let path = format!("{path} {}", sub.get_name());
                let about = sub.get_about().map(ToString::to_string).unwrap_or_default();
                assert!(!about.is_empty(), "{path} has no about");
                assert!(!about.contains('\n'), "{path} about is not one line");
                let after = sub
                    .get_after_help()
                    .map(ToString::to_string)
                    .unwrap_or_default();
                assert!(after.contains("fleet "), "{path} has no examples");
                *seen += 1;
                walk(sub, &path, seen);
            }
        }
        let mut seen = 0;
        walk(&Cli::command(), "fleet", &mut seen);
        assert!(seen > 40, "{seen}");
        let top = Cli::command().get_after_help().unwrap().to_string();
        for needle in ["FLEET_OPERATOR_TOKEN", "fleet doctor", "10", "--yes"] {
            assert!(top.contains(needle), "{needle}");
        }
    }

    /// Records the request line and body of each request and replies from a script.
    fn mock(
        replies: Vec<(u16, &'static str)>,
    ) -> (String, thread::JoinHandle<Vec<(String, String)>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = thread::spawn(move || {
            let mut seen = Vec::new();
            for (status, body) in replies {
                let (mut stream, _) = listener.accept().unwrap();
                let mut data = Vec::new();
                let mut buffer = [0_u8; 4096];
                loop {
                    let size = stream.read(&mut buffer).unwrap();
                    data.extend_from_slice(&buffer[..size]);
                    let text = String::from_utf8_lossy(&data).into_owned();
                    if let Some((head, rest)) = text.split_once("\r\n\r\n") {
                        let length = head
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length: ")
                                    .map(|v| v.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if rest.len() >= length {
                            seen.push((head.lines().next().unwrap().to_owned(), rest.to_owned()));
                            break;
                        }
                    }
                }
                let response = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).unwrap();
            }
            seen
        });
        (url, handle)
    }

    #[tokio::test]
    async fn node_segments_are_percent_encoded_in_paths() {
        let (url, server) = mock(vec![(200, "{}"), (200, r#"{"items":[]}"#), (200, "{}")]);
        let api = Api::new(&url, "t".into(), true, None).unwrap();
        let alias = "rack/A ?# \"snow\" 100%+é";
        api.get(&["nodes", alias], &[]).await.unwrap();
        api.list(
            &["nodes", alias, "attempts"],
            &[("target", "ai-client/claude&x=1")],
            Some("c ursor"),
        )
        .await
        .unwrap();
        api.post(
            &["nodes", alias, "retry"],
            Some(&serde_json::json!({"target": "t"})),
        )
        .await
        .unwrap();
        let seen = server.join().unwrap();
        let encoded = "rack%2FA%20%3F%23%20%22snow%22%20100%25+%C3%A9";
        assert_eq!(
            seen[0].0,
            format!("GET /operator/v1/nodes/{encoded} HTTP/1.1")
        );
        assert_eq!(
            seen[1].0,
            format!(
                "GET /operator/v1/nodes/{encoded}/attempts?limit=100&target=ai-client%2Fclaude%26x%3D1&after=c+ursor HTTP/1.1"
            )
        );
        assert_eq!(
            seen[2].0,
            format!("POST /operator/v1/nodes/{encoded}/retry HTTP/1.1")
        );
        assert_eq!(seen[2].1, r#"{"target":"t"}"#);
    }

    #[tokio::test]
    async fn dot_segments_and_empty_names_never_reach_the_network() {
        let api = Api::new("https://fleet.example", "t".into(), false, None).unwrap();
        for node in ["", ".", ".."] {
            let error = api.get(&["nodes", node], &[]).await.unwrap_err();
            assert_eq!(
                (error.code.as_str(), error.exit),
                ("invalid_argument", 2),
                "{node:?}"
            );
        }
    }
}
