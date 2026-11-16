//! Filesystem primitives shared by both transaction engines: containment
//! checks, private directories, the shared target lock, and the bounded,
//! atomically replaced JSON state files (Receipts and journals).

use crate::{ErrorCode, ReconcileError, Result, hex_sha256};
use serde::{Serialize, de::DeserializeOwned};
use std::{
    fs,
    fs::{File, OpenOptions},
    io::{self, Write},
    path::{Component, Path, PathBuf},
};

const MAX_STATE_FILE: u64 = 2 * 1024 * 1024;

/// Describes `at` below the Target base `home` as `~/relative`, so errors name
/// a location without revealing where the base lives. A path outside the base
/// is reduced to its last component.
fn under_home(home: &Path, at: &Path) -> String {
    match at.strip_prefix(home) {
        Ok(rel) if rel.as_os_str().is_empty() => "~".to_owned(),
        Ok(rel) => format!("~/{}", rel.display()),
        Err(_) => tail_display(at),
    }
}

/// Describes `at` by its last two components, as `.../parent/name`, never as an
/// absolute path.
fn tail_display(at: &Path) -> String {
    let names: Vec<_> = at
        .components()
        .filter_map(|component| match component {
            Component::Normal(name) => Some(name.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    let tail = &names[names.len().saturating_sub(2)..];
    match names.len() {
        0 => "the root directory".to_owned(),
        1..=2 if at.is_relative() => tail.join("/"),
        _ => format!(".../{}", tail.join("/")),
    }
}

pub(crate) fn ensure_beneath(home: &Path, target: &Path, create: bool) -> Result<()> {
    if !target.starts_with(home) {
        return Err(ReconcileError::new(
            ErrorCode::FilesystemEscape,
            "target is outside home",
        ));
    }
    let rel = target
        .strip_prefix(home)
        .map_err(|_| ReconcileError::new(ErrorCode::FilesystemEscape, "target is outside home"))?;
    let mut at = home.to_owned();
    for component in rel.components() {
        let Component::Normal(name) = component else {
            return Err(ReconcileError::new(
                ErrorCode::FilesystemEscape,
                "invalid target component",
            ));
        };
        at.push(name);
        match fs::symlink_metadata(&at) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err(ReconcileError::new(
                    ErrorCode::FilesystemEscape,
                    format!("symlink in target path: {}", under_home(home, &at)),
                ));
            }
            Ok(m) if !m.is_dir() => {
                return Err(ReconcileError::new(
                    ErrorCode::NonRegularEntry,
                    format!(
                        "target ancestor is not a directory: {}",
                        under_home(home, &at)
                    ),
                ));
            }
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound && create => {
                fs::create_dir(&at).map_err(|e| {
                    ReconcileError::io(
                        ErrorCode::Io,
                        format!("cannot create {}", under_home(home, &at)),
                        e,
                    )
                })?;
                sync_parent(&at)?;
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => {
                return Err(ReconcileError::io(
                    ErrorCode::Io,
                    format!("cannot inspect {}", under_home(home, &at)),
                    e,
                ));
            }
        }
    }
    let resolved = fs::canonicalize(target)
        .map_err(|e| ReconcileError::io(ErrorCode::Io, "cannot resolve target", e))?;
    if !resolved.starts_with(home) {
        return Err(ReconcileError::new(
            ErrorCode::FilesystemEscape,
            "resolved target escapes home",
        ));
    }
    Ok(())
}

pub(crate) fn reject_symlink_path(path: &Path, code: ErrorCode) -> Result<()> {
    let mut at = PathBuf::new();
    for c in path.components() {
        at.push(c);
        if let Ok(m) = fs::symlink_metadata(&at)
            && m.file_type().is_symlink()
        {
            return Err(ReconcileError::new(
                code,
                format!("symlink in path: {}", tail_display(&at)),
            ));
        }
    }
    Ok(())
}

pub(crate) fn ensure_private_dir(path: &Path, code: ErrorCode) -> Result<()> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
                return Err(ReconcileError::new(
                    code,
                    format!(
                        "private path component is not a real directory: {}",
                        tail_display(&current)
                    ),
                ));
            }
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|e| {
                    ReconcileError::io(code, format!("cannot create {}", tail_display(&current)), e)
                })?;
            }
            Err(e) => {
                return Err(ReconcileError::io(
                    code,
                    format!("cannot inspect {}", tail_display(&current)),
                    e,
                ));
            }
        }
    }
    let m = fs::symlink_metadata(path)
        .map_err(|e| ReconcileError::io(code, "cannot inspect directory", e))?;
    if !m.is_dir() || m.file_type().is_symlink() {
        return Err(ReconcileError::new(
            code,
            "private path is not a real directory",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|e| ReconcileError::io(code, "cannot secure private directory", e))?;
    }
    Ok(())
}

fn open_lock(path: &Path) -> Result<File> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => {
            return Err(ReconcileError::new(
                ErrorCode::LockFailed,
                "target lock is not a regular file",
            ));
        }
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(ReconcileError::io(
                ErrorCode::LockFailed,
                "cannot inspect target lock",
                e,
            ));
        }
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| ReconcileError::io(ErrorCode::LockFailed, "cannot open target lock", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|e| {
                ReconcileError::io(ErrorCode::LockFailed, "cannot secure target lock", e)
            })?;
    }
    Ok(file)
}

/// What a shared lock serializes. It only selects the error wording.
#[derive(Clone, Copy)]
pub(crate) enum Locked {
    Target,
    ManagedFile,
}

/// A held shared lock: `.fleet-reconcile/<key>/lock` beside the Target.
pub(crate) struct SharedLock {
    /// `hex_sha256` of the locked path's text; it also names the private state
    /// directory (`targets/<key>` or `files/<key>`).
    pub(crate) key: String,
    /// `<parent of the Target>/.fleet-reconcile/<key>`, which holds the lock
    /// and the transaction directories.
    pub(crate) shared: PathBuf,
    /// Keeps the lock until it is dropped.
    _lock: File,
}

/// Derives the key from `keyed` (the Target, or the managed file in it),
/// creates the shared directory beside `target`, and takes its lock.
///
/// `reject_links` is set by the reconcile paths, which refuse a symlink
/// anywhere in the shared directory's path; the recover paths do not check it.
/// That difference predates this helper and is kept as is.
pub(crate) fn lock_shared(
    target: &Path,
    keyed: &Path,
    locked: Locked,
    reject_links: bool,
) -> Result<SharedLock> {
    let key = hex_sha256(keyed.as_os_str().to_string_lossy().as_bytes());
    let shared = target
        .parent()
        .ok_or_else(|| {
            ReconcileError::new(
                ErrorCode::InvalidTarget,
                match locked {
                    Locked::Target => "target has no parent",
                    Locked::ManagedFile => "managed file Target has no parent",
                },
            )
        })?
        .join(".fleet-reconcile")
        .join(&key);
    ensure_private_dir(&shared, ErrorCode::Io)?;
    if reject_links {
        reject_symlink_path(&shared, ErrorCode::FilesystemEscape)?;
    }
    let lock = open_lock(&shared.join("lock"))?;
    lock.lock().map_err(|e| {
        ReconcileError::io(
            ErrorCode::LockFailed,
            match locked {
                Locked::Target => "cannot lock target",
                Locked::ManagedFile => "cannot lock managed file",
            },
            e,
        )
    })?;
    Ok(SharedLock {
        key,
        shared,
        _lock: lock,
    })
}

/// A JSON state file and the error codes and wording its failures use.
#[derive(Clone, Copy)]
pub(crate) struct StateFile {
    /// Name in error messages, such as `file Receipt`.
    label: &'static str,
    journal: bool,
}

impl StateFile {
    /// A Receipt: failing to inspect or read it is `io`; a bad file is
    /// `corrupt_receipt`.
    pub(crate) const fn receipt(label: &'static str) -> Self {
        Self {
            label,
            journal: false,
        }
    }
    /// A recovery journal: every failure is `recovery_failed`.
    pub(crate) const fn journal(label: &'static str) -> Self {
        Self {
            label,
            journal: true,
        }
    }
}

/// How `read_state_file` treats a missing file.
#[derive(Clone, Copy)]
pub(crate) enum IfMissing {
    /// A missing file is an error.
    Fail,
    /// Missing when inspected is `None`; vanishing before it is read is an error.
    Absent,
    /// Missing when inspected or when read is `None`.
    AbsentEvenWhileReading,
}

/// Reads a state file that must be a regular file of at most 2 MiB holding
/// JSON. The caller checks what the contents are bound to.
pub(crate) fn read_state_file<T: DeserializeOwned>(
    path: &Path,
    file: StateFile,
    if_missing: IfMissing,
) -> Result<Option<T>> {
    let StateFile { label, journal } = file;
    let (unreadable, invalid, unparsable) = if journal {
        (
            ErrorCode::RecoveryFailed,
            ErrorCode::RecoveryFailed,
            "is corrupt",
        )
    } else {
        (ErrorCode::Io, ErrorCode::CorruptReceipt, "is invalid JSON")
    };
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == io::ErrorKind::NotFound && !matches!(if_missing, IfMissing::Fail) => {
            return Ok(None);
        }
        Err(e) => {
            return Err(ReconcileError::io(
                unreadable,
                format!("cannot inspect {label}"),
                e,
            ));
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > MAX_STATE_FILE {
        return Err(ReconcileError::new(
            invalid,
            format!("{label} is not a bounded regular file"),
        ));
    }
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e)
            if e.kind() == io::ErrorKind::NotFound
                && matches!(if_missing, IfMissing::AbsentEvenWhileReading) =>
        {
            return Ok(None);
        }
        Err(e) => {
            return Err(ReconcileError::io(
                unreadable,
                format!("cannot read {label}"),
                e,
            ));
        }
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| ReconcileError::new(invalid, format!("{label} {unparsable}")))
}

pub(crate) fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let parent = path.parent().unwrap();
    ensure_private_dir(parent, ErrorCode::Io)?;
    let temp = path.with_extension("tmp");
    let bytes =
        serde_json::to_vec(value).map_err(|e| ReconcileError::new(ErrorCode::Io, e.to_string()))?;
    let mut f = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&temp)
        .map_err(|e| ReconcileError::io(ErrorCode::Io, "cannot create state file", e))?;
    f.write_all(&bytes)
        .and_then(|_| f.sync_all())
        .map_err(|e| ReconcileError::io(ErrorCode::Io, "cannot sync state file", e))?;
    fs::rename(&temp, path)
        .map_err(|e| ReconcileError::io(ErrorCode::Io, "cannot commit state file", e))?;
    sync_parent(path)
}
pub(crate) fn sync_tree(path: &Path) -> Result<()> {
    for e in fs::read_dir(path)
        .map_err(|e| ReconcileError::io(ErrorCode::Io, "cannot read staging tree", e))?
    {
        let p = e
            .map_err(|e| ReconcileError::io(ErrorCode::Io, "cannot read staging entry", e))?
            .path();
        if p.is_dir() {
            sync_tree(&p)?;
        }
    }
    File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(|e| ReconcileError::io(ErrorCode::Io, "cannot sync directory", e))
}
pub(crate) fn sync_parent(path: &Path) -> Result<()> {
    File::open(path.parent().unwrap())
        .and_then(|f| f.sync_all())
        .map_err(|e| ReconcileError::io(ErrorCode::Io, "cannot sync parent directory", e))
}
pub(crate) fn remove_file_sync(path: &Path) -> Result<()> {
    fs::remove_file(path)
        .map_err(|e| ReconcileError::io(ErrorCode::Io, "cannot remove state file", e))?;
    sync_parent(path)
}
pub(crate) fn remove_tree(path: &Path) -> Result<()> {
    let m = fs::symlink_metadata(path)
        .map_err(|e| ReconcileError::io(ErrorCode::Io, "cannot inspect removal target", e))?;
    if m.file_type().is_symlink() {
        return Err(ReconcileError::new(
            ErrorCode::NonRegularEntry,
            "refusing to remove symlink",
        ));
    }
    if m.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
    .map_err(|e| ReconcileError::io(ErrorCode::Io, "cannot remove transaction path", e))?;
    sync_parent(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::TestDir;
    #[test]
    fn filesystem_errors_name_locations_without_absolute_paths() {
        let t = TestDir::new().unwrap();
        let state = t.path().join("external-state");
        fs::create_dir(&state).unwrap();
        fs::write(state.join("targets"), b"not a directory").unwrap();
        let message = ensure_private_dir(&state.join("targets"), ErrorCode::Io)
            .unwrap_err()
            .to_string();
        assert!(
            message.ends_with("is not a real directory: .../external-state/targets"),
            "{message}"
        );

        let home = t.path().join("home");
        fs::create_dir_all(home.join(".claude")).unwrap();
        std::os::unix::fs::symlink(t.path(), home.join(".claude/link")).unwrap();
        let message = ensure_beneath(&home, &home.join(".claude/link/x"), false)
            .unwrap_err()
            .to_string();
        assert!(
            message.ends_with("symlink in target path: ~/.claude/link"),
            "{message}"
        );

        let message = reject_symlink_path(&home.join(".claude/link"), ErrorCode::Io)
            .unwrap_err()
            .to_string();
        assert!(
            message.ends_with("symlink in path: .../.claude/link"),
            "{message}"
        );
        assert!(!message.contains(t.path().to_str().unwrap()));
    }
}
