use anyhow::{Context, Result, bail};
use reqwest::{Certificate, Client, StatusCode, Url, redirect::Policy};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{path::PathBuf, time::Duration};
use uuid::Uuid;

const API_PREFIX: &str = "/operator/v1";
const PAGE_LIMIT: u32 = 100;
pub(crate) const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
pub(crate) const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

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

impl Api {
    pub(crate) fn new(
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
            builder = builder
                .add_root_certificate(Certificate::from_pem(&pem).context("parse CA certificate")?);
        }
        Ok(Self {
            client: builder.build().context("build HTTP client")?,
            base,
            token,
        })
    }

    fn endpoint(&self, path: &str) -> Result<Url> {
        self.base
            .join(&format!("{API_PREFIX}/{path}"))
            .context("construct API URL")
    }

    pub(crate) async fn get_collection(&self, resource: &str, after: Option<&str>) -> Result<()> {
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

    pub(crate) async fn create_enrollment(&self, expires: u32) -> Result<()> {
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

    pub(crate) async fn revoke_credential(&self, id: Uuid) -> Result<()> {
        let response: Value = self
            .send(
                self.client
                    .post(self.endpoint(&format!("credentials/{id}/revoke"))?),
            )
            .await?;
        println!("{}", serde_json::to_string(&response)?);
        Ok(())
    }

    pub(crate) async fn rename_node(&self, current_alias: &str, new_alias: &str) -> Result<()> {
        let response: RenameNodeResponse = self
            .send_with_errors(
                self.client
                    .post(self.endpoint("nodes/rename")?)
                    .json(&RenameNodeRequest {
                        current_alias,
                        alias: new_alias,
                    }),
                rename_error_detail,
            )
            .await?;
        println!("{}", serde_json::to_string(&response)?);
        Ok(())
    }

    pub(crate) async fn rescan(&self) -> Result<()> {
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
        self.send_with_errors(request, default_error_detail).await
    }

    async fn send_with_errors<T: for<'de> Deserialize<'de>>(
        &self,
        request: reqwest::RequestBuilder,
        error_detail: fn(StatusCode) -> &'static str,
    ) -> Result<T> {
        let response = request
            .bearer_auth(&self.token)
            .send()
            .await
            .context("request Fleet Server")?;
        let status = response.status();
        if !status.is_success() {
            let detail = error_detail(status);
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

fn default_error_detail(status: StatusCode) -> &'static str {
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => "operator authentication failed",
        StatusCode::NOT_FOUND => "Fleet Server route was not found",
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
fn is_loopback(url: &Url) -> bool {
    matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"))
}
