use crate::ai_client::{PROVIDER_NAME, Receipt, validate_receipt};
use anyhow::{Context, Result, bail};
use jsonc_parser::{
    ParseOptions,
    cst::{CstInputValue, CstObject, CstObjectProp, CstRootNode},
};
use serde_json::Value;
use std::{collections::BTreeMap, path::Path};

pub(in crate::ai_client) fn render_opencode(
    old: Option<&[u8]>,
    previous: Option<&Receipt>,
    base_url: &str,
    model: Option<&str>,
    models: &[String],
    key_path: &Path,
    efforts: &BTreeMap<String, Vec<String>>,
) -> Result<(Vec<u8>, Receipt)> {
    let existed = old.is_some();
    let text =
        std::str::from_utf8(old.unwrap_or(b"{}\n")).context("OpenCode config is not UTF-8")?;
    let root =
        CstRootNode::parse(text, &ParseOptions::default()).context("invalid OpenCode JSONC")?;
    let object = root
        .object_value()
        .context("OpenCode config root must be an object")?;
    let current_model = optional_json_string(&object, "model")?;
    let provider = object.object_value("provider");
    let fleet_provider = provider
        .as_ref()
        .and_then(|providers| providers.get(PROVIDER_NAME));
    let key_path = key_path
        .to_str()
        .context("OpenCode key path is not UTF-8")?
        .to_owned();
    if key_path.contains('}') || key_path.chars().any(char::is_control) {
        bail!("OpenCode key path contains unsupported characters");
    }
    let selected = super::super::select_model(
        model,
        current_model
            .as_deref()
            .and_then(|model| model.strip_prefix("fleet-cliproxy/")),
        models,
    )?
    .to_owned();
    let original_model = match previous {
        Some(receipt) => {
            validate_receipt(receipt, "opencode")?;
            if (!receipt.automatic_model
                && current_model.as_deref()
                    != Some(format!("{PROVIDER_NAME}/{}", receipt.expected_model).as_str()))
                || !opencode_provider_matches(fleet_provider.as_ref(), receipt)
            {
                bail!("Fleet-owned OpenCode settings changed outside Fleet");
            }
            receipt.original_model.clone()
        }
        None => {
            if fleet_provider.is_some() {
                bail!("OpenCode provider name fleet-cliproxy is already in use");
            }
            current_model
        }
    };
    set_json_property(
        &object,
        "model",
        format!("{PROVIDER_NAME}/{selected}").into(),
    );
    let providers = match provider {
        Some(provider) => provider,
        None => object
            .object_value_or_create("provider")
            .context("OpenCode provider must be an object")?,
    };
    let models_value = models
        .iter()
        .map(|model| {
            (
                model.clone(),
                CstInputValue::Object(vec![
                    ("name".to_owned(), model.clone().into()),
                    (
                        "variants".to_owned(),
                        CstInputValue::Object(
                            efforts
                                .get(model)
                                .into_iter()
                                .flatten()
                                .map(|effort| {
                                    (
                                        effort.clone(),
                                        CstInputValue::Object(vec![(
                                            "reasoningEffort".to_owned(),
                                            effort.clone().into(),
                                        )]),
                                    )
                                })
                                .collect(),
                        ),
                    ),
                ]),
            )
        })
        .collect();
    set_json_property(
        &providers,
        PROVIDER_NAME,
        CstInputValue::Object(vec![
            ("npm".to_owned(), "@ai-sdk/openai-compatible".into()),
            ("name".to_owned(), "Fleet CLIProxy".into()),
            (
                "options".to_owned(),
                CstInputValue::Object(vec![
                    ("baseURL".to_owned(), base_url.to_owned().into()),
                    ("apiKey".to_owned(), format!("{{file:{key_path}}}").into()),
                ]),
            ),
            ("models".to_owned(), CstInputValue::Object(models_value)),
        ]),
    );
    Ok((
        root.to_string().into_bytes(),
        Receipt {
            version: 1,
            client: "opencode".to_owned(),
            config_existed: previous.map_or(existed, |receipt| receipt.config_existed),
            original_model,
            original_provider: None,
            original_catalog: None,
            expected_model: selected,
            automatic_model: model.is_none(),
            expected_base_url: base_url.to_owned(),
            expected_key_path: key_path,
            expected_catalog_path: None,
            expected_models: models.to_vec(),
            expected_reasoning_levels: efforts.clone(),
        },
    ))
}

pub(in crate::ai_client) fn restore_opencode(
    old: Option<&[u8]>,
    receipt: &Receipt,
) -> Result<Vec<u8>> {
    validate_receipt(receipt, "opencode")?;
    let text = std::str::from_utf8(old.context("managed OpenCode config is missing")?)
        .context("OpenCode config is not UTF-8")?;
    let root =
        CstRootNode::parse(text, &ParseOptions::default()).context("invalid OpenCode JSONC")?;
    let object = root
        .object_value()
        .context("OpenCode config root must be an object")?;
    if !receipt.automatic_model
        && optional_json_string(&object, "model")?.as_deref()
            != Some(format!("{PROVIDER_NAME}/{}", receipt.expected_model).as_str())
    {
        bail!("Fleet-owned OpenCode model changed outside Fleet");
    }
    let providers = object
        .object_value("provider")
        .context("managed OpenCode provider is missing")?;
    let provider = providers.get(PROVIDER_NAME);
    if !opencode_provider_matches(provider.as_ref(), receipt) {
        bail!("Fleet-owned OpenCode provider changed outside Fleet");
    }
    match receipt.original_model.as_deref() {
        Some(model) => set_json_property(&object, "model", model.into()),
        None => object.get("model").unwrap().remove(),
    }
    provider.unwrap().remove();
    if providers.properties().is_empty() {
        object.get("provider").unwrap().remove();
    }
    Ok(root.to_string().into_bytes())
}

fn opencode_provider_matches(property: Option<&CstObjectProp>, receipt: &Receipt) -> bool {
    let Some(value) = property.and_then(CstObjectProp::to_serde_value) else {
        return false;
    };
    value.get("npm").and_then(Value::as_str) == Some("@ai-sdk/openai-compatible")
        && value.get("name").and_then(Value::as_str) == Some("Fleet CLIProxy")
        && value.pointer("/options/baseURL").and_then(Value::as_str)
            == Some(receipt.expected_base_url.as_str())
        && value.pointer("/options/apiKey").and_then(Value::as_str)
            == Some(format!("{{file:{}}}", receipt.expected_key_path).as_str())
        && value
            .get("models")
            .and_then(Value::as_object)
            .is_some_and(|map| {
                map.len() == receipt.expected_models.len()
                    && receipt.expected_models.iter().all(|model| {
                        map.get(model)
                            .and_then(|entry| entry.get("name"))
                            .and_then(Value::as_str)
                            == Some(model)
                            && variants_match(
                                map.get(model).and_then(|entry| entry.get("variants")),
                                receipt
                                    .expected_reasoning_levels
                                    .get(model)
                                    .map(Vec::as_slice)
                                    .unwrap_or_default(),
                            )
                    })
            })
}

fn variants_match(value: Option<&Value>, levels: &[String]) -> bool {
    let expected = levels
        .iter()
        .map(|level| (level.clone(), serde_json::json!({"reasoningEffort": level})))
        .collect::<serde_json::Map<_, _>>();
    value.is_none_or(|value| value == &Value::Object(expected))
        && (value.is_some() || levels.is_empty())
}

fn optional_json_string(object: &CstObject, name: &str) -> Result<Option<String>> {
    match object.get(name) {
        None => Ok(None),
        Some(property) => property
            .to_serde_value()
            .and_then(|value| value.as_str().map(ToOwned::to_owned))
            .map(Some)
            .with_context(|| format!("OpenCode {name} must be a string")),
    }
}

fn set_json_property(object: &CstObject, name: &str, value: CstInputValue) {
    match object.get(name) {
        Some(property) => property.set_value(value),
        None => {
            object.append(name, value);
        }
    }
}
