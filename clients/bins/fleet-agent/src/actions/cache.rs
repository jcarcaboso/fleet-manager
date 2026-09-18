use crate::{protocol, state};
use anyhow::{Context, Result, bail};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub fn path(cache: &Path, digest: &str) -> Result<PathBuf> {
    let hex = digest
        .strip_prefix("sha256:")
        .context("unsupported Bundle digest")?;
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("invalid Bundle digest");
    }
    Ok(cache.join(hex))
}

pub fn verify_skill(skill: &protocol::AssignmentSkill, bytes: &[u8]) -> bool {
    skill.schema == "fleet.bundle/v1"
        && skill.size >= 0
        && bytes.len() as i64 == skill.size
        && format!("sha256:{:x}", Sha256::digest(bytes)) == skill.bundle_digest
}

pub fn verify_file(file: &protocol::AssignmentFile, bytes: &[u8]) -> bool {
    let mut digest = Sha256::new();
    digest.update(b"fleet.file/v1\0");
    digest.update(bytes);
    file.schema.as_deref() == Some("fleet.file/v1")
        && file
            .size
            .is_some_and(|size| size >= 0 && bytes.len() as i64 == size)
        && file
            .bundle_digest
            .as_ref()
            .is_some_and(|expected| format!("sha256:{:x}", digest.finalize()) == *expected)
}

pub fn valid_entry(destination: &Path, verify: impl FnOnce(&[u8]) -> bool) -> Result<bool> {
    match std::fs::symlink_metadata(destination) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                bail!("unsafe Bundle cache entry");
            }
            if metadata.len() <= 16 * 1024 * 1024
                && verify(&state::read_bytes(destination, 16 * 1024 * 1024)?)
            {
                Ok(true)
            } else {
                std::fs::remove_file(destination)?;
                Ok(false)
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_cache_rejects_digest_path_injection() {
        for digest in [
            "../identity.json",
            "sha256:../identity.json",
            "sha256:ABCDEF",
            "sha512:abc",
        ] {
            assert!(path(Path::new("/cache"), digest).is_err());
        }
        assert_eq!(
            path(Path::new("/cache"), &format!("sha256:{}", "a".repeat(64))).unwrap(),
            PathBuf::from("/cache").join("a".repeat(64))
        );
    }
}
