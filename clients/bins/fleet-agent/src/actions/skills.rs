use super::{ActionError, cache};
use crate::{
    protocol::{Api, Assignment},
    state,
};
use anyhow::{Context, Result, bail};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

pub fn validate(assignment: &Assignment) -> Result<()> {
    if assignment.target_name != "skills"
        || assignment.target.base != "home"
        || assignment.file.is_some()
        || assignment.ai_client.is_some()
        || assignment.skills.len() > 10_000
    {
        bail!("unsupported Target descriptor");
    }
    let total = assignment.skills.iter().try_fold(0u64, |sum, skill| {
        u64::try_from(skill.size)
            .ok()
            .and_then(|size| sum.checked_add(size))
    });
    if total.is_none_or(|bytes| bytes > 256 * 1024 * 1024) {
        bail!("Assignment exceeds the supported size budget");
    }
    Ok(())
}

pub fn recover(reconciler: &fleet_reconcile::Reconciler, assignment: &Assignment) -> Result<()> {
    reconciler.recover(&descriptor(assignment)?)?;
    Ok(())
}

pub async fn prepare(api: &Api, assignment: &Assignment, cache_root: &Path) -> Result<()> {
    let mut total = 0u64;
    for skill in &assignment.skills {
        let size = u64::try_from(skill.size).context("invalid Bundle size")?;
        total = total
            .checked_add(size)
            .context("Assignment size overflow")?;
        if size > 16 * 1024 * 1024 || total > 256 * 1024 * 1024 || skill.schema != "fleet.bundle/v1"
        {
            bail!("unsupported Bundle size or schema");
        }
        let destination = cache::path(cache_root, &skill.bundle_digest)?;
        if !cache::valid_entry(&destination, |bytes| cache::verify_skill(skill, bytes))? {
            let bundle = api.bundle(skill).await?;
            if bundle.digest != skill.bundle_digest
                || bundle.schema != skill.schema
                || !cache::verify_skill(skill, &bundle.bytes)
            {
                bail!("downloaded Bundle failed integrity validation");
            }
            state::write_bytes(&destination, &bundle.bytes)?;
        }
    }
    Ok(())
}

pub fn apply(
    reconciler: &fleet_reconcile::Reconciler,
    assignment: &Assignment,
    cache_root: &Path,
) -> std::result::Result<(), ActionError> {
    let descriptor = descriptor(assignment).map_err(ActionError::invalid_assignment)?;
    let local =
        local_assignment(assignment, cache_root).map_err(ActionError::invalid_assignment)?;
    reconciler
        .reconcile(&descriptor, &local)
        .map(|_| ())
        .map_err(ActionError::reconcile)
}

pub fn keep_cached(
    assignment: &Assignment,
    cache_root: &Path,
    keep: &mut HashSet<PathBuf>,
) -> Result<()> {
    for skill in &assignment.skills {
        keep.insert(cache::path(cache_root, &skill.bundle_digest)?);
    }
    Ok(())
}

fn descriptor(assignment: &Assignment) -> Result<fleet_reconcile::TargetDescriptor> {
    validate(assignment)?;
    Ok(fleet_reconcile::TargetDescriptor {
        base: fleet_reconcile::TargetBase::Home,
        path: PathBuf::from(&assignment.target.path),
    })
}

fn local_assignment(
    assignment: &Assignment,
    cache_root: &Path,
) -> Result<fleet_reconcile::Assignment> {
    let mut total = 0u64;
    let mut skills = Vec::new();
    for skill in &assignment.skills {
        if skill.size < 0 || skill.size > 16 * 1024 * 1024 {
            bail!("Bundle exceeds 16 MiB");
        }
        total = total
            .checked_add(skill.size as u64)
            .context("Assignment size overflow")?;
        if total > 256 * 1024 * 1024 {
            bail!("Assignment exceeds 256 MiB");
        }
        skills.push(fleet_reconcile::DesiredSkill {
            name: skill.name.clone(),
            digest: skill.bundle_digest.clone(),
            size: skill.size as u64,
            schema: skill.schema.clone(),
            bundle: state::read_bytes(
                &cache::path(cache_root, &skill.bundle_digest)?,
                16 * 1024 * 1024,
            )?,
        });
    }
    Ok(fleet_reconcile::Assignment {
        assignment_id: assignment.assignment_id.to_string(),
        desired_revision_id: assignment.desired_revision_id.to_string(),
        skills,
    })
}
