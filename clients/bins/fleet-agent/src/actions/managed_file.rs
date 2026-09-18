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
    let Some(file) = &assignment.file else {
        bail!("managed-file Target has no file");
    };
    if !assignment.target_name.starts_with("agent-file/")
        || assignment.target.base != "home"
        || !assignment.skills.is_empty()
        || assignment.ai_client.is_some()
        || !matches!(
            (
                file.bundle_digest.as_ref(),
                file.size,
                file.schema.as_deref(),
            ),
            (None, None, None) | (Some(_), Some(0..=16_777_216), Some("fleet.file/v1"))
        )
    {
        bail!("unsupported Target descriptor");
    }
    Ok(())
}

pub fn recover(reconciler: &fleet_reconcile::Reconciler, assignment: &Assignment) -> Result<()> {
    validate(assignment)?;
    let file = assignment.file.as_ref().unwrap();
    reconciler.recover_file(&descriptor(assignment), &file.name)?;
    Ok(())
}

pub async fn prepare(api: &Api, assignment: &Assignment, cache_root: &Path) -> Result<()> {
    let file = assignment
        .file
        .as_ref()
        .context("managed-file Target has no file")?;
    let Some(digest) = file.bundle_digest.as_deref() else {
        return Ok(());
    };
    let size = file.size.context("managed file size is missing")?;
    if !(0..=16 * 1024 * 1024).contains(&size) || file.schema.as_deref() != Some("fleet.file/v1") {
        bail!("unsupported managed file size or schema");
    }
    let destination = cache::path(cache_root, digest)?;
    if !cache::valid_entry(&destination, |bytes| cache::verify_file(file, bytes))? {
        let downloaded = api.file(file).await?;
        if downloaded.digest != digest
            || downloaded.schema != "fleet.file/v1"
            || !cache::verify_file(file, &downloaded.bytes)
        {
            bail!("downloaded managed file failed integrity validation");
        }
        state::write_bytes(&destination, &downloaded.bytes)?;
    }
    Ok(())
}

pub fn apply(
    reconciler: &fleet_reconcile::Reconciler,
    assignment: &Assignment,
    cache_root: &Path,
) -> std::result::Result<(), ActionError> {
    validate(assignment).map_err(ActionError::invalid_assignment)?;
    let local =
        local_assignment(assignment, cache_root).map_err(ActionError::invalid_assignment)?;
    reconciler
        .reconcile_file(&descriptor(assignment), &local)
        .map(|_| ())
        .map_err(ActionError::reconcile)
}

pub fn keep_cached(
    assignment: &Assignment,
    cache_root: &Path,
    keep: &mut HashSet<PathBuf>,
) -> Result<()> {
    if let Some(digest) = assignment
        .file
        .as_ref()
        .and_then(|file| file.bundle_digest.as_deref())
    {
        keep.insert(cache::path(cache_root, digest)?);
    }
    Ok(())
}

fn descriptor(assignment: &Assignment) -> fleet_reconcile::TargetDescriptor {
    fleet_reconcile::TargetDescriptor {
        base: fleet_reconcile::TargetBase::Home,
        path: PathBuf::from(&assignment.target.path),
    }
}

fn local_assignment(
    assignment: &Assignment,
    cache_root: &Path,
) -> Result<fleet_reconcile::FileAssignment> {
    let file = assignment
        .file
        .as_ref()
        .context("managed-file Target has no file")?;
    let content = match &file.bundle_digest {
        Some(digest) => state::read_bytes(&cache::path(cache_root, digest)?, 16 * 1024 * 1024)?,
        None => Vec::new(),
    };
    Ok(fleet_reconcile::FileAssignment {
        assignment_id: assignment.assignment_id.to_string(),
        desired_revision_id: assignment.desired_revision_id.to_string(),
        file: fleet_reconcile::DesiredFile {
            name: file.name.clone(),
            digest: file.bundle_digest.clone(),
            size: file
                .size
                .map(|size| u64::try_from(size).context("invalid managed file size"))
                .transpose()?,
            schema: file.schema.clone(),
            content,
        },
    })
}
