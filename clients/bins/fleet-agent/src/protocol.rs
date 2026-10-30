use std::{error::Error, fmt, time::Duration};

use reqwest::{
    Certificate, Client, Identity, Method, Response, StatusCode, Url, header::CONTENT_TYPE,
    redirect::Policy,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use uuid::Uuid;

const MAX_JSON_BYTES: usize = 1024 * 1024;
const MAX_BUNDLE_BYTES: usize = 16 * 1024 * 1024;
const MAX_CLIPROXY_CREDENTIAL_BYTES: usize = 4096;
const MAX_DETAIL_REQUEST_BYTES: usize = 16 * 1024;
const MAX_DISK_USAGE_REQUEST_BYTES: usize = 4 * 1024;
const MAX_TELEMETRY_REQUEST_BYTES: usize = 8 * 1024;
const MAX_DRIFT_REQUEST_BYTES: usize = 64 * 1024;
const MAX_REPAIR_REQUEST_BYTES: usize = 512 * 1024;
/// Timeout of the best-effort reports (disk usage, machine information, drift
/// and repair failures).
const SIDE_REPORT_TIMEOUT: Duration = Duration::from_secs(10);
/// Tells the Server which optional features this Agent understands. Only then
/// may the poll response carry the matching fields.
const CAPABILITIES_HEADER: &str = "x-fleet-agent-capabilities";
const CAPABILITIES: &str = "disk-usage,agent-update";
/// Largest signed release manifest the Agent reads.
pub const MAX_RELEASE_MANIFEST_BYTES: usize = 64 * 1024;
/// Size of an Ed25519 signature, the whole content of the signature file.
const RELEASE_SIGNATURE_BYTES: usize = 64;
/// Time limit of one release binary download.
const RELEASE_BINARY_TIMEOUT: Duration = Duration::from_secs(600);
const MAX_AGENT_UPDATE_REQUEST_BYTES: usize = 1024;

#[derive(Debug)]
pub enum ProtocolError {
    Configuration(&'static str),
    Transport(reqwest::Error),
    Http(StatusCode),
    ResponseTooLarge { limit: usize },
    RequestTooLarge { limit: usize },
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
            Self::RequestTooLarge { limit } => {
                write!(f, "Fleet server request exceeded {limit} bytes")
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
        let response = self
            .authenticated()?
            .post(self.endpoint("agent/v1/poll")?)
            .header(CAPABILITIES_HEADER, CAPABILITIES)
            .send()
            .await
            .map_err(ProtocolError::Transport)?;
        decode(response).await
    }

    pub async fn cliproxy_credential(&self) -> Result<Vec<u8>, ProtocolError> {
        let response = self
            .authenticated()?
            .get(self.endpoint("agent/v1/cliproxy/credential")?)
            .send()
            .await
            .map_err(ProtocolError::Transport)?;
        let bytes = read_bounded(success(response)?, MAX_CLIPROXY_CREDENTIAL_BYTES).await?;
        if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_graphic) {
            return Err(ProtocolError::InvalidResponse(
                "CLIProxy credential is invalid",
            ));
        }
        Ok(bytes)
    }

    pub async fn cliproxy_models(&self) -> Result<Vec<u8>, ProtocolError> {
        let response = self
            .authenticated()?
            .get(self.endpoint("agent/v1/cliproxy/models")?)
            .send()
            .await
            .map_err(ProtocolError::Transport)?;
        read_bounded(success(response)?, 4 * 1024 * 1024).await
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

    /// Sends the failure detail of an Attempt whose failed report the Server has
    /// accepted. The response body is never read.
    pub async fn attempt_detail(
        &self,
        attempt_id: Uuid,
        detail: &AttemptDetail,
    ) -> Result<(), ProtocolError> {
        let body = serde_json::to_vec(detail).map_err(|_| ProtocolError::Json)?;
        if body.len() > MAX_DETAIL_REQUEST_BYTES {
            return Err(ProtocolError::RequestTooLarge {
                limit: MAX_DETAIL_REQUEST_BYTES,
            });
        }
        let response = self
            .authenticated()?
            .post(self.endpoint(&format!("agent/v1/attempts/{attempt_id}/detail"))?)
            .header(CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
            .map_err(ProtocolError::Transport)?;
        success(response)?;
        Ok(())
    }

    /// Sends the latest disk usage. Best effort: the response body is never
    /// read, and the caller decides when to try again.
    pub async fn disk_usage(&self, report: &DiskUsageReport) -> Result<(), ProtocolError> {
        self.send_report(
            Method::PUT,
            "agent/v1/disk-usage",
            report,
            MAX_DISK_USAGE_REQUEST_BYTES,
        )
        .await
    }

    /// Sends the machine and Agent information. Best effort like
    /// [`Api::disk_usage`]: the response body is never read.
    pub async fn telemetry(&self, report: &TelemetryReport) -> Result<(), ProtocolError> {
        self.send_report(
            Method::PUT,
            "agent/v1/telemetry",
            report,
            MAX_TELEMETRY_REQUEST_BYTES,
        )
        .await
    }

    /// Sends the files repaired in one Target. Best effort like
    /// [`Api::disk_usage`]: the response body is never read.
    pub async fn drift(&self, report: &crate::drift::Report) -> Result<(), ProtocolError> {
        self.send_report(
            Method::POST,
            "agent/v1/drift",
            report,
            MAX_DRIFT_REQUEST_BYTES,
        )
        .await
    }

    /// Replaces the Targets this Node currently fails to repair. Best effort
    /// like [`Api::disk_usage`]: the response body is never read.
    pub async fn repair_failures(
        &self,
        report: &crate::repair::Report,
    ) -> Result<(), ProtocolError> {
        self.send_report(
            Method::PUT,
            "agent/v1/repair-failures",
            report,
            MAX_REPAIR_REQUEST_BYTES,
        )
        .await
    }

    async fn send_report(
        &self,
        method: Method,
        path: &str,
        report: &impl Serialize,
        limit: usize,
    ) -> Result<(), ProtocolError> {
        let body = serde_json::to_vec(report).map_err(|_| ProtocolError::Json)?;
        if body.len() > limit {
            return Err(ProtocolError::RequestTooLarge { limit });
        }
        let response = self
            .authenticated()?
            .request(method, self.endpoint(path)?)
            .header(CONTENT_TYPE, "application/json")
            .timeout(SIDE_REPORT_TIMEOUT)
            .body(body)
            .send()
            .await
            .map_err(ProtocolError::Transport)?;
        success(response)?;
        Ok(())
    }

    /// A client for loopback tests that speaks plain HTTP to a mock Server.
    #[cfg(test)]
    pub fn for_loopback_test(base: &str) -> Self {
        let client = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        Self {
            base: Url::parse(base).unwrap(),
            anonymous: client.clone(),
            authenticated: Some(client),
        }
    }

    /// The signed release manifest of `version`, as the Server mirrors it.
    pub async fn release_manifest(&self, version: &str) -> Result<Vec<u8>, ProtocolError> {
        let response = self
            .authenticated()?
            .get(self.release_url(version, &["manifest"])?)
            .send()
            .await
            .map_err(ProtocolError::Transport)?;
        read_bounded(success(response)?, MAX_RELEASE_MANIFEST_BYTES).await
    }

    /// The Ed25519 signature of the release manifest of `version`.
    pub async fn release_signature(&self, version: &str) -> Result<Vec<u8>, ProtocolError> {
        let response = self
            .authenticated()?
            .get(self.release_url(version, &["signature"])?)
            .send()
            .await
            .map_err(ProtocolError::Transport)?;
        let bytes = read_bounded(success(response)?, RELEASE_SIGNATURE_BYTES).await?;
        if bytes.len() != RELEASE_SIGNATURE_BYTES {
            return Err(ProtocolError::InvalidResponse(
                "release signature has the wrong size",
            ));
        }
        Ok(bytes)
    }

    /// Streams the release binary of `version` for `platform` (`{os}-{arch}`)
    /// to `sink`, failing as soon as more than `limit` bytes arrive. Returns
    /// the number of bytes received.
    pub async fn release_binary(
        &self,
        version: &str,
        platform: &str,
        limit: u64,
        mut sink: impl FnMut(&[u8]) -> std::io::Result<()>,
    ) -> Result<u64, ProtocolError> {
        let mut response = success(
            self.authenticated()?
                .get(self.release_url(version, &["binaries", platform])?)
                .timeout(RELEASE_BINARY_TIMEOUT)
                .send()
                .await
                .map_err(ProtocolError::Transport)?,
        )?;
        let too_large = ProtocolError::ResponseTooLarge {
            limit: usize::try_from(limit).unwrap_or(usize::MAX),
        };
        if response
            .content_length()
            .is_some_and(|length| length > limit)
        {
            return Err(too_large);
        }
        let mut total = 0u64;
        while let Some(chunk) = response.chunk().await.map_err(ProtocolError::Transport)? {
            total += chunk.len() as u64;
            if total > limit {
                return Err(too_large);
            }
            sink(&chunk).map_err(|_| {
                ProtocolError::InvalidResponse("could not store the release binary")
            })?;
        }
        Ok(total)
    }

    /// Reports the progress of a requested update. Returns false when the
    /// Server has no matching update (409), for example because it was
    /// cancelled.
    pub async fn agent_update_report(
        &self,
        update: &AgentUpdate,
        state: AgentUpdateState,
        error_code: Option<&str>,
    ) -> Result<bool, ProtocolError> {
        let body = serde_json::to_vec(&AgentUpdateReport {
            update_id: update.update_id,
            version: &update.version,
            state,
            error_code,
        })
        .map_err(|_| ProtocolError::Json)?;
        if body.len() > MAX_AGENT_UPDATE_REQUEST_BYTES {
            return Err(ProtocolError::RequestTooLarge {
                limit: MAX_AGENT_UPDATE_REQUEST_BYTES,
            });
        }
        let response = self
            .authenticated()?
            .post(self.endpoint("agent/v1/agent-update/report")?)
            .header(CONTENT_TYPE, "application/json")
            .timeout(SIDE_REPORT_TIMEOUT)
            .body(body)
            .send()
            .await
            .map_err(ProtocolError::Transport)?;
        if response.status() == StatusCode::CONFLICT {
            return Ok(false);
        }
        success(response)?;
        Ok(true)
    }

    fn release_url(&self, version: &str, rest: &[&str]) -> Result<Url, ProtocolError> {
        let mut url = self.endpoint("agent/v1/agent-releases")?;
        url.path_segments_mut()
            .map_err(|_| ProtocolError::Configuration("server URL cannot be a base"))?
            .push(version)
            .extend(rest);
        Ok(url)
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
        decode(response).await
    }
}

async fn decode<T: DeserializeOwned>(response: Response) -> Result<T, ProtocolError> {
    let bytes = read_bounded(success(response)?, MAX_JSON_BYTES).await?;
    serde_json::from_slice(&bytes).map_err(|_| ProtocolError::Json)
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
    /// Set by the Server only for Agents that sent the disk-usage capability.
    #[serde(default)]
    pub disk_usage_requested: bool,
    /// An Operator's update request. Set by the Server only for Agents that
    /// sent the agent-update capability.
    #[serde(default)]
    pub agent_update: Option<AgentUpdate>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentUpdate {
    pub version: String,
    /// Identifies this request; every report about it repeats it, so a late
    /// report about an earlier request of the same version changes nothing.
    pub update_id: Uuid,
}

/// States an Agent reports while it updates itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentUpdateState {
    Downloading,
    Restarting,
    Succeeded,
    Failed,
}

/// Body of `POST agent/v1/agent-update/report`. Every property is always
/// present; `errorCode` is `null` unless the state is `failed`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentUpdateReport<'a> {
    update_id: Uuid,
    version: &'a str,
    state: AgentUpdateState,
    error_code: Option<&'a str>,
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
    #[serde(default)]
    pub ai_client: Option<AiClientAssignment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiClientAssignment {
    pub schema: String,
    pub client: String,
    pub mode: String,
    pub base_url: Option<String>,
    pub model: Option<String>,
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

/// Failure detail for one Attempt, as the Server's attempt-detail route
/// expects it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttemptDetail {
    pub diagnostic: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<fleet_reconcile::Step>,
}

/// Body of `PUT agent/v1/disk-usage`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiskUsageReport {
    pub volumes: Vec<DiskVolume>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskVolume {
    pub label: &'static str,
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub available_bytes: u64,
}

/// Body of `PUT agent/v1/telemetry`. Every property is always present; a value
/// that could not be read is `null`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryReport {
    pub agent_version: String,
    pub os: TelemetryOs,
    pub arch: Option<String>,
    pub hostname: Option<String>,
    pub user: Option<String>,
    /// `homebrew`, `cargo` or `binary`.
    pub install_method: Option<&'static str>,
    /// `systemd`, `launchd` or `none`.
    pub service_manager: &'static str,
    pub state_directory: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TelemetryOs {
    pub name: Option<String>,
    pub version: Option<String>,
    pub kernel: Option<String>,
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
    use rustls::pki_types::{CertificateDer, PrivateKeyDer};

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
    fn ai_client_fixture_matches_server_wire_contract() {
        let poll: PollResponse = serde_json::from_str(r#"{"workspaceId":"00000000-0000-0000-0000-000000000001","nodeId":"00000000-0000-0000-0000-000000000002","assignment":{"assignmentId":"00000000-0000-0000-0000-000000000003","attemptId":"00000000-0000-0000-0000-000000000004","rolloutId":"00000000-0000-0000-0000-000000000005","desiredRevisionId":"00000000-0000-0000-0000-000000000006","targetName":"ai-client/codex","target":{"base":"home","path":".codex"},"skills":[],"aiClient":{"schema":"fleet.ai-client/v1","client":"codex","mode":"cliproxy","baseUrl":"https://proxy.example/v1","model":"gpt-6-astra"}},"nextPollSeconds":30}"#).unwrap();
        let ai = poll.assignment.unwrap().ai_client.unwrap();
        assert_eq!(ai.client, "codex");
        assert_eq!(ai.base_url.as_deref(), Some("https://proxy.example/v1"));
        assert_eq!(ai.model.as_deref(), Some("gpt-6-astra"));
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

    const POLL: &str = r#"{"workspaceId":"00000000-0000-0000-0000-000000000001","nodeId":"00000000-0000-0000-0000-000000000002","assignment":null,"nextPollSeconds":30}"#;
    const POLL_REQUESTED: &str = r#"{"workspaceId":"00000000-0000-0000-0000-000000000001","nodeId":"00000000-0000-0000-0000-000000000002","assignment":null,"nextPollSeconds":30,"diskUsageRequested":true}"#;

    #[test]
    fn poll_response_parses_with_and_without_disk_usage_requested() {
        let without: PollResponse = serde_json::from_str(POLL).unwrap();
        assert!(!without.disk_usage_requested);
        let with: PollResponse = serde_json::from_str(POLL_REQUESTED).unwrap();
        assert!(with.disk_usage_requested);
        let explicit_false = POLL_REQUESTED.replace("true", "false");
        let off: PollResponse = serde_json::from_str(&explicit_false).unwrap();
        assert!(!off.disk_usage_requested);
        // Other unknown fields are still rejected.
        let unknown = POLL.replace("}", r#","somethingElse":1}"#);
        assert!(serde_json::from_str::<PollResponse>(&unknown).is_err());
    }

    #[tokio::test]
    async fn every_poll_request_advertises_the_disk_usage_and_agent_update_capabilities() {
        let server =
            crate::detail::testing::MockServer::start(vec![(200, POLL), (200, POLL_REQUESTED)]);
        let client = Api::for_loopback_test(&server.url());
        assert!(!client.poll().await.unwrap().disk_usage_requested);
        assert!(client.poll().await.unwrap().disk_usage_requested);
        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        for request in requests {
            assert_eq!(
                (request.method.as_str(), request.path.as_str()),
                ("POST", "/agent/v1/poll")
            );
            assert_eq!(
                request.header("x-fleet-agent-capabilities"),
                Some("disk-usage,agent-update")
            );
        }
    }

    #[test]
    fn poll_response_parses_an_agent_update_request_and_nothing_else_new() {
        let without: PollResponse = serde_json::from_str(POLL).unwrap();
        assert_eq!(without.agent_update, None);
        const ID: &str = "7d3c2a91-5b8e-4f60-9a1d-2e4b6c8f0a13";
        let with: PollResponse = serde_json::from_str(&POLL.replace(
            '}',
            &format!(r#","agentUpdate":{{"version":"0.12.0","updateId":"{ID}"}}}}"#),
        ))
        .unwrap();
        assert_eq!(
            with.agent_update,
            Some(AgentUpdate {
                version: "0.12.0".to_owned(),
                update_id: ID.parse().unwrap(),
            })
        );
        // The request object itself is closed, so a future field needs a new capability.
        let extended = POLL.replace(
            '}',
            &format!(r#","agentUpdate":{{"version":"0.12.0","updateId":"{ID}","url":"x"}}}}"#),
        );
        assert!(serde_json::from_str::<PollResponse>(&extended).is_err());
        let without_id = POLL.replace('}', r#","agentUpdate":{"version":"0.12.0"}}"#);
        assert!(serde_json::from_str::<PollResponse>(&without_id).is_err());
    }

    #[tokio::test]
    async fn update_reports_have_the_wire_shape_and_a_409_means_not_requested() {
        let server =
            crate::detail::testing::MockServer::start(vec![(204, ""), (409, ""), (500, "")]);
        let client = Api::for_loopback_test(&server.url());
        let update = AgentUpdate {
            version: "0.12.0".to_owned(),
            update_id: Uuid::nil(),
        };
        assert!(
            client
                .agent_update_report(&update, AgentUpdateState::Downloading, None)
                .await
                .unwrap()
        );
        assert!(
            !client
                .agent_update_report(
                    &update,
                    AgentUpdateState::Failed,
                    Some("agent_update_digest")
                )
                .await
                .unwrap()
        );
        assert!(matches!(
            client
                .agent_update_report(&update, AgentUpdateState::Succeeded, None)
                .await,
            Err(ProtocolError::Http(StatusCode::INTERNAL_SERVER_ERROR))
        ));
        let requests = server.requests();
        assert_eq!(
            (requests[0].method.as_str(), requests[0].path.as_str()),
            ("POST", "/agent/v1/agent-update/report")
        );
        let bodies = requests
            .iter()
            .map(|request| serde_json::from_str::<serde_json::Value>(&request.body).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            bodies[0],
            serde_json::json!({"updateId":Uuid::nil(),"version":"0.12.0","state":"downloading","errorCode":null})
        );
        assert_eq!(
            bodies[1],
            serde_json::json!({"updateId":Uuid::nil(),"version":"0.12.0","state":"failed","errorCode":"agent_update_digest"})
        );
    }

    #[tokio::test]
    async fn release_files_are_fetched_by_version_with_their_limits() {
        let manifest = "x".repeat(MAX_RELEASE_MANIFEST_BYTES + 1);
        let server = crate::detail::testing::MockServer::routes(vec![
            (
                "GET",
                "/agent/v1/agent-releases/0.12.0/manifest".to_owned(),
                200,
                manifest.into_bytes(),
            ),
            (
                "GET",
                "/agent/v1/agent-releases/0.12.0/signature".to_owned(),
                200,
                vec![1; 63],
            ),
            (
                "GET",
                "/agent/v1/agent-releases/0.12.0/binaries/linux-amd64".to_owned(),
                200,
                vec![7; 100],
            ),
        ]);
        let client = Api::for_loopback_test(&server.url());
        assert!(matches!(
            client.release_manifest("0.12.0").await,
            Err(ProtocolError::ResponseTooLarge { .. })
        ));
        assert!(matches!(
            client.release_signature("0.12.0").await,
            Err(ProtocolError::InvalidResponse(_))
        ));
        let mut received = Vec::new();
        let size = client
            .release_binary("0.12.0", "linux-amd64", 100, |chunk| {
                received.extend_from_slice(chunk);
                Ok(())
            })
            .await
            .unwrap();
        assert_eq!((size, received), (100, vec![7; 100]));
        assert!(matches!(
            client
                .release_binary("0.12.0", "linux-amd64", 99, |_| Ok(()))
                .await,
            Err(ProtocolError::ResponseTooLarge { .. })
        ));
        assert!(matches!(
            client.release_manifest("0.13.0").await,
            Err(ProtocolError::Http(StatusCode::NOT_FOUND))
        ));
    }

    fn sample_report() -> DiskUsageReport {
        DiskUsageReport {
            volumes: vec![
                DiskVolume {
                    label: "home",
                    total_bytes: 994662584320,
                    used_bytes: 871203905536,
                    available_bytes: 72818462720,
                },
                DiskVolume {
                    label: "state",
                    total_bytes: 10,
                    used_bytes: 4,
                    available_bytes: 6,
                },
            ],
        }
    }

    #[test]
    fn disk_usage_body_has_the_wire_shape() {
        assert_eq!(
            serde_json::to_value(sample_report()).unwrap(),
            serde_json::json!({"volumes":[
                {"label":"home","totalBytes":994662584320u64,"usedBytes":871203905536u64,"availableBytes":72818462720u64},
                {"label":"state","totalBytes":10,"usedBytes":4,"availableBytes":6}
            ]})
        );
    }

    #[tokio::test]
    async fn disk_usage_is_put_and_the_response_body_is_ignored() {
        let server = crate::detail::testing::MockServer::start(vec![(204, ""), (200, "not json")]);
        let client = Api::for_loopback_test(&server.url());
        client.disk_usage(&sample_report()).await.unwrap();
        client.disk_usage(&sample_report()).await.unwrap();
        let requests = server.requests();
        assert_eq!(requests[0].method, "PUT");
        assert_eq!(requests[0].path, "/agent/v1/disk-usage");
        assert_eq!(requests[0].header("content-type"), Some("application/json"));
        let body: serde_json::Value = serde_json::from_str(&requests[0].body).unwrap();
        assert_eq!(body["volumes"][0]["label"], "home");
    }

    #[tokio::test]
    async fn disk_usage_failures_are_errors_not_panics() {
        let server = crate::detail::testing::MockServer::start(vec![(404, ""), (429, "")]);
        let client = Api::for_loopback_test(&server.url());
        for expected in [StatusCode::NOT_FOUND, StatusCode::TOO_MANY_REQUESTS] {
            let error = client.disk_usage(&sample_report()).await.unwrap_err();
            assert!(matches!(error, ProtocolError::Http(status) if status == expected));
        }
    }

    #[tokio::test]
    async fn oversized_disk_usage_requests_are_not_sent() {
        let server = crate::detail::testing::MockServer::start(vec![(204, "")]);
        let client = Api::for_loopback_test(&server.url());
        let report = DiskUsageReport {
            volumes: vec![sample_report().volumes[0].clone(); 200],
        };
        assert!(matches!(
            client.disk_usage(&report).await,
            Err(ProtocolError::RequestTooLarge { .. })
        ));
        assert!(server.requests().is_empty());
    }

    /// Certificates for the trust tests: a CA key whose certificate can be
    /// reissued, as `setup.py --renew-ca` does, and server certificates under it.
    mod trust {
        use rcgen::{
            BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer,
            KeyPair, KeyUsagePurpose, PKCS_ECDSA_P256_SHA256,
        };
        use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
        use time::{Duration, OffsetDateTime};

        pub fn key() -> KeyPair {
            KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap()
        }

        pub fn key_copy(key: &KeyPair) -> KeyPair {
            KeyPair::from_pem(&key.serialize_pem()).unwrap()
        }

        fn ca_params(days_left: i64) -> CertificateParams {
            let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
            params
                .distinguished_name
                .push(DnType::CommonName, "Fleet test CA");
            params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
            params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
            let now = OffsetDateTime::now_utc();
            params.not_before = now - Duration::days(400);
            params.not_after = now + Duration::days(days_left);
            params
        }

        pub fn ca_pem(key: &KeyPair, days_left: i64) -> String {
            ca_params(days_left).self_signed(key).unwrap().pem()
        }

        /// A server certificate for `localhost`, and its key, signed by `key`.
        pub fn server_certificate(
            key: KeyPair,
            days_left: i64,
        ) -> (CertificateDer<'static>, PrivateKeyDer<'static>) {
            let issuer = Issuer::new(ca_params(3650), key);
            let server_key = self::key();
            let mut params = CertificateParams::new(vec!["localhost".to_owned()]).unwrap();
            params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
            params.use_authority_key_identifier_extension = true;
            let now = OffsetDateTime::now_utc();
            params.not_before = now - Duration::days(30);
            params.not_after = now + Duration::days(days_left);
            let certificate = params.signed_by(&server_key, &issuer).unwrap();
            (
                certificate.der().clone(),
                PrivatePkcs8KeyDer::from(server_key.serialize_der()).into(),
            )
        }

        pub fn identity_pem() -> Vec<u8> {
            let key = self::key();
            let certificate = CertificateParams::new(Vec::<String>::new())
                .unwrap()
                .self_signed(&key)
                .unwrap();
            format!("{}{}", certificate.pem(), key.serialize_pem()).into_bytes()
        }
    }

    /// Serves one TLS connection with the same stack as the Agent and answers
    /// its request with [`POLL`]. Returns the port.
    fn serve_poll(certificate: (CertificateDer<'static>, PrivateKeyDer<'static>)) -> u16 {
        use std::io::{Read, Write};
        let config = rustls::ServerConfig::builder_with_provider(
            rustls::crypto::ring::default_provider().into(),
        )
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![certificate.0], certificate.1)
        .unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut tcp, _) = listener.accept().unwrap();
            let mut connection = rustls::ServerConnection::new(config.into()).unwrap();
            let mut tls = rustls::Stream::new(&mut connection, &mut tcp);
            // A client that refuses the certificate ends the connection here.
            if tls.read(&mut [0; 4096]).is_ok() {
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{POLL}",
                    POLL.len()
                );
                let _ = tls.write_all(response.as_bytes());
                let _ = tls.flush();
            }
        });
        port
    }

    async fn poll_trusting(
        ca_pem: &str,
        certificate: (CertificateDer<'static>, PrivateKeyDer<'static>),
    ) -> Result<PollResponse, ProtocolError> {
        let port = serve_poll(certificate);
        Api::new(
            &format!("https://localhost:{port}"),
            ca_pem.as_bytes(),
            Some(&trust::identity_pem()),
        )?
        .poll()
        .await
    }

    #[tokio::test]
    async fn a_server_certificate_renewed_under_the_same_ca_needs_nothing_from_the_agent() {
        let key = trust::key();
        let ca_pem = trust::ca_pem(&key, 300);
        let first = trust::server_certificate(trust::key_copy(&key), 10);
        let renewed = trust::server_certificate(trust::key_copy(&key), 90);
        assert_ne!(first.0, renewed.0);
        poll_trusting(&ca_pem, first).await.unwrap();
        poll_trusting(&ca_pem, renewed).await.unwrap();
    }

    // Extending the CA relies on this: an enrolled Agent keeps the CA certificate
    // it received, and rustls takes only the name and key from a trust anchor.
    // If an upgrade makes this fail, Agents stop connecting when that certificate
    // expires, so docs/technical-design/tls-certificates.md must change first.
    #[tokio::test]
    async fn an_agent_keeps_trusting_a_ca_whose_certificate_it_holds_has_expired() {
        let key = trust::key();
        let expired_ca_pem = trust::ca_pem(&key, -1);
        let certificate = trust::server_certificate(key, 90);
        poll_trusting(&expired_ca_pem, certificate).await.unwrap();
    }

    #[tokio::test]
    async fn every_certificate_in_a_ca_file_is_trusted() {
        let key = trust::key();
        let bundle = format!(
            "{}{}",
            trust::ca_pem(&trust::key(), 300),
            trust::ca_pem(&key, 300)
        );
        let certificate = trust::server_certificate(key, 90);
        poll_trusting(&bundle, certificate).await.unwrap();
    }

    #[tokio::test]
    async fn the_expired_ca_trusts_only_its_own_key() {
        let expired_ca_pem = trust::ca_pem(&trust::key(), -1);
        let certificate = trust::server_certificate(trust::key(), 90);
        assert!(matches!(
            poll_trusting(&expired_ca_pem, certificate).await,
            Err(ProtocolError::Transport(_))
        ));
    }

    #[tokio::test]
    async fn an_agent_refuses_an_expired_server_certificate_under_a_trusted_ca() {
        let key = trust::key();
        let ca_pem = trust::ca_pem(&key, 300);
        let certificate = trust::server_certificate(key, -1);
        assert!(matches!(
            poll_trusting(&ca_pem, certificate).await,
            Err(ProtocolError::Transport(_))
        ));
    }

    fn sample_telemetry() -> TelemetryReport {
        crate::telemetry::fixture()
    }

    #[tokio::test]
    async fn telemetry_is_put_and_the_response_body_is_ignored() {
        let server = crate::detail::testing::MockServer::start(vec![(204, ""), (200, "not json")]);
        let client = Api::for_loopback_test(&server.url());
        client.telemetry(&sample_telemetry()).await.unwrap();
        client.telemetry(&sample_telemetry()).await.unwrap();
        let requests = server.requests();
        assert_eq!(requests[0].method, "PUT");
        assert_eq!(requests[0].path, "/agent/v1/telemetry");
        assert_eq!(requests[0].header("content-type"), Some("application/json"));
        let body: serde_json::Value = serde_json::from_str(&requests[0].body).unwrap();
        assert_eq!(body["agentVersion"], "0.9.0");
    }

    #[tokio::test]
    async fn telemetry_failures_are_errors_not_panics() {
        let server = crate::detail::testing::MockServer::start(vec![(404, ""), (429, "")]);
        let client = Api::for_loopback_test(&server.url());
        for expected in [StatusCode::NOT_FOUND, StatusCode::TOO_MANY_REQUESTS] {
            let error = client.telemetry(&sample_telemetry()).await.unwrap_err();
            assert!(matches!(error, ProtocolError::Http(status) if status == expected));
        }
    }

    #[tokio::test]
    async fn oversized_telemetry_requests_are_not_sent() {
        let server = crate::detail::testing::MockServer::start(vec![(204, "")]);
        let client = Api::for_loopback_test(&server.url());
        let mut report = sample_telemetry();
        report.hostname = Some("x".repeat(MAX_TELEMETRY_REQUEST_BYTES));
        assert!(matches!(
            client.telemetry(&report).await,
            Err(ProtocolError::RequestTooLarge { .. })
        ));
        assert!(server.requests().is_empty());
    }
}
