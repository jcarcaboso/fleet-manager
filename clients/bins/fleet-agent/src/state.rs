use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::{
    fs::{self, File, OpenOptions, TryLockError},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
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

/// How a directory looks to a read-only command.
#[derive(Debug, PartialEq, Eq)]
pub enum DirectoryState {
    Missing,
    /// A real directory owned by this user that nobody else can enter.
    Private,
    /// Why it cannot be trusted, phrased to follow the directory's name.
    Unsafe(&'static str),
}

/// Looks at one directory without creating it or changing its permissions.
pub fn classify_directory(path: &Path) -> std::io::Result<DirectoryState> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DirectoryState::Missing);
        }
        Err(error) => return Err(error),
    };
    // SAFETY: `geteuid` has no preconditions and cannot fail.
    let user = unsafe { libc::geteuid() };
    Ok(if metadata.file_type().is_symlink() || !metadata.is_dir() {
        DirectoryState::Unsafe("is a link or not a directory")
    } else if metadata.uid() != user {
        DirectoryState::Unsafe("is not owned by the current user")
    } else if metadata.mode() & 0o077 != 0 {
        DirectoryState::Unsafe("must have user-only permissions (chmod 700)")
    } else {
        DirectoryState::Private
    })
}

/// The read-only counterpart of [`private_directory`]: the same ancestor rules,
/// but nothing is ever created or changed. A missing path is `Missing`.
pub fn inspect_directory(path: &Path) -> Result<DirectoryState> {
    if !path.is_absolute() {
        bail!("state directory must be absolute");
    }
    let ancestors = path.ancestors().skip(1).collect::<Vec<_>>();
    for ancestor in ancestors.into_iter().rev() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => {
                return Ok(DirectoryState::Unsafe(
                    "path contains a link or non-directory",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(DirectoryState::Missing);
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(classify_directory(path)?)
}

/// Whether the state directory exists and is safe to read, for commands that
/// must never create it. `false` means it does not exist.
pub fn existing_private_directory(path: &Path) -> Result<bool> {
    match inspect_directory(path)? {
        DirectoryState::Missing => Ok(false),
        DirectoryState::Private => Ok(true),
        DirectoryState::Unsafe(reason) => bail!("state directory {reason}"),
    }
}

const LOCK_ATTEMPTS: u32 = 10;
const LOCK_PAUSE: Duration = Duration::from_millis(50);

/// Takes the exclusive state lock. A holder that releases within about half a
/// second, such as a read-only command probing the lock, does not make this fail.
pub fn lock(path: &Path) -> Result<File> {
    lock_with(path, LOCK_ATTEMPTS, LOCK_PAUSE)
}

/// Whether some process holds the state lock. It never creates the lock file
/// and holds a shared lock for an instant at most, so it cannot block anything
/// but a simultaneous `lock`, which retries.
pub fn lock_is_held(directory: &Path) -> Result<bool> {
    let path = directory.join("agent.lock");
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
            bail!("invalid agent lock")
        }
        Ok(_) => {}
    }
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    match file.try_lock_shared() {
        Ok(()) => Ok(false),
        Err(TryLockError::WouldBlock) => Ok(true),
        Err(TryLockError::Error(error)) => Err(error.into()),
    }
}

fn lock_with(path: &Path, attempts: u32, pause: Duration) -> Result<File> {
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
    for attempt in 1..=attempts.max(1) {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(TryLockError::WouldBlock) if attempt < attempts => std::thread::sleep(pause),
            Err(TryLockError::WouldBlock) => break,
            Err(TryLockError::Error(error)) => return Err(error.into()),
        }
    }
    bail!("another fleet-agent process is using this state directory")
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
            serde_json::from_slice(&read_bytes(path, MAX_JSON)?).map_err(|error| {
                anyhow::anyhow!("invalid agent state ({})", json_location(&error))
            })?,
        )),
    }
}

/// Describes where and why JSON parsing failed without the offending content.
///
/// `serde_json` data errors quote the rejected value ("invalid type: string
/// \"...\""), which may be a credential or file content. Diagnostics that leave
/// the Node must use this instead of the error's own text.
pub fn json_location(error: &serde_json::Error) -> String {
    use serde_json::error::Category;
    let kind = match error.classify() {
        Category::Io => "read error",
        Category::Syntax => "syntax error",
        Category::Data => "unexpected value or field",
        Category::Eof => "unexpected end of input",
    };
    format!("{kind} at line {} column {}", error.line(), error.column())
}

/// Returns the 1-based line and column of a byte offset in `text`.
pub fn text_location(text: &str, offset: usize) -> (usize, usize) {
    let end = offset.min(text.len());
    let end = (0..=end)
        .rev()
        .find(|index| text.is_char_boundary(*index))
        .unwrap_or(0);
    let before = &text[..end];
    let line = before.matches('\n').count() + 1;
    let column = before
        .rsplit('\n')
        .next()
        .map_or(0, |last| last.chars().count())
        + 1;
    (line, column)
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

    fn test_root() -> PathBuf {
        std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("fleet-state-test-{}", Uuid::new_v4()))
    }

    #[test]
    fn the_lock_probe_sees_a_holder_and_creates_nothing() {
        let root = test_root();
        // A missing directory and a missing lock file mean nothing is running.
        assert!(!lock_is_held(&root).unwrap());
        assert!(!root.exists());
        private_directory(&root).unwrap();
        assert!(!lock_is_held(&root).unwrap());
        assert!(!root.join("agent.lock").exists());

        let held = lock(&root).unwrap();
        for _ in 0..3 {
            assert!(lock_is_held(&root).unwrap());
        }
        drop(held);
        assert!(!lock_is_held(&root).unwrap());
        assert!(root.join("agent.lock").exists());
        // Probes do not hold anything: the lock can be taken straight after.
        drop(lock(&root).unwrap());

        fs::remove_file(root.join("agent.lock")).unwrap();
        std::os::unix::fs::symlink(&root, root.join("agent.lock")).unwrap();
        assert!(lock_is_held(&root).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_lock_retries_while_a_probe_holds_it_briefly() {
        let root = test_root();
        private_directory(&root).unwrap();
        drop(lock(&root).unwrap());
        let (acquired, wait) = std::sync::mpsc::channel();
        let probe_root = root.clone();
        let probe = std::thread::spawn(move || {
            let file = File::open(probe_root.join("agent.lock")).unwrap();
            file.try_lock_shared().unwrap();
            acquired.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(150));
        });
        wait.recv().unwrap();
        // One attempt fails while the probe holds the lock; the default retries succeed.
        assert!(lock_with(&root, 1, Duration::ZERO).is_err());
        let started = std::time::Instant::now();
        let file = lock(&root).unwrap();
        assert!(started.elapsed() >= Duration::from_millis(50));
        probe.join().unwrap();
        // A real holder still fails after the retries, with the same message.
        let error = lock_with(&root, 3, Duration::from_millis(1)).unwrap_err();
        assert!(error.to_string().contains("another fleet-agent process"));
        drop(file);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn inspecting_a_directory_never_creates_or_changes_it() {
        let root = test_root();
        let state = root.join("a/state");
        assert_eq!(inspect_directory(&state).unwrap(), DirectoryState::Missing);
        assert!(!existing_private_directory(&state).unwrap());
        assert!(!root.exists());
        assert!(inspect_directory(Path::new("relative")).is_err());

        fs::create_dir_all(&state).unwrap();
        fs::set_permissions(&state, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(matches!(
            inspect_directory(&state).unwrap(),
            DirectoryState::Unsafe(_)
        ));
        assert!(existing_private_directory(&state).is_err());
        assert_eq!(
            fs::metadata(&state).unwrap().permissions().mode() & 0o777,
            0o755
        );

        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(existing_private_directory(&state).unwrap());

        let link = root.join("link");
        std::os::unix::fs::symlink(&state, &link).unwrap();
        assert!(matches!(
            inspect_directory(&link).unwrap(),
            DirectoryState::Unsafe(_)
        ));
        assert!(matches!(
            inspect_directory(&link.join("child")).unwrap(),
            DirectoryState::Unsafe(_)
        ));
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
