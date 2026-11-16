//! Observation of what is on disk: the digest of an owned Skill directory as
//! if it were a Bundle, the files that differ from a parsed Bundle, and the
//! digest of a managed file. Everything is bounded and refuses links.

use crate::{
    ErrorCode, MAX_ASSIGNMENT_BYTES, MAX_BUNDLE_BYTES, MAX_FILE_BYTES, ReconcileError, Result,
    bundle::{MAGIC, MAX_FILES, ParsedSkill, validate_bundle_path},
    file_digest, hex_sha256,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    fs::File,
    io::{self, Read},
    path::Path,
};

pub(crate) fn differing_files(root: &Path, skill: &ParsedSkill) -> Option<Vec<String>> {
    let mut observed = Vec::new();
    match fs::symlink_metadata(root) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {
            collect_files(root, root, &mut observed, &mut ObservationLimits::default()).ok()?
        }
        Ok(_) => return None,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return None,
    }
    let expected: BTreeMap<&str, (bool, &[u8])> = skill
        .files
        .iter()
        .map(|f| (f.path.as_str(), (f.executable, f.bytes.as_slice())))
        .collect();
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for (path, executable, bytes) in &observed {
        seen.insert(path.as_str());
        if expected.get(path.as_str()) != Some(&(*executable, bytes.as_slice())) {
            out.push(path.clone());
        }
    }
    out.extend(
        expected
            .keys()
            .filter(|path| !seen.contains(*path))
            .map(|path| (*path).to_owned()),
    );
    Some(out)
}

pub(crate) fn digest_tree(root: &Path) -> Result<String> {
    let meta = fs::symlink_metadata(root)
        .map_err(|e| ReconcileError::io(ErrorCode::Io, "cannot inspect Skill", e))?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err(ReconcileError::new(
            ErrorCode::NonRegularEntry,
            "Skill root is not a real directory",
        ));
    }
    let mut files = Vec::new();
    let mut limits = ObservationLimits::default();
    collect_files(root, root, &mut files, &mut limits)?;
    files.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    let mut encoded = Vec::new();
    encoded.extend(MAGIC);
    encoded.extend(
        u32::try_from(files.len())
            .map_err(|_| ReconcileError::new(ErrorCode::BundleLimitExceeded, "too many files"))?
            .to_be_bytes(),
    );
    for (path, executable, bytes) in files {
        encoded.extend((path.len() as u32).to_be_bytes());
        encoded.extend(path.as_bytes());
        encoded.push(u8::from(executable));
        encoded.extend((bytes.len() as u64).to_be_bytes());
        encoded.extend(bytes);
        if encoded.len() > MAX_BUNDLE_BYTES {
            return Err(ReconcileError::new(
                ErrorCode::OwnedSkillDrift,
                "owned Skill exceeds Bundle limit",
            ));
        }
    }
    Ok(format!("sha256:{}", hex_sha256(&encoded)))
}
#[derive(Default)]
struct ObservationLimits {
    entries: usize,
    content_bytes: u64,
}

fn collect_files(
    root: &Path,
    at: &Path,
    out: &mut Vec<(String, bool, Vec<u8>)>,
    limits: &mut ObservationLimits,
) -> Result<()> {
    for item in fs::read_dir(at)
        .map_err(|e| ReconcileError::io(ErrorCode::Io, "cannot read Skill directory", e))?
    {
        let item =
            item.map_err(|e| ReconcileError::io(ErrorCode::Io, "cannot read Skill entry", e))?;
        let path = item.path();
        limits.entries = limits.entries.checked_add(1).ok_or_else(|| {
            ReconcileError::new(
                ErrorCode::BundleLimitExceeded,
                "observed entry count overflow",
            )
        })?;
        if limits.entries > MAX_FILES {
            return Err(ReconcileError::new(
                ErrorCode::BundleLimitExceeded,
                "observed Skill has too many entries",
            ));
        }
        let rel = path.strip_prefix(root).map_err(|_| {
            ReconcileError::new(
                ErrorCode::FilesystemEscape,
                "observed path escaped Skill root",
            )
        })?;
        let value = rel
            .components()
            .map(|c| {
                c.as_os_str().to_str().ok_or_else(|| {
                    ReconcileError::new(
                        ErrorCode::InvalidBundlePath,
                        "filesystem path is not UTF-8",
                    )
                })
            })
            .collect::<Result<Vec<_>>>()?
            .join("/");
        validate_bundle_path(&value)?;
        let meta = fs::symlink_metadata(&path).map_err(|e| {
            ReconcileError::io(ErrorCode::Io, "cannot inspect Skill entry", e).at_entry(&value)
        })?;
        if meta.file_type().is_symlink() || (!meta.is_dir() && !meta.is_file()) {
            return Err(ReconcileError::new(
                ErrorCode::NonRegularEntry,
                format!("non-regular Skill entry: {value}"),
            )
            .at_entry(&value));
        }
        #[cfg(unix)]
        if meta.is_file() && {
            use std::os::unix::fs::MetadataExt;
            meta.nlink() != 1
        } {
            return Err(ReconcileError::new(
                ErrorCode::NonRegularEntry,
                format!("hard-linked Skill entry: {value}"),
            )
            .at_entry(&value));
        }
        if meta.is_dir() {
            collect_files(root, &path, out, limits)?;
            continue;
        }
        if meta.len() > MAX_FILE_BYTES as u64 {
            return Err(ReconcileError::new(
                ErrorCode::BundleLimitExceeded,
                "observed file exceeds 16 MiB",
            ));
        }
        limits.content_bytes = limits
            .content_bytes
            .checked_add(meta.len())
            .ok_or_else(|| {
                ReconcileError::new(
                    ErrorCode::BundleLimitExceeded,
                    "observed content size overflow",
                )
            })?;
        if limits.content_bytes > MAX_ASSIGNMENT_BYTES {
            return Err(ReconcileError::new(
                ErrorCode::BundleLimitExceeded,
                "observed Skill content exceeds limit",
            ));
        }
        let mut bytes = Vec::with_capacity(meta.len() as usize);
        File::open(&path)
            .map(|f| f.take(MAX_FILE_BYTES as u64 + 1))
            .and_then(|mut f| f.read_to_end(&mut bytes))
            .map_err(|e| ReconcileError::io(ErrorCode::Io, "cannot read Skill file", e))?;
        if bytes.len() > MAX_FILE_BYTES {
            return Err(ReconcileError::new(
                ErrorCode::BundleLimitExceeded,
                "observed file grew beyond 16 MiB while reading",
            ));
        }
        if bytes.len() as u64 > meta.len() {
            limits.content_bytes = limits
                .content_bytes
                .checked_add(bytes.len() as u64 - meta.len())
                .ok_or_else(|| {
                    ReconcileError::new(
                        ErrorCode::BundleLimitExceeded,
                        "observed content size overflow",
                    )
                })?;
            if limits.content_bytes > MAX_ASSIGNMENT_BYTES {
                return Err(ReconcileError::new(
                    ErrorCode::BundleLimitExceeded,
                    "observed Skill content exceeds limit",
                ));
            }
        }
        #[cfg(unix)]
        let executable = {
            use std::os::unix::fs::PermissionsExt;
            meta.permissions().mode() & 0o111 != 0
        };
        #[cfg(not(unix))]
        let executable = false;
        out.push((value, executable, bytes));
    }
    Ok(())
}

pub(crate) fn digest_regular_file(path: &Path) -> Result<Option<String>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(ReconcileError::io(
                ErrorCode::Io,
                "cannot inspect managed file",
                error,
            ));
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ReconcileError::new(
            ErrorCode::NonRegularEntry,
            "managed file destination is not a regular file",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err(ReconcileError::new(
                ErrorCode::NonRegularEntry,
                "managed file destination is hard-linked",
            ));
        }
    }
    if metadata.len() > MAX_FILE_BYTES as u64 {
        return Err(ReconcileError::new(
            ErrorCode::BundleLimitExceeded,
            "managed file exceeds 16 MiB",
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)
        .map(|file| file.take(MAX_FILE_BYTES as u64 + 1))
        .and_then(|mut file| file.read_to_end(&mut bytes))
        .map_err(|error| ReconcileError::io(ErrorCode::Io, "cannot read managed file", error))?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(ReconcileError::new(
            ErrorCode::BundleLimitExceeded,
            "managed file grew beyond 16 MiB while reading",
        ));
    }
    Ok(Some(file_digest(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        bundle::validate_assignment,
        tests::{assignment, setup, skill},
    };
    #[cfg(unix)]
    #[test]
    fn drift_file_listing_refuses_a_replaced_skill_root() {
        let (_t, r, _) = setup();
        let foreign = r.home.join("foreign");
        fs::create_dir(&foreign).unwrap();
        fs::write(foreign.join("private-name"), b"private content").unwrap();
        let root = r.home.join("replaced");
        std::os::unix::fs::symlink(&foreign, &root).unwrap();
        let current = assignment("1", vec![skill("alpha", &[("SKILL.md", false, b"x")])]);
        let parsed = validate_assignment(&current).unwrap();
        assert_eq!(differing_files(&root, &parsed[0]), None);
        fs::remove_file(&root).unwrap();
        fs::write(&root, b"not a directory").unwrap();
        assert_eq!(differing_files(&root, &parsed[0]), None);
    }
}
