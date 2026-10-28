//! The Fleet-owned install layout in the state directory.
//!
//! ```text
//! <state-dir>/versions/<version>/fleet-agent   never changed once installed
//! <state-dir>/current -> versions/<version>    the path the service runs
//! ```
//!
//! `fleet-agent service install` copies the running executable here, so
//! Homebrew, Cargo or a release archive only supply the first binary. Switching
//! `current` is one rename, so it always names a complete version, and the
//! service manager resolves it at each start. At most two versions are kept:
//! the active one and the one it replaced, for `update rollback`.

use std::{
    fs::{self, File, OpenOptions},
    io::{ErrorKind, Read, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const VERSIONS: &str = "versions";
pub const CURRENT: &str = "current";
pub const EXECUTABLE: &str = "fleet-agent";
/// The version of this executable.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Largest executable accepted; release binaries are about a tenth of it.
const MAX_EXECUTABLE_BYTES: u64 = 64 * 1024 * 1024;

/// The executable a service definition runs: `<state-dir>/current/fleet-agent`.
pub fn current_executable(state_dir: &Path) -> PathBuf {
    state_dir.join(CURRENT).join(EXECUTABLE)
}

/// Whether `executable` lies in the versions directory of `state_dir`, as
/// given or after resolving the state directory's own links.
pub fn is_managed(executable: &Path, state_dir: &Path) -> bool {
    let roots = [Some(state_dir.to_path_buf()), state_dir.canonicalize().ok()];
    roots
        .into_iter()
        .flatten()
        .any(|root| executable.starts_with(root.join(VERSIONS)))
}

/// A version is a directory name, so only semantic-version characters are
/// accepted and nothing that could leave the versions directory.
fn check_version(version: &str) -> Result<()> {
    let valid = !version.is_empty()
        && version.len() <= 64
        && version.starts_with(|c: char| c.is_ascii_digit())
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        && !version.contains("..");
    if !valid {
        bail!("invalid Agent version {version:?}");
    }
    Ok(())
}

fn digest(path: &Path) -> Result<[u8; 32]> {
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut limited = file.take(MAX_EXECUTABLE_BYTES + 1);
    let mut buffer = vec![0; 64 * 1024];
    let mut total = 0u64;
    loop {
        let read = limited
            .read(&mut buffer)
            .with_context(|| format!("read {}", path.display()))?;
        if read == 0 {
            break;
        }
        total += read as u64;
        hasher.update(&buffer[..read]);
    }
    if total > MAX_EXECUTABLE_BYTES {
        bail!("{} is larger than 64 MiB", path.display());
    }
    Ok(hasher.finalize().into())
}

fn sync_directory(path: &Path) -> Result<()> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .with_context(|| format!("sync {}", path.display()))
}

/// Creates `path` with mode 0700 unless it is already a real directory.
fn directory(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => bail!("{} is a link or not a directory", path.display()),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            fs::create_dir(path).with_context(|| format!("create {}", path.display()))?;
            fs::set_permissions(path, fs::Permissions::from_mode(0o700))
                .with_context(|| format!("protect {}", path.display()))
        }
        Err(error) => Err(error).with_context(|| format!("inspect {}", path.display())),
    }
}

/// Copies `source` to `versions/<version>/fleet-agent` unless the same bytes
/// are already there, and returns the installed path. The copy is written to a
/// temporary file, checked against the source digest, and renamed into place,
/// so the destination is never a partial file.
pub fn install(state_dir: &Path, source: &Path, version: &str) -> Result<PathBuf> {
    check_version(version)?;
    let versions = state_dir.join(VERSIONS);
    let folder = versions.join(version);
    let destination = folder.join(EXECUTABLE);
    directory(&versions)?;
    directory(&folder)?;
    let wanted = digest(source)?;
    match fs::symlink_metadata(&destination) {
        Ok(metadata) if metadata.is_file() && digest(&destination)? == wanted => {
            return Ok(destination);
        }
        Ok(metadata) if !metadata.is_file() => {
            bail!("{} is not a regular file", destination.display())
        }
        _ => {}
    }
    let temporary = folder.join(format!(".{EXECUTABLE}.{}.tmp", std::process::id()));
    let result = (|| -> Result<()> {
        let mut input = File::open(source).with_context(|| format!("open {}", source.display()))?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o755)
            .open(&temporary)
            .with_context(|| format!("create {}", temporary.display()))?;
        std::io::copy(
            &mut (&mut input).take(MAX_EXECUTABLE_BYTES + 1),
            &mut output,
        )
        .with_context(|| format!("copy {}", source.display()))?;
        output.flush()?;
        output.sync_all()?;
        if digest(&temporary)? != wanted {
            bail!(
                "the copy of {} does not match it; it changed while being copied",
                source.display()
            );
        }
        fs::rename(&temporary, &destination)
            .with_context(|| format!("install {}", destination.display()))?;
        sync_directory(&folder)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map(|()| destination)
}

/// The version `current` points to, or `None` without a managed install.
pub fn active_version(state_dir: &Path) -> Result<Option<String>> {
    let link = state_dir.join(CURRENT);
    let target = match fs::read_link(&link) {
        Ok(target) => target,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) if error.kind() == ErrorKind::InvalidInput => {
            bail!("{} is not a link", link.display())
        }
        Err(error) => return Err(error).with_context(|| format!("read {}", link.display())),
    };
    let mut parts = target.components();
    match (parts.next(), parts.next(), parts.next()) {
        (Some(first), Some(version), None) if first.as_os_str() == VERSIONS => {
            let version = version
                .as_os_str()
                .to_str()
                .context("the current link names a version that is not text")?;
            check_version(version)?;
            Ok(Some(version.to_owned()))
        }
        _ => bail!(
            "{} points to {}, not to a version under {VERSIONS}/",
            link.display(),
            target.display()
        ),
    }
}

/// Points `current` at an installed version and returns the version it
/// pointed to before.
pub fn activate(state_dir: &Path, version: &str) -> Result<Option<String>> {
    check_version(version)?;
    let executable = state_dir.join(VERSIONS).join(version).join(EXECUTABLE);
    if !fs::symlink_metadata(&executable).is_ok_and(|metadata| metadata.is_file()) {
        bail!("version {version} is not installed");
    }
    let previous = active_version(state_dir)?;
    let link = state_dir.join(CURRENT);
    let temporary = state_dir.join(format!(".{CURRENT}.{}.tmp", std::process::id()));
    let _ = fs::remove_file(&temporary);
    std::os::unix::fs::symlink(Path::new(VERSIONS).join(version), &temporary)
        .with_context(|| format!("create {}", temporary.display()))?;
    if let Err(error) = fs::rename(&temporary, &link) {
        let _ = fs::remove_file(&temporary);
        return Err(error).with_context(|| format!("replace {}", link.display()));
    }
    sync_directory(state_dir)?;
    Ok(previous)
}

/// Installed versions, sorted by name.
pub fn installed_versions(state_dir: &Path) -> Result<Vec<String>> {
    let versions = state_dir.join(VERSIONS);
    let entries = match fs::read_dir(&versions) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error).with_context(|| format!("read {}", versions.display())),
    };
    let mut found = Vec::new();
    for entry in entries {
        let entry = entry?;
        if let Some(name) = entry.file_name().to_str()
            && check_version(name).is_ok()
            && fs::symlink_metadata(entry.path().join(EXECUTABLE))
                .is_ok_and(|metadata| metadata.is_file())
        {
            found.push(name.to_owned());
        }
    }
    found.sort();
    Ok(found)
}

/// Removes every installed version except `keep`. Only valid version
/// directories are touched.
pub fn prune(state_dir: &Path, keep: &[&str]) -> Result<()> {
    let versions = state_dir.join(VERSIONS);
    let entries = match fs::read_dir(&versions) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error).with_context(|| format!("read {}", versions.display())),
    };
    for entry in entries {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if check_version(&name).is_ok()
            && !keep.contains(&name.as_str())
            && entry.file_type()?.is_dir()
        {
            fs::remove_dir_all(entry.path())
                .with_context(|| format!("remove {}", entry.path().display()))?;
        }
    }
    Ok(())
}

/// The installed version that is not active: the one `update rollback`
/// switches to.
pub fn previous_version(state_dir: &Path) -> Result<Option<String>> {
    let active = active_version(state_dir)?;
    Ok(installed_versions(state_dir)?
        .into_iter()
        .rfind(|version| Some(version) != active.as_ref()))
}

/// Installs `source` as `version`, makes it active, and keeps only it and the
/// version to roll back to: the one it replaced or, when `version` was already
/// active, the one kept before. Returns the replaced version.
pub fn install_and_activate(
    state_dir: &Path,
    source: &Path,
    version: &str,
) -> Result<Option<String>> {
    let kept = previous_version(state_dir)?;
    install(state_dir, source, version)?;
    let replaced = activate(state_dir, version)?;
    let rollback = match replaced.as_deref() {
        Some(replaced) if replaced != version => Some(replaced.to_owned()),
        _ => kept,
    };
    let mut keep = vec![version];
    if let Some(rollback) = rollback.as_deref() {
        keep.push(rollback);
    }
    prune(state_dir, &keep)?;
    Ok(replaced)
}

/// Removes `current` and every installed version. Identity, credentials and
/// reconciliation state are left alone.
pub fn remove(state_dir: &Path) -> Result<()> {
    let link = state_dir.join(CURRENT);
    match fs::symlink_metadata(&link) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            fs::remove_file(&link).with_context(|| format!("remove {}", link.display()))?;
        }
        Ok(_) => bail!("{} is not a link; remove it by hand", link.display()),
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error).with_context(|| format!("inspect {}", link.display())),
    }
    prune(state_dir, &[])?;
    let versions = state_dir.join(VERSIONS);
    match fs::remove_dir(&versions) {
        Err(error) if error.kind() != ErrorKind::NotFound => {
            Err(error).with_context(|| format!("remove {}", versions.display()))
        }
        _ => Ok(()),
    }
}

/// `update status`: what is installed and what runs. Read-only.
pub fn status(state_dir: &Path) -> Result<Value> {
    let running = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.canonicalize().ok());
    Ok(json!({
        "version": VERSION,
        "managed": running.as_deref().is_some_and(|exe| is_managed(exe, state_dir)),
        "activeVersion": active_version(state_dir)?,
        "previousVersion": previous_version(state_dir)?,
        "installedVersions": installed_versions(state_dir)?,
        "executable": current_executable(state_dir),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "fleet-managed-{name}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    fn binary(directory: &Path, name: &str, content: &[u8]) -> PathBuf {
        let path = directory.join(name);
        fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn install_copies_once_and_activates() {
        let state = scratch("install");
        let source = binary(&state, "source", b"agent 1");
        assert_eq!(active_version(&state).unwrap(), None);
        assert_eq!(
            install_and_activate(&state, &source, "1.0.0").unwrap(),
            None
        );
        let installed = state.join("versions/1.0.0/fleet-agent");
        assert_eq!(fs::read(&installed).unwrap(), b"agent 1");
        assert_eq!(
            fs::metadata(&installed).unwrap().permissions().mode() & 0o777,
            0o755
        );
        assert_eq!(
            fs::read_link(state.join("current")).unwrap(),
            Path::new("versions/1.0.0")
        );
        assert_eq!(fs::read(current_executable(&state)).unwrap(), b"agent 1");
        assert_eq!(active_version(&state).unwrap().as_deref(), Some("1.0.0"));
        // Installing the same bytes again changes nothing.
        let inode = fs::metadata(&installed).unwrap();
        install_and_activate(&state, &source, "1.0.0").unwrap();
        assert_eq!(
            std::os::unix::fs::MetadataExt::ino(&fs::metadata(&installed).unwrap()),
            std::os::unix::fs::MetadataExt::ino(&inode)
        );
        // Different bytes under the same version replace the file.
        let rebuilt = binary(&state, "rebuilt", b"agent 1 rebuilt");
        install_and_activate(&state, &rebuilt, "1.0.0").unwrap();
        assert_eq!(fs::read(&installed).unwrap(), b"agent 1 rebuilt");
        // No temporary files remain.
        let leftovers = fs::read_dir(state.join("versions/1.0.0"))
            .unwrap()
            .filter(|entry| entry.as_ref().unwrap().file_name() != "fleet-agent")
            .count();
        assert_eq!(leftovers, 0);
        fs::remove_dir_all(state).unwrap();
    }

    #[test]
    fn upgrades_keep_one_previous_version_and_rollback_switches_to_it() {
        let state = scratch("upgrade");
        for (version, content) in [("1.0.0", "a"), ("1.1.0", "b"), ("1.2.0", "c")] {
            let source = binary(&state, version, content.as_bytes());
            install_and_activate(&state, &source, version).unwrap();
        }
        assert_eq!(installed_versions(&state).unwrap(), ["1.1.0", "1.2.0"]);
        assert_eq!(previous_version(&state).unwrap().as_deref(), Some("1.1.0"));
        assert_eq!(activate(&state, "1.1.0").unwrap().as_deref(), Some("1.2.0"));
        assert_eq!(fs::read(current_executable(&state)).unwrap(), b"b");
        assert_eq!(previous_version(&state).unwrap().as_deref(), Some("1.2.0"));
        assert!(activate(&state, "1.0.0").is_err());
        // Installing the active version again keeps the rollback version.
        let again = binary(&state, "again", b"b");
        install_and_activate(&state, &again, "1.1.0").unwrap();
        assert_eq!(installed_versions(&state).unwrap(), ["1.1.0", "1.2.0"]);
        let status = status(&state).unwrap();
        assert_eq!(status["activeVersion"], "1.1.0");
        assert_eq!(status["installedVersions"], json!(["1.1.0", "1.2.0"]));
        assert_eq!(status["managed"], false);
        remove(&state).unwrap();
        assert!(!state.join("current").exists());
        assert!(!state.join("versions").exists());
        assert!(installed_versions(&state).unwrap().is_empty());
        fs::remove_dir_all(state).unwrap();
    }

    #[test]
    fn versions_cannot_escape_the_versions_directory() {
        let state = scratch("escape");
        let source = binary(&state, "source", b"x");
        for version in [
            "",
            "..",
            "../x",
            "1/2",
            "1.0.0/../..",
            "v1.0.0",
            "1..0",
            "1.0.0 ",
        ] {
            assert!(install(&state, &source, version).is_err(), "{version:?}");
        }
        assert!(check_version("0.11.0-rc.1").is_ok());
        // A current link that points elsewhere is reported, not followed.
        std::os::unix::fs::symlink("/usr/bin", state.join("current")).unwrap();
        assert!(active_version(&state).is_err());
        fs::remove_dir_all(state).unwrap();
    }

    #[test]
    fn managed_paths_are_recognized() {
        let state = Path::new("/home/joan/.local/state/fleet-agent");
        assert!(is_managed(&state.join("versions/1.0.0/fleet-agent"), state));
        assert!(!is_managed(
            Path::new("/opt/homebrew/bin/fleet-agent"),
            state
        ));
        assert!(!is_managed(&state.join("fleet-agent"), state));
    }
}
