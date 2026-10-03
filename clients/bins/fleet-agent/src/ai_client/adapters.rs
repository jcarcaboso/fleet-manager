use super::{Receipt, Reconciler};
use anyhow::{Result, bail};
use std::path::PathBuf;

mod claude;
mod codex;
pub(super) mod opencode;

const REGISTERED: [Adapter; 3] = [Adapter::Codex, Adapter::OpenCode, Adapter::Claude];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
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

    pub(super) fn config_path(self, reconciler: &Reconciler) -> PathBuf {
        match self {
            Self::Codex => reconciler.home.join(".codex/config.toml"),
            Self::Claude => reconciler.home.join(".claude/settings.json"),
            Self::OpenCode => {
                let directory = reconciler.home.join(".config/opencode");
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
        models: &[String],
    ) -> Result<(Vec<u8>, Receipt)> {
        let cache =
            crate::state::read_json::<super::ModelCache>(&reconciler.state.join("models.json"))?;
        let skip_claude = cache
            .as_ref()
            .filter(|cache| cache.base_url == base_url)
            .is_none_or(|cache| cache.skip_claude_models_for_other_clients);
        let allowed_models: Vec<String> = models
            .iter()
            .filter(|model| {
                !skip_claude
                    || self == Self::Claude
                    || !model.to_ascii_lowercase().starts_with("claude-")
            })
            .cloned()
            .collect();
        let models = allowed_models.as_slice();
        if models.is_empty() {
            bail!(
                "no allowed CLIProxy models for {}; Claude models are restricted to Claude Code",
                self.name()
            );
        }
        if model.is_some_and(|selected| !models.iter().any(|model| model == selected)) {
            bail!("selected CLIProxy model is not allowed for {}", self.name());
        }
        let (efforts, context_limits) = cache
            .filter(|cache| cache.base_url == base_url)
            .map(|cache| (cache.reasoning_levels, cache.context_limits))
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
            Self::Claude => {
                claude::render_claude(old, previous, base_url, model, models, &key_path)
            }
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
            Self::Codex => Ok(std::str::from_utf8(bytes)?
                .parse::<toml_edit::DocumentMut>()?
                .is_empty()),
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
            Self::Codex => {
                super::remove_state_file(&reconciler.state.join("codex-model-catalog.json"))
            }
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
}
