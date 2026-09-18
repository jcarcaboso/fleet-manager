use crate::{
    protocol::{AiClientAssignment, Api},
    state,
};
use anyhow::{Context, Result, bail};
use jsonc_parser::{
    ParseOptions,
    cst::{CstInputValue, CstObject, CstObjectProp, CstRootNode},
};
use reqwest::{Client, Url, redirect::Policy};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    time::Duration,
};
use toml_edit::{DocumentMut, Item, Table, value};
use uuid::Uuid;

const MODEL_FIELDS: [&str; 5] = ["id", "slug", "name", "model", "value"];
const MAX_MODEL_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_CLIENT_CONFIG_BYTES: u64 = 4 * 1024 * 1024;
const PROVIDER_NAME: &str = "fleet-cliproxy";

pub struct Reconciler {
    home: PathBuf,
    state: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelCache {
    version: u8,
    base_url: String,
    models: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    version: u8,
    client: String,
    config_existed: bool,
    original_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    original_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    original_catalog: Option<String>,
    expected_model: String,
    expected_base_url: String,
    expected_key_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_catalog_path: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    expected_models: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    version: u8,
    config_path: PathBuf,
    old_digest: String,
    new_digest: String,
    receipt: Option<Receipt>,
}

impl Reconciler {
    pub fn new(home: &Path, state_root: PathBuf) -> Result<Self> {
        let home = fs::canonicalize(home).context("resolve AI client home")?;
        state::private_directory(&state_root)?;
        Ok(Self {
            home,
            state: state_root,
        })
    }

    pub fn recover(&self, client: &str) -> Result<()> {
        let journal_path = self.journal_path(client)?;
        let Some(journal) = state::read_json::<Journal>(&journal_path)? else {
            return Ok(());
        };
        if journal.version != 1 || journal.config_path != self.config_path(client)? {
            bail!("invalid AI client recovery journal");
        }
        let digest = config_digest(read_optional_config(&journal.config_path)?.as_deref());
        if digest == journal.new_digest {
            self.finish_receipt(client, journal.receipt.as_ref())?;
        } else if digest != journal.old_digest {
            bail!("AI client configuration changed during interrupted recovery");
        }
        remove_state_file(&journal_path)
    }

    pub async fn reconcile(&self, api: &Api, assignment: &AiClientAssignment) -> Result<()> {
        self.validate_assignment(assignment)?;
        self.recover(&assignment.client)?;
        match assignment.mode.as_str() {
            "native" => self.restore_native(&assignment.client),
            "cliproxy" => {
                let base_url = assignment
                    .base_url
                    .as_deref()
                    .context("missing CLIProxy URL")?;
                let model = assignment
                    .model
                    .as_deref()
                    .context("missing CLIProxy model")?;
                let key = self.credential(api).await?;
                let models = self.models(base_url, &key, model).await?;
                self.apply_proxy(&assignment.client, base_url, model, &models)
            }
            _ => bail!("unsupported AI client mode"),
        }
    }

    fn validate_assignment(&self, assignment: &AiClientAssignment) -> Result<()> {
        if assignment.schema != "fleet.ai-client/v1"
            || !matches!(assignment.client.as_str(), "codex" | "opencode")
        {
            bail!("unsupported AI client assignment");
        }
        match assignment.mode.as_str() {
            "native" if assignment.base_url.is_none() && assignment.model.is_none() => Ok(()),
            "cliproxy"
                if assignment.base_url.is_some()
                    && assignment.model.as_deref().is_some_and(valid_model_id) =>
            {
                validate_base_url(assignment.base_url.as_deref().unwrap()).map(|_| ())
            }
            _ => bail!("invalid AI client assignment"),
        }
    }

    async fn credential(&self, api: &Api) -> Result<Vec<u8>> {
        let path = self.state.join("api-key");
        match api.cliproxy_credential().await {
            Ok(key) => {
                state::write_bytes(&path, &key)?;
                Ok(key)
            }
            Err(error) => match read_saved_credential(&path) {
                Ok(key) if !key.is_empty() && key.iter().all(u8::is_ascii_graphic) => {
                    eprintln!("CLIProxy credential refresh failed; using the saved credential");
                    Ok(key)
                }
                _ => Err(error).context("fetch CLIProxy credential"),
            },
        }
    }

    async fn models(&self, base_url: &str, key: &[u8], selected: &str) -> Result<Vec<String>> {
        let cache_path = self.state.join("models.json");
        let cached = state::read_json::<ModelCache>(&cache_path)?;
        let fetched = CliProxyClient::new(base_url)?.models(key).await;
        match fetched {
            Ok(models) if models.iter().any(|model| model == selected) => {
                state::write_json(
                    &cache_path,
                    &ModelCache {
                        version: 1,
                        base_url: base_url.to_owned(),
                        models: models.clone(),
                    },
                )?;
                Ok(models)
            }
            result => {
                let cached = usable_cache(cached, base_url, selected);
                if let Some(cache) = cached {
                    eprintln!("CLIProxy model refresh failed; using the saved model catalog");
                    return Ok(cache.models);
                }
                match result {
                    Ok(_) => bail!("selected model is not advertised by CLIProxy"),
                    Err(error) => Err(error).context("fetch CLIProxy model catalog"),
                }
            }
        }
    }

    fn apply_proxy(
        &self,
        client: &str,
        base_url: &str,
        model: &str,
        models: &[String],
    ) -> Result<()> {
        let path = self.config_path(client)?;
        let old = read_optional_config(&path)?;
        let previous = state::read_json::<Receipt>(&self.receipt_path(client)?)?;
        let key_path = self.state.join("api-key");
        let (new, receipt) = match client {
            "codex" => {
                let catalog_path = self.state.join("codex-model-catalog.json");
                let catalog = render_codex_catalog(models)?;
                let rendered = render_codex(
                    old.as_deref(),
                    previous.as_ref(),
                    base_url,
                    model,
                    models,
                    &key_path,
                    &catalog_path,
                )?;
                state::write_bytes(&catalog_path, &catalog)?;
                rendered
            }
            "opencode" => render_opencode(
                old.as_deref(),
                previous.as_ref(),
                base_url,
                model,
                models,
                &key_path,
            )?,
            _ => bail!("unsupported AI client"),
        };
        self.commit(client, &path, old.as_deref(), Some(&new), Some(receipt))
    }

    fn restore_native(&self, client: &str) -> Result<()> {
        let Some(receipt) = state::read_json::<Receipt>(&self.receipt_path(client)?)? else {
            if client == "codex" {
                remove_state_file(&self.state.join("codex-model-catalog.json"))?;
            }
            return Ok(());
        };
        let path = self.config_path(client)?;
        let old = read_optional_config(&path)?;
        let restored = match client {
            "codex" => restore_codex(old.as_deref(), &receipt)?,
            "opencode" => restore_opencode(old.as_deref(), &receipt)?,
            _ => bail!("unsupported AI client"),
        };
        let new = if !receipt.config_existed && config_is_empty(client, &restored)? {
            None
        } else {
            Some(restored.as_slice())
        };
        self.commit(client, &path, old.as_deref(), new, None)?;
        if client == "codex" {
            remove_state_file(&self.state.join("codex-model-catalog.json"))?;
        }
        Ok(())
    }

    fn commit(
        &self,
        client: &str,
        path: &Path,
        old: Option<&[u8]>,
        new: Option<&[u8]>,
        receipt: Option<Receipt>,
    ) -> Result<()> {
        if old == new {
            return self.finish_receipt(client, receipt.as_ref());
        }
        if new.is_some() {
            ensure_config_parent(&self.home, path)?;
        }
        let journal = Journal {
            version: 1,
            config_path: path.to_owned(),
            old_digest: config_digest(old),
            new_digest: config_digest(new),
            receipt,
        };
        state::write_json(&self.journal_path(client)?, &journal)?;
        match new {
            Some(bytes) => write_config(path, old, bytes)?,
            None => remove_config(path, old)?,
        }
        self.finish_receipt(client, journal.receipt.as_ref())?;
        remove_state_file(&self.journal_path(client)?)
    }

    fn finish_receipt(&self, client: &str, receipt: Option<&Receipt>) -> Result<()> {
        let path = self.receipt_path(client)?;
        match receipt {
            Some(receipt) => state::write_json(&path, receipt),
            None => remove_state_file(&path),
        }
    }

    fn config_path(&self, client: &str) -> Result<PathBuf> {
        match client {
            "codex" => Ok(self.home.join(".codex/config.toml")),
            "opencode" => Ok(self.home.join(".config/opencode/opencode.json")),
            _ => bail!("unsupported AI client"),
        }
    }

    fn receipt_path(&self, client: &str) -> Result<PathBuf> {
        validate_client(client)?;
        Ok(self.state.join(format!("{client}-receipt.json")))
    }

    fn journal_path(&self, client: &str) -> Result<PathBuf> {
        validate_client(client)?;
        Ok(self.state.join(format!("{client}-journal.json")))
    }
}

fn read_saved_credential(path: &Path) -> Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.nlink() != 1
        || metadata.permissions().mode() & 0o077 != 0
    {
        bail!("saved CLIProxy credential is not a private regular file");
    }
    state::read_bytes(path, 4096)
}

struct CliProxyClient {
    client: Client,
    models_url: Url,
}

impl CliProxyClient {
    fn new(base_url: &str) -> Result<Self> {
        let base = validate_base_url(base_url)?;
        let models_url = base
            .join("models")
            .context("construct CLIProxy model URL")?;
        let client = Client::builder()
            .https_only(true)
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(15))
            .build()?;
        Ok(Self { client, models_url })
    }

    async fn models(&self, key: &[u8]) -> Result<Vec<String>> {
        let key = std::str::from_utf8(key).context("CLIProxy credential is not UTF-8")?;
        let mut response = self
            .client
            .get(self.models_url.clone())
            .bearer_auth(key)
            .send()
            .await
            .context("CLIProxy model request failed")?
            .error_for_status()
            .context("CLIProxy model request returned an error")?;
        if response
            .content_length()
            .is_some_and(|length| length > MAX_MODEL_RESPONSE_BYTES as u64)
        {
            bail!("CLIProxy model response exceeds 4 MiB");
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if bytes
                .len()
                .checked_add(chunk.len())
                .is_none_or(|length| length > MAX_MODEL_RESPONSE_BYTES)
            {
                bail!("CLIProxy model response exceeds 4 MiB");
            }
            bytes.extend_from_slice(&chunk);
        }
        parse_models(&bytes)
    }
}

fn validate_base_url(value: &str) -> Result<Url> {
    let mut url = Url::parse(value).context("invalid CLIProxy URL")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path().trim_end_matches('/') != "/v1"
    {
        bail!("CLIProxy URL must be an HTTPS /v1 endpoint without credentials, query, or fragment");
    }
    url.set_path("/v1/");
    Ok(url)
}

pub fn parse_models(bytes: &[u8]) -> Result<Vec<String>> {
    let value: Value = serde_json::from_slice(bytes).context("invalid CLIProxy model response")?;
    let candidates: Vec<&Value> = match &value {
        Value::Array(items) => items.iter().collect(),
        Value::Object(root) => match root.get("data").or_else(|| root.get("models")) {
            Some(Value::Array(items)) => items.iter().collect(),
            Some(Value::Object(items)) => {
                let mut seen = HashSet::new();
                let mut models = items
                    .keys()
                    .filter(|name| valid_model_id(name) && seen.insert(name.to_ascii_lowercase()))
                    .cloned()
                    .collect::<Vec<_>>();
                if models.is_empty() {
                    bail!("CLIProxy returned no valid model identifiers");
                }
                models.sort();
                return Ok(models);
            }
            _ => bail!("CLIProxy model response has an unsupported shape"),
        },
        _ => bail!("CLIProxy model response has an unsupported shape"),
    };
    let mut seen = HashSet::new();
    let mut models = Vec::new();
    for candidate in candidates {
        let Some(id) = candidate.as_str().or_else(|| {
            candidate.as_object().and_then(|item| {
                MODEL_FIELDS
                    .iter()
                    .find_map(|field| item.get(*field)?.as_str())
            })
        }) else {
            continue;
        };
        if valid_model_id(id) && seen.insert(id.to_ascii_lowercase()) {
            models.push(id.to_owned());
        }
    }
    if models.is_empty() {
        bail!("CLIProxy returned no valid model identifiers");
    }
    Ok(models)
}

fn valid_model_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value.trim() == value
        && value.bytes().all(|byte| byte.is_ascii_graphic())
}

fn usable_cache(cache: Option<ModelCache>, base_url: &str, selected: &str) -> Option<ModelCache> {
    cache.filter(|cache| {
        cache.version == 1
            && cache.base_url == base_url
            && !cache.models.is_empty()
            && cache.models.iter().all(|model| valid_model_id(model))
            && cache.models.iter().any(|model| model == selected)
    })
}

fn render_codex(
    old: Option<&[u8]>,
    previous: Option<&Receipt>,
    base_url: &str,
    model: &str,
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
    let (original_model, original_provider, original_catalog) = match previous {
        Some(receipt) => {
            validate_receipt(receipt, "codex")?;
            if current_model.as_deref() != Some(receipt.expected_model.as_str())
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
    document["model"] = value(model);
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
            expected_model: model.to_owned(),
            expected_base_url: base_url.to_owned(),
            expected_key_path: key_path,
            expected_catalog_path: Some(catalog_path),
            expected_models: models.to_vec(),
        },
    ))
}

fn restore_codex(old: Option<&[u8]>, receipt: &Receipt) -> Result<Vec<u8>> {
    validate_receipt(receipt, "codex")?;
    let text = std::str::from_utf8(old.context("managed Codex config is missing")?)
        .context("Codex config is not UTF-8")?;
    let mut document = text.parse::<DocumentMut>().context("invalid Codex TOML")?;
    let current_catalog = optional_toml_string(&document, "model_catalog_json")?;
    let provider = document
        .get("model_providers")
        .and_then(Item::as_table)
        .and_then(|table| table.get(PROVIDER_NAME));
    if optional_toml_string(&document, "model")?.as_deref() != Some(receipt.expected_model.as_str())
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

fn render_codex_catalog(models: &[String]) -> Result<Vec<u8>> {
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
                "default_reasoning_level": null,
                "supported_reasoning_levels": [],
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

fn render_opencode(
    old: Option<&[u8]>,
    previous: Option<&Receipt>,
    base_url: &str,
    model: &str,
    models: &[String],
    key_path: &Path,
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
    let original_model = match previous {
        Some(receipt) => {
            validate_receipt(receipt, "opencode")?;
            if current_model.as_deref()
                != Some(format!("{PROVIDER_NAME}/{}", receipt.expected_model).as_str())
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
    set_json_property(&object, "model", format!("{PROVIDER_NAME}/{model}").into());
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
                CstInputValue::Object(vec![("name".to_owned(), model.clone().into())]),
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
            expected_model: model.to_owned(),
            expected_base_url: base_url.to_owned(),
            expected_key_path: key_path,
            expected_catalog_path: None,
            expected_models: models.to_vec(),
        },
    ))
}

fn restore_opencode(old: Option<&[u8]>, receipt: &Receipt) -> Result<Vec<u8>> {
    validate_receipt(receipt, "opencode")?;
    let text = std::str::from_utf8(old.context("managed OpenCode config is missing")?)
        .context("OpenCode config is not UTF-8")?;
    let root =
        CstRootNode::parse(text, &ParseOptions::default()).context("invalid OpenCode JSONC")?;
    let object = root
        .object_value()
        .context("OpenCode config root must be an object")?;
    if optional_json_string(&object, "model")?.as_deref()
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
                    })
            })
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

fn validate_receipt(receipt: &Receipt, client: &str) -> Result<()> {
    if receipt.version != 1 || receipt.client != client {
        bail!("invalid AI client receipt");
    }
    Ok(())
}

fn validate_client(client: &str) -> Result<()> {
    if !matches!(client, "codex" | "opencode") {
        bail!("unsupported AI client");
    }
    Ok(())
}

fn config_is_empty(client: &str, bytes: &[u8]) -> Result<bool> {
    match client {
        "codex" => Ok(std::str::from_utf8(bytes)?
            .parse::<DocumentMut>()?
            .is_empty()),
        "opencode" => {
            let root = CstRootNode::parse(std::str::from_utf8(bytes)?, &ParseOptions::default())?;
            Ok(root
                .object_value()
                .is_some_and(|object| object.properties().is_empty()))
        }
        _ => bail!("unsupported AI client"),
    }
}

fn read_optional_config(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
        Ok(metadata)
            if metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.nlink() == 1
                && metadata.len() <= MAX_CLIENT_CONFIG_BYTES =>
        {
            let mut bytes = Vec::new();
            File::open(path)?
                .take(MAX_CLIENT_CONFIG_BYTES + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() as u64 > MAX_CLIENT_CONFIG_BYTES {
                bail!("AI client configuration exceeds 4 MiB");
            }
            Ok(Some(bytes))
        }
        Ok(_) => bail!("AI client configuration is not a safe regular file"),
    }
}

fn ensure_config_parent(home: &Path, path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .context("AI client configuration requires parent")?;
    let relative = parent
        .strip_prefix(home)
        .context("AI client configuration escaped home")?;
    let mut current = home.to_owned();
    for component in relative.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => bail!("AI client path contains a link or non-directory"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current)?;
                fs::set_permissions(&current, fs::Permissions::from_mode(0o700))?;
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn write_config(path: &Path, expected: Option<&[u8]>, bytes: &[u8]) -> Result<()> {
    if read_optional_config(path)?.as_deref() != expected {
        bail!("AI client configuration changed concurrently");
    }
    let parent = path.parent().unwrap();
    let temporary = parent.join(format!(".fleet-write-{}", Uuid::new_v4()));
    let mode = fs::metadata(path)
        .map(|metadata| metadata.permissions().mode() & 0o777)
        .unwrap_or(0o600);
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn remove_config(path: &Path, expected: Option<&[u8]>) -> Result<()> {
    if read_optional_config(path)?.as_deref() != expected {
        bail!("AI client configuration changed concurrently");
    }
    if expected.is_some() {
        fs::remove_file(path)?;
        File::open(path.parent().unwrap())?.sync_all()?;
    }
    Ok(())
}

fn config_digest(bytes: Option<&[u8]>) -> String {
    match bytes {
        Some(bytes) => format!("sha256:{:x}", Sha256::digest(bytes)),
        None => "missing".to_owned(),
    }
}

fn remove_state_file(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => {
            File::open(path.parent().unwrap())?.sync_all()?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn temp_root() -> PathBuf {
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("fleet-ai-client-test-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        root
    }

    fn disk_reconciler(root: &Path) -> Reconciler {
        let home = root.join("home");
        let state_root = root.join("state");
        fs::create_dir(&home).unwrap();
        fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
        Reconciler::new(&home, state_root).unwrap()
    }

    #[test]
    fn model_catalog_accepts_supported_shapes_and_deduplicates_ids() {
        let models = parse_models(
            br#"{"data":[{"id":"gpt-6-astra"},{"slug":"GPT-6-ASTRA"},{"model":"gpt-5.6-sol"}]}"#,
        )
        .unwrap();
        assert_eq!(models, ["gpt-6-astra", "gpt-5.6-sol"]);
        assert_eq!(
            parse_models(br#"[{"name":"one"},{"value":"two"}]"#).unwrap(),
            ["one", "two"]
        );
        assert_eq!(
            parse_models(br#"{"models":{"Two":{},"two":{},"one":{}}}"#)
                .unwrap()
                .len(),
            2
        );
        assert!(parse_models(br#"{"models":[]}"#).is_err());
        assert!(parse_models(br#"{"data":[{"id":"bad\nmodel"}]}"#).is_err());
    }

    #[test]
    fn url_and_cache_validation_fail_closed() {
        for url in [
            "http://proxy.example/v1",
            "https://user:secret@proxy.example/v1",
            "https://proxy.example/v1?key=secret",
            "https://proxy.example/not-v1",
        ] {
            assert!(validate_base_url(url).is_err(), "accepted {url}");
        }
        let cache = ModelCache {
            version: 1,
            base_url: "https://proxy.example/v1".to_owned(),
            models: vec!["gpt-6-astra".to_owned()],
        };
        assert!(
            usable_cache(
                Some(cache.clone()),
                "https://proxy.example/v1",
                "gpt-6-astra"
            )
            .is_some()
        );
        assert!(
            usable_cache(
                Some(cache.clone()),
                "https://other.example/v1",
                "gpt-6-astra"
            )
            .is_none()
        );
        assert!(usable_cache(Some(cache), "https://proxy.example/v1", "missing-model").is_none());
    }

    #[test]
    fn codex_apply_restart_and_native_restore_preserve_unowned_content() {
        let root = temp_root();
        let reconciler = disk_reconciler(&root);
        let codex_home = reconciler.home.join(".codex");
        fs::create_dir(&codex_home).unwrap();
        let config_path = codex_home.join("config.toml");
        let auth_path = codex_home.join("auth.json");
        let original = "# keep me\napproval_policy = \"never\"\nmodel = \"native-model\"\nmodel_provider = \"native-provider\"\nmodel_catalog_json = \"/native/catalog.json\"\n";
        fs::write(&config_path, original).unwrap();
        fs::write(&auth_path, b"oauth-secret").unwrap();
        let initial_models = ["gpt-6-astra".to_owned(), "gpt-5.6-sol".to_owned()];

        reconciler
            .apply_proxy(
                "codex",
                "https://proxy.example/v1",
                "gpt-6-astra",
                &initial_models,
            )
            .unwrap();
        let applied = fs::read(&config_path).unwrap();
        let config = String::from_utf8(applied.clone()).unwrap();
        let catalog_path = reconciler.state.join("codex-model-catalog.json");
        assert!(config.contains(&format!(
            "model_catalog_json = {:?}",
            catalog_path.to_str().unwrap()
        )));
        let catalog: Value = serde_json::from_slice(&fs::read(&catalog_path).unwrap()).unwrap();
        assert_eq!(catalog["models"].as_array().unwrap().len(), 2);
        assert_eq!(catalog["models"][0]["slug"], "gpt-6-astra");
        assert_eq!(catalog["models"][0]["shell_type"], "unified_exec");
        assert_eq!(catalog["models"][0]["visibility"], "list");
        assert_eq!(catalog["models"][0]["supported_in_api"], true);
        assert_eq!(fs::read(&auth_path).unwrap(), b"oauth-secret");

        reconciler
            .apply_proxy(
                "codex",
                "https://proxy.example/v1",
                "gpt-6-astra",
                &initial_models,
            )
            .unwrap();
        assert_eq!(fs::read(&config_path).unwrap(), applied);

        let refreshed_models = ["gpt-6-astra".to_owned(), "gpt-6-mini".to_owned()];
        reconciler
            .apply_proxy(
                "codex",
                "https://proxy.example/v1",
                "gpt-6-astra",
                &refreshed_models,
            )
            .unwrap();
        let refreshed: Value = serde_json::from_slice(&fs::read(&catalog_path).unwrap()).unwrap();
        assert_eq!(refreshed["models"][1]["slug"], "gpt-6-mini");

        reconciler.restore_native("codex").unwrap();
        let restored = String::from_utf8(fs::read(&config_path).unwrap()).unwrap();
        assert!(restored.contains("# keep me"));
        assert!(restored.contains("approval_policy = \"never\""));
        assert!(restored.contains("model = \"native-model\""));
        assert!(restored.contains("model_provider = \"native-provider\""));
        assert!(restored.contains("model_catalog_json = \"/native/catalog.json\""));
        assert!(!restored.contains(PROVIDER_NAME));
        assert!(!catalog_path.exists());
        assert_eq!(fs::read(&auth_path).unwrap(), b"oauth-secret");
        assert!(!config.contains("secret"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn opencode_apply_and_native_restore_preserve_comments_and_credentials() {
        let root = temp_root();
        let key = root.join("state/api-key");
        let original = br#"{
  // keep me
  "theme": "dark",
  "model": "native/model",
  "provider": { "other": { "name": "Other" } }
}
"#;
        let models = vec!["gpt-6-astra".to_owned(), "gpt-5.6-sol".to_owned()];
        let (applied, receipt) = render_opencode(
            Some(original),
            None,
            "https://proxy.example/v1",
            "gpt-6-astra",
            &models,
            &key,
        )
        .unwrap();
        let (restarted, _) = render_opencode(
            Some(&applied),
            Some(&receipt),
            "https://proxy.example/v1",
            "gpt-6-astra",
            &models,
            &key,
        )
        .unwrap();
        assert_eq!(applied, restarted);
        let restored =
            String::from_utf8(restore_opencode(Some(&applied), &receipt).unwrap()).unwrap();
        assert!(restored.contains("// keep me"));
        assert!(restored.contains("\"theme\": \"dark\""));
        assert!(restored.contains("\"other\""));
        assert!(restored.contains("\"model\": \"native/model\""));
        assert!(!restored.contains(PROVIDER_NAME));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn disk_transaction_rejects_drift_and_never_touches_oauth_files() {
        let root = temp_root();
        let reconciler = disk_reconciler(&root);
        let auth = reconciler.home.join(".codex/auth.json");
        fs::create_dir(reconciler.home.join(".codex")).unwrap();
        fs::write(&auth, b"oauth-secret").unwrap();
        reconciler
            .apply_proxy(
                "codex",
                "https://proxy.example/v1",
                "gpt-6-astra",
                &["gpt-6-astra".to_owned()],
            )
            .unwrap();
        let config_path = reconciler.config_path("codex").unwrap();
        let config = String::from_utf8(fs::read(&config_path).unwrap()).unwrap();
        assert!(config.contains("command = \"/bin/cat\""));
        assert!(!config.contains("oauth-secret"));
        assert_eq!(fs::read(&auth).unwrap(), b"oauth-secret");
        assert_eq!(
            fs::metadata(&config_path).unwrap().permissions().mode() & 0o077,
            0
        );

        fs::write(
            &config_path,
            config.replace("model = \"gpt-6-astra\"", "model = \"local-drift\""),
        )
        .unwrap();
        assert!(
            reconciler
                .apply_proxy(
                    "codex",
                    "https://proxy.example/v1",
                    "gpt-6-astra",
                    &["gpt-6-astra".to_owned()],
                )
                .is_err()
        );
        assert_eq!(fs::read(&auth).unwrap(), b"oauth-secret");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_finishes_receipt_after_config_commit() {
        let root = temp_root();
        let reconciler = disk_reconciler(&root);
        reconciler
            .apply_proxy(
                "opencode",
                "https://proxy.example/v1",
                "gpt-6-astra",
                &["gpt-6-astra".to_owned()],
            )
            .unwrap();
        let receipt_path = reconciler.receipt_path("opencode").unwrap();
        let receipt = state::read_json::<Receipt>(&receipt_path).unwrap().unwrap();
        let config_path = reconciler.config_path("opencode").unwrap();
        let config = read_optional_config(&config_path).unwrap().unwrap();
        remove_state_file(&receipt_path).unwrap();
        state::write_json(
            &reconciler.journal_path("opencode").unwrap(),
            &Journal {
                version: 1,
                config_path,
                old_digest: "missing".to_owned(),
                new_digest: config_digest(Some(&config)),
                receipt: Some(receipt),
            },
        )
        .unwrap();
        reconciler.recover("opencode").unwrap();
        assert!(receipt_path.exists());
        assert!(!reconciler.journal_path("opencode").unwrap().exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn configuration_links_are_rejected() {
        let root = temp_root();
        let reconciler = disk_reconciler(&root);
        fs::create_dir(reconciler.home.join(".codex")).unwrap();
        let outside = root.join("outside.toml");
        fs::write(&outside, b"").unwrap();
        symlink(&outside, reconciler.config_path("codex").unwrap()).unwrap();
        assert!(
            reconciler
                .apply_proxy(
                    "codex",
                    "https://proxy.example/v1",
                    "gpt-6-astra",
                    &["gpt-6-astra".to_owned()],
                )
                .is_err()
        );
        assert!(fs::read(&outside).unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
