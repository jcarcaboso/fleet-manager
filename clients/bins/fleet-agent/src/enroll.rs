//! The `enroll` command and the enrollment link it reads.
//!
//! An enrollment link is `https://<server>/enroll#fleet-v1=<payload>`, where
//! the payload is canonical unpadded base64url of a JSON object holding the
//! Server URL, its CA, the alias and a one-time token. The link is pasted at a
//! prompt so the token never appears in a process listing or shell history.

use std::{
    fs,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::{cli::EnrollArgs, credentials::CredentialStore, protocol::Api, state};

const MAX_ENROLLMENT_LINK_BYTES: usize = 16 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EnrollmentLinkPayload {
    version: u8,
    server_url: String,
    token: String,
    alias: String,
    ca_pem: String,
    expires_at: String,
}

struct EnrollmentSettings {
    server_url: String,
    ca_pem: String,
    alias: String,
    token: String,
}

/// The `enroll` command: creates this Node's identity with a one-time token
/// from an enrollment link or from explicit settings. `home` is the account's
/// home directory, used when `--home` is not given. The caller holds the state
/// lock.
pub async fn run(
    store: &CredentialStore,
    config_path: &Path,
    home: PathBuf,
    args: EnrollArgs,
) -> Result<()> {
    if store.load_identity()?.is_some() {
        bail!("this Agent is already enrolled; use status or alias");
    }
    let settings = if args.link {
        enrollment_settings_from_prompt()?
    } else {
        let server_url = args.server_url.context("provide --server-url")?;
        let ca_cert = args.ca_cert.context("provide --ca-cert")?;
        let alias = args.alias.context("provide --alias")?;
        let ca_pem = String::from_utf8(state::read_bytes(&ca_cert, 256 * 1024)?)
            .context("CA certificate must be PEM text")?;
        let raw = match args.token_file {
            Some(path) => String::from_utf8(state::read_bytes(&path, 64 * 1024)?)?,
            None => std::env::var("FLEET_ENROLLMENT_TOKEN")
                .context("provide --token-file or FLEET_ENROLLMENT_TOKEN")?,
        };
        EnrollmentSettings {
            server_url,
            ca_pem,
            alias,
            token: token_from_text(&raw)?,
        }
    };
    if settings.alias.trim().is_empty() || settings.alias.chars().count() > 200 {
        bail!("alias must be nonblank and at most 200 characters");
    }
    if settings.token.is_empty() || settings.token.len() > 4096 {
        bail!("invalid enrollment token length");
    }
    let home = fs::canonicalize(args.home.unwrap_or(home)).context("resolve installation home")?;
    let config = state::Config {
        server_url: settings.server_url,
        ca_pem: settings.ca_pem,
        node_alias: settings.alias,
        home,
    };
    let api = Api::new(&config.server_url, config.ca_pem.as_bytes(), None)?;
    if let Some(previous) = state::read_json::<state::Config>(config_path)?
        && (previous.server_url != config.server_url
            || previous.ca_pem != config.ca_pem
            || previous.node_alias != config.node_alias
            || previous.home != config.home)
    {
        bail!(
            "unfinished enrollment belongs to different settings; retry with the original settings"
        );
    }
    state::write_json(config_path, &config)?;
    let pending = store.load_or_generate_pending()?;
    let response = api
        .enroll(
            &settings.token,
            &pending.csr_pem,
            &config.node_alias,
            std::env::consts::OS,
        )
        .await?;
    store.complete_enrollment(&pending, &response)?;
    store.clear_pending()?;
    println!(
        "{}",
        serde_json::json!({"nodeId":response.node_id,"alias":config.node_alias,"enrolled":true})
    );
    Ok(())
}

fn token_from_text(raw: &str) -> Result<String> {
    if raw.trim_start().starts_with('{') {
        Ok(serde_json::from_str::<serde_json::Value>(raw)
            .context("invalid enrollment token JSON")?
            .get("token")
            .and_then(|value| value.as_str())
            .context("enrollment JSON requires token")?
            .to_owned())
    } else {
        Ok(raw.trim().to_owned())
    }
}

fn enrollment_settings_from_prompt() -> Result<EnrollmentSettings> {
    eprint!("Paste enrollment link: ");
    io::stderr().flush()?;
    let stdin = io::stdin();
    let mut reader = stdin.lock();
    read_enrollment_link(&mut reader)
}

fn read_enrollment_link(reader: &mut impl BufRead) -> Result<EnrollmentSettings> {
    let mut input = String::new();
    let mut limited = std::io::Read::take(reader, (MAX_ENROLLMENT_LINK_BYTES + 1) as u64);
    limited
        .read_line(&mut input)
        .context("read enrollment link")?;
    if input.len() > MAX_ENROLLMENT_LINK_BYTES {
        bail!("enrollment link must be between 1 and {MAX_ENROLLMENT_LINK_BYTES} bytes");
    }
    parse_enrollment_link(input.trim())
}

fn parse_enrollment_link(input: &str) -> Result<EnrollmentSettings> {
    if input.is_empty() || input.len() > MAX_ENROLLMENT_LINK_BYTES {
        bail!("enrollment link must be between 1 and {MAX_ENROLLMENT_LINK_BYTES} bytes");
    }
    let outer = reqwest::Url::parse(input).context("invalid enrollment link")?;
    if outer.scheme() != "https"
        || !outer.username().is_empty()
        || outer.password().is_some()
        || outer.query().is_some()
        || outer.path() != "/enroll"
    {
        bail!("invalid enrollment link URL");
    }
    let encoded = outer
        .fragment()
        .and_then(|fragment| fragment.strip_prefix("fleet-v1="))
        .context("invalid enrollment link fragment")?;
    let json = decode_base64url(encoded).context("invalid enrollment link payload encoding")?;
    if json.len() > MAX_ENROLLMENT_LINK_BYTES {
        bail!("enrollment link payload is too large");
    }
    let payload: EnrollmentLinkPayload = serde_json::from_slice(&json)
        .map_err(|_| anyhow::anyhow!("invalid enrollment link payload"))?;
    if payload.version != 1 {
        bail!("unsupported enrollment link version");
    }
    let server = reqwest::Url::parse(&payload.server_url)
        .context("invalid server URL in enrollment link")?;
    if server.scheme() != "https"
        || !server.username().is_empty()
        || server.password().is_some()
        || server.query().is_some()
        || server.fragment().is_some()
        || (server.path() != "/" && !server.path().is_empty())
    {
        bail!("invalid server URL in enrollment link");
    }
    if outer.origin() != server.origin() {
        bail!("enrollment link origin does not match its server URL");
    }
    let expires_at = OffsetDateTime::parse(&payload.expires_at, &Rfc3339)
        .map_err(|_| anyhow::anyhow!("invalid enrollment link expiry"))?;
    if expires_at <= OffsetDateTime::now_utc() {
        bail!("enrollment link has expired");
    }
    Api::new(&payload.server_url, payload.ca_pem.as_bytes(), None)?;
    Ok(EnrollmentSettings {
        server_url: payload.server_url,
        ca_pem: payload.ca_pem,
        alias: payload.alias,
        token: payload.token,
    })
}

fn decode_base64url(input: &str) -> Result<Vec<u8>> {
    fn value(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'-' => Some(62),
            b'_' => Some(63),
            _ => None,
        }
    }

    let bytes = input.as_bytes();
    if bytes.is_empty() || bytes.len() % 4 == 1 {
        bail!("invalid base64url length");
    }
    let mut decoded = Vec::with_capacity(bytes.len() * 3 / 4);
    // `as_chunks` is stable since Rust 1.88; CI builds with 1.95.
    let (chunks, remainder) = bytes.as_chunks::<4>();
    for chunk in chunks {
        let a = value(chunk[0]).context("invalid base64url character")?;
        let b = value(chunk[1]).context("invalid base64url character")?;
        let c = value(chunk[2]).context("invalid base64url character")?;
        let d = value(chunk[3]).context("invalid base64url character")?;
        decoded.extend_from_slice(&[(a << 2) | (b >> 4), (b << 4) | (c >> 2), (c << 6) | d]);
    }
    match remainder {
        [] => {}
        [a, b] => {
            let a = value(*a).context("invalid base64url character")?;
            let b = value(*b).context("invalid base64url character")?;
            if b & 0x0f != 0 {
                bail!("non-canonical base64url payload");
            }
            decoded.push((a << 2) | (b >> 4));
        }
        [a, b, c] => {
            let a = value(*a).context("invalid base64url character")?;
            let b = value(*b).context("invalid base64url character")?;
            let c = value(*c).context("invalid base64url character")?;
            if c & 0x03 != 0 {
                bail!("non-canonical base64url payload");
            }
            decoded.extend_from_slice(&[(a << 2) | (b >> 4), (b << 4) | (c >> 2)]);
        }
        _ => unreachable!(),
    }
    Ok(decoded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn encode_base64url(input: &[u8]) -> String {
        const ALPHABET: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut encoded = String::new();
        for chunk in input.chunks(3) {
            encoded.push(ALPHABET[(chunk[0] >> 2) as usize] as char);
            encoded.push(
                ALPHABET[((chunk[0] << 4 | chunk.get(1).copied().unwrap_or(0) >> 4) & 63) as usize]
                    as char,
            );
            if let Some(second) = chunk.get(1) {
                encoded.push(
                    ALPHABET
                        [((second << 2 | chunk.get(2).copied().unwrap_or(0) >> 6) & 63) as usize]
                        as char,
                );
            }
            if let Some(third) = chunk.get(2) {
                encoded.push(ALPHABET[(third & 63) as usize] as char);
            }
        }
        encoded
    }

    fn enrollment_link(server_url: &str, expires_at: &str, extra: &str) -> String {
        let json = format!(
            r#"{{"version":1,"serverUrl":"{server_url}","token":"secret","alias":"node","caPem":"not reached in these tests","expiresAt":"{expires_at}"{extra}}}"#
        );
        format!(
            "https://fleet.example/enroll#fleet-v1={}",
            encode_base64url(json.as_bytes())
        )
    }

    #[test]
    fn enrollment_link_requires_matching_https_origin_and_exact_path() {
        let future = "2999-01-01T00:00:00Z";
        let wrong_origin = enrollment_link("https://other.example", future, "");
        assert!(
            parse_enrollment_link(&wrong_origin)
                .err()
                .unwrap()
                .to_string()
                .contains("origin")
        );

        let wrong_path =
            enrollment_link("https://fleet.example", future, "").replacen("/enroll#", "/other#", 1);
        assert!(
            parse_enrollment_link(&wrong_path)
                .err()
                .unwrap()
                .to_string()
                .contains("URL")
        );
    }

    #[test]
    fn enrollment_link_rejects_expired_and_unknown_fields() {
        let expired = enrollment_link("https://fleet.example/", "2000-01-01T00:00:00Z", "");
        assert!(
            parse_enrollment_link(&expired)
                .err()
                .unwrap()
                .to_string()
                .contains("expired")
        );

        let unknown = enrollment_link(
            "https://fleet.example",
            "2999-01-01T00:00:00Z",
            r#","unexpected":true"#,
        );
        assert!(
            parse_enrollment_link(&unknown)
                .err()
                .unwrap()
                .to_string()
                .contains("payload")
        );
    }

    #[test]
    fn enrollment_link_reader_stops_at_newline() {
        let link = enrollment_link("https://fleet.example", "2999-01-01T00:00:00Z", "");
        let input = format!("{link}\nbytes that have not reached EOF");
        let mut reader = Cursor::new(input.as_bytes());
        assert!(read_enrollment_link(&mut reader).is_ok());
        assert_eq!(reader.position(), (link.len() + 1) as u64);
    }

    #[test]
    fn malformed_enrollment_payload_does_not_echo_secret_content() {
        let secret = "DO_NOT_DISPLAY_THIS_TOKEN";
        let malformed = format!(r#"{{"token":"{secret}","alias":]}}"#);
        let link = format!(
            "https://fleet.example/enroll#fleet-v1={}",
            encode_base64url(malformed.as_bytes())
        );
        let error = parse_enrollment_link(&link).err().unwrap().to_string();
        assert_eq!(error, "invalid enrollment link payload");
        assert!(!error.contains(secret));
    }
}
