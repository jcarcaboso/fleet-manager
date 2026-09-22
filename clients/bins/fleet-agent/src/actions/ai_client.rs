use super::ActionError;
use crate::protocol::{Api, Assignment};
use anyhow::{Result, bail};

pub fn validate(assignment: &Assignment) -> Result<()> {
    let Some(ai) = &assignment.ai_client else {
        bail!("AI-client Target has no connection");
    };
    let valid_mode = match ai.mode.as_str() {
        "native" => ai.base_url.is_none() && ai.model.is_none(),
        "cliproxy" => {
            ai.base_url.as_ref().is_some_and(|url| url.len() <= 2048)
                && ai.model.as_ref().is_none_or(|model| model.len() <= 200)
        }
        _ => false,
    };
    if assignment.target_name != format!("ai-client/{}", ai.client)
        || assignment.target.base != "home"
        || !assignment.skills.is_empty()
        || assignment.file.is_some()
        || ai.schema != "fleet.ai-client/v1"
        || !matches!(ai.client.as_str(), "codex" | "opencode")
        || !matches!(
            (ai.client.as_str(), assignment.target.path.as_str()),
            ("codex", ".codex") | ("opencode", ".config/opencode")
        )
        || !valid_mode
    {
        bail!("unsupported Target descriptor");
    }
    Ok(())
}

pub fn recover(reconciler: &crate::ai_client::Reconciler, assignment: &Assignment) -> Result<()> {
    validate(assignment)?;
    reconciler.recover(&assignment.ai_client.as_ref().unwrap().client)
}

pub async fn apply(
    reconciler: &crate::ai_client::Reconciler,
    api: &Api,
    assignment: &Assignment,
) -> std::result::Result<(), ActionError> {
    validate(assignment).map_err(ActionError::invalid_assignment)?;
    reconciler
        .reconcile(api, assignment.ai_client.as_ref().unwrap())
        .await
        .map_err(|error| ActionError::new("ai_client_reconcile_failed", error))
}
