mod adapters;
mod catalog;
mod config_file;

use crate::{
    protocol::{AiClientAssignment, Api},
    state,
};
use anyhow::{Context, Result, bail};
use fleet_reconcile::Step;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
};

use adapters::Adapter;
use catalog::{
    MAX_MODEL_RESPONSE_BYTES, parse_server_catalog, select_model, usable_cache, valid_model_id,
    validate_base_url,
};
use config_file::{
    config_digest, ensure_config_parent, read_optional_config, remove_config, remove_state_file,
    write_config,
};

const PROVIDER_NAME: &str = "fleet-cliproxy";

/// Whether `client` is a supported AI client whose Target is `target_path`
/// in the home directory.
pub fn supports(client: &str, target_path: &str) -> bool {
    Adapter::find(client).is_ok_and(|adapter| adapter.target_path() == target_path)
}

pub struct Reconciler {
    home: PathBuf,
    state: PathBuf,
}

/// A failed reconciliation with the phase it failed in and, for failures about
/// the client's own configuration, that file relative to the home directory.
#[derive(Debug)]
pub struct ReconcileFailure {
    pub error: anyhow::Error,
    pub step: Step,
    pub config_path: Option<PathBuf>,
}

impl ReconcileFailure {
    fn new(error: anyhow::Error, step: Step, config_path: Option<PathBuf>) -> Self {
        Self {
            error,
            step,
            config_path,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelCache {
    version: u8,
    base_url: String,
    models: Vec<String>,
    #[serde(default)]
    reasoning_levels: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    context_limits: BTreeMap<String, ContextLimits>,
    #[serde(default = "default_skip_claude_models")]
    skip_claude_models_for_other_clients: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_routing: Option<catalog::ClientRouting>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContextLimits {
    context_window: Option<i64>,
    max_context_window: Option<i64>,
    auto_compact_token_limit: Option<i64>,
}

fn default_skip_claude_models() -> bool {
    true
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
    #[serde(default)]
    automatic_model: bool,
    expected_base_url: String,
    expected_key_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_catalog_path: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    expected_models: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    expected_reasoning_levels: BTreeMap<String, Vec<String>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    original_settings: BTreeMap<String, Option<serde_json::Value>>,
}

impl Receipt {
    /// A receipt for Fleet settings found without one. The adapters fill in
    /// the original settings; the expected ones are unknown and unused.
    fn orphan(client: &str) -> Self {
        Self {
            version: 1,
            client: client.to_owned(),
            config_existed: true,
            original_model: None,
            original_provider: None,
            original_catalog: None,
            expected_model: String::new(),
            automatic_model: true,
            expected_base_url: String::new(),
            expected_key_path: String::new(),
            expected_catalog_path: None,
            expected_models: Vec::new(),
            expected_reasoning_levels: BTreeMap::new(),
            original_settings: BTreeMap::new(),
        }
    }
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

    /// Applies the assignment. Returns the config file, relative to the home
    /// directory, when Fleet-owned settings in it had been changed outside
    /// Fleet and were repaired.
    pub async fn reconcile(
        &self,
        api: &Api,
        assignment: &AiClientAssignment,
    ) -> std::result::Result<Option<PathBuf>, ReconcileFailure> {
        let config_path = self.relative_config_path(&assignment.client);
        let configure = |error| ReconcileFailure::new(error, Step::Configure, config_path.clone());
        self.validate_assignment(assignment)
            .map_err(|error| ReconcileFailure::new(error, Step::Validate, None))?;
        self.recover(&assignment.client)
            .map_err(|error| ReconcileFailure::new(error, Step::Recover, config_path.clone()))?;
        match assignment.mode.as_str() {
            "native" => self
                .restore_native(&assignment.client)
                .map(|()| None)
                .map_err(configure),
            "cliproxy" => {
                let base_url = assignment
                    .base_url
                    .as_deref()
                    .context("missing CLIProxy URL")
                    .map_err(|error| ReconcileFailure::new(error, Step::Validate, None))?;
                let model = assignment.model.as_deref();
                let fetch = |error| ReconcileFailure::new(error, Step::Download, None);
                self.credential(api).await.map_err(fetch)?;
                let cache = self.models(api, base_url, model).await.map_err(fetch)?;
                let drifted = self
                    .apply_proxy(&assignment.client, base_url, model, &cache)
                    .map_err(configure)?;
                Ok(config_path.clone().filter(|_| drifted))
            }
            _ => Err(ReconcileFailure::new(
                anyhow::anyhow!("unsupported AI client mode"),
                Step::Validate,
                None,
            )),
        }
    }

    /// The managed client configuration file, relative to the home directory.
    fn relative_config_path(&self, client: &str) -> Option<PathBuf> {
        self.config_path(client)
            .ok()?
            .strip_prefix(&self.home)
            .ok()
            .map(Path::to_owned)
    }

    fn validate_assignment(&self, assignment: &AiClientAssignment) -> Result<()> {
        if assignment.schema != "fleet.ai-client/v1" || Adapter::find(&assignment.client).is_err() {
            bail!("unsupported AI client assignment");
        }
        match assignment.mode.as_str() {
            "native" if assignment.base_url.is_none() && assignment.model.is_none() => Ok(()),
            "cliproxy"
                if assignment.base_url.is_some()
                    && assignment.model.as_deref().is_none_or(valid_model_id) =>
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

    /// The model catalog for `base_url`: fetched and saved, or else the saved
    /// one when it is usable. It is the one `apply_proxy` renders from.
    async fn models(
        &self,
        api: &Api,
        base_url: &str,
        selected: Option<&str>,
    ) -> Result<ModelCache> {
        // Older Agents strictly parse models.json, including after a rollback.
        let cache_path = self.state.join("models-routed.json");
        let cached = match state::read_json::<ModelCache>(&cache_path)? {
            Some(cache) => Some(cache),
            None => state::read_json(&self.state.join("models.json"))?,
        };
        let fetched = async {
            let bytes = api.cliproxy_models().await?;
            parse_server_catalog(&bytes, base_url)
        }
        .await;
        match fetched {
            Ok(cache)
                if selected
                    .is_none_or(|selected| cache.models.iter().any(|model| model == selected)) =>
            {
                state::write_json(&cache_path, &cache)?;
                Ok(cache)
            }
            // Do not fall back to a model removed from a fresh routed catalog.
            Ok(cache) if cache.client_routing.is_some() => {
                state::write_json(&cache_path, &cache)?;
                bail!("selected model is not advertised by CLIProxy");
            }
            result => {
                if let Some(cache) = usable_cache(cached, base_url, selected) {
                    eprintln!("CLIProxy model refresh failed; using the saved model catalog");
                    return Ok(cache);
                }
                match result {
                    Ok(_) => bail!("selected model is not advertised by CLIProxy"),
                    Err(error) => Err(error).context("fetch CLIProxy model catalog from Server"),
                }
            }
        }
    }

    /// Writes the Fleet settings. The Server assignment wins: Fleet-owned
    /// settings changed or removed outside Fleet, or a deleted config file,
    /// are repaired, and the original settings in the receipt are kept.
    /// Returns whether such a repair happened.
    ///
    /// Without a receipt (for example after the state directory was wiped and
    /// the Node enrolled again), Fleet takes over a `fleet-cliproxy` provider
    /// it finds, but never records Fleet's own leftover values as the
    /// originals: native mode then removes them instead of restoring them.
    fn apply_proxy(
        &self,
        client: &str,
        base_url: &str,
        model: Option<&str>,
        cache: &ModelCache,
    ) -> Result<bool> {
        let adapter = Adapter::find(client)?;
        let path = adapter.config_path(self);
        adapter.check_managed_file(self, &path)?;
        let old = read_optional_config(&path)?;
        let previous = state::read_json::<Receipt>(&self.receipt_path(client)?)?;
        let rendered = adapter.apply_proxy(
            self,
            old.as_deref(),
            previous.as_ref(),
            base_url,
            model,
            cache,
        )?;
        let drifted = rendered.drifted && old.as_deref() != Some(rendered.bytes.as_slice());
        self.commit(
            client,
            &path,
            old.as_deref(),
            Some(&rendered.bytes),
            Some(rendered.receipt),
        )?;
        Ok(drifted)
    }

    /// Restores the original settings and removes whatever is left of the
    /// Fleet ones, even when they were changed or removed outside Fleet or the
    /// file is gone. Without a receipt, Fleet settings found in the file are
    /// removed and everything else is kept.
    fn restore_native(&self, client: &str) -> Result<()> {
        let adapter = Adapter::find(client)?;
        let path = adapter.config_path(self);
        let receipt = match state::read_json::<Receipt>(&self.receipt_path(client)?)? {
            Some(receipt) => receipt,
            // Native mode never required a readable config. If it cannot be
            // read safely (a link, a parse error), Fleet cannot have left
            // settings there it could remove, so this stays a no-op.
            None => match self.orphan_receipt(adapter, &path).ok().flatten() {
                Some(receipt) => receipt,
                None => {
                    adapter.remove_auxiliary_state(self)?;
                    return Ok(());
                }
            },
        };
        adapter.check_managed_file(self, &path)?;
        let old = read_optional_config(&path)?;
        let restored = adapter.restore(old.as_deref(), &receipt)?;
        // A file that did not exist, or that was deleted since, is not
        // created again just to hold nothing.
        let new =
            if (!receipt.config_existed || old.is_none()) && adapter.config_is_empty(&restored)? {
                None
            } else {
                Some(restored.as_slice())
            };
        self.commit(client, &path, old.as_deref(), new, None)?;
        adapter.remove_auxiliary_state(self)?;
        Ok(())
    }

    fn orphan_receipt(&self, adapter: Adapter, path: &Path) -> Result<Option<Receipt>> {
        adapter.check_managed_file(self, path)?;
        adapter.orphan_receipt(self, read_optional_config(path)?.as_deref())
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
        Ok(Adapter::find(client)?.config_path(self))
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

fn validate_receipt(receipt: &Receipt, client: &str) -> Result<()> {
    if receipt.version != 1 || receipt.client != client {
        bail!("invalid AI client receipt");
    }
    Ok(())
}

fn validate_client(client: &str) -> Result<()> {
    Adapter::find(client).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::os::unix::fs::symlink;
    use uuid::Uuid;

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
    fn codex_catalog_preserves_context_limits_through_cache_and_refresh() {
        let root = temp_root();
        let reconciler = disk_reconciler(&root);
        let base_url = "https://proxy.example/v1";
        let bytes = br#"{"baseUrl":"https://proxy.example/v1","models":[
            {"id":"gpt-6.1-sol","reasoningLevels":["medium","xhigh"],"contextWindow":272000,"maxContextWindow":872000,"autoCompactTokenLimit":null},
            {"id":"explicit-limit","reasoningLevels":[],"contextWindow":128000,"autoCompactTokenLimit":100000},
            {"id":"max-only","reasoningLevels":[],"maxContextWindow":64000},
            {"id":"legacy","reasoningLevels":[]}
        ]}"#;
        let cache = parse_server_catalog(bytes, base_url).unwrap();
        let cache_path = reconciler.state.join("models.json");
        state::write_json(&cache_path, &cache).unwrap();
        let cached = usable_cache(state::read_json(&cache_path).unwrap(), base_url, None).unwrap();
        reconciler
            .apply_proxy("codex", base_url, None, &cached)
            .unwrap();
        let catalog_path = reconciler.state.join("codex-model-catalog.json");
        let catalog: Value = serde_json::from_slice(&fs::read(&catalog_path).unwrap()).unwrap();
        assert_eq!(catalog["models"][0]["context_window"], 272000);
        assert_eq!(catalog["models"][0]["max_context_window"], 872000);
        assert!(catalog["models"][0]["auto_compact_token_limit"].is_null());
        assert_eq!(catalog["models"][1]["context_window"], 128000);
        assert_eq!(catalog["models"][1]["auto_compact_token_limit"], 100000);
        assert!(catalog["models"][2]["context_window"].is_null());
        assert_eq!(catalog["models"][2]["max_context_window"], 64000);
        assert!(catalog["models"][3]["context_window"].is_null());
        assert!(catalog["models"][3]["max_context_window"].is_null());
        assert!(catalog["models"][3]["auto_compact_token_limit"].is_null());

        let refreshed = parse_server_catalog(
            &String::from_utf8(bytes.to_vec())
                .unwrap()
                .replace("272000", "256000")
                .into_bytes(),
            base_url,
        )
        .unwrap();
        state::write_json(&cache_path, &refreshed).unwrap();
        reconciler
            .apply_proxy("codex", base_url, None, &refreshed)
            .unwrap();
        let updated: Value = serde_json::from_slice(&fs::read(&catalog_path).unwrap()).unwrap();
        assert_eq!(updated["models"][0]["context_window"], 256000);

        let mut invalid = refreshed.clone();
        invalid
            .context_limits
            .get_mut("gpt-6.1-sol")
            .unwrap()
            .context_window = Some(0);
        state::write_json(&cache_path, &invalid).unwrap();
        let previous_catalog = fs::read(&catalog_path).unwrap();
        assert!(
            reconciler
                .apply_proxy("codex", base_url, None, &invalid)
                .is_err()
        );
        assert_eq!(fs::read(&catalog_path).unwrap(), previous_catalog);

        let mut other_endpoint = refreshed.clone();
        other_endpoint.base_url = "https://other.example/v1".to_owned();
        state::write_json(&cache_path, &other_endpoint).unwrap();
        reconciler
            .apply_proxy("codex", base_url, None, &other_endpoint)
            .unwrap();
        let isolated: Value = serde_json::from_slice(&fs::read(&catalog_path).unwrap()).unwrap();
        assert!(isolated["models"][0]["context_window"].is_null());
        reconciler.restore_native("codex").unwrap();
        assert!(!catalog_path.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn automatic_catalog_refresh_keeps_local_selection_and_restores_native() {
        for client in ["codex", "opencode"] {
            let root = temp_root();
            let reconciler = disk_reconciler(&root);
            let base_url = "https://proxy.example/v1";
            let cache = parse_server_catalog(br#"{"baseUrl":"https://proxy.example/v1","models":[{"id":"one","reasoningLevels":["low","high"]},{"id":"two","reasoningLevels":[]}]}"#, base_url).unwrap();
            state::write_json(&reconciler.state.join("models.json"), &cache).unwrap();
            reconciler
                .apply_proxy(client, base_url, None, &cache)
                .unwrap();
            let path = reconciler.config_path(client).unwrap();
            let original = fs::read_to_string(&path).unwrap();
            let changed = if client == "codex" {
                let catalog: Value = serde_json::from_slice(
                    &fs::read(reconciler.state.join("codex-model-catalog.json")).unwrap(),
                )
                .unwrap();
                assert_eq!(
                    catalog["models"][0]["supported_reasoning_levels"][1]["effort"],
                    "high"
                );
                original.replace("model = \"one\"", "model = \"two\"")
            } else {
                assert!(original.contains("reasoningEffort"));
                original.replace("fleet-cliproxy/one", "fleet-cliproxy/two")
            };
            fs::write(&path, &changed).unwrap();
            reconciler
                .apply_proxy(client, base_url, None, &cache)
                .unwrap();
            assert_eq!(fs::read_to_string(&path).unwrap(), changed);
            let mut refreshed = cache.clone();
            refreshed
                .reasoning_levels
                .insert("one".to_owned(), vec!["medium".to_owned()]);
            state::write_json(&reconciler.state.join("models.json"), &refreshed).unwrap();
            reconciler
                .apply_proxy(client, base_url, None, &refreshed)
                .unwrap();
            reconciler.restore_native(client).unwrap();
            assert!(!path.exists());
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn removing_proxy_restores_existing_native_auth_for_all_clients() {
        for client in ["codex", "opencode", "claude"] {
            let root = temp_root();
            let reconciler = disk_reconciler(&root);
            let (config_path, auth_path, native_config) = if client == "codex" {
                let directory = reconciler.home.join(".codex");
                fs::create_dir_all(&directory).unwrap();
                (
                    directory.join("config.toml"),
                    directory.join("auth.json"),
                    "# native Codex login\nmodel = \"gpt-6-sol\"\n",
                )
            } else if client == "claude" {
                let directory = reconciler.home.join(".claude");
                fs::create_dir_all(&directory).unwrap();
                (
                    directory.join("settings.json"),
                    directory.join(".credentials.json"),
                    "{\"model\":\"gpt-6-sol\",\"permissions\":{\"allow\":[]}}\n",
                )
            } else {
                let directory = reconciler.home.join(".config/opencode");
                let auth_directory = reconciler.home.join(".local/share/opencode");
                fs::create_dir_all(&directory).unwrap();
                fs::create_dir_all(&auth_directory).unwrap();
                (
                    directory.join("opencode.json"),
                    auth_directory.join("auth.json"),
                    "{\"model\":\"openai/gpt-6-sol\"}\n",
                )
            };
            let native_auth = b"{\"openai\":{\"token\":\"native-auth\"}}";
            fs::write(&config_path, native_config).unwrap();
            fs::write(&auth_path, native_auth).unwrap();
            reconciler
                .apply_proxy(
                    client,
                    "https://proxy.example/v1",
                    None,
                    &uncached(&["proxy-model".to_owned()]),
                )
                .unwrap();
            reconciler.restore_native(client).unwrap();
            let restored = fs::read_to_string(&config_path).unwrap();
            assert!(restored.contains("gpt-6-sol"));
            assert!(!restored.contains(PROVIDER_NAME));
            assert_eq!(fs::read(&auth_path).unwrap(), native_auth);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn claude_proxy_creates_settings_and_native_removes_them() {
        let root = temp_root();
        let reconciler = disk_reconciler(&root);
        reconciler
            .apply_proxy(
                "claude",
                "https://proxy.example/v1",
                None,
                &uncached(&["claude-one".to_owned()]),
            )
            .unwrap();
        let path = reconciler.config_path("claude").unwrap();
        assert_eq!(path, reconciler.home.join(".claude/settings.json"));
        let settings: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            settings["env"]["ANTHROPIC_BASE_URL"],
            "https://proxy.example"
        );
        reconciler.recover("claude").unwrap();
        reconciler.restore_native("claude").unwrap();
        assert!(!path.exists());
        assert!(!reconciler.receipt_path("claude").unwrap().exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn claude_models_are_filtered_from_other_client_catalogs() {
        let models = vec![
            "claude-one".to_owned(),
            "gpt-one".to_owned(),
            "ClAuDe-two".to_owned(),
        ];
        for client in ["codex", "opencode", "claude"] {
            let root = temp_root();
            let reconciler = disk_reconciler(&root);
            reconciler
                .apply_proxy(client, "https://proxy.example/v1", None, &uncached(&models))
                .unwrap();
            let receipt = state::read_json::<Receipt>(&reconciler.receipt_path(client).unwrap())
                .unwrap()
                .unwrap();
            if client == "claude" {
                assert_eq!(receipt.expected_models, models);
                assert_eq!(receipt.expected_model, "claude-one");
            } else {
                assert_eq!(receipt.expected_models, ["gpt-one"]);
                assert_eq!(receipt.expected_model, "gpt-one");
                let catalog_path = if client == "codex" {
                    reconciler.state.join("codex-model-catalog.json")
                } else {
                    reconciler.config_path(client).unwrap()
                };
                let catalog = fs::read_to_string(catalog_path).unwrap();
                assert!(!catalog.to_ascii_lowercase().contains("claude-"));
            }
            reconciler.restore_native(client).unwrap();
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn restricted_models_fail_without_changing_configuration_or_receipts() {
        for client in ["codex", "opencode"] {
            let root = temp_root();
            let reconciler = disk_reconciler(&root);
            reconciler
                .apply_proxy(
                    client,
                    "https://proxy.example/v1",
                    None,
                    &uncached(&["gpt-one".to_owned()]),
                )
                .unwrap();
            let path = reconciler.config_path(client).unwrap();
            let receipt_path = reconciler.receipt_path(client).unwrap();
            let config = fs::read(&path).unwrap();
            let receipt = fs::read(&receipt_path).unwrap();
            let catalog_path = reconciler.state.join("codex-model-catalog.json");
            let catalog = read_optional_config(&catalog_path).unwrap();
            for pinned in [None, Some("claude-one")] {
                assert!(
                    reconciler
                        .apply_proxy(
                            client,
                            "https://proxy.example/v1",
                            pinned,
                            &uncached(&["claude-one".to_owned()])
                        )
                        .is_err()
                );
            }
            assert!(
                reconciler
                    .apply_proxy(
                        client,
                        "https://proxy.example/v1",
                        Some("claude-one"),
                        &uncached(&["claude-one".to_owned(), "gpt-one".to_owned()])
                    )
                    .is_err()
            );
            assert_eq!(fs::read(&path).unwrap(), config);
            assert_eq!(fs::read(&receipt_path).unwrap(), receipt);
            assert_eq!(read_optional_config(&catalog_path).unwrap(), catalog);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn unchecked_restriction_allows_claude_models_and_cached_policy_survives_restart() {
        let base_url = "https://proxy.example/v1";
        let bytes = br#"{"baseUrl":"https://proxy.example/v1","skipClaudeModelsForOtherClients":false,"models":[{"id":"claude-one","reasoningLevels":[]},{"id":"gpt-one","reasoningLevels":[]}]}"#;
        for client in ["codex", "opencode"] {
            let root = temp_root();
            let reconciler = disk_reconciler(&root);
            let mut cache = parse_server_catalog(bytes, base_url).unwrap();
            assert!(!cache.skip_claude_models_for_other_clients);
            state::write_json(&reconciler.state.join("models.json"), &cache).unwrap();
            // Recreate the reconciler to use the persisted policy, as during offline fallback.
            let reconciler = Reconciler::new(&reconciler.home, root.join("state")).unwrap();
            reconciler
                .apply_proxy(client, base_url, None, &cache)
                .unwrap();
            let receipt_path = reconciler.receipt_path(client).unwrap();
            let receipt = state::read_json::<Receipt>(&receipt_path).unwrap().unwrap();
            assert_eq!(receipt.expected_model, "claude-one");
            assert_eq!(receipt.expected_models, cache.models);
            cache.skip_claude_models_for_other_clients = true;
            state::write_json(&reconciler.state.join("models.json"), &cache).unwrap();
            reconciler
                .apply_proxy(client, base_url, None, &cache)
                .unwrap();
            let receipt = state::read_json::<Receipt>(&receipt_path).unwrap().unwrap();
            assert_eq!(receipt.expected_model, "gpt-one");
            assert_eq!(receipt.expected_models, ["gpt-one"]);
            reconciler.restore_native(client).unwrap();
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn routed_catalog_filters_each_client_and_updates_the_claude_picker() {
        let root = temp_root();
        let reconciler = disk_reconciler(&root);
        let base_url = "https://proxy.example/v1";
        let models = ["gemini-one", "GpT-one", "ClAuDe-one"]
            .map(|id| serde_json::json!({ "id": id, "reasoningLevels": [] }));
        let mut response = serde_json::json!({
            "baseUrl": base_url,
            "clientRouting": { "claude": ["claude"], "gpt": ["codex", "opencode"], "other": ["opencode"] },
            "models": models,
        });
        let cache =
            parse_server_catalog(&serde_json::to_vec(&response).unwrap(), base_url).unwrap();
        let cache_path = reconciler.state.join("models.json");
        state::write_json(&cache_path, &cache).unwrap();
        let cached = usable_cache(state::read_json(&cache_path).unwrap(), base_url, None).unwrap();

        let path = reconciler.config_path("claude").unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let native = serde_json::json!({ "modelPicker": { "options": [{ "value": "native" }] } });
        fs::write(&path, serde_json::to_vec(&native).unwrap()).unwrap();
        for (client, models) in [
            ("claude", &["ClAuDe-one"][..]),
            ("codex", &["GpT-one"][..]),
            ("opencode", &["gemini-one", "GpT-one"][..]),
        ] {
            reconciler
                .apply_proxy(client, base_url, None, &cached)
                .unwrap();
            let receipt = state::read_json::<Receipt>(&reconciler.receipt_path(client).unwrap())
                .unwrap()
                .unwrap();
            assert_eq!(receipt.expected_models, models);
        }
        assert!(
            reconciler
                .apply_proxy("claude", base_url, Some("gemini-one"), &cached)
                .is_err()
        );
        assert_eq!(
            state::read_json::<Value>(&path).unwrap().unwrap()["modelPicker"]["options"],
            serde_json::json!([{ "value": "ClAuDe-one" }])
        );

        response["clientRouting"]["other"] = serde_json::json!(["claude", "opencode"]);
        let updated =
            parse_server_catalog(&serde_json::to_vec(&response).unwrap(), base_url).unwrap();
        reconciler
            .apply_proxy("claude", base_url, Some("gemini-one"), &updated)
            .unwrap();
        let settings = state::read_json::<Value>(&path).unwrap().unwrap();
        assert_eq!(settings["model"], "gemini-one");
        assert_eq!(
            settings["modelPicker"],
            serde_json::json!({
                "options": [{ "value": "gemini-one" }, { "value": "ClAuDe-one" }],
                "replaceBuiltInOptions": true,
            })
        );
        reconciler.restore_native("claude").unwrap();
        assert_eq!(state::read_json::<Value>(&path).unwrap().unwrap(), native);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn codex_apply_restart_and_native_restore_preserve_unowned_content() {
        let root = temp_root();
        let reconciler = disk_reconciler(&root);
        let codex_home = reconciler.home.join(".codex");
        fs::create_dir(&codex_home).unwrap();
        let config_path = codex_home.join("config.toml");
        let auth_path = codex_home.join("auth.json");
        let original = "# keep me\napproval_policy = \"never\"\nmodel_context_window = 272000\nmodel_auto_compact_token_limit = 200000\nmodel = \"native-model\"\nmodel_provider = \"native-provider\"\nmodel_catalog_json = \"/native/catalog.json\"\n";
        fs::write(&config_path, original).unwrap();
        fs::write(&auth_path, b"oauth-secret").unwrap();
        let initial_models = ["gpt-6-astra".to_owned(), "gpt-5.6-sol".to_owned()];

        reconciler
            .apply_proxy(
                "codex",
                "https://proxy.example/v1",
                Some("gpt-6-astra"),
                &uncached(&initial_models),
            )
            .unwrap();
        let applied = fs::read(&config_path).unwrap();
        let config = String::from_utf8(applied.clone()).unwrap();
        assert!(config.contains("model_context_window = 272000"));
        assert!(config.contains("model_auto_compact_token_limit = 200000"));
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

        // Upgrade the old Fleet command without losing the original native settings.
        fs::write(
            &config_path,
            config
                .replace("command = \"cat\"", "command = \"/bin/cat\"")
                .replace("requires_openai_auth = false\n", ""),
        )
        .unwrap();

        reconciler
            .apply_proxy(
                "codex",
                "https://proxy.example/v1",
                Some("gpt-6-astra"),
                &uncached(&initial_models),
            )
            .unwrap();
        assert_eq!(fs::read(&config_path).unwrap(), applied);

        let refreshed_models = ["gpt-6-astra".to_owned(), "gpt-6-mini".to_owned()];
        reconciler
            .apply_proxy(
                "codex",
                "https://proxy.example/v1",
                Some("gpt-6-astra"),
                &uncached(&refreshed_models),
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
    fn opencode_new_jsonc_does_not_transfer_existing_json_ownership() {
        let root = temp_root();
        let reconciler = disk_reconciler(&root);
        let models = ["one".to_owned()];
        reconciler
            .apply_proxy(
                "opencode",
                "https://proxy.example/v1",
                None,
                &uncached(&models),
            )
            .unwrap();
        let json = reconciler.config_path("opencode").unwrap();
        let managed = fs::read(&json).unwrap();
        let jsonc = json.with_extension("jsonc");
        let local = b"{\"model\":\"native/model\"}";
        fs::write(&jsonc, local).unwrap();
        assert!(
            reconciler
                .apply_proxy(
                    "opencode",
                    "https://proxy.example/v1",
                    None,
                    &uncached(&models)
                )
                .is_err()
        );
        assert!(reconciler.restore_native("opencode").is_err());
        assert_eq!(fs::read(&json).unwrap(), managed);
        assert_eq!(fs::read(&jsonc).unwrap(), local);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn opencode_updates_existing_jsonc_instead_of_shadowed_json() {
        let root = temp_root();
        let reconciler = disk_reconciler(&root);
        let directory = reconciler.home.join(".config/opencode");
        fs::create_dir_all(&directory).unwrap();
        let json = directory.join("opencode.json");
        let jsonc = directory.join("opencode.jsonc");
        let lower_priority = br#"{"model":"other/model"}"#;
        fs::write(&json, lower_priority).unwrap();
        fs::write(
            &jsonc,
            "{\n // keep my preferences\n \"model\": \"native/model\",\n \"theme\": \"dark\"\n}\n",
        )
        .unwrap();

        reconciler
            .apply_proxy(
                "opencode",
                "https://proxy.example/v1",
                None,
                &uncached(&["one".to_owned()]),
            )
            .unwrap();
        let applied = fs::read_to_string(&jsonc).unwrap();
        assert!(applied.contains("fleet-cliproxy/one"));
        assert!(applied.contains("// keep my preferences"));
        assert_eq!(fs::read(&json).unwrap(), lower_priority);

        reconciler
            .apply_proxy(
                "opencode",
                "https://proxy.example/v1",
                None,
                &uncached(&["two".to_owned()]),
            )
            .unwrap();
        assert!(
            fs::read_to_string(&jsonc)
                .unwrap()
                .contains("fleet-cliproxy/two")
        );
        reconciler.restore_native("opencode").unwrap();
        let restored = fs::read_to_string(&jsonc).unwrap();
        assert!(restored.contains("native/model"));
        assert!(restored.contains("// keep my preferences"));
        assert!(!restored.contains(PROVIDER_NAME));
        assert_eq!(fs::read(&json).unwrap(), lower_priority);
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
        let adapters::Rendered {
            bytes: applied,
            receipt,
            ..
        } = adapters::opencode::render_opencode(
            Some(original),
            None,
            "https://proxy.example/v1",
            Some("gpt-6-astra"),
            &models,
            &key,
            &BTreeMap::new(),
        )
        .unwrap();
        let restarted = adapters::opencode::render_opencode(
            Some(&applied),
            Some(&receipt),
            "https://proxy.example/v1",
            Some("gpt-6-astra"),
            &models,
            &key,
            &BTreeMap::new(),
        )
        .unwrap();
        assert!(!restarted.drifted);
        assert_eq!(applied, restarted.bytes);
        let restored = String::from_utf8(
            adapters::opencode::restore_opencode(Some(&applied), &receipt).unwrap(),
        )
        .unwrap();
        assert!(restored.contains("// keep me"));
        assert!(restored.contains("\"theme\": \"dark\""));
        assert!(restored.contains("\"other\""));
        assert!(restored.contains("\"model\": \"native/model\""));
        assert!(!restored.contains(PROVIDER_NAME));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn disk_transaction_repairs_drift_and_never_touches_oauth_files() {
        let root = temp_root();
        let reconciler = disk_reconciler(&root);
        let auth = reconciler.home.join(".codex/auth.json");
        fs::create_dir(reconciler.home.join(".codex")).unwrap();
        fs::write(&auth, b"oauth-secret").unwrap();
        reconciler
            .apply_proxy(
                "codex",
                "https://proxy.example/v1",
                Some("gpt-6-astra"),
                &uncached(&["gpt-6-astra".to_owned()]),
            )
            .unwrap();
        let config_path = reconciler.config_path("codex").unwrap();
        let config = String::from_utf8(fs::read(&config_path).unwrap()).unwrap();
        assert!(config.contains("command = \"cat\""));
        assert!(config.contains("requires_openai_auth = false"));
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
                    Some("gpt-6-astra"),
                    &uncached(&["gpt-6-astra".to_owned()]),
                )
                .unwrap()
        );
        assert_eq!(fs::read_to_string(&config_path).unwrap(), config);
        assert_eq!(fs::read(&auth).unwrap(), b"oauth-secret");
        fs::remove_dir_all(root).unwrap();
    }

    const PROXY: &str = "https://proxy.example/v1";

    /// The cache for `models` at [`PROXY`] without per-model metadata, as
    /// the adapters saw it before any catalog was cached.
    fn uncached(models: &[String]) -> ModelCache {
        ModelCache {
            version: 1,
            base_url: PROXY.to_owned(),
            models: models.to_vec(),
            reasoning_levels: BTreeMap::new(),
            context_limits: BTreeMap::new(),
            skip_claude_models_for_other_clients: true,
            client_routing: None,
        }
    }

    fn codex_models() -> Vec<String> {
        vec!["gpt-6-astra".to_owned(), "gpt-6-mini".to_owned()]
    }

    const NATIVE_CODEX: &str = "# keep me\napproval_policy = \"never\"\nmodel = \"native-model\"\nmodel_provider = \"native-provider\"\nmodel_catalog_json = \"/native/catalog.json\"\n\n[model_providers.native-provider]\nname = \"Native\"\n";

    /// A Codex config with Fleet's settings applied over [`NATIVE_CODEX`].
    fn codex_on_proxy() -> (PathBuf, Reconciler, PathBuf) {
        let root = temp_root();
        let reconciler = disk_reconciler(&root);
        fs::create_dir(reconciler.home.join(".codex")).unwrap();
        let path = reconciler.config_path("codex").unwrap();
        fs::write(&path, NATIVE_CODEX).unwrap();
        reconciler
            .apply_proxy(
                "codex",
                PROXY,
                Some("gpt-6-astra"),
                &uncached(&codex_models()),
            )
            .unwrap();
        (root, reconciler, path)
    }

    fn assert_native_codex(path: &Path) {
        let restored = fs::read_to_string(path).unwrap();
        assert!(restored.contains("# keep me"), "{restored}");
        assert!(
            restored.contains("approval_policy = \"never\""),
            "{restored}"
        );
        assert!(restored.contains("model = \"native-model\""), "{restored}");
        assert!(
            restored.contains("model_provider = \"native-provider\""),
            "{restored}"
        );
        assert!(
            restored.contains("model_catalog_json = \"/native/catalog.json\""),
            "{restored}"
        );
        assert!(
            restored.contains("[model_providers.native-provider]"),
            "{restored}"
        );
        assert!(!restored.contains(PROVIDER_NAME), "{restored}");
    }

    fn codex_receipt(reconciler: &Reconciler) -> Receipt {
        state::read_json::<Receipt>(&reconciler.receipt_path("codex").unwrap())
            .unwrap()
            .unwrap()
    }

    /// The node's case: on Oct 16 something outside Fleet selected the
    /// `openai` provider and removed Fleet's provider table.
    fn switch_codex_to_openai(path: &Path) {
        let mut document = adapters_test_document(path);
        document["model_provider"] = toml_edit::value("openai");
        document["model_providers"]
            .as_table_mut()
            .unwrap()
            .remove(PROVIDER_NAME);
        fs::write(path, document.to_string()).unwrap();
    }

    fn adapters_test_document(path: &Path) -> toml_edit::DocumentMut {
        fs::read_to_string(path).unwrap().parse().unwrap()
    }

    #[test]
    fn codex_external_model_change_is_repaired_and_native_restores_originals() {
        let (root, reconciler, path) = codex_on_proxy();
        let applied = fs::read_to_string(&path).unwrap();
        let original = codex_receipt(&reconciler);
        // Codex's own /model command writes `model`.
        fs::write(
            &path,
            applied.replace("model = \"gpt-6-astra\"", "model = \"gpt-6-mini\""),
        )
        .unwrap();
        assert!(
            reconciler
                .apply_proxy(
                    "codex",
                    PROXY,
                    Some("gpt-6-astra"),
                    &uncached(&codex_models())
                )
                .unwrap()
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), applied);
        let receipt = codex_receipt(&reconciler);
        assert_eq!(receipt.original_model.as_deref(), Some("native-model"));
        assert_eq!(receipt.original_provider, original.original_provider);
        assert_eq!(receipt.original_catalog, original.original_catalog);
        reconciler.restore_native("codex").unwrap();
        assert_native_codex(&path);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn codex_provider_removed_outside_fleet_recovers_for_every_assignment() {
        type Step = fn(&Reconciler) -> Result<bool>;
        let steps: [(&str, Step); 4] = [
            ("same settings", |r| {
                r.apply_proxy(
                    "codex",
                    PROXY,
                    Some("gpt-6-astra"),
                    &uncached(&codex_models()),
                )
            }),
            ("new model", |r| {
                r.apply_proxy(
                    "codex",
                    PROXY,
                    Some("gpt-6-mini"),
                    &uncached(&codex_models()),
                )
            }),
            ("automatic model", |r| {
                r.apply_proxy("codex", PROXY, None, &uncached(&codex_models()))
            }),
            ("native", |r| r.restore_native("codex").map(|()| true)),
        ];
        for (name, step) in steps {
            let (root, reconciler, path) = codex_on_proxy();
            switch_codex_to_openai(&path);
            assert!(step(&reconciler).unwrap(), "{name}");
            if name == "native" {
                assert_native_codex(&path);
                assert!(!reconciler.receipt_path("codex").unwrap().exists());
            } else {
                let document = adapters_test_document(&path);
                assert_eq!(document["model_provider"].as_str(), Some(PROVIDER_NAME));
                assert!(document["model_providers"][PROVIDER_NAME].is_table());
                assert!(document["model_providers"]["native-provider"].is_table());
                let receipt = codex_receipt(&reconciler);
                assert_eq!(
                    receipt.original_provider.as_deref(),
                    Some("native-provider")
                );
                reconciler.restore_native("codex").unwrap();
                assert_native_codex(&path);
            }
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn deleted_client_config_is_recreated_and_native_restore_succeeds() {
        for client in ["codex", "opencode", "claude"] {
            let root = temp_root();
            let reconciler = disk_reconciler(&root);
            let models = ["gpt-one".to_owned(), "claude-one".to_owned()];
            let model = if client == "claude" {
                "claude-one"
            } else {
                "gpt-one"
            };
            reconciler
                .apply_proxy(client, PROXY, Some(model), &uncached(&models))
                .unwrap();
            let path = reconciler.config_path(client).unwrap();
            let applied = fs::read(&path).unwrap();

            fs::remove_file(&path).unwrap();
            assert!(
                reconciler
                    .apply_proxy(client, PROXY, Some(model), &uncached(&models))
                    .unwrap(),
                "{client}"
            );
            assert_eq!(fs::read(&path).unwrap(), applied, "{client}");

            // Deleted again, then native: nothing to restore and nothing created.
            fs::remove_file(&path).unwrap();
            reconciler.restore_native(client).unwrap();
            assert!(!path.exists(), "{client}");
            assert!(!reconciler.receipt_path(client).unwrap().exists());
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn deleted_codex_config_with_native_originals_restores_them() {
        let (root, reconciler, path) = codex_on_proxy();
        fs::remove_file(&path).unwrap();
        reconciler.restore_native("codex").unwrap();
        let restored = adapters_test_document(&path);
        assert_eq!(restored["model"].as_str(), Some("native-model"));
        assert_eq!(restored["model_provider"].as_str(), Some("native-provider"));
        assert!(!fs::read_to_string(&path).unwrap().contains(PROVIDER_NAME));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lost_codex_receipt_takes_over_the_provider_without_recording_fleet_values() {
        // Proxy mode again after the state directory was wiped.
        let (root, reconciler, path) = codex_on_proxy();
        remove_state_file(&reconciler.receipt_path("codex").unwrap()).unwrap();
        reconciler
            .apply_proxy(
                "codex",
                PROXY,
                Some("gpt-6-mini"),
                &uncached(&codex_models()),
            )
            .unwrap();
        let receipt = codex_receipt(&reconciler);
        assert_eq!(receipt.original_model, None);
        assert_eq!(receipt.original_provider, None);
        assert_eq!(receipt.original_catalog, None);
        reconciler.restore_native("codex").unwrap();
        let restored = fs::read_to_string(&path).unwrap();
        assert!(!restored.contains(PROVIDER_NAME));
        assert!(!restored.contains("model = "));
        assert!(!restored.contains("model_catalog_json"));
        assert!(restored.contains("approval_policy = \"never\""));
        assert!(restored.contains("[model_providers.native-provider]"));

        // A leftover table next to the user's own provider keeps the user's.
        let (root2, reconciler, path) = codex_on_proxy();
        switch_codex_to_openai(&path);
        let mut document = adapters_test_document(&path);
        document["model_providers"][PROVIDER_NAME]["name"] = toml_edit::value("Fleet CLIProxy");
        fs::write(&path, document.to_string()).unwrap();
        remove_state_file(&reconciler.receipt_path("codex").unwrap()).unwrap();
        reconciler
            .apply_proxy("codex", PROXY, None, &uncached(&codex_models()))
            .unwrap();
        let receipt = codex_receipt(&reconciler);
        assert_eq!(receipt.original_provider.as_deref(), Some("openai"));
        assert_eq!(receipt.original_model.as_deref(), Some("gpt-6-astra"));
        reconciler.restore_native("codex").unwrap();
        let restored = adapters_test_document(&path);
        assert_eq!(restored["model_provider"].as_str(), Some("openai"));
        assert!(restored.get("model_catalog_json").is_none());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(root2).unwrap();
    }

    #[test]
    fn native_mode_without_a_receipt_removes_leftover_fleet_settings() {
        for client in ["codex", "opencode", "claude"] {
            let root = temp_root();
            let reconciler = disk_reconciler(&root);
            let path = reconciler.config_path(client).unwrap();
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let native: &[u8] = match client {
                "codex" => b"approval_policy = \"never\"\n",
                _ => b"{\"theme\":\"dark\"}",
            };
            fs::write(&path, native).unwrap();
            let models = ["gpt-one".to_owned(), "claude-one".to_owned()];
            let model = if client == "claude" {
                "claude-one"
            } else {
                "gpt-one"
            };
            reconciler
                .apply_proxy(client, PROXY, Some(model), &uncached(&models))
                .unwrap();
            remove_state_file(&reconciler.receipt_path(client).unwrap()).unwrap();
            reconciler.restore_native(client).unwrap();
            let restored = fs::read_to_string(&path).unwrap();
            assert!(!restored.contains(PROVIDER_NAME), "{client}: {restored}");
            assert!(!restored.contains("api-key"), "{client}: {restored}");
            assert!(!restored.contains(model), "{client}: {restored}");
            assert!(
                restored.contains("approval_policy") || restored.contains("dark"),
                "{client}: {restored}"
            );
            // Nothing Fleet-owned is left, so a second run changes nothing.
            reconciler.restore_native(client).unwrap();
            assert_eq!(fs::read_to_string(&path).unwrap(), restored);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn opencode_and_claude_external_changes_are_repaired_and_restored() {
        for client in ["opencode", "claude"] {
            let root = temp_root();
            let reconciler = disk_reconciler(&root);
            let path = reconciler.config_path(client).unwrap();
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let native = if client == "opencode" {
                "{\"model\":\"native/model\",\"theme\":\"dark\"}"
            } else {
                "{\"model\":\"native\",\"theme\":\"dark\"}"
            };
            fs::write(&path, native).unwrap();
            let models = ["one".to_owned(), "claude-one".to_owned()];
            let model = if client == "claude" {
                "claude-one"
            } else {
                "one"
            };
            reconciler
                .apply_proxy(client, PROXY, Some(model), &uncached(&models))
                .unwrap();
            // The user selects another model and Fleet's provider disappears.
            let mut value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            value["model"] = "other/model".into();
            value.as_object_mut().unwrap().remove("provider");
            value.as_object_mut().unwrap().remove("apiKeyHelper");
            fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
            assert!(
                reconciler
                    .apply_proxy(client, PROXY, Some(model), &uncached(&models))
                    .unwrap(),
                "{client}"
            );
            let repaired = fs::read_to_string(&path).unwrap();
            assert!(repaired.contains(model), "{client}: {repaired}");
            assert!(!repaired.contains("other/model"), "{client}: {repaired}");
            reconciler.restore_native(client).unwrap();
            let restored: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            assert_eq!(
                restored,
                serde_json::from_str::<Value>(native).unwrap(),
                "{client}"
            );
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn recovery_finishes_receipt_after_config_commit() {
        let root = temp_root();
        let reconciler = disk_reconciler(&root);
        reconciler
            .apply_proxy(
                "opencode",
                "https://proxy.example/v1",
                Some("gpt-6-astra"),
                &uncached(&["gpt-6-astra".to_owned()]),
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
                    Some("gpt-6-astra"),
                    &uncached(&["gpt-6-astra".to_owned()]),
                )
                .is_err()
        );
        assert!(fs::read(&outside).unwrap().is_empty());
        // Native mode without a receipt leaves a linked config alone, as before.
        fs::write(&outside, b"model_provider = \"fleet-cliproxy\"\n").unwrap();
        reconciler.restore_native("codex").unwrap();
        assert!(
            fs::symlink_metadata(reconciler.config_path("codex").unwrap())
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            fs::read(&outside).unwrap(),
            b"model_provider = \"fleet-cliproxy\"\n"
        );
        fs::remove_dir_all(root).unwrap();
    }

    const SECRET: &str = "SECRET-TOKEN-4f9c";

    fn chain(error: &anyhow::Error) -> String {
        format!("{error:#} / {error:?}")
    }

    #[test]
    fn config_parse_errors_never_quote_file_content() {
        let root = temp_root();
        let reconciler = disk_reconciler(&root);
        let models = ["m".to_owned()];
        let cases = [
            ("codex", format!("token = \"{SECRET}\" trailing garbage\n")),
            ("codex", format!("[a\nkey = '{SECRET}'\n")),
            ("claude", format!("{{\"apiKey\": \"{SECRET}\" \"oops\"}}")),
            ("claude", format!("{{\"apiKey\": \"{SECRET}")),
            ("opencode", format!("{{\"apiKey\": \"{SECRET}\" \"oops\"}}")),
            ("opencode", format!("{{\"apiKey\": '{SECRET}'")),
        ];
        for (client, content) in cases {
            let adapter = Adapter::find(client).unwrap();
            let error = adapter
                .apply_proxy(
                    &reconciler,
                    Some(content.as_bytes()),
                    None,
                    "https://proxy.example/v1",
                    None,
                    &uncached(&models),
                )
                .unwrap_err();
            let text = chain(&error);
            assert!(!text.contains(SECRET), "{client}: {text}");
            assert!(!text.contains("oops"), "{client}: {text}");
            assert!(text.contains("invalid"), "{client}: {text}");
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn toml_errors_report_only_the_position() {
        let root = temp_root();
        let reconciler = disk_reconciler(&root);
        let error = Adapter::Codex
            .apply_proxy(
                &reconciler,
                Some(format!("model = \"ok\"\ntoken = {SECRET}\n").as_bytes()),
                None,
                "https://proxy.example/v1",
                None,
                &uncached(&["m".to_owned()]),
            )
            .unwrap_err();
        assert_eq!(error.to_string(), "invalid Codex TOML at line 2 column 9");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restore_errors_never_quote_file_content() {
        let receipt = Receipt {
            version: 1,
            client: "codex".to_owned(),
            config_existed: true,
            original_model: None,
            original_provider: None,
            original_catalog: None,
            expected_model: "m".to_owned(),
            automatic_model: false,
            expected_base_url: "https://proxy.example/v1".to_owned(),
            expected_key_path: "/k".to_owned(),
            expected_catalog_path: None,
            expected_models: Vec::new(),
            expected_reasoning_levels: BTreeMap::new(),
            original_settings: BTreeMap::new(),
        };
        let broken = format!("password = \"{SECRET}\" oops\n");
        let error = Adapter::Codex
            .restore(Some(broken.as_bytes()), &receipt)
            .unwrap_err();
        assert!(!chain(&error).contains(SECRET));
        let error = Adapter::Codex
            .config_is_empty(broken.as_bytes())
            .unwrap_err();
        assert!(!chain(&error).contains(SECRET));
    }

    #[test]
    fn state_and_catalog_data_errors_never_quote_values() {
        let root = temp_root();
        let path = root.join("receipt.json");
        // A value of the wrong type makes serde quote it in its own message.
        fs::write(&path, format!(r#"{{"version":"{SECRET}"}}"#)).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let error = state::read_json::<Receipt>(&path).unwrap_err();
        assert!(!chain(&error).contains(SECRET), "{}", chain(&error));
        let unknown = format!(r#"{{"{SECRET}":1}}"#);
        fs::write(&path, unknown).unwrap();
        let error = state::read_json::<Receipt>(&path).unwrap_err();
        assert!(!chain(&error).contains(SECRET), "{}", chain(&error));

        let catalog = format!(
            r#"{{"baseUrl":"https://proxy.example/v1","models":[{{"id":"{SECRET}","reasoningLevels":"x"}}]}}"#
        );
        let error =
            parse_server_catalog(catalog.as_bytes(), "https://proxy.example/v1").unwrap_err();
        assert!(!chain(&error).contains(SECRET), "{}", chain(&error));
        let catalog = format!(r#"{{"{SECRET}":1}}"#);
        let error =
            parse_server_catalog(catalog.as_bytes(), "https://proxy.example/v1").unwrap_err();
        assert!(!chain(&error).contains(SECRET), "{}", chain(&error));
        fs::remove_dir_all(root).unwrap();
    }
}
