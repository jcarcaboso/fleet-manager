use super::Rendered;
use crate::ai_client::{
    ContextLimits, MAX_MODEL_RESPONSE_BYTES, PROVIDER_NAME, Receipt, valid_model_id,
    validate_receipt,
};
use anyhow::{Context, Result, bail};
use std::{collections::BTreeMap, path::Path};
use toml_edit::{DocumentMut, Item, Table, value};

/// Parses a Codex config. The parser's own error prints the offending source
/// line, so only the position is kept.
pub(super) fn parse_document(text: &str) -> Result<DocumentMut> {
    text.parse::<DocumentMut>()
        .map_err(|error| match error.span() {
            Some(span) => {
                let (line, column) = crate::state::text_location(text, span.start);
                anyhow::anyhow!("invalid Codex TOML at line {line} column {column}")
            }
            None => anyhow::anyhow!("invalid Codex TOML"),
        })
}

/// Writes the Fleet-owned Codex settings: `model`, `model_provider`,
/// `model_catalog_json` and the `[model_providers.fleet-cliproxy]` table.
/// Everything else in the file is kept.
///
/// The Server assignment wins. When a receipt exists, its original settings
/// are kept and the Fleet-owned keys are overwritten even if something outside
/// Fleet changed or removed them (Codex's own `/model` writes `model`); the
/// returned flag says whether that happened, so it can be reported as drift.
/// Without a receipt, the current settings become the originals, except
/// leftovers of an earlier Fleet installation (see [`unowned_originals`]).
pub(super) fn render_codex(
    old: Option<&[u8]>,
    previous: Option<&Receipt>,
    base_url: &str,
    model: Option<&str>,
    models: &[String],
    key_path: &Path,
    catalog_path: &Path,
) -> Result<Rendered> {
    let existed = old.is_some();
    let mut document = document(old)?;
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
    let (original_model, original_provider, original_catalog, drifted) = match previous {
        Some(receipt) => {
            validate_receipt(receipt, "codex")?;
            let drifted = (!receipt.automatic_model
                && current_model.as_deref() != Some(receipt.expected_model.as_str()))
                || current_provider.as_deref() != Some(PROVIDER_NAME)
                || current_catalog.as_deref() != receipt.expected_catalog_path.as_deref()
                || !codex_provider_matches(fleet_provider, receipt);
            (
                receipt.original_model.clone(),
                receipt.original_provider.clone(),
                receipt.original_catalog.clone(),
                drifted,
            )
        }
        None => {
            let (model, provider, catalog) = unowned_originals(
                current_model,
                current_provider,
                current_catalog,
                &catalog_path,
            );
            (model, provider, catalog, false)
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
    provider["requires_openai_auth"] = value(false);
    let mut auth = Table::new();
    auth["command"] = value("cat");
    let mut args = toml_edit::Array::new();
    args.push(key_path.as_str());
    auth["args"] = value(args);
    auth["timeout_ms"] = value(5000);
    auth["refresh_interval_ms"] = value(300000);
    provider["auth"] = Item::Table(auth);
    providers[PROVIDER_NAME] = Item::Table(provider);
    Ok(Rendered {
        bytes: document.to_string().into_bytes(),
        receipt: Receipt {
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
            original_settings: BTreeMap::new(),
        },
        drifted,
    })
}

/// The settings to restore when Fleet finds no receipt. Values that Fleet
/// itself writes are never treated as the user's: a `model_provider` of
/// `fleet-cliproxy` (and the `model` chosen for it) and a `model_catalog_json`
/// that is Fleet's catalog or belongs to that provider. They are restored by
/// removing them, so Codex falls back to its defaults.
fn unowned_originals(
    model: Option<String>,
    provider: Option<String>,
    catalog: Option<String>,
    catalog_path: &str,
) -> (Option<String>, Option<String>, Option<String>) {
    let fleet_selected = provider.as_deref() == Some(PROVIDER_NAME);
    let catalog = catalog.filter(|catalog| !fleet_selected && catalog != catalog_path);
    if fleet_selected {
        (None, None, catalog)
    } else {
        (model, provider, catalog)
    }
}

/// A receipt for Fleet settings left in the config without one, for example
/// after the state directory was wiped. `None` when the config holds no Fleet
/// setting. Restoring it removes the Fleet settings and keeps the user's.
pub(super) fn orphan_receipt(old: Option<&[u8]>, catalog_path: &Path) -> Result<Option<Receipt>> {
    let Some(old) = old else {
        return Ok(None);
    };
    let document = document(Some(old))?;
    let catalog_path = catalog_path
        .to_str()
        .context("Codex catalog path is not UTF-8")?;
    let model = optional_toml_string(&document, "model")?;
    let provider = optional_toml_string(&document, "model_provider")?;
    let catalog = optional_toml_string(&document, "model_catalog_json")?;
    let has_table = document
        .get("model_providers")
        .and_then(Item::as_table)
        .is_some_and(|table| table.contains_key(PROVIDER_NAME));
    if !has_table
        && provider.as_deref() != Some(PROVIDER_NAME)
        && catalog.as_deref() != Some(catalog_path)
    {
        return Ok(None);
    }
    let (original_model, original_provider, original_catalog) =
        unowned_originals(model, provider, catalog, catalog_path);
    Ok(Some(Receipt {
        original_model,
        original_provider,
        original_catalog,
        ..Receipt::orphan("codex")
    }))
}

/// Restores the original settings and removes Fleet's provider table. It
/// does not require the Fleet settings to be intact: whatever is left of
/// them is replaced, and a missing file is treated as empty.
pub(super) fn restore_codex(old: Option<&[u8]>, receipt: &Receipt) -> Result<Vec<u8>> {
    validate_receipt(receipt, "codex")?;
    let mut document = document(old)?;
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

fn document(old: Option<&[u8]>) -> Result<DocumentMut> {
    match old {
        Some(bytes) => {
            parse_document(std::str::from_utf8(bytes).context("Codex config is not UTF-8")?)
        }
        None => Ok(DocumentMut::new()),
    }
}

pub(super) fn render_codex_catalog(
    models: &[String],
    efforts: &BTreeMap<String, Vec<String>>,
    context_limits: &BTreeMap<String, ContextLimits>,
) -> Result<Vec<u8>> {
    const BASE_INSTRUCTIONS: &str = "You are Codex, a coding agent. Work in the user's repository, follow applicable AGENTS.md instructions, and use the provided tools to complete the request.";

    if models.is_empty() || models.iter().any(|model| !valid_model_id(model)) {
        bail!("cannot build Codex catalog from invalid models");
    }
    let models = models
        .iter()
        .enumerate()
        .map(|(index, model)| {
            let limits = context_limits.get(model).copied().unwrap_or_default();
            if !limits.is_valid() {
                bail!("cannot build Codex catalog from invalid context limits");
            }
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
                "context_window": limits.context_window,
                "max_context_window": limits.max_context_window,
                "auto_compact_token_limit": limits.auto_compact_token_limit,
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
        && table
            .get("requires_openai_auth")
            .is_none_or(|item| item.as_bool() == Some(false))
        && auth
            .and_then(|table| table.get("command"))
            .and_then(Item::as_str)
            .is_some_and(|command| command == "cat" || command == "/bin/cat")
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
