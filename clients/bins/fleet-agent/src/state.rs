use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

const MAX_JSON: u64 = 3 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub server_url: String,
    pub ca_pem: String,
    pub node_alias: String,
    pub home: PathBuf,
}

pub fn private_directory(path: &Path) -> Result<()> {
    if !path.is_absolute() {
        bail!("state directory must be absolute");
    }
    for ancestor in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => bail!("state path contains a link or non-directory"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(ancestor)?;
                fs::set_permissions(ancestor, fs::Permissions::from_mode(0o700))?;
            }
            Err(error) => return Err(error.into()),
        }
    }
    if fs::metadata(path)?.permissions().mode() & 0o077 != 0 {
        bail!("state directory must have user-only permissions (chmod 700)");
    }
    Ok(())
}

pub fn lock(path: &Path) -> Result<File> {
    let path = path.join("agent.lock");
    if let Ok(metadata) = fs::symlink_metadata(&path)
        && (!metadata.is_file() || metadata.file_type().is_symlink())
    {
        bail!("invalid agent lock");
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(path)?;
    file.try_lock()
        .context("another fleet-agent process is using this state directory")?;
    Ok(file)
}

pub fn read_bytes(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > limit {
        bail!("state file is not a bounded regular file");
    }
    let mut bytes = Vec::new();
    File::open(path)?.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        bail!("state file exceeds its size limit");
    }
    Ok(bytes)
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
        Ok(_) => Ok(Some(
            serde_json::from_slice(&read_bytes(path, MAX_JSON)?).context("invalid agent state")?,
        )),
    }
}

pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() as u64 > MAX_JSON {
        bail!("agent state exceeds 3 MiB");
    }
    write_bytes(path, &bytes)
}

pub fn write_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Ok(metadata) = fs::symlink_metadata(path)
        && (!metadata.is_file() || metadata.file_type().is_symlink())
    {
        bail!("invalid state file destination");
    }
    let parent = path.parent().context("state file requires parent")?;
    let temporary = parent.join(format!(".write-{}", Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_state_rejects_links_and_concurrent_processes() {
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("fleet-state-test-{}", Uuid::new_v4()));
        private_directory(&root).unwrap();
        let first = lock(&root).unwrap();
        assert!(lock(&root).is_err());
        drop(first);
        let path = root.join("state.json");
        write_json(&path, &serde_json::json!({"version":1})).unwrap();
        assert_eq!(
            read_json::<serde_json::Value>(&path).unwrap().unwrap()["version"],
            1
        );
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(root.join("agent.lock"), &path).unwrap();
        assert!(read_json::<serde_json::Value>(&path).is_err());
        assert!(write_json(&path, &serde_json::json!({})).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_or_oversized_state_is_not_treated_as_fresh_state() {
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("fleet-state-test-{}", Uuid::new_v4()));
        private_directory(&root).unwrap();
        let path = root.join("run.json");
        write_bytes(&path, b"{broken").unwrap();
        assert!(read_json::<serde_json::Value>(&path).is_err());
        write_bytes(&path, &vec![b' '; MAX_JSON as usize + 1]).unwrap();
        assert!(read_json::<serde_json::Value>(&path).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
