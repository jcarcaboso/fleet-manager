//! The Antigravity adapter: a JSON gateway config at `~/.gemini/config/config.json`.
//!
//! Antigravity's Enterprise LLM Gateway (`wireProtocol: "openai"`) routes all
//! inference to an OpenAI-compatible endpoint. Fleet owns the top-level
//! `gateway` and `models` keys and preserves every other key in the file (the
//! App also keeps `userSettings`, `plugins`, `sidecars` and similar here).
//!
//! Antigravity cannot read a key file, expand variables, or run a helper
//! command: the API key must be a literal string in `gateway.apiKey`. Fleet
//! therefore reads its private `api-key` state file and injects the value. The
//! written config is mode 0600. The API key is deliberately excluded from drift
//! comparison, so a credential rotation rewrites the file without reporting
//! spurious drift.
//!
//! Config-path caveat: Google's Enterprise Gateway docs name
//! `~/.antigravity/settings.json` as the user gateway file, while the App's
//! general user config (and the Router proxy integration) use
//! `~/.gemini/config/config.json`. Fleet writes the latter so the gateway
//! config is colocated with the personal Skills directory
//! `~/.gemini/config/skills`. Operators should confirm which file their
//! Antigravity build reads; a future version may mirror the block to both.

use super::Rendered;
use crate::ai_client::{Receipt, select_model, validate_receipt};
use crate::state;
use anyhow::{Context, Result, bail};
use serde_json::{Map, Value};
use std::{collections::BTreeMap, path::Path};

const MARKER_HEADER: &str = "X-Fleet-Managed";
const MARKER_VALUE: &str = "cliproxy";
const OWNED_KEYS: [&str; 2] = ["gateway", "models"];

fn settings(old: Option<&[u8]>) -> Result<Map<String, Value>> {
    let value: Value = serde_json::from_slice(old.unwrap_or(b"{}")).map_err(|error| {
        anyhow::anyhow!(
            "invalid Antigravity settings JSON ({})",
            state::json_location(&error)
        )
    })?;
    value
        .as_object()
        .cloned()
        .context("Antigravity settings must be an object")
}

fn restore_value(root: &mut Map<String, Value>, key: &str, original: Option<Value>) {
    if let Some(value) = original {
        root.insert(key.to_owned(), value);
    } else {
        root.remove(key);
    }
}

fn has_fleet_marker(root: &Map<String, Value>) -> bool {
    root.get("gateway")
        .and_then(|gateway| gateway.get("customHeaders"))
        .and_then(|headers| headers.get(MARKER_HEADER))
        == Some(&Value::String(MARKER_VALUE.to_owned()))
}

fn gateway_value(base_url: &str, key: &str) -> Value {
    let mut headers = Map::new();
    headers.insert(
        MARKER_HEADER.to_owned(),
        Value::String(MARKER_VALUE.to_owned()),
    );
    serde_json::json!({
        "enabled": true,
        "url": base_url,
        "wireProtocol": "openai",
        "apiKey": key,
        "customHeaders": headers,
    })
}

fn models_value(models: &[String], selected: &str) -> Value {
    serde_json::json!({
        "defaultModelId": selected,
        "list": models.iter().map(|id| serde_json::json!({ "modelId": id })).collect::<Vec<_>>(),
    })
}

fn expected_list(models: &[String]) -> Value {
    Value::Array(
        models
            .iter()
            .map(|id| serde_json::json!({ "modelId": id }))
            .collect(),
    )
}

fn is_owned_gateway(value: Option<&Value>, expected_base_url: &str) -> bool {
    value.is_some_and(|gateway| {
        gateway.get("enabled") == Some(&Value::Bool(true))
            && gateway.get("wireProtocol") == Some(&Value::String("openai".to_owned()))
            && gateway.get("url") == Some(&Value::String(expected_base_url.to_owned()))
            && gateway
                .get("customHeaders")
                .and_then(|headers| headers.get(MARKER_HEADER))
                == Some(&Value::String(MARKER_VALUE.to_owned()))
    })
}

/// Whether the Fleet-owned settings still hold what Fleet wrote. The API key
/// is a secret that is refreshed on every reconcile, so it is not compared.
fn owned_settings_match(settings: &Map<String, Value>, receipt: &Receipt) -> bool {
    if !is_owned_gateway(settings.get("gateway"), &receipt.expected_base_url) {
        return false;
    }
    let Some(models) = settings.get("models") else {
        return false;
    };
    models.get("list") == Some(&expected_list(&receipt.expected_models))
        && (receipt.automatic_model
            || models.get("defaultModelId") == Some(&Value::String(receipt.expected_model.clone())))
}

/// The originals of the keys Fleet owns. A gateway carrying Fleet's marker is
/// a leftover of an earlier Fleet install, so it is recorded as absent and
/// removed on restore rather than preserved as a user original.
fn unowned_originals(root: &Map<String, Value>) -> BTreeMap<String, Option<Value>> {
    let fleet_owned = has_fleet_marker(root);
    OWNED_KEYS
        .iter()
        .map(|key| {
            (
                (*key).to_owned(),
                if fleet_owned {
                    None
                } else {
                    root.get(*key).cloned()
                },
            )
        })
        .collect()
}

/// A receipt for a Fleet gateway left in the config without one. `None` unless
/// the gateway carries Fleet's marker.
pub(in crate::ai_client) fn orphan_receipt(old: Option<&[u8]>) -> Result<Option<Receipt>> {
    let Some(old) = old else {
        return Ok(None);
    };
    let root = settings(Some(old))?;
    if !has_fleet_marker(&root) {
        return Ok(None);
    }
    Ok(Some(Receipt {
        original_settings: unowned_originals(&root),
        ..Receipt::orphan("antigravity")
    }))
}

pub(in crate::ai_client) fn render_antigravity(
    old: Option<&[u8]>,
    previous: Option<&Receipt>,
    base_url: &str,
    model: Option<&str>,
    models: &[String],
    key_path: &Path,
) -> Result<Rendered> {
    let mut root = settings(old)?;
    let drifted = match previous {
        Some(receipt) => {
            validate_receipt(receipt, "antigravity")?;
            !owned_settings_match(&root, receipt)
        }
        None => false,
    };
    // Anthropic-style clients append their own API path; Antigravity posts to
    // /v1/chat/completions itself, so the gateway URL is the proxy origin.
    let gateway_url = base_url.trim_end_matches("/v1").to_owned();
    let key = state::read_bytes(key_path, 4096)?;
    if key.is_empty() || !key.iter().all(u8::is_ascii_graphic) {
        bail!("CLIProxy credential is missing or invalid");
    }
    let key = String::from_utf8(key).context("CLIProxy credential is not UTF-8")?;
    let current_model = root
        .get("models")
        .and_then(|models| models.get("defaultModelId"))
        .and_then(Value::as_str);
    let selected = select_model(model, current_model, models)?.to_owned();
    let key_path = key_path
        .to_str()
        .context("Antigravity key path is not UTF-8")?
        .to_owned();
    let original_settings = match previous {
        Some(receipt) => receipt.original_settings.clone(),
        None => unowned_originals(&root),
    };
    root.insert("gateway".to_owned(), gateway_value(&gateway_url, &key));
    root.insert("models".to_owned(), models_value(models, &selected));
    Ok(Rendered {
        bytes: serde_json::to_vec_pretty(&root)?,
        receipt: Receipt {
            version: 1,
            client: "antigravity".to_owned(),
            config_existed: previous.map_or(old.is_some(), |receipt| receipt.config_existed),
            original_model: None,
            original_provider: None,
            original_catalog: None,
            expected_model: selected,
            automatic_model: model.is_none(),
            expected_base_url: gateway_url,
            expected_key_path: key_path,
            expected_catalog_path: None,
            expected_models: models.to_vec(),
            expected_reasoning_levels: BTreeMap::new(),
            original_settings,
        },
        drifted,
    })
}

/// Restores the original `gateway` and `models` values and removes Fleet's.
pub(in crate::ai_client) fn restore_antigravity(
    old: Option<&[u8]>,
    receipt: &Receipt,
) -> Result<Vec<u8>> {
    validate_receipt(receipt, "antigravity")?;
    let mut root = settings(old)?;
    for key in OWNED_KEYS {
        if !receipt.original_settings.contains_key(key) {
            bail!("invalid Antigravity settings receipt");
        }
    }
    for key in OWNED_KEYS {
        let original = receipt.original_settings.get(key).cloned().unwrap_or(None);
        restore_value(&mut root, key, original);
    }
    Ok(serde_json::to_vec_pretty(&root)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    fn render(
        old: Option<&[u8]>,
        previous: Option<&Receipt>,
        model: Option<&str>,
    ) -> (Vec<u8>, Receipt) {
        let dir = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("fleet-antigravity-{}", Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let key_path = dir.join("api-key");
        state::write_bytes(&key_path, b"sk-test-key").unwrap();
        let models = ["gemini-2.5-pro".to_owned(), "gemini-2.5-flash".to_owned()];
        let rendered = render_antigravity(
            old,
            previous,
            "https://proxy.example/v1",
            model,
            &models,
            &key_path,
        )
        .unwrap();
        fs::remove_dir_all(&dir).unwrap();
        (rendered.bytes, rendered.receipt)
    }

    #[test]
    fn gateway_config_round_trips_and_preserves_unrelated_settings() {
        let native = br#"{"userSettings":{"enableAdc":true},"theme":"dark"}"#;
        let (bytes, receipt) = render(Some(native), None, Some("gemini-2.5-pro"));
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["gateway"]["enabled"], true);
        assert_eq!(value["gateway"]["wireProtocol"], "openai");
        assert_eq!(value["gateway"]["url"], "https://proxy.example");
        assert_eq!(value["gateway"]["apiKey"], "sk-test-key");
        assert_eq!(
            value["gateway"]["customHeaders"]["X-Fleet-Managed"],
            "cliproxy"
        );
        assert_eq!(value["models"]["defaultModelId"], "gemini-2.5-pro");
        assert_eq!(value["models"]["list"][0]["modelId"], "gemini-2.5-pro");
        assert_eq!(value["userSettings"]["enableAdc"], true);
        assert_eq!(value["theme"], "dark");

        let restored: Value =
            serde_json::from_slice(&restore_antigravity(Some(&bytes), &receipt).unwrap()).unwrap();
        assert_eq!(restored, serde_json::from_slice::<Value>(native).unwrap());
    }

    #[test]
    fn external_edits_are_repaired_without_key_drift() {
        let (bytes, receipt) = render(None, None, Some("gemini-2.5-flash"));
        let mut value: Value = serde_json::from_slice(&bytes).unwrap();
        // A credential rotation changes only the key: not reported as drift.
        value["gateway"]["apiKey"] = "sk-rotated".into();
        let rotated = serde_json::to_vec(&value).unwrap();
        let rerendered = {
            let dir = std::env::temp_dir()
                .canonicalize()
                .unwrap()
                .join(format!("fleet-antigravity-{}", Uuid::new_v4()));
            fs::create_dir(&dir).unwrap();
            let key_path = dir.join("api-key");
            state::write_bytes(&key_path, b"sk-rotated").unwrap();
            let models = ["gemini-2.5-pro".to_owned(), "gemini-2.5-flash".to_owned()];
            let result = render_antigravity(
                Some(&rotated),
                Some(&receipt),
                "https://proxy.example/v1",
                Some("gemini-2.5-flash"),
                &models,
                &key_path,
            )
            .unwrap();
            fs::remove_dir_all(&dir).unwrap();
            result
        };
        assert!(!rerendered.drifted);

        // A disabled gateway is drift and is repaired.
        value["gateway"]["enabled"] = false.into();
        let disabled = serde_json::to_vec(&value).unwrap();
        let dir = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("fleet-antigravity-{}", Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let key_path = dir.join("api-key");
        state::write_bytes(&key_path, b"sk-test-key").unwrap();
        let models = ["gemini-2.5-pro".to_owned(), "gemini-2.5-flash".to_owned()];
        let repaired = render_antigravity(
            Some(&disabled),
            Some(&receipt),
            "https://proxy.example/v1",
            Some("gemini-2.5-flash"),
            &models,
            &key_path,
        )
        .unwrap();
        fs::remove_dir_all(&dir).unwrap();
        assert!(repaired.drifted);
        assert_eq!(
            serde_json::from_slice::<Value>(&repaired.bytes).unwrap()["gateway"]["enabled"],
            true
        );
    }

    #[test]
    fn orphan_receipt_removes_fleet_leftovers_but_keeps_user_gateway() {
        let (bytes, _) = render(Some(br#"{"theme":"dark"}"#), None, None);
        let receipt = orphan_receipt(Some(&bytes)).unwrap().unwrap();
        let restored: Value =
            serde_json::from_slice(&restore_antigravity(Some(&bytes), &receipt).unwrap()).unwrap();
        assert_eq!(restored, serde_json::json!({"theme": "dark"}));

        let user = br#"{"gateway":{"enabled":false,"apiKey":"mine"}}"#;
        assert!(orphan_receipt(Some(user)).unwrap().is_none());
        let (taken, receipt) = render(Some(user), None, None);
        let restored: Value =
            serde_json::from_slice(&restore_antigravity(Some(&taken), &receipt).unwrap()).unwrap();
        assert_eq!(restored, serde_json::from_slice::<Value>(user).unwrap());
    }
}
