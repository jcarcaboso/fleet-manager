use crate::ai_client::{Receipt, select_model, validate_receipt};
use anyhow::{Context, Result, bail};
use serde_json::{Map, Value};
use std::{collections::BTreeMap, path::Path};

fn settings(old: Option<&[u8]>) -> Result<Map<String, Value>> {
    let value: Value = serde_json::from_slice(old.unwrap_or(b"{}"))?;
    value
        .as_object()
        .cloned()
        .context("Claude settings must be an object")
}

fn helper(key_path: &str) -> String {
    format!("cat '{}'", key_path.replace('\'', "'\\''"))
}

fn check_owned(settings: &Map<String, Value>, receipt: &Receipt) -> Result<()> {
    validate_receipt(receipt, "claude")?;
    if settings.get("apiKeyHelper") != Some(&Value::String(helper(&receipt.expected_key_path)))
        || settings
            .get("env")
            .and_then(|env| env.get("ANTHROPIC_BASE_URL"))
            != Some(&Value::String(receipt.expected_base_url.clone()))
        || (!receipt.automatic_model
            && settings.get("model") != Some(&Value::String(receipt.expected_model.clone())))
    {
        bail!("Fleet-owned Claude settings changed outside Fleet");
    }
    Ok(())
}

pub(in crate::ai_client) fn render_claude(
    old: Option<&[u8]>,
    previous: Option<&Receipt>,
    base_url: &str,
    model: Option<&str>,
    models: &[String],
    key_path: &Path,
) -> Result<(Vec<u8>, Receipt)> {
    let mut root = settings(old)?;
    if let Some(receipt) = previous {
        check_owned(&root, receipt)?;
    }
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
    let original_settings = previous.map_or_else(
        || {
            BTreeMap::from([
                ("apiKeyHelper".to_owned(), root.get("apiKeyHelper").cloned()),
                ("model".to_owned(), root.get("model").cloned()),
                ("baseUrl".to_owned(), env.get("ANTHROPIC_BASE_URL").cloned()),
                (
                    "env".to_owned(),
                    root.contains_key("env").then_some(Value::Bool(true)),
                ),
            ])
        },
        |receipt| receipt.original_settings.clone(),
    );
    // Claude appends /v1/messages itself, unlike the OpenAI-compatible clients.
    let base_url = base_url.trim_end_matches("/v1").to_owned();
    let key_path = key_path
        .to_str()
        .context("Claude key path is not UTF-8")?
        .to_owned();
    env.insert("ANTHROPIC_BASE_URL".to_owned(), base_url.clone().into());
    root.insert("env".to_owned(), env.into());
    root.insert("apiKeyHelper".to_owned(), helper(&key_path).into());
    root.insert("model".to_owned(), selected.clone().into());
    Ok((
        serde_json::to_vec_pretty(&root)?,
        Receipt {
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
    ))
}

pub(in crate::ai_client) fn restore_claude(
    old: Option<&[u8]>,
    receipt: &Receipt,
) -> Result<Vec<u8>> {
    let mut root = settings(Some(old.context("managed Claude settings are missing")?))?;
    check_owned(&root, receipt)?;
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
    let env = root
        .get_mut("env")
        .and_then(Value::as_object_mut)
        .context("Claude env must be an object")?;
    match &receipt.original_settings["baseUrl"] {
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
        render_claude(
            old,
            previous,
            "https://proxy.example/v1",
            model,
            &["claude-one".to_owned(), "claude-two".to_owned()],
            Path::new("/private/fleet's key"),
        )
        .unwrap()
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
    fn conflicting_auth_and_external_managed_edits_fail_closed() {
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
        let (bytes, receipt) = render(None, None, Some("claude-one"));
        let changed = String::from_utf8(bytes)
            .unwrap()
            .replace("proxy.example", "other.example");
        assert!(restore_claude(Some(changed.as_bytes()), &receipt).is_err());
        assert!(
            render_claude(
                Some(changed.as_bytes()),
                Some(&receipt),
                "https://proxy.example/v1",
                None,
                &["claude-one".to_owned()],
                Path::new("/key")
            )
            .is_err()
        );
    }
}
