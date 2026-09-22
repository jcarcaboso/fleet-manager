use crate::ai_client::{
    MAX_MODEL_RESPONSE_BYTES, PROVIDER_NAME, Receipt, valid_model_id, validate_receipt,
};
use anyhow::{Context, Result, bail};
use std::{collections::BTreeMap, path::Path};
use toml_edit::{DocumentMut, Item, Table, value};

pub(super) fn render_codex(
    old: Option<&[u8]>,
    previous: Option<&Receipt>,
    base_url: &str,
    model: Option<&str>,
    models: &[String],
    key_path: &Path,
    catalog_path: &Path,
) -> Result<(Vec<u8>, Receipt)> {
    let existed = old.is_some();
    let text = std::str::from_utf8(old.unwrap_or_default()).context("Codex config is not UTF-8")?;
    let mut document = if existed {
        text.parse::<DocumentMut>().context("invalid Codex TOML")?
    } else {
        DocumentMut::new()
    };
    let current_model = optional_toml_string(&document, "model")?;
    let current_provider = optional_toml_string(&document, "model_provider")?;
    let current_catalog = optional_toml_string(&document, "model_catalog_json")?;
    let fleet_provider = document
        .get("model_providers")
        .and_then(Item::as_table)
        .and_then(|table| table.get(PROVIDER_NAME));
    let key_path = key_path
        .to_str()
        .context("Codex key path is not UTF-8")?
        .to_owned();
    let catalog_path = catalog_path
        .to_str()
        .context("Codex catalog path is not UTF-8")?
        .to_owned();
    let selected = super::super::select_model(model, current_model.as_deref(), models)?.to_owned();
    let (original_model, original_provider, original_catalog) = match previous {
        Some(receipt) => {
            validate_receipt(receipt, "codex")?;
            if (!receipt.automatic_model
                && current_model.as_deref() != Some(receipt.expected_model.as_str()))
                || current_provider.as_deref() != Some(PROVIDER_NAME)
                || current_catalog.as_deref() != receipt.expected_catalog_path.as_deref()
                || !codex_provider_matches(fleet_provider, receipt)
            {
                bail!("Fleet-owned Codex settings changed outside Fleet");
            }
            (
                receipt.original_model.clone(),
                receipt.original_provider.clone(),
                receipt.original_catalog.clone(),
            )
        }
        None => {
            if fleet_provider.is_some() {
                bail!("Codex provider name fleet-cliproxy is already in use");
            }
            (current_model, current_provider, current_catalog)
        }
    };
    document["model_provider"] = value(PROVIDER_NAME);
    document["model"] = value(selected.as_str());
    document["model_catalog_json"] = value(catalog_path.as_str());
    let providers = table_or_create(&mut document, "model_providers")?;
    let mut provider = Table::new();
    provider["name"] = value("Fleet CLIProxy");
    provider["base_url"] = value(base_url);
    provider["wire_api"] = value("responses");
    let mut auth = Table::new();
    auth["command"] = value("/bin/cat");
    let mut args = toml_edit::Array::new();
    args.push(key_path.as_str());
    auth["args"] = value(args);
    auth["timeout_ms"] = value(5000);
    auth["refresh_interval_ms"] = value(300000);
    provider["auth"] = Item::Table(auth);
    providers[PROVIDER_NAME] = Item::Table(provider);
    Ok((
        document.to_string().into_bytes(),
        Receipt {
            version: 1,
            client: "codex".to_owned(),
            config_existed: previous.map_or(existed, |receipt| receipt.config_existed),
            original_model,
            original_provider,
            original_catalog,
            expected_model: selected,
            automatic_model: model.is_none(),
            expected_base_url: base_url.to_owned(),
            expected_key_path: key_path,
            expected_catalog_path: Some(catalog_path),
            expected_models: models.to_vec(),
            expected_reasoning_levels: BTreeMap::new(),
        },
    ))
}

pub(super) fn restore_codex(old: Option<&[u8]>, receipt: &Receipt) -> Result<Vec<u8>> {
    validate_receipt(receipt, "codex")?;
    let text = std::str::from_utf8(old.context("managed Codex config is missing")?)
        .context("Codex config is not UTF-8")?;
    let mut document = text.parse::<DocumentMut>().context("invalid Codex TOML")?;
    let current_catalog = optional_toml_string(&document, "model_catalog_json")?;
    let provider = document
        .get("model_providers")
        .and_then(Item::as_table)
        .and_then(|table| table.get(PROVIDER_NAME));
    if (!receipt.automatic_model
        && optional_toml_string(&document, "model")?.as_deref()
            != Some(receipt.expected_model.as_str()))
        || optional_toml_string(&document, "model_provider")?.as_deref() != Some(PROVIDER_NAME)
        || current_catalog.as_deref() != receipt.expected_catalog_path.as_deref()
        || !codex_provider_matches(provider, receipt)
    {
        bail!("Fleet-owned Codex settings changed outside Fleet");
    }
    restore_toml_string(&mut document, "model", receipt.original_model.as_deref());
    restore_toml_string(
        &mut document,
        "model_provider",
        receipt.original_provider.as_deref(),
    );
    restore_toml_string(
        &mut document,
        "model_catalog_json",
        receipt.original_catalog.as_deref(),
    );
    if let Some(providers) = document
        .get_mut("model_providers")
        .and_then(Item::as_table_mut)
    {
        providers.remove(PROVIDER_NAME);
        if providers.is_empty() {
            document.remove("model_providers");
        }
    }
    Ok(document.to_string().into_bytes())
}

pub(super) fn render_codex_catalog(
    models: &[String],
    efforts: &BTreeMap<String, Vec<String>>,
) -> Result<Vec<u8>> {
    const BASE_INSTRUCTIONS: &str = "You are Codex, a coding agent. Work in the user's repository, follow applicable AGENTS.md instructions, and use the provided tools to complete the request.";

    if models.is_empty() || models.iter().any(|model| !valid_model_id(model)) {
        bail!("cannot build Codex catalog from invalid models");
    }
    let models = models
        .iter()
        .enumerate()
        .map(|(index, model)| {
            let priority = i32::try_from(index + 1).context("too many Codex models")?;
            Ok(serde_json::json!({
                "slug": model,
                "display_name": model,
                "description": null,
                "default_reasoning_level": efforts.get(model).and_then(|levels|
                    levels.iter().find(|level| level.as_str() == "medium").or_else(|| levels.first())),
                "supported_reasoning_levels": efforts.get(model).into_iter().flatten()
                    .map(|effort| serde_json::json!({"effort": effort, "description": effort}))
                    .collect::<Vec<_>>(),
                "shell_type": "unified_exec",
                "visibility": "list",
                "supported_in_api": true,
                "priority": priority,
                "availability_nux": null,
                "upgrade": null,
                "include_apps_usage_instructions": false,
                "supports_reasoning_summary_parameter": false,
                "support_verbosity": false,
                "default_verbosity": null,
                "apply_patch_tool_type": "freeform",
                "truncation_policy": { "mode": "bytes", "limit": 10_000 },
                "experimental_supported_tools": [],
                "base_instructions": BASE_INSTRUCTIONS
            }))
        })
        .collect::<Result<Vec<_>>>()?;
    let mut catalog = serde_json::to_vec_pretty(&serde_json::json!({ "models": models }))?;
    catalog.push(b'\n');
    if catalog.len() > MAX_MODEL_RESPONSE_BYTES {
        bail!("generated Codex model catalog exceeds 4 MiB");
    }
    Ok(catalog)
}

fn codex_provider_matches(item: Option<&Item>, receipt: &Receipt) -> bool {
    let Some(table) = item.and_then(Item::as_table) else {
        return false;
    };
    let auth = table.get("auth").and_then(Item::as_table);
    table.get("name").and_then(Item::as_str) == Some("Fleet CLIProxy")
        && table.get("base_url").and_then(Item::as_str) == Some(receipt.expected_base_url.as_str())
        && table.get("wire_api").and_then(Item::as_str) == Some("responses")
        && auth
            .and_then(|table| table.get("command"))
            .and_then(Item::as_str)
            == Some("/bin/cat")
        && auth
            .and_then(|table| table.get("args"))
            .and_then(Item::as_array)
            .is_some_and(|args| {
                args.len() == 1
                    && args.get(0).and_then(toml_edit::Value::as_str)
                        == Some(receipt.expected_key_path.as_str())
            })
        && auth
            .and_then(|table| table.get("timeout_ms"))
            .and_then(Item::as_integer)
            == Some(5000)
        && auth
            .and_then(|table| table.get("refresh_interval_ms"))
            .and_then(Item::as_integer)
            == Some(300000)
}

fn table_or_create<'a>(document: &'a mut DocumentMut, name: &str) -> Result<&'a mut Table> {
    if !document.contains_key(name) {
        document[name] = Item::Table(Table::new());
    }
    document[name]
        .as_table_mut()
        .with_context(|| format!("Codex {name} must be a table"))
}

fn optional_toml_string(document: &DocumentMut, name: &str) -> Result<Option<String>> {
    match document.get(name) {
        None => Ok(None),
        Some(item) => item
            .as_str()
            .map(|value| Some(value.to_owned()))
            .with_context(|| format!("Codex {name} must be a string")),
    }
}

fn restore_toml_string(document: &mut DocumentMut, name: &str, original: Option<&str>) {
    match original {
        Some(original) => document[name] = value(original),
        None => {
            document.remove(name);
        }
    }
}
