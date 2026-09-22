use anyhow::{Context, Result, bail};
mod api;
mod commands;

use api::Api;
use clap::Parser;
use commands::Cli;

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let token =
        std::env::var("FLEET_OPERATOR_TOKEN").context("FLEET_OPERATOR_TOKEN must be set")?;
    if token.is_empty() {
        bail!("FLEET_OPERATOR_TOKEN must not be empty")
    }
    let api = Api::new(&cli.server_url, token, cli.allow_http, cli.ca_cert.as_ref())?;
    commands::run(&api, cli.command).await
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
}
