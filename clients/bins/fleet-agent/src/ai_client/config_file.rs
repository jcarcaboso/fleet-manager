//! The AI clients' own configuration files: bounded, link-refusing reads,
//! writes and removals that fail when the file changed since it was read, and
//! the digests the recovery journal compares.

use crate::state;
use anyhow::{Context, Result, bail};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::Path,
};
use uuid::Uuid;

const MAX_CLIENT_CONFIG_BYTES: u64 = 4 * 1024 * 1024;

pub(super) fn read_optional_config(path: &Path) -> Result<Option<Vec<u8>>> {
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

pub(super) fn ensure_config_parent(home: &Path, path: &Path) -> Result<()> {
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

pub(super) fn write_config(path: &Path, expected: Option<&[u8]>, bytes: &[u8]) -> Result<()> {
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
        state::sync_dir(parent)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

pub(super) fn remove_config(path: &Path, expected: Option<&[u8]>) -> Result<()> {
    if read_optional_config(path)?.as_deref() != expected {
        bail!("AI client configuration changed concurrently");
    }
    if expected.is_some() {
        fs::remove_file(path)?;
        state::sync_dir(path.parent().unwrap())?;
    }
    Ok(())
}

pub(super) fn config_digest(bytes: Option<&[u8]>) -> String {
    match bytes {
        Some(bytes) => format!("sha256:{:x}", Sha256::digest(bytes)),
        None => "missing".to_owned(),
    }
}

pub(super) fn remove_state_file(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => {
            state::sync_dir(path.parent().unwrap())?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}
