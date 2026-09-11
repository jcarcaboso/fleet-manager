use std::{error::Error, fmt, time::Duration};

use reqwest::{Certificate, Client, Identity, Method, Response, StatusCode, Url, redirect::Policy};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use uuid::Uuid;

const MAX_JSON_BYTES: usize = 1024 * 1024;
const MAX_BUNDLE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug)]
pub enum ProtocolError {
    Configuration(&'static str),
    Transport(reqwest::Error),
    Http(StatusCode),
    ResponseTooLarge { limit: usize },
    InvalidResponse(&'static str),
    Json,
}

impl ProtocolError {
    pub fn is_auth_failure(&self) -> bool {
        matches!(
            self,
            Self::Http(StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN)
        )
    }
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Configuration(message) => {
                write!(f, "invalid Fleet server configuration: {message}")
            }
            Self::Transport(error) => write!(f, "Fleet server request failed: {error}"),
            Self::Http(status) => write!(f, "Fleet server returned HTTP {status}"),
            Self::ResponseTooLarge { limit } => {
                write!(f, "Fleet server response exceeded {limit} bytes")
            }
            Self::InvalidResponse(message) => write!(f, "invalid Fleet server response: {message}"),
            Self::Json => write!(f, "invalid Fleet server JSON"),
        }
    }
}

impl Error for ProtocolError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Transport(e) => Some(e),
            _ => None,
        }
    }
}

#[derive(Clone)]
pub struct Api {
    base: Url,
    anonymous: Client,
    authenticated: Option<Client>,
}

impl Api {
    pub fn new(
        server_url: &str,
        ca_pem: &[u8],
        identity_pem: Option<&[u8]>,
    ) -> Result<Self, ProtocolError> {
        let mut base = Url::parse(server_url)
            .map_err(|_| ProtocolError::Configuration("server URL is invalid"))?;
        if base.scheme() != "https" {
            return Err(ProtocolError::Configuration("server URL must use HTTPS"));
        }
        if !base.username().is_empty() || base.password().is_some() {
            return Err(ProtocolError::Configuration(
                "server URL must not contain credentials",
            ));
        }
        if base.query().is_some() || base.fragment().is_some() {
            return Err(ProtocolError::Configuration(
                "server URL must not contain a query or fragment",
            ));
        }
        if base.path() != "/" && !base.path().is_empty() {
            return Err(ProtocolError::Configuration(
                "server URL must not contain a path",
            ));
        }
        base.set_path("/");
        let ca = Certificate::from_pem(ca_pem)
            .map_err(|_| ProtocolError::Configuration("CA certificate is invalid"))?;
        let build = |identity: Option<Identity>| {
            let mut builder = Client::builder()
                .https_only(true)
                .redirect(Policy::none())
                .timeout(Duration::from_secs(30))
                .add_root_certificate(ca.clone());
            if let Some(identity) = identity {
                builder = builder.identity(identity);
            }
            builder.build().map_err(ProtocolError::Transport)
        };
        let anonymous = build(None)?;
        let authenticated = identity_pem
            .map(|pem| {
                Identity::from_pem(pem)
                    .map_err(|_| ProtocolError::Configuration("client identity PEM is invalid"))
                    .and_then(|identity| build(Some(identity)))
            })
            .transpose()?;
        Ok(Self {
            base,
            anonymous,
            authenticated,
        })
    }

    pub async fn enroll(
        &self,
        token: &str,
        csr: &str,
        node_name: &str,
        platform: &str,
    ) -> Result<EnrollmentResponse, ProtocolError> {
        self.json(
            &self.anonymous,
            Method::POST,
            "agent/v1/enroll",
            Some(&EnrollmentRequest {
                token,
                certificate_request_pem: csr,
                node_name,
                platform,
            }),
        )
        .await
    }

    pub async fn poll(&self) -> Result<PollResponse, ProtocolError> {
        self.json::<(), _>(self.authenticated()?, Method::POST, "agent/v1/poll", None)
            .await
    }

    pub async fn bundle(&self, skill: &AssignmentSkill) -> Result<Bundle, ProtocolError> {
        self.bundle_content(&skill.bundle_digest, skill.size, &skill.schema)
            .await
    }

    pub async fn file(&self, file: &AssignmentFile) -> Result<Bundle, ProtocolError> {
        let digest = file
            .bundle_digest
            .as_deref()
            .ok_or(ProtocolError::InvalidResponse(
                "managed file digest is missing",
            ))?;
        let size = file.size.ok_or(ProtocolError::InvalidResponse(
            "managed file size is missing",
        ))?;
        let schema = file
            .schema
            .as_deref()
            .ok_or(ProtocolError::InvalidResponse(
                "managed file schema is missing",
            ))?;
        self.bundle_content(digest, size, schema).await
    }

    async fn bundle_content(
        &self,
        digest: &str,
        size: i64,
        expected_schema: &str,
    ) -> Result<Bundle, ProtocolError> {
        if size < 0 || size as usize > MAX_BUNDLE_BYTES {
            return Err(ProtocolError::ResponseTooLarge {
                limit: MAX_BUNDLE_BYTES,
            });
        }
        let mut url = self.endpoint("agent/v1/bundles")?;
        url.path_segments_mut()
            .map_err(|_| ProtocolError::Configuration("server URL cannot be a base"))?
            .push(digest);
        let response = self
            .authenticated()?
            .get(url)
            .send()
            .await
            .map_err(ProtocolError::Transport)?;
        let response = success(response)?;
        let schema = response
            .headers()
            .get("x-fleet-bundle-schema")
            .and_then(|x| x.to_str().ok())
            .ok_or(ProtocolError::InvalidResponse(
                "bundle schema header is missing",
            ))?
            .to_owned();
        if schema != expected_schema {
            return Err(ProtocolError::InvalidResponse(
                "bundle schema does not match assignment",
            ));
        }
        let bytes = read_bounded(response, MAX_BUNDLE_BYTES).await?;
        if bytes.len() as i64 != size {
            return Err(ProtocolError::InvalidResponse(
                "bundle size does not match assignment",
            ));
        }
        Ok(Bundle {
            digest: digest.to_owned(),
            schema,
            bytes,
        })
    }

    pub async fn report(
        &self,
        attempt_id: Uuid,
        state: ConvergenceState,
        error_code: Option<&str>,
    ) -> Result<ReportResponse, ProtocolError> {
        self.json(
            self.authenticated()?,
            Method::POST,
            "agent/v1/reports",
            Some(&ReportRequest {
                attempt_id,
                state,
                error_code,
            }),
        )
        .await
    }

    pub async fn renew(&self, csr: &str) -> Result<RenewalResponse, ProtocolError> {
        self.json(
            self.authenticated()?,
            Method::POST,
            "agent/v1/credentials/renew",
            Some(&RenewalRequest {
                certificate_request_pem: csr,
            }),
        )
        .await
    }

    pub async fn rename(&self, alias: &str) -> Result<RenameResponse, ProtocolError> {
        self.json(
            self.authenticated()?,
            Method::PUT,
            "agent/v1/alias",
            Some(&AliasRequest { alias }),
        )
        .await
    }

    fn authenticated(&self) -> Result<&Client, ProtocolError> {
        self.authenticated
            .as_ref()
            .ok_or(ProtocolError::Configuration("client identity is required"))
    }

    fn endpoint(&self, path: &str) -> Result<Url, ProtocolError> {
        self.base
            .join(path)
            .map_err(|_| ProtocolError::Configuration("could not construct API URL"))
    }

    async fn json<B: Serialize + ?Sized, T: DeserializeOwned>(
        &self,
        client: &Client,
        method: Method,
        path: &str,
        body: Option<&B>,
    ) -> Result<T, ProtocolError> {
        let mut request = client.request(method, self.endpoint(path)?);
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await.map_err(ProtocolError::Transport)?;
        let bytes = read_bounded(success(response)?, MAX_JSON_BYTES).await?;
        serde_json::from_slice(&bytes).map_err(|_| ProtocolError::Json)
    }
}

fn success(response: Response) -> Result<Response, ProtocolError> {
    if response.status().is_success() {
        Ok(response)
    } else {
        Err(ProtocolError::Http(response.status()))
    }
}

async fn read_bounded(mut response: Response, limit: usize) -> Result<Vec<u8>, ProtocolError> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(ProtocolError::ResponseTooLarge { limit });
    }
    let mut output = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(ProtocolError::Transport)? {
        if output
            .len()
            .checked_add(chunk.len())
            .is_none_or(|length| length > limit)
        {
            return Err(ProtocolError::ResponseTooLarge { limit });
        }
        output.extend_from_slice(&chunk);
    }
    Ok(output)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnrollmentResponse {
    pub workspace_id: Uuid,
    pub node_id: Uuid,
    pub credential_id: Uuid,
    pub certificate_pem: String,
    pub expires_at: String,
    pub poll_interval_seconds: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenewalResponse {
    pub credential_id: Uuid,
    pub certificate_pem: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PollResponse {
    pub workspace_id: Uuid,
    pub node_id: Uuid,
    pub assignment: Option<Assignment>,
    pub next_poll_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Assignment {
    pub assignment_id: Uuid,
    pub attempt_id: Uuid,
    pub rollout_id: Uuid,
    pub desired_revision_id: Uuid,
    pub target_name: String,
    pub target: TargetDescriptor,
    pub skills: Vec<AssignmentSkill>,
    #[serde(default)]
    pub file: Option<AssignmentFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TargetDescriptor {
    pub base: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssignmentSkill {
    pub name: String,
    pub bundle_digest: String,
    pub size: i64,
    pub schema: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssignmentFile {
    pub name: String,
    pub bundle_digest: Option<String>,
    pub size: Option<i64>,
    pub schema: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Bundle {
    pub digest: String,
    pub schema: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConvergenceState {
    Pending,
    Applying,
    Succeeded,
    Failed,
    Superseded,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportResponse {
    pub outcome: ReportOutcome,
    pub state: ConvergenceState,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportOutcome {
    Recorded,
    Duplicate,
    Stale,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenameResponse {
    pub node_id: Uuid,
    pub alias: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnrollmentRequest<'a> {
    token: &'a str,
    certificate_request_pem: &'a str,
    node_name: &'a str,
    platform: &'a str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RenewalRequest<'a> {
    certificate_request_pem: &'a str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReportRequest<'a> {
    attempt_id: Uuid,
    state: ConvergenceState,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<&'a str>,
}
#[derive(Serialize)]
struct AliasRequest<'a> {
    alias: &'a str,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poll_fixture_matches_server_wire_contract() {
        let poll: PollResponse = serde_json::from_str(r#"{"workspaceId":"00000000-0000-0000-0000-000000000001","nodeId":"00000000-0000-0000-0000-000000000002","assignment":{"assignmentId":"00000000-0000-0000-0000-000000000003","attemptId":"00000000-0000-0000-0000-000000000004","rolloutId":"00000000-0000-0000-0000-000000000005","desiredRevisionId":"00000000-0000-0000-0000-000000000006","targetName":"skills","target":{"base":"home","path":".agents/skills"},"skills":[{"name":"review","bundleDigest":"sha256:abc","size":12,"schema":"fleet.bundle/v1"}]},"nextPollSeconds":30}"#).unwrap();
        assert_eq!(poll.assignment.unwrap().skills[0].name, "review");
    }

    #[test]
    fn managed_file_fixture_accepts_content_and_removal_assignments() {
        let content: PollResponse = serde_json::from_str(r#"{"workspaceId":"00000000-0000-0000-0000-000000000001","nodeId":"00000000-0000-0000-0000-000000000002","assignment":{"assignmentId":"00000000-0000-0000-0000-000000000003","attemptId":"00000000-0000-0000-0000-000000000004","rolloutId":"00000000-0000-0000-0000-000000000005","desiredRevisionId":"00000000-0000-0000-0000-000000000006","targetName":"agent-file/claude","target":{"base":"home","path":".claude"},"skills":[],"file":{"name":"CLAUDE.md","bundleDigest":"sha256:abc","size":12,"schema":"fleet.file/v1"}},"nextPollSeconds":30}"#).unwrap();
        assert_eq!(content.assignment.unwrap().file.unwrap().name, "CLAUDE.md");

        let removal: AssignmentFile = serde_json::from_str(
            r#"{"name":"AGENTS.md","bundleDigest":null,"size":null,"schema":null}"#,
        )
        .unwrap();
        assert!(removal.bundle_digest.is_none());
    }

    #[test]
    fn report_uses_server_enum_and_omits_absent_error() {
        let value = serde_json::to_value(ReportRequest {
            attempt_id: Uuid::nil(),
            state: ConvergenceState::Succeeded,
            error_code: None,
        })
        .unwrap();
        assert_eq!(value["state"], "succeeded");
        assert!(value.get("errorCode").is_none());
    }

    #[test]
    fn rejects_unsafe_server_urls_before_reading_ca() {
        for url in [
            "http://fleet.example",
            "https://user:secret@fleet.example",
            "https://fleet.example/prefix",
            "https://fleet.example/?token=secret",
            "https://fleet.example/#fragment",
        ] {
            assert!(
                matches!(
                    Api::new(url, b"invalid CA", None),
                    Err(ProtocolError::Configuration(_))
                ),
                "accepted {url}"
            );
        }
    }

    #[test]
    fn json_errors_do_not_display_response_content() {
        let secret = "server-controlled-secret";
        let result: Result<ReportResponse, _> =
            serde_json::from_str(&format!(r#"{{"outcome":"{secret}","state":"failed"}}"#));
        let error = result.unwrap_err();
        let protocol_error = ProtocolError::Json;
        assert!(!protocol_error.to_string().contains(secret));
        assert!(format!("{protocol_error:?}").contains("Json"));
        assert!(error.to_string().contains(secret));
    }
}
