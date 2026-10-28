use crate::error::{CliError, is_error_code, known_code_message};
use reqwest::{Certificate, Client, StatusCode, Url, redirect::Policy};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{net::IpAddr, path::PathBuf, time::Duration};
use uuid::Uuid;

const API_PREFIX: [&str; 2] = ["operator", "v1"];
const PAGE_LIMIT: u32 = 100;
pub(crate) const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
/// Failure bodies are read only to find an error `code`; larger ones are ignored.
pub(crate) const MAX_ERROR_BODY_BYTES: usize = 4096;
pub(crate) const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Agent update requests wait while the Server mirrors and verifies the
/// release, which downloads every archive the first time.
pub(crate) const AGENT_UPDATE_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct Collection {
    pub(crate) items: Vec<Value>,
    #[serde(rename = "nextCursor")]
    pub(crate) next_cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnrollmentRequest {
    expires_in_seconds: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RenameNodeRequest<'a> {
    current_alias: &'a str,
    alias: &'a str,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenameNodeResponse {
    pub(crate) node_id: Uuid,
    pub(crate) alias: String,
}

pub(crate) struct Api {
    client: Client,
    base: Url,
    token: String,
}

fn config_error(message: &str) -> CliError {
    CliError::usage("invalid_configuration", message)
}

impl Api {
    pub(crate) fn new(
        server_url: &str,
        token: String,
        allow_http: bool,
        ca_cert: Option<&PathBuf>,
    ) -> Result<Self, CliError> {
        let base = Url::parse(server_url).map_err(|_| config_error("invalid server URL"))?;
        if !base.username().is_empty() || base.password().is_some() {
            return Err(config_error(
                "server URL must not include a username or password",
            ));
        }
        if base.query().is_some() || base.fragment().is_some() {
            return Err(config_error(
                "server URL must not include a query or fragment",
            ));
        }
        if base.path() != "" && base.path() != "/" {
            return Err(config_error("server URL must not include a path"));
        }
        match base.scheme() {
            "https" => {}
            "http" if allow_http && is_loopback(&base) => {}
            "http" => {
                return Err(config_error(
                    "HTTP is allowed only for loopback with --allow-http",
                ));
            }
            _ => return Err(config_error("server URL must use HTTPS")),
        }
        if base.host_str().is_none() {
            return Err(config_error("server URL must include a host"));
        }
        let mut builder = Client::builder()
            .https_only(false)
            .redirect(Policy::none())
            .timeout(REQUEST_TIMEOUT);
        if let Some(ca_cert) = ca_cert {
            let pem = std::fs::read(ca_cert)
                .map_err(|_| config_error("could not read the CA certificate file"))?;
            builder = builder.add_root_certificate(
                Certificate::from_pem(&pem)
                    .map_err(|_| config_error("could not parse the CA certificate"))?,
            );
        }
        Ok(Self {
            client: builder
                .build()
                .map_err(|_| config_error("could not build the HTTP client"))?,
            base,
            token,
        })
    }

    /// Builds `/operator/v1/<segments...>`. Every segment is percent-encoded as
    /// one path segment, so aliases may contain `/`, `?`, `#`, `%` and spaces.
    fn endpoint(&self, segments: &[&str]) -> Result<Url, CliError> {
        if segments
            .iter()
            .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
        {
            return Err(CliError::usage(
                "invalid_argument",
                "a name or ID argument is empty, \".\" or \"..\"",
            ));
        }
        let mut url = self.base.clone();
        url.path_segments_mut()
            .map_err(|()| config_error("server URL cannot be a base"))?
            .clear()
            .extend(API_PREFIX)
            .extend(segments);
        Ok(url)
    }

    /// `GET` one JSON document.
    pub(crate) async fn get(
        &self,
        segments: &[&str],
        query: &[(&str, &str)],
    ) -> Result<Value, CliError> {
        let mut url = self.endpoint(segments)?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        self.send(self.client.get(url)).await
    }

    /// `POST` with an optional JSON body.
    pub(crate) async fn post(
        &self,
        segments: &[&str],
        body: Option<&Value>,
    ) -> Result<Value, CliError> {
        let request = self.client.post(self.endpoint(segments)?);
        self.send(if let Some(body) = body {
            request.json(body)
        } else {
            request
        })
        .await
    }

    /// `GET` one page of a paged list, always with `limit=100`.
    pub(crate) async fn list(
        &self,
        segments: &[&str],
        filters: &[(&str, &str)],
        after: Option<&str>,
    ) -> Result<Collection, CliError> {
        let mut url = self.endpoint(segments)?;
        {
            let mut pairs = url.query_pairs_mut();
            pairs.append_pair("limit", &PAGE_LIMIT.to_string());
            pairs.extend_pairs(filters);
            if let Some(after) = after {
                pairs.append_pair("after", after);
            }
        }
        self.send(self.client.get(url)).await
    }

    pub(crate) async fn get_collection(
        &self,
        resource: &str,
        after: Option<&str>,
    ) -> Result<Collection, CliError> {
        self.list(&[resource], &[], after).await
    }

    pub(crate) async fn create_enrollment(&self, expires: u32) -> Result<Value, CliError> {
        let body = serde_json::to_value(EnrollmentRequest {
            expires_in_seconds: expires,
        })
        .map_err(|_| CliError::transport("encode_failed", "could not encode the request"))?;
        self.post(&["enrollment-tokens"], Some(&body)).await
    }

    pub(crate) async fn revoke_credential(&self, id: Uuid) -> Result<Value, CliError> {
        self.post(&["credentials", &id.to_string(), "revoke"], None)
            .await
    }

    pub(crate) async fn rename_node(
        &self,
        current_alias: &str,
        new_alias: &str,
    ) -> Result<RenameNodeResponse, CliError> {
        self.send_with_errors(
            self.client
                .post(self.endpoint(&["nodes", "rename"])?)
                .json(&RenameNodeRequest {
                    current_alias,
                    alias: new_alias,
                }),
            rename_error_detail,
        )
        .await
    }

    /// `POST` with the longer [`AGENT_UPDATE_TIMEOUT`].
    pub(crate) async fn post_agent_update(
        &self,
        segments: &[&str],
        body: Option<&Value>,
    ) -> Result<Value, CliError> {
        let request = self
            .client
            .post(self.endpoint(segments)?)
            .timeout(AGENT_UPDATE_TIMEOUT);
        self.send(if let Some(body) = body {
            request.json(body)
        } else {
            request
        })
        .await
    }

    pub(crate) async fn rescan(&self) -> Result<Value, CliError> {
        self.post(&["source", "rescan"], None).await
    }

    async fn send<T: for<'de> Deserialize<'de>>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<T, CliError> {
        self.send_with_errors(request, default_error_detail).await
    }

    async fn send_with_errors<T: for<'de> Deserialize<'de>>(
        &self,
        request: reqwest::RequestBuilder,
        error_detail: fn(StatusCode) -> &'static str,
    ) -> Result<T, CliError> {
        let response = request
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    CliError::transport("timeout", "Fleet Server request timed out")
                } else {
                    CliError::transport("transport_error", "could not reach Fleet Server")
                }
            })?;
        let status = response.status();
        if !status.is_success() {
            let code = read_error_code(response).await;
            let message = code
                .as_deref()
                .and_then(known_code_message)
                .unwrap_or_else(|| error_detail(status));
            return Err(CliError::http(status.as_u16(), code, message));
        }
        let too_large =
            || CliError::transport("response_too_large", "Fleet Server response exceeds 1 MiB");
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(too_large());
        }
        let mut body = Vec::new();
        let mut response = response;
        while let Some(chunk) = response.chunk().await.map_err(|_| {
            CliError::transport("transport_error", "could not read Fleet Server response")
        })? {
            if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                return Err(too_large());
            }
            body.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&body).map_err(|_| {
            CliError::transport("invalid_response", "could not decode Fleet Server response")
        })
    }
}

/// Reads at most 4 KiB of a failure body and returns its `code` only when it
/// is a plain snake_case identifier. Nothing else from the body is kept.
async fn read_error_code(mut response: reqwest::Response) -> Option<String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_ERROR_BODY_BYTES as u64)
    {
        return None;
    }
    let mut body = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        if body.len().saturating_add(chunk.len()) > MAX_ERROR_BODY_BYTES {
            return None;
        }
        body.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&body).ok()?;
    let code = value.get("code")?.as_str()?;
    is_error_code(code).then(|| code.to_owned())
}

fn default_error_detail(status: StatusCode) -> &'static str {
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => "operator authentication failed",
        StatusCode::NOT_FOUND => "Fleet Server route or resource was not found",
        StatusCode::CONFLICT => "Fleet Server reported a conflict",
        _ => "Fleet Server request failed",
    }
}
fn rename_error_detail(status: StatusCode) -> &'static str {
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => "operator authentication failed",
        StatusCode::NOT_FOUND => "no node has the current alias",
        StatusCode::CONFLICT => "new alias is already in use or the node is revoked",
        _ => "Fleet Server request failed",
    }
}
/// Loopback by the parsed host, not by its text: `Url::host_str` returns IPv6
/// hosts in brackets (`[::1]`), so a string comparison would never match them.
fn is_loopback(url: &Url) -> bool {
    // host_str() keeps the brackets around IPv6 literals, for example "[::1]".
    match url.host_str() {
        Some(host) if host.eq_ignore_ascii_case("localhost") => true,
        Some(host) => host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
            .is_ok_and(|ip| ip.is_loopback()),
        None => false,
    }
}
