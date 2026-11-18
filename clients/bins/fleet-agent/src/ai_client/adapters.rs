use super::{ModelCache, Receipt, Reconciler};
use anyhow::{Result, bail};
use std::path::{Path, PathBuf};

mod claude;
mod codex;
pub(super) mod opencode;

const REGISTERED: [Adapter; 3] = [Adapter::Codex, Adapter::OpenCode, Adapter::Claude];

/// A client config with the Fleet settings applied, its receipt, and whether
/// Fleet-owned settings had been changed outside Fleet and were overwritten.
#[derive(Debug)]
pub(super) struct Rendered {
    pub(super) bytes: Vec<u8>,
    pub(super) receipt: Receipt,
    pub(super) drifted: bool,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Adapter {
    Codex,
    OpenCode,
    Claude,
}

impl Adapter {
    pub(super) fn find(name: &str) -> Result<Self> {
        REGISTERED
            .into_iter()
            .find(|adapter| adapter.name() == name)
            .ok_or_else(|| anyhow::anyhow!("unsupported AI client"))
    }

    pub(super) const fn name(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::OpenCode => "opencode",
            Self::Claude => "claude",
        }
    }

    /// The Target path of the client's configuration, relative to the home
    /// directory, as Assignments name it.
    pub(super) const fn target_path(self) -> &'static str {
        match self {
            Self::Codex => ".codex",
            Self::OpenCode => ".config/opencode",
            Self::Claude => ".claude",
        }
    }

    pub(super) fn config_path(self, reconciler: &Reconciler) -> PathBuf {
        let directory = reconciler.home.join(self.target_path());
        match self {
            Self::Codex => directory.join("config.toml"),
            Self::Claude => directory.join("settings.json"),
            Self::OpenCode => {
                let jsonc = directory.join("opencode.jsonc");
                // OpenCode loads JSONC after JSON, so update the overriding file.
                if jsonc.symlink_metadata().is_ok() {
                    jsonc
                } else {
                    directory.join("opencode.json")
                }
            }
        }
    }

    pub(super) fn apply_proxy(
        self,
        reconciler: &Reconciler,
        old: Option<&[u8]>,
        previous: Option<&Receipt>,
        base_url: &str,
        model: Option<&str>,
        cache: &ModelCache,
    ) -> Result<Rendered> {
        // Per-model metadata is only used for the endpoint it was cached for.
        let metadata = Some(cache).filter(|cache| cache.base_url == base_url);
        let routing = metadata.and_then(|cache| cache.client_routing.as_ref());
        let skip_claude = metadata.is_none_or(|cache| cache.skip_claude_models_for_other_clients);
        let allowed_models: Vec<String> = cache
            .models
            .iter()
            .filter(|model| {
                routing.map_or_else(
                    || {
                        !skip_claude
                            || self == Self::Claude
                            || !model.to_ascii_lowercase().starts_with("claude-")
                    },
                    |routing| routing.allows(self, model),
                )
            })
            .cloned()
            .collect();
        let models = allowed_models.as_slice();
        if models.is_empty() {
            bail!("no allowed CLIProxy models for {}", self.name());
        }
        if model.is_some_and(|selected| !models.iter().any(|model| model == selected)) {
            bail!("selected CLIProxy model is not allowed for {}", self.name());
        }
        let (efforts, context_limits) = metadata
            .map(|cache| (cache.reasoning_levels.clone(), cache.context_limits.clone()))
            .unwrap_or_default();
        let key_path = reconciler.state.join("api-key");
        match self {
            Self::Codex => {
                let catalog_path = reconciler.state.join("codex-model-catalog.json");
                let catalog = codex::render_codex_catalog(models, &efforts, &context_limits)?;
                let rendered = codex::render_codex(
                    old,
                    previous,
                    base_url,
                    model,
                    models,
                    &key_path,
                    &catalog_path,
                )?;
                crate::state::write_bytes(&catalog_path, &catalog)?;
                Ok(rendered)
            }
            Self::OpenCode => opencode::render_opencode(
                old, previous, base_url, model, models, &key_path, &efforts,
            ),
            Self::Claude => claude::render_claude(
                old,
                previous,
                base_url,
                model,
                models,
                &key_path,
                routing.is_some(),
            ),
        }
    }

    /// Fails when OpenCode loads one config file while Fleet's provider is in
    /// the other: ownership never moves between them silently.
    pub(super) fn check_managed_file(self, reconciler: &Reconciler, path: &Path) -> Result<()> {
        if self != Self::OpenCode {
            return Ok(());
        }
        let other = if path
            .extension()
            .is_some_and(|extension| extension == "jsonc")
        {
            path.with_extension("json")
        } else {
            path.with_extension("jsonc")
        };
        let has_provider = |path: &Path| -> Result<bool> {
            super::config_file::read_optional_config(path)?
                .map_or(Ok(false), |bytes| opencode::has_fleet_provider(&bytes))
        };
        if other.starts_with(&reconciler.home) && !has_provider(path)? && has_provider(&other)? {
            bail!(
                "Fleet's OpenCode provider is in {}, but OpenCode loads {}; move the settings into one file",
                other.file_name().unwrap_or_default().to_string_lossy(),
                path.file_name().unwrap_or_default().to_string_lossy()
            );
        }
        Ok(())
    }

    /// A receipt for Fleet settings found in the config without a receipt,
    /// so that native mode can remove them. `None` when there are none.
    pub(super) fn orphan_receipt(
        self,
        reconciler: &Reconciler,
        old: Option<&[u8]>,
    ) -> Result<Option<Receipt>> {
        match self {
            Self::Codex => {
                codex::orphan_receipt(old, &reconciler.state.join("codex-model-catalog.json"))
            }
            Self::OpenCode => opencode::orphan_receipt(old),
            Self::Claude => claude::orphan_receipt(old, &reconciler.state.join("api-key")),
        }
    }

    pub(super) fn restore(self, old: Option<&[u8]>, receipt: &Receipt) -> Result<Vec<u8>> {
        match self {
            Self::Codex => codex::restore_codex(old, receipt),
            Self::OpenCode => opencode::restore_opencode(old, receipt),
            Self::Claude => claude::restore_claude(old, receipt),
        }
    }

    pub(super) fn config_is_empty(self, bytes: &[u8]) -> Result<bool> {
        match self {
            Self::Claude => Ok(serde_json::from_slice::<serde_json::Value>(bytes)?
                .as_object()
                .is_some_and(|object| object.is_empty())),
            Self::Codex => Ok(codex::parse_document(std::str::from_utf8(bytes)?)?.is_empty()),
            Self::OpenCode => {
                let root = jsonc_parser::cst::CstRootNode::parse(
                    std::str::from_utf8(bytes)?,
                    &jsonc_parser::ParseOptions::default(),
                )?;
                Ok(root
                    .object_value()
                    .is_some_and(|object| object.properties().is_empty()))
            }
        }
    }

    pub(super) fn remove_auxiliary_state(self, reconciler: &Reconciler) -> Result<()> {
        match self {
            Self::Codex => super::config_file::remove_state_file(
                &reconciler.state.join("codex-model-catalog.json"),
            ),
            Self::OpenCode | Self::Claude => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registered_adapters_resolve_by_name() {
        assert_eq!(Adapter::find("codex").unwrap(), Adapter::Codex);
        assert_eq!(Adapter::find("opencode").unwrap(), Adapter::OpenCode);
        assert_eq!(Adapter::find("claude").unwrap(), Adapter::Claude);
        assert!(Adapter::find("unknown").is_err());
        assert_eq!(
            REGISTERED.map(Adapter::name),
            ["codex", "opencode", "claude"]
        );
    }

    #[test]
    fn supported_clients_pair_with_their_target_paths() {
        assert!(crate::ai_client::supports("codex", ".codex"));
        assert!(crate::ai_client::supports("opencode", ".config/opencode"));
        assert!(crate::ai_client::supports("claude", ".claude"));
        assert!(!crate::ai_client::supports("codex", ".claude"));
        assert!(!crate::ai_client::supports("unknown", ".codex"));
    }
}
