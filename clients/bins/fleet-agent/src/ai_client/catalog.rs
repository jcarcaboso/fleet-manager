//! The CLIProxy model catalog: the Server's copy parsed into a [`ModelCache`],
//! a cached one checked before reuse, model selection, and the checks on
//! model names, reasoning efforts and the CLIProxy URL. Pure functions; the
//! cache types are on-disk formats and stay in the parent module.

use super::{ContextLimits, ModelCache, adapters::Adapter, default_skip_claude_models};
use crate::state;
use anyhow::{Context, Result, bail};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

/// Largest Codex model catalog Fleet generates from the cache.
pub(super) const MAX_MODEL_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ClientRouting {
    claude: Vec<Adapter>,
    gpt: Vec<Adapter>,
    // Older Servers send a three-key catalog; Gemini models then fall back to "other".
    #[serde(default)]
    gemini: Vec<Adapter>,
    other: Vec<Adapter>,
}

impl ClientRouting {
    pub(super) fn allows(&self, client: Adapter, model: &str) -> bool {
        let model = model.to_ascii_lowercase();
        let clients = if model.starts_with("claude-") {
            &self.claude
        } else if model.starts_with("gpt-") {
            &self.gpt
        } else if model.starts_with("gemini-") && !self.gemini.is_empty() {
            &self.gemini
        } else {
            &self.other
        };
        clients.contains(&client)
    }

    fn is_valid(&self) -> bool {
        [&self.claude, &self.gpt, &self.other]
            .into_iter()
            .all(|clients| {
                !clients.is_empty() && clients.iter().collect::<HashSet<_>>().len() == clients.len()
            })
            // An absent (empty) Gemini route is valid for an older Server.
            && self.gemini.iter().collect::<HashSet<_>>().len() == self.gemini.len()
    }
}

impl ContextLimits {
    pub(super) fn is_valid(self) -> bool {
        [
            self.context_window,
            self.max_context_window,
            self.auto_compact_token_limit,
        ]
        .into_iter()
        .flatten()
        .all(|limit| limit > 0)
            && self
                .context_window
                .zip(self.max_context_window)
                .is_none_or(|(window, maximum)| window <= maximum)
    }
}

pub(super) fn parse_server_catalog(bytes: &[u8], base_url: &str) -> Result<ModelCache> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Model {
        id: String,
        reasoning_levels: Vec<String>,
        context_window: Option<i64>,
        max_context_window: Option<i64>,
        auto_compact_token_limit: Option<i64>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Catalog {
        base_url: String,
        models: Vec<Model>,
        #[serde(default = "default_skip_claude_models")]
        skip_claude_models_for_other_clients: bool,
        client_routing: Option<ClientRouting>,
    }
    let catalog: Catalog = serde_json::from_slice(bytes).map_err(|error| {
        anyhow::anyhow!(
            "invalid Server model catalog ({})",
            state::json_location(&error)
        )
    })?;
    if catalog.base_url != base_url || catalog.models.is_empty() {
        bail!("Server model catalog does not match the assignment");
    }
    if catalog
        .client_routing
        .as_ref()
        .is_some_and(|routing| !routing.is_valid())
    {
        bail!("invalid Server model client routing");
    }
    let mut models = Vec::new();
    let mut reasoning_levels = BTreeMap::new();
    let mut context_limits = BTreeMap::new();
    let mut seen = HashSet::new();
    for model in catalog.models {
        let limits = ContextLimits {
            context_window: model.context_window,
            max_context_window: model.max_context_window,
            auto_compact_token_limit: model.auto_compact_token_limit,
        };
        if !valid_model_id(&model.id)
            || !seen.insert(model.id.to_ascii_lowercase())
            || !limits.is_valid()
            || model
                .reasoning_levels
                .iter()
                .any(|level| !valid_effort(level))
        {
            bail!("invalid Server model metadata");
        }
        context_limits.insert(model.id.clone(), limits);
        reasoning_levels.insert(model.id.clone(), model.reasoning_levels);
        models.push(model.id);
    }
    Ok(ModelCache {
        version: 1,
        base_url: base_url.to_owned(),
        models,
        reasoning_levels,
        context_limits,
        skip_claude_models_for_other_clients: catalog.skip_claude_models_for_other_clients,
        client_routing: catalog.client_routing,
    })
}

pub(super) fn select_model<'a>(
    configured: Option<&'a str>,
    current: Option<&'a str>,
    models: &'a [String],
) -> Result<&'a str> {
    if let Some(configured) = configured {
        if !models.iter().any(|model| model == configured) {
            bail!("selected model is not advertised by CLIProxy");
        }
        return Ok(configured);
    }
    current
        .filter(|current| models.iter().any(|model| model == current))
        .or_else(|| models.first().map(String::as_str))
        .context("CLIProxy model catalog is empty")
}

pub(super) fn valid_effort(value: &str) -> bool {
    matches!(
        value,
        "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
    )
}

pub(super) fn validate_base_url(value: &str) -> Result<Url> {
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

pub(super) fn valid_model_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value.trim() == value
        && value.bytes().all(|byte| byte.is_ascii_graphic())
}

pub(super) fn usable_cache(
    cache: Option<ModelCache>,
    base_url: &str,
    selected: Option<&str>,
) -> Option<ModelCache> {
    cache.filter(|cache| {
        cache.version == 1
            && cache.base_url == base_url
            && !cache.models.is_empty()
            && cache.models.iter().all(|model| valid_model_id(model))
            && selected.is_none_or(|selected| cache.models.iter().any(|model| model == selected))
            && cache
                .client_routing
                .as_ref()
                .is_none_or(ClientRouting::is_valid)
            && cache
                .reasoning_levels
                .values()
                .flatten()
                .all(|level| valid_effort(level))
            && cache
                .context_limits
                .values()
                .all(|limits| limits.is_valid())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_catalog_preserves_efforts_and_rejects_wrong_endpoint() {
        let bytes = br#"{"baseUrl":"https://proxy.example/v1","models":[{"id":"one","reasoningLevels":["low","high"]},{"id":"two","reasoningLevels":[]}]}"#;
        let cache = parse_server_catalog(bytes, "https://proxy.example/v1").unwrap();
        assert_eq!(cache.models, ["one", "two"]);
        assert_eq!(cache.reasoning_levels["one"], ["low", "high"]);
        assert!(cache.skip_claude_models_for_other_clients);
        assert!(parse_server_catalog(bytes, "https://other.example/v1").is_err());
        assert!(
            parse_server_catalog(
                br#"{"baseUrl":"https://proxy.example/v1","models":[]}"#,
                "https://proxy.example/v1"
            )
            .is_err()
        );
        assert_eq!(
            select_model(None, Some("two"), &cache.models).unwrap(),
            "two"
        );
        assert_eq!(
            select_model(None, Some("removed"), &cache.models).unwrap(),
            "one"
        );
        assert!(select_model(Some("removed"), None, &cache.models).is_err());
    }

    #[test]
    fn server_catalog_rejects_invalid_context_limits() {
        for field in ["contextWindow", "maxContextWindow", "autoCompactTokenLimit"] {
            for value in [
                serde_json::json!(0),
                serde_json::json!(-1),
                serde_json::json!(1.5),
                serde_json::json!("272000"),
                serde_json::json!(true),
                serde_json::json!(i64::MAX as u64 + 1),
            ] {
                let bytes = serde_json::to_vec(&serde_json::json!({
                    "baseUrl": "https://proxy.example/v1",
                    "models": [{"id": "one", "reasoningLevels": [], field: value}]
                }))
                .unwrap();
                assert!(parse_server_catalog(&bytes, "https://proxy.example/v1").is_err());
            }
        }
        assert!(
            parse_server_catalog(
                br#"{"baseUrl":"https://proxy.example/v1","models":[{"id":"one","reasoningLevels":[],"contextWindow":872000,"maxContextWindow":272000}]}"#,
                "https://proxy.example/v1",
            )
            .is_err()
        );
    }

    #[test]
    fn gemini_route_is_separate_and_only_allows_antigravity() {
        let bytes = br#"{"baseUrl":"https://proxy.example/v1","models":[{"id":"gemini-2.5-pro","reasoningLevels":[]}],
            "clientRouting":{"claude":["claude"],"gpt":["codex","opencode"],"gemini":["antigravity"],"other":["opencode"]}}"#;
        let cache = parse_server_catalog(bytes, "https://proxy.example/v1").unwrap();
        let routing = cache.client_routing.as_ref().unwrap();
        assert!(routing.allows(Adapter::Antigravity, "gemini-2.5-pro"));
        assert!(!routing.allows(Adapter::OpenCode, "gemini-2.5-pro"));
        assert!(!routing.allows(Adapter::Claude, "gemini-2.5-pro"));
        assert!(routing.allows(Adapter::Claude, "claude-opus-4-1"));
        assert!(usable_cache(Some(cache), "https://proxy.example/v1", None).is_some());

        // A three-key catalog from an older Server keeps Gemini models on "other".
        let legacy = br#"{"baseUrl":"https://proxy.example/v1","models":[{"id":"gemini-2.5-pro","reasoningLevels":[]}],
            "clientRouting":{"claude":["claude"],"gpt":["codex","opencode"],"other":["opencode"]}}"#;
        let cache = parse_server_catalog(legacy, "https://proxy.example/v1").unwrap();
        let routing = cache.client_routing.as_ref().unwrap();
        assert!(routing.allows(Adapter::OpenCode, "gemini-2.5-pro"));
        assert!(!routing.allows(Adapter::Antigravity, "gemini-2.5-pro"));
    }

    #[test]
    fn legacy_model_cache_remains_usable() {
        let cache: ModelCache = serde_json::from_slice(
            br#"{"version":1,"baseUrl":"https://proxy.example/v1","models":["one"],"reasoningLevels":{"one":["medium"]}}"#,
        )
        .unwrap();
        assert!(cache.context_limits.is_empty());
        assert!(usable_cache(Some(cache), "https://proxy.example/v1", None).is_some());
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
            reasoning_levels: BTreeMap::new(),
            context_limits: BTreeMap::new(),
            skip_claude_models_for_other_clients: true,
            client_routing: None,
        };
        assert!(
            usable_cache(
                Some(cache.clone()),
                "https://proxy.example/v1",
                Some("gpt-6-astra")
            )
            .is_some()
        );
        assert!(
            usable_cache(
                Some(cache.clone()),
                "https://other.example/v1",
                Some("gpt-6-astra")
            )
            .is_none()
        );
        let mut invalid = cache.clone();
        invalid.context_limits.insert(
            "gpt-6-astra".to_owned(),
            ContextLimits {
                context_window: Some(0),
                ..Default::default()
            },
        );
        assert!(usable_cache(Some(invalid), "https://proxy.example/v1", None).is_none());
        assert!(
            usable_cache(
                Some(cache),
                "https://proxy.example/v1",
                Some("missing-model")
            )
            .is_none()
        );
    }
}
