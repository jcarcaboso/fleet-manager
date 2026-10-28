use super::Rendered;
use crate::ai_client::{Receipt, select_model, validate_receipt};
use anyhow::{Context, Result, bail};
use serde_json::{Map, Value};
use std::{collections::BTreeMap, path::Path};

fn settings(old: Option<&[u8]>) -> Result<Map<String, Value>> {
    let value: Value = serde_json::from_slice(old.unwrap_or(b"{}")).map_err(|error| {
        anyhow::anyhow!(
            "invalid Claude settings JSON ({})",
            crate::state::json_location(&error)
        )
    })?;
    value
        .as_object()
        .cloned()
        .context("Claude settings must be an object")
}

fn helper(key_path: &str) -> String {
    format!("cat '{}'", key_path.replace('\'', "'\\''"))
}

/// Whether the Fleet-owned settings still hold what Fleet wrote.
fn owned_settings_match(settings: &Map<String, Value>, receipt: &Receipt) -> bool {
    settings.get("apiKeyHelper") == Some(&Value::String(helper(&receipt.expected_key_path)))
        && settings
            .get("env")
            .and_then(|env| env.get("ANTHROPIC_BASE_URL"))
            == Some(&Value::String(receipt.expected_base_url.clone()))
        && (receipt.automatic_model
            || settings.get("model") == Some(&Value::String(receipt.expected_model.clone())))
}

/// The settings to restore when Fleet finds no receipt. When `apiKeyHelper` is
/// Fleet's own helper, the Fleet settings are a leftover of an earlier Fleet
/// installation: the helper, base URL and model are then not the user's and
/// are restored by removal, and `env` counts as the user's only if it holds
/// anything else.
fn unowned_originals(root: &Map<String, Value>, key_path: &str) -> BTreeMap<String, Option<Value>> {
    let env = root.get("env").and_then(Value::as_object);
    if root.get("apiKeyHelper") == Some(&Value::String(helper(key_path))) {
        return BTreeMap::from([
            ("apiKeyHelper".to_owned(), None),
            ("model".to_owned(), None),
            ("baseUrl".to_owned(), None),
            (
                "env".to_owned(),
                env.is_some_and(|env| env.keys().any(|key| key != "ANTHROPIC_BASE_URL"))
                    .then_some(Value::Bool(true)),
            ),
        ]);
    }
    BTreeMap::from([
        ("apiKeyHelper".to_owned(), root.get("apiKeyHelper").cloned()),
        ("model".to_owned(), root.get("model").cloned()),
        (
            "baseUrl".to_owned(),
            env.and_then(|env| env.get("ANTHROPIC_BASE_URL")).cloned(),
        ),
        (
            "env".to_owned(),
            root.contains_key("env").then_some(Value::Bool(true)),
        ),
    ])
}

/// A receipt for Fleet settings left in the config without one (see the
/// Codex adapter). `None` unless `apiKeyHelper` is Fleet's helper.
pub(in crate::ai_client) fn orphan_receipt(
    old: Option<&[u8]>,
    key_path: &Path,
) -> Result<Option<Receipt>> {
    let Some(old) = old else {
        return Ok(None);
    };
    let root = settings(Some(old))?;
    let key_path = key_path.to_str().context("Claude key path is not UTF-8")?;
    if root.get("apiKeyHelper") != Some(&Value::String(helper(key_path))) {
        return Ok(None);
    }
    Ok(Some(Receipt {
        original_settings: unowned_originals(&root, key_path),
        ..Receipt::orphan("claude")
    }))
}

pub(in crate::ai_client) fn render_claude(
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
            validate_receipt(receipt, "claude")?;
            !owned_settings_match(&root, receipt)
        }
        None => false,
    };
    let mut env = match root.get("env") {
        Some(value) => value
            .as_object()
            .cloned()
            .context("Claude env must be an object")?,
        None => Map::new(),
    };
    // These take precedence over apiKeyHelper. Never copy their secrets into a receipt.
    if [
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_MODEL",
    ]
    .iter()
    .any(|key| env.contains_key(*key))
    {
        bail!(
            "remove conflicting Anthropic authentication or model environment settings before enabling CLIProxy"
        );
    }
    let current_model = root
        .get("model")
        .map(|value| value.as_str().context("Claude model must be a string"))
        .transpose()?;
    let selected = select_model(model, current_model, models)?.to_owned();
    // Claude appends /v1/messages itself, unlike the OpenAI-compatible clients.
    let base_url = base_url.trim_end_matches("/v1").to_owned();
    let key_path = key_path
        .to_str()
        .context("Claude key path is not UTF-8")?
        .to_owned();
    let original_settings = match previous {
        Some(receipt) => receipt.original_settings.clone(),
        None => unowned_originals(&root, &key_path),
    };
    env.insert("ANTHROPIC_BASE_URL".to_owned(), base_url.clone().into());
    root.insert("env".to_owned(), env.into());
    root.insert("apiKeyHelper".to_owned(), helper(&key_path).into());
    root.insert("model".to_owned(), selected.clone().into());
    Ok(Rendered {
        bytes: serde_json::to_vec_pretty(&root)?,
        receipt: Receipt {
            version: 1,
            client: "claude".to_owned(),
            config_existed: previous.map_or(old.is_some(), |receipt| receipt.config_existed),
            original_model: None,
            original_provider: None,
            original_catalog: None,
            expected_model: selected,
            automatic_model: model.is_none(),
            expected_base_url: base_url,
            expected_key_path: key_path,
            expected_catalog_path: None,
            expected_models: models.to_vec(),
            expected_reasoning_levels: BTreeMap::new(),
            original_settings,
        },
        drifted,
    })
}

/// Restores the original settings, whatever is left of the Fleet ones. A
/// missing file is treated as empty.
pub(in crate::ai_client) fn restore_claude(
    old: Option<&[u8]>,
    receipt: &Receipt,
) -> Result<Vec<u8>> {
    validate_receipt(receipt, "claude")?;
    let mut root = settings(old)?;
    for key in ["apiKeyHelper", "model", "baseUrl", "env"] {
        if !receipt.original_settings.contains_key(key) {
            bail!("invalid Claude settings receipt");
        }
    }
    for key in ["apiKeyHelper", "model"] {
        match &receipt.original_settings[key] {
            Some(value) => {
                root.insert(key.to_owned(), value.clone());
            }
            None => {
                root.remove(key);
            }
        }
    }
    let base_url = &receipt.original_settings["baseUrl"];
    if base_url.is_some() && !root.contains_key("env") {
        root.insert("env".to_owned(), Value::Object(Map::new()));
    }
    if let Some(env) = root.get_mut("env") {
        let env = env
            .as_object_mut()
            .context("Claude env must be an object")?;
        match base_url {
            Some(value) => {
                env.insert("ANTHROPIC_BASE_URL".to_owned(), value.clone());
            }
            None => {
                env.remove("ANTHROPIC_BASE_URL");
            }
        }
        if env.is_empty() && receipt.original_settings["env"].is_none() {
            root.remove("env");
        }
    }
    Ok(serde_json::to_vec_pretty(&root)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(
        old: Option<&[u8]>,
        previous: Option<&Receipt>,
        model: Option<&str>,
    ) -> (Vec<u8>, Receipt) {
        let rendered = render_claude(
            old,
            previous,
            "https://proxy.example/v1",
            model,
            &["claude-one".to_owned(), "claude-two".to_owned()],
            Path::new("/private/fleet's key"),
        )
        .unwrap();
        (rendered.bytes, rendered.receipt)
    }

    #[test]
    fn proxy_settings_restore_native_and_preserve_unrelated_edits() {
        let native = br#"{"model":"native","apiKeyHelper":"native-helper","env":{"OTHER":"keep","ANTHROPIC_BASE_URL":"https://native.example"},"permissions":{"allow":[]}}"#;
        let (bytes, receipt) = render(Some(native), None, Some("claude-one"));
        let mut value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["env"]["ANTHROPIC_BASE_URL"], "https://proxy.example");
        assert_eq!(value["apiKeyHelper"], "cat '/private/fleet'\\''s key'");
        value["theme"] = "dark".into();
        let refreshed = serde_json::to_vec(&value).unwrap();
        let (bytes, receipt) = render(Some(&refreshed), Some(&receipt), Some("claude-two"));
        let restored: Value =
            serde_json::from_slice(&restore_claude(Some(&bytes), &receipt).unwrap()).unwrap();
        let mut expected: Value = serde_json::from_slice(native).unwrap();
        expected["theme"] = "dark".into();
        assert_eq!(restored, expected);
    }

    #[test]
    fn automatic_model_keeps_local_selection_and_empty_settings_restore() {
        let (bytes, receipt) = render(None, None, None);
        let mut value: Value = serde_json::from_slice(&bytes).unwrap();
        value["model"] = "claude-two".into();
        let changed = serde_json::to_vec(&value).unwrap();
        let (bytes, receipt) = render(Some(&changed), Some(&receipt), None);
        assert_eq!(receipt.expected_model, "claude-two");
        assert_eq!(
            settings(Some(&restore_claude(Some(&bytes), &receipt).unwrap())).unwrap(),
            Map::new()
        );
    }

    #[test]
    fn conflicting_auth_fails_closed() {
        assert!(
            render_claude(
                Some(br#"{"env":{"ANTHROPIC_AUTH_TOKEN":"secret"}}"#),
                None,
                "https://proxy.example/v1",
                None,
                &["claude-one".to_owned()],
                Path::new("/key")
            )
            .is_err()
        );
    }

    #[test]
    fn external_edits_are_repaired_and_native_restores_the_originals() {
        let native = br#"{"model":"native","apiKeyHelper":"native-helper","theme":"dark"}"#;
        let (bytes, receipt) = render(Some(native), None, Some("claude-one"));
        let mut value: Value = serde_json::from_slice(&bytes).unwrap();
        value["model"] = "claude-two".into();
        value["apiKeyHelper"] = "someone-else".into();
        value["env"]
            .as_object_mut()
            .unwrap()
            .remove("ANTHROPIC_BASE_URL");
        let changed = serde_json::to_vec(&value).unwrap();
        let rendered = render_claude(
            Some(&changed),
            Some(&receipt),
            "https://proxy.example/v1",
            Some("claude-one"),
            &["claude-one".to_owned()],
            Path::new("/private/fleet's key"),
        )
        .unwrap();
        assert!(rendered.drifted);
        let repaired: Value = serde_json::from_slice(&rendered.bytes).unwrap();
        assert_eq!(repaired["model"], "claude-one");
        assert_eq!(
            repaired["env"]["ANTHROPIC_BASE_URL"],
            "https://proxy.example"
        );
        assert_eq!(
            rendered.receipt.original_settings,
            receipt.original_settings
        );

        // Native mode restores the originals from changed, partial or missing settings.
        let expected: Value = serde_json::from_slice(native).unwrap();
        for old in [
            Some(changed.as_slice()),
            Some(br#"{"theme":"dark"}"#.as_slice()),
        ] {
            let restored: Value =
                serde_json::from_slice(&restore_claude(old, &receipt).unwrap()).unwrap();
            assert_eq!(restored, expected);
        }
        let restored: Value =
            serde_json::from_slice(&restore_claude(None, &receipt).unwrap()).unwrap();
        assert_eq!(
            restored,
            serde_json::json!({"model":"native","apiKeyHelper":"native-helper"})
        );
    }

    #[test]
    fn leftover_fleet_settings_without_a_receipt_are_not_recorded_as_originals() {
        let (bytes, _) = render(
            Some(br#"{"theme":"dark","env":{"OTHER":"1"}}"#),
            None,
            Some("claude-one"),
        );
        let receipt = orphan_receipt(Some(&bytes), Path::new("/private/fleet's key"))
            .unwrap()
            .unwrap();
        let restored: Value =
            serde_json::from_slice(&restore_claude(Some(&bytes), &receipt).unwrap()).unwrap();
        assert_eq!(
            restored,
            serde_json::json!({"theme":"dark","env":{"OTHER":"1"}})
        );
        let (_, taken_over) = render(Some(&bytes), None, Some("claude-two"));
        assert_eq!(taken_over.original_settings, receipt.original_settings);
        assert!(
            orphan_receipt(Some(br#"{"apiKeyHelper":"mine"}"#), Path::new("/k"))
                .unwrap()
                .is_none()
        );
    }
}
