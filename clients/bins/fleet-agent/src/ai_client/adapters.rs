use super::{Receipt, Reconciler};
use anyhow::Result;
use std::path::PathBuf;

mod codex;
pub(super) mod opencode;

const REGISTERED: [Adapter; 2] = [Adapter::Codex, Adapter::OpenCode];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Adapter {
    Codex,
    OpenCode,
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
        }
    }

    pub(super) fn config_path(self, reconciler: &Reconciler) -> PathBuf {
        match self {
            Self::Codex => reconciler.home.join(".codex/config.toml"),
            Self::OpenCode => reconciler.home.join(".config/opencode/opencode.json"),
        }
    }

    pub(super) fn apply_proxy(
        self,
        reconciler: &Reconciler,
        old: Option<&[u8]>,
        previous: Option<&Receipt>,
        base_url: &str,
        model: &str,
        models: &[String],
    ) -> Result<(Vec<u8>, Receipt)> {
        let key_path = reconciler.state.join("api-key");
        match self {
            Self::Codex => {
                let catalog_path = reconciler.state.join("codex-model-catalog.json");
                let catalog = codex::render_codex_catalog(models)?;
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
            Self::OpenCode => {
                opencode::render_opencode(old, previous, base_url, model, models, &key_path)
            }
        }
    }

    pub(super) fn restore(self, old: Option<&[u8]>, receipt: &Receipt) -> Result<Vec<u8>> {
        match self {
            Self::Codex => codex::restore_codex(old, receipt),
            Self::OpenCode => opencode::restore_opencode(old, receipt),
        }
    }

    pub(super) fn config_is_empty(self, bytes: &[u8]) -> Result<bool> {
        match self {
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
            Self::OpenCode => Ok(()),
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
        assert!(Adapter::find("unknown").is_err());
        assert_eq!(REGISTERED.map(Adapter::name), ["codex", "opencode"]);
    }
}
