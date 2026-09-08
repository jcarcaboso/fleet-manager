use anyhow::{Context, Result, bail};
use clap::{Args, Parser, Subcommand};
use reqwest::{Certificate, Client, StatusCode, Url, redirect::Policy};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{path::PathBuf, time::Duration};
use uuid::Uuid;

const API_PREFIX: &str = "/operator/v1";
const PAGE_LIMIT: u32 = 100;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Parser)]
#[command(name = "fleet", version, about = "Fleet Manager operator CLI")]
struct Cli {
    /// Fleet Server base URL. Defaults to FLEET_SERVER_URL.
    #[arg(long, env = "FLEET_SERVER_URL")]
    server_url: String,

    /// Permit plain HTTP only when the server host is loopback.
    #[arg(long)]
    allow_http: bool,

    /// PEM CA certificate for a private Fleet Server trust root.
    #[arg(long, value_name = "FILE")]
    ca_cert: Option<PathBuf>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Nodes(ListArgs),
    Rollouts(ListArgs),
    Warnings(ListArgs),
    Enrollment(EnrollmentCommand),
    Credentials(CredentialsCommand),
    Source(SourceCommand),
}

#[derive(Debug, Args)]
struct ListArgs {
    #[command(subcommand)]
    command: ListCommand,

    /// Opaque cursor returned by a previous list response.
    #[arg(long)]
    after: Option<String>,
}

#[derive(Debug, Subcommand)]
enum ListCommand {
    List,
}

#[derive(Debug, Args)]
struct EnrollmentCommand {
    #[command(subcommand)]
    command: EnrollmentSubcommand,
}

#[derive(Debug, Subcommand)]
enum EnrollmentSubcommand {
    Create(EnrollmentCreateArgs),
}

#[derive(Debug, Args)]
struct EnrollmentCreateArgs {
    /// Lifetime of the one-time enrollment token.
    #[arg(long, default_value_t = 900)]
    expires_in_seconds: u32,
}

#[derive(Debug, Args)]
struct CredentialsCommand {
    #[command(subcommand)]
    command: CredentialsSubcommand,
}

#[derive(Debug, Subcommand)]
enum CredentialsSubcommand {
    Revoke { id: Uuid },
}

#[derive(Debug, Args)]
struct SourceCommand {
    #[command(subcommand)]
    command: SourceSubcommand,
}

#[derive(Debug, Subcommand)]
enum SourceSubcommand {
    Rescan,
}

#[derive(Debug, Deserialize, Serialize)]
struct Collection {
    items: Vec<Value>,
    #[serde(rename = "nextCursor")]
    next_cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnrollmentRequest {
    expires_in_seconds: u32,
}

struct Api {
    client: Client,
    base: Url,
    token: String,
}

impl Api {
    fn new(
        server_url: &str,
        token: String,
        allow_http: bool,
        ca_cert: Option<&PathBuf>,
    ) -> Result<Self> {
        let base = Url::parse(server_url).context("invalid server URL")?;
        if !base.username().is_empty() || base.password().is_some() {
            bail!("server URL must not include a username or password")
        }
        if base.query().is_some() || base.fragment().is_some() {
            bail!("server URL must not include a query or fragment")
        }
        if base.path() != "" && base.path() != "/" {
            bail!("server URL must not include a path")
        }
        match base.scheme() {
            "https" => {}
            "http" if allow_http && is_loopback(&base) => {}
            "http" => bail!("HTTP is allowed only for loopback with --allow-http"),
            _ => bail!("server URL must use HTTPS"),
        }
        if base.host_str().is_none() {
            bail!("server URL must include a host")
        }
        let mut builder = Client::builder()
            .https_only(false)
            .redirect(Policy::none())
            .timeout(REQUEST_TIMEOUT);
        if let Some(ca_cert) = ca_cert {
            let pem = std::fs::read(ca_cert).context("read CA certificate")?;
            let certificate = Certificate::from_pem(&pem).context("parse CA certificate")?;
            builder = builder.add_root_certificate(certificate);
        }
        let client = builder.build().context("build HTTP client")?;
        Ok(Self {
            client,
            base,
            token,
        })
    }

    fn endpoint(&self, path: &str) -> Result<Url> {
        self.base
            .join(&format!("{API_PREFIX}/{path}"))
            .context("construct API URL")
    }

    async fn get_collection(&self, resource: &str, after: Option<&str>) -> Result<()> {
        let mut url = self.endpoint(resource)?;
        url.query_pairs_mut()
            .append_pair("limit", &PAGE_LIMIT.to_string());
        if let Some(after) = after {
            url.query_pairs_mut().append_pair("after", after);
        }
        let result: Collection = self.send(self.client.get(url)).await?;
        println!("{}", serde_json::to_string(&result)?);
        Ok(())
    }

    async fn create_enrollment(&self, expires: u32) -> Result<()> {
        let response: Value =
            self.send(self.client.post(self.endpoint("enrollment-tokens")?).json(
                &EnrollmentRequest {
                    expires_in_seconds: expires,
                },
            ))
            .await?;
        println!("{}", serde_json::to_string(&response)?);
        Ok(())
    }

    async fn revoke_credential(&self, id: Uuid) -> Result<()> {
        let response: Value = self
            .send(
                self.client
                    .post(self.endpoint(&format!("credentials/{id}/revoke"))?),
            )
            .await?;
        println!("{}", serde_json::to_string(&response)?);
        Ok(())
    }

    async fn rescan(&self) -> Result<()> {
        let response: Value = self
            .send(self.client.post(self.endpoint("source/rescan")?))
            .await?;
        println!("{}", serde_json::to_string(&response)?);
        Ok(())
    }

    async fn send<T: for<'de> Deserialize<'de>>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<T> {
        let response = request
            .bearer_auth(&self.token)
            .send()
            .await
            .context("request Fleet Server")?;
        let status = response.status();
        if !status.is_success() {
            let detail = match status {
                StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                    "operator authentication failed"
                }
                StatusCode::NOT_FOUND => "Fleet Server route was not found",
                _ => "Fleet Server request failed",
            };
            bail!("{detail} (HTTP {})", status.as_u16());
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            bail!("Fleet Server response exceeds 1 MiB")
        }
        let mut body = Vec::new();
        let mut response = response;
        while let Some(chunk) = response
            .chunk()
            .await
            .context("read Fleet Server response")?
        {
            if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                bail!("Fleet Server response exceeds 1 MiB")
            }
            body.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&body).context("decode Fleet Server response")
    }
}

fn is_loopback(url: &Url) -> bool {
    matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"))
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let token =
        std::env::var("FLEET_OPERATOR_TOKEN").context("FLEET_OPERATOR_TOKEN must be set")?;
    if token.is_empty() {
        bail!("FLEET_OPERATOR_TOKEN must not be empty")
    }
    let api = Api::new(&cli.server_url, token, cli.allow_http, cli.ca_cert.as_ref())?;
    match cli.command {
        Command::Nodes(ListArgs {
            command: ListCommand::List,
            after,
        }) => api.get_collection("nodes", after.as_deref()).await,
        Command::Rollouts(ListArgs {
            command: ListCommand::List,
            after,
        }) => api.get_collection("rollouts", after.as_deref()).await,
        Command::Warnings(ListArgs {
            command: ListCommand::List,
            after,
        }) => api.get_collection("warnings", after.as_deref()).await,
        Command::Enrollment(EnrollmentCommand {
            command: EnrollmentSubcommand::Create(args),
        }) => api.create_enrollment(args.expires_in_seconds).await,
        Command::Credentials(CredentialsCommand {
            command: CredentialsSubcommand::Revoke { id },
        }) => api.revoke_credential(id).await,
        Command::Source(SourceCommand {
            command: SourceSubcommand::Rescan,
        }) => api.rescan().await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

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
