//! Builds the CLIProxy selection body for `fleet models select`.
//!
//! The Server stores one policy per base URL and requires the version it was
//! read at. The CLI reads the current selection, applies the requested changes
//! on top of it and sends the whole policy back.

use crate::commands::SelectArgs;
use crate::error::CliError;
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

fn invalid_response() -> CliError {
    CliError::transport(
        "invalid_response",
        "Fleet Server response had an unexpected shape",
    )
}

fn strings(policy: &Value, key: &str) -> BTreeSet<String> {
    policy
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str().map(str::to_owned))
        .collect()
}

fn overlap(name: &str, left: &[String], right: &[String]) -> Result<(), CliError> {
    match left.iter().find(|value| right.contains(value)) {
        Some(value) => Err(CliError::usage(
            "conflicting_flags",
            format!("{name}: {value:?} is both enabled and disabled"),
        )),
        None => Ok(()),
    }
}

/// `selection` is the `GET cliproxy/selection` response.
pub(crate) fn build_body(selection: &Value, args: &SelectArgs) -> Result<Value, CliError> {
    if args.include_new.is_none()
        && args.skip_claude_models_for_other_clients.is_none()
        && args.enable_family.is_empty()
        && args.disable_family.is_empty()
        && args.enable_model.is_empty()
        && args.disable_model.is_empty()
        && args.clear_model_override.is_empty()
    {
        return Err(CliError::usage(
            "no_changes",
            "pass at least one change flag; see `fleet models select --help`",
        ));
    }
    overlap("families", &args.enable_family, &args.disable_family)?;
    overlap("models", &args.enable_model, &args.disable_model)?;
    overlap("models", &args.enable_model, &args.clear_model_override)?;
    overlap("models", &args.disable_model, &args.clear_model_override)?;

    let catalogs = selection
        .get("catalogs")
        .and_then(Value::as_array)
        .ok_or_else(invalid_response)?;
    let current = match (&args.base_url, catalogs.as_slice()) {
        (Some(url), _) => catalogs
            .iter()
            .find(|catalog| catalog.get("baseUrl").and_then(Value::as_str) == Some(url)),
        (None, [only]) => Some(only),
        (None, []) => {
            return Err(CliError::not_found(
                "catalog_unavailable",
                "no CLIProxy catalog is available; run `fleet models refresh`",
            ));
        }
        (None, _) => {
            return Err(CliError::usage(
                "base_url_required",
                "several CLIProxy catalogs exist; pass --base-url (see `fleet models selection`)",
            ));
        }
    };
    let base_url = args
        .base_url
        .clone()
        .or_else(|| {
            current
                .and_then(|catalog| catalog.get("baseUrl"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .ok_or_else(invalid_response)?;
    let policy = current
        .and_then(|catalog| catalog.get("policy"))
        .unwrap_or(&Value::Null);
    let version = args.selection_version.unwrap_or_else(|| {
        current
            .and_then(|catalog| catalog.get("version"))
            .and_then(Value::as_u64)
            .unwrap_or(0)
    });

    let mut enabled = strings(policy, "enabledFamilies");
    let mut disabled = strings(policy, "disabledFamilies");
    for family in &args.enable_family {
        disabled.remove(family);
        enabled.insert(family.clone());
    }
    for family in &args.disable_family {
        enabled.remove(family);
        disabled.insert(family.clone());
    }
    let mut overrides: Map<String, Value> = policy
        .get("modelOverrides")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for model in &args.enable_model {
        overrides.insert(model.clone(), Value::Bool(true));
    }
    for model in &args.disable_model {
        overrides.insert(model.clone(), Value::Bool(false));
    }
    for model in &args.clear_model_override {
        overrides.remove(model);
    }
    let include_new = args
        .include_new
        .or_else(|| policy.get("includeNew").and_then(Value::as_bool))
        .unwrap_or(true);
    let skip_claude = args
        .skip_claude_models_for_other_clients
        .or_else(|| {
            policy
                .get("skipClaudeModelsForOtherClients")
                .and_then(Value::as_bool)
        })
        .unwrap_or(true);
    Ok(json!({
        "baseUrl": base_url,
        "version": version,
        "policy": {
            "includeNew": include_new,
            "disabledFamilies": disabled,
            "enabledFamilies": enabled,
            "modelOverrides": overrides,
            "skipClaudeModelsForOtherClients": skip_claude,
        }
    }))
}
