//! Agent self-update, started by an Operator through the Server.
//!
//! When a poll carries `agentUpdate`, the Agent finishes the cycle and then
//! [`Updater::apply`]: it downloads the signed release manifest from the
//! Server, verifies it with the release keys compiled into this executable,
//! streams its own platform's binary into `versions/<v>/`, checks size and
//! SHA-256, runs `<new> --version`, records a trial in `update.json`, switches
//! `current` and exits with [`RESTART_EXIT_CODE`] so the service manager
//! starts the new version.
//!
//! The new version counts its starts in [`Session::start`] and commits the
//! update after its first successful poll ([`Session::poll_succeeded`]). After
//! more than three starts, or without a successful poll for ten minutes, it
//! switches `current` back and exits; the restored version reports the
//! failure. Neither the Server nor GitHub alone can make an Agent run a binary:
//! only a manifest signed by an embedded key names one.

use std::{
    cmp::Ordering,
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use ring::signature::{ED25519, UnparsedPublicKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{
    managed,
    protocol::{AgentUpdate, AgentUpdateState, Api, ProtocolError},
    state,
};

include!(concat!(env!("OUT_DIR"), "/release_keys.rs"));

/// The update record in the state directory.
pub const STATE_FILE: &str = "update.json";
/// Exit code after switching versions (`EX_TEMPFAIL`). The service manager
/// restarts the Agent, which then runs the version `current` names.
pub const RESTART_EXIT_CODE: i32 = 75;
/// Largest release binary accepted, whatever the manifest says.
pub const MAX_BINARY_BYTES: u64 = 64 * 1024 * 1024;
const SMOKE_TEST_TIMEOUT: Duration = Duration::from_secs(10);
/// A new version that starts more often than this without a successful poll
/// is rolled back.
const MAX_TRIAL_STARTS: u32 = 3;
/// A new version without a successful poll for this long is rolled back.
const TRIAL_CONTACT_LIMIT: Duration = Duration::from_secs(600);
// DER SubjectPublicKeyInfo prefix of an Ed25519 key.
const SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

/// Why an update failed. Every code has an entry in the Server's error
/// catalog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    Unmanaged,
    Untrusted,
    InvalidManifest,
    Downgrade,
    Platform,
    Download,
    TooLarge,
    Digest,
    SmokeTest,
    Install,
    CrashLoop,
    NoContact,
    RolledBack,
}

impl Failure {
    pub const fn code(self) -> &'static str {
        match self {
            Self::Unmanaged => "agent_update_unmanaged",
            Self::Untrusted => "agent_update_untrusted",
            Self::InvalidManifest => "agent_update_invalid_manifest",
            Self::Downgrade => "agent_update_downgrade",
            Self::Platform => "agent_update_platform",
            Self::Download => "agent_update_download",
            Self::TooLarge => "agent_update_too_large",
            Self::Digest => "agent_update_digest",
            Self::SmokeTest => "agent_update_smoke_test",
            Self::Install => "agent_update_install",
            Self::CrashLoop => "agent_update_crash_loop",
            Self::NoContact => "agent_update_no_contact",
            Self::RolledBack => "agent_update_rolled_back",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordState {
    Trial,
    Succeeded,
    Failed,
}

/// `update.json`: the update in trial, or the result of the last one. Older
/// Agents ignore the file, and unknown fields are kept out of the way.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub from: String,
    pub to: String,
    pub state: RecordState,
    #[serde(default)]
    pub starts: u32,
    /// Unix seconds when `current` was switched to `to`.
    #[serde(default)]
    pub since: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    /// Whether the Server has received the final result.
    #[serde(default)]
    pub reported: bool,
}

#[derive(Debug, Deserialize)]
struct Manifest {
    schema: u32,
    name: String,
    version: String,
    binaries: Vec<ManifestBinary>,
}

#[derive(Debug, Deserialize)]
struct ManifestBinary {
    os: String,
    arch: String,
    sha256: String,
    size: u64,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

/// The release keys compiled into this executable, as raw Ed25519 keys.
pub fn trusted_keys() -> Vec<[u8; 32]> {
    RELEASE_KEYS
        .iter()
        .filter_map(|pem| public_key_from_pem(pem))
        .collect()
}

/// The raw key of a PEM `PUBLIC KEY` block holding an Ed25519 key, as
/// `openssl pkey -pubout` writes it.
pub fn public_key_from_pem(pem: &str) -> Option<[u8; 32]> {
    let body = pem
        .split("-----BEGIN PUBLIC KEY-----")
        .nth(1)?
        .split("-----END PUBLIC KEY-----")
        .next()?;
    let der = decode_base64(body)?;
    let key = der.strip_prefix(SPKI_PREFIX.as_slice())?;
    key.try_into().ok()
}

fn decode_base64(text: &str) -> Option<Vec<u8>> {
    fn value(byte: u8) -> Option<u32> {
        Some(match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    }
    let clean = text
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect::<Vec<_>>();
    let data = clean
        .strip_suffix(b"==")
        .or_else(|| clean.strip_suffix(b"="));
    let data = data.unwrap_or(&clean);
    if clean.len() % 4 != 0 || data.len() % 4 == 1 {
        return None;
    }
    let mut output = Vec::with_capacity(data.len() * 3 / 4);
    for chunk in data.chunks(4) {
        let mut buffer = 0u32;
        for (index, byte) in chunk.iter().enumerate() {
            buffer |= value(*byte)? << (18 - 6 * index);
        }
        let bytes = buffer.to_be_bytes();
        output.extend_from_slice(&bytes[1..chunk.len()]);
    }
    Some(output)
}

fn decode_sha256(text: &str) -> Option<[u8; 32]> {
    if text.len() != 64
        || !text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    let mut digest = [0u8; 32];
    for (index, byte) in digest.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(digest)
}

/// Checks the manifest signature against the trusted keys.
pub fn verify_signature(
    manifest: &[u8],
    signature: &[u8],
    keys: &[[u8; 32]],
) -> Result<(), Failure> {
    keys.iter()
        .any(|key| {
            UnparsedPublicKey::new(&ED25519, key)
                .verify(manifest, signature)
                .is_ok()
        })
        .then_some(())
        .ok_or(Failure::Untrusted)
}

/// Orders `MAJOR.MINOR.PATCH[-prerelease]` versions by semver precedence, or
/// `None` when one is not such a version.
pub fn compare_versions(left: &str, right: &str) -> Option<Ordering> {
    fn parse(version: &str) -> Option<([u64; 3], Vec<&str>)> {
        let (core, prerelease) = match version.split_once('-') {
            Some((core, prerelease)) => (core, prerelease.split('.').collect::<Vec<_>>()),
            None => (version, Vec::new()),
        };
        let mut numbers = [0u64; 3];
        let mut parts = core.split('.');
        for number in &mut numbers {
            let part = parts.next()?;
            if part.is_empty() || (part.len() > 1 && part.starts_with('0')) {
                return None;
            }
            *number = part.parse().ok()?;
        }
        if parts.next().is_some()
            || prerelease.iter().any(|identifier| {
                identifier.is_empty()
                    || !identifier
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
        {
            return None;
        }
        Some((numbers, prerelease))
    }
    fn identifier(left: &str, right: &str) -> Ordering {
        match (left.parse::<u64>(), right.parse::<u64>()) {
            (Ok(left), Ok(right)) => left.cmp(&right),
            (Ok(_), Err(_)) => Ordering::Less,
            (Err(_), Ok(_)) => Ordering::Greater,
            (Err(_), Err(_)) => left.cmp(right),
        }
    }
    let (left_numbers, left_pre) = parse(left)?;
    let (right_numbers, right_pre) = parse(right)?;
    Some(left_numbers.cmp(&right_numbers).then_with(|| {
        match (left_pre.is_empty(), right_pre.is_empty()) {
            (true, true) => Ordering::Equal,
            (true, false) => Ordering::Greater,
            (false, true) => Ordering::Less,
            (false, false) => left_pre
                .iter()
                .zip(&right_pre)
                .map(|(left, right)| identifier(left, right))
                .find(|order| order.is_ne())
                .unwrap_or_else(|| left_pre.len().cmp(&right_pre.len())),
        }
    }))
}

/// `{os}-{arch}` as release manifests name this machine.
fn this_platform() -> Option<String> {
    let os = match std::env::consts::OS {
        "linux" => "linux",
        "macos" => "macos",
        _ => return None,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        _ => return None,
    };
    Some(format!("{os}-{arch}"))
}

fn download_failure(error: ProtocolError) -> Failure {
    match error {
        ProtocolError::ResponseTooLarge { .. } => Failure::TooLarge,
        _ => Failure::Download,
    }
}

pub fn read_record(state_dir: &Path) -> Result<Option<Record>> {
    state::read_json(&state_dir.join(STATE_FILE))
}

fn write_record(state_dir: &Path, record: &Record) -> Result<()> {
    state::write_json(&state_dir.join(STATE_FILE), record)
}

/// `update status`: the installed versions and the last update. Read-only.
pub fn status(state_dir: &Path) -> Result<Value> {
    let mut status = managed::status(state_dir)?;
    status["lastUpdate"] = match read_record(state_dir) {
        Ok(record) => serde_json::to_value(record)?,
        Err(error) => Value::String(format!("unreadable: {error}")),
    };
    Ok(status)
}

/// Downloads, verifies, stages and switches to a requested version.
pub struct Updater {
    state_dir: PathBuf,
    version: String,
    executable: Option<PathBuf>,
    platform: Option<String>,
    keys: Vec<[u8; 32]>,
    smoke_timeout: Duration,
}

impl Updater {
    pub fn new(state_dir: &Path) -> Self {
        Self {
            state_dir: state_dir.to_path_buf(),
            version: managed::VERSION.to_owned(),
            executable: std::env::current_exe()
                .ok()
                .and_then(|path| path.canonicalize().ok()),
            platform: this_platform(),
            keys: trusted_keys(),
            smoke_timeout: SMOKE_TEST_TIMEOUT,
        }
    }

    /// Applies a requested update and reports its progress. Returns true when
    /// `current` now names the new version and the process must exit with
    /// [`RESTART_EXIT_CODE`]. Failures are reported and logged, never
    /// returned: the running version keeps working.
    pub async fn apply(&self, api: &Api, target: &str) -> bool {
        if target == self.version {
            // The Server's view was older than this Agent: nothing to do.
            if let Err(error) = api
                .agent_update_report(target, AgentUpdateState::Succeeded, None)
                .await
            {
                eprintln!("could not report that the Agent already runs {target}: {error}");
            }
            return false;
        }
        match api
            .agent_update_report(target, AgentUpdateState::Downloading, None)
            .await
        {
            Ok(true) => {}
            Ok(false) => {
                eprintln!("the update to {target} is no longer requested; not starting it");
                return false;
            }
            Err(error) => {
                eprintln!("could not start the update to {target}; will retry: {error}");
                return false;
            }
        }
        eprintln!("updating the Agent from {} to {target}", self.version);
        match self.stage_and_switch(api, target).await {
            Ok(()) => {
                if let Err(error) = api
                    .agent_update_report(target, AgentUpdateState::Restarting, None)
                    .await
                {
                    eprintln!("could not report the restart into {target}: {error}");
                }
                true
            }
            Err(failure) => {
                eprintln!("the update to {target} failed: {}", failure.code());
                if let Err(error) = api
                    .agent_update_report(target, AgentUpdateState::Failed, Some(failure.code()))
                    .await
                {
                    eprintln!("could not report the failed update: {error}");
                }
                false
            }
        }
    }

    async fn stage_and_switch(&self, api: &Api, target: &str) -> Result<(), Failure> {
        let executable = self.executable.as_deref().ok_or(Failure::Unmanaged)?;
        if !managed::is_managed(executable, &self.state_dir) {
            return Err(Failure::Unmanaged);
        }
        let manifest = api
            .release_manifest(target)
            .await
            .map_err(download_failure)?;
        let signature = api
            .release_signature(target)
            .await
            .map_err(download_failure)?;
        verify_signature(&manifest, &signature, &self.keys)?;
        let manifest: Manifest =
            serde_json::from_slice(&manifest).map_err(|_| Failure::InvalidManifest)?;
        if manifest.schema != 1 || manifest.name != "fleet-agent" || manifest.version != target {
            return Err(Failure::InvalidManifest);
        }
        match compare_versions(target, &self.version) {
            Some(Ordering::Greater) => {}
            Some(_) => return Err(Failure::Downgrade),
            None => return Err(Failure::InvalidManifest),
        }
        let platform = self.platform.as_deref().ok_or(Failure::Platform)?;
        let entry = manifest
            .binaries
            .iter()
            .find(|binary| format!("{}-{}", binary.os, binary.arch) == platform)
            .ok_or(Failure::Platform)?;
        if entry.size > MAX_BINARY_BYTES {
            return Err(Failure::TooLarge);
        }
        let digest = decode_sha256(&entry.sha256).ok_or(Failure::InvalidManifest)?;
        let staged = self
            .download(api, target, platform, entry.size, digest)
            .await?;
        let checked = tokio::task::spawn_blocking({
            let (staged, target, timeout) = (staged.clone(), target.to_owned(), self.smoke_timeout);
            move || smoke_test(&staged, &target, timeout)
        })
        .await
        .unwrap_or(Err(Failure::SmokeTest));
        if let Err(failure) = checked {
            let _ = managed::remove_version(&self.state_dir, target);
            return Err(failure);
        }
        let record = Record {
            from: self.version.clone(),
            to: target.to_owned(),
            state: RecordState::Trial,
            starts: 0,
            since: now(),
            error_code: None,
            reported: false,
        };
        write_record(&self.state_dir, &record).map_err(|_| Failure::Install)?;
        managed::activate(&self.state_dir, target).map_err(|error| {
            eprintln!("could not switch to {target}: {error}");
            Failure::Install
        })?;
        Ok(())
    }

    /// Streams the binary to `versions/<v>/fleet-agent.partial`, checks it
    /// against the manifest, and renames it into place.
    async fn download(
        &self,
        api: &Api,
        version: &str,
        platform: &str,
        size: u64,
        digest: [u8; 32],
    ) -> Result<PathBuf, Failure> {
        let folder =
            managed::prepare_version(&self.state_dir, version).map_err(|_| Failure::Install)?;
        let partial = folder.join(format!("{}.partial", managed::EXECUTABLE));
        let destination = folder.join(managed::EXECUTABLE);
        let result = async {
            let mut file = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o700)
                .open(&partial)
                .map_err(|_| Failure::Install)?;
            let mut hasher = Sha256::new();
            let received = api
                .release_binary(version, platform, size, |chunk| {
                    hasher.update(chunk);
                    file.write_all(chunk)
                })
                .await
                .map_err(download_failure)?;
            if received != size || <[u8; 32]>::from(hasher.finalize()) != digest {
                return Err(Failure::Digest);
            }
            file.set_permissions(fs::Permissions::from_mode(0o755))
                .and_then(|()| file.sync_all())
                .map_err(|_| Failure::Install)?;
            drop(file);
            fs::rename(&partial, &destination).map_err(|_| Failure::Install)?;
            managed::sync_directory(&folder).map_err(|_| Failure::Install)
        }
        .await;
        if let Err(failure) = result {
            let _ = fs::remove_file(&partial);
            let _ = managed::remove_version(&self.state_dir, version);
            return Err(failure);
        }
        Ok(destination)
    }
}

/// Runs `<binary> --version` and expects `fleet-agent <version>`. This catches
/// binaries that cannot load on this machine before `current` changes.
fn smoke_test(binary: &Path, version: &str, timeout: Duration) -> Result<(), Failure> {
    let mut spawned = None;
    for _ in 0..10 {
        match Command::new(binary)
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => {
                spawned = Some(child);
                break;
            }
            // Another thread may briefly hold the new file open across a fork.
            Err(error) if error.kind() == ErrorKind::ExecutableFileBusy => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return Err(Failure::SmokeTest),
        }
    }
    let mut child = spawned.ok_or(Failure::SmokeTest)?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) | Err(_) => return Err(Failure::SmokeTest),
            Ok(None) if started.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Failure::SmokeTest);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    let mut output = String::new();
    std::io::Read::read_to_string(
        &mut std::io::Read::take(child.stdout.take().ok_or(Failure::SmokeTest)?, 4096),
        &mut output,
    )
    .map_err(|_| Failure::SmokeTest)?;
    (output.trim() == format!("{} {version}", managed::EXECUTABLE))
        .then_some(())
        .ok_or(Failure::SmokeTest)
}

/// What [`Session::start`] decided.
pub enum Startup {
    Continue(Session),
    /// `current` was switched back to the previous version; exit with
    /// [`RESTART_EXIT_CODE`].
    Restart,
}

/// The update state of one `run`: the trial of a new version, the result
/// still to report, and the update the last poll requested.
pub struct Session {
    state_dir: PathBuf,
    version: String,
    record: Option<Record>,
    requested: Option<String>,
}

impl Session {
    /// A session that never updates, for `run --once`.
    pub fn inactive(state_dir: &Path) -> Self {
        Self {
            state_dir: state_dir.to_path_buf(),
            version: managed::VERSION.to_owned(),
            record: None,
            requested: None,
        }
    }

    /// Runs before anything else at startup: counts the starts of a version in
    /// trial and rolls it back after too many, or after too long.
    pub fn start(state_dir: &Path) -> Result<Startup> {
        Self::start_with(state_dir, managed::VERSION, now())
    }

    fn start_with(state_dir: &Path, version: &str, now: u64) -> Result<Startup> {
        let mut session = Self {
            state_dir: state_dir.to_path_buf(),
            version: version.to_owned(),
            record: None,
            requested: None,
        };
        let mut record = match read_record(state_dir) {
            Ok(Some(record)) => record,
            Ok(None) => return Ok(Startup::Continue(session)),
            Err(error) => {
                eprintln!("ignoring the update record: {error}");
                return Ok(Startup::Continue(session));
            }
        };
        if record.state == RecordState::Trial && record.to == version {
            record.starts += 1;
            if record.starts > MAX_TRIAL_STARTS {
                return rollback(state_dir, record, Failure::CrashLoop);
            }
            if now >= record.since.saturating_add(TRIAL_CONTACT_LIMIT.as_secs()) {
                return rollback(state_dir, record, Failure::NoContact);
            }
            write_record(state_dir, &record)?;
        } else if record.state == RecordState::Trial && record.from == version {
            // `update rollback` switched back before the new version committed.
            record.state = RecordState::Failed;
            record.error_code = Some(Failure::RolledBack.code().to_owned());
            record.reported = false;
            write_record(state_dir, &record)?;
        }
        session.record = Some(record);
        Ok(Startup::Continue(session))
    }

    /// After every successful poll: commits a version in trial, and keeps the
    /// update the poll requested.
    pub fn poll_succeeded(&mut self, requested: Option<&AgentUpdate>) {
        self.requested = requested.map(|update| update.version.clone());
        let Some(record) = self.record.as_mut() else {
            return;
        };
        if record.state != RecordState::Trial || record.to != self.version {
            return;
        }
        record.state = RecordState::Succeeded;
        record.error_code = None;
        record.reported = false;
        if let Err(error) = write_record(&self.state_dir, record) {
            eprintln!("could not record the update to {}: {error}", record.to);
        }
        if let Err(error) = managed::prune(&self.state_dir, &[&record.to, &record.from]) {
            eprintln!("could not remove old Agent versions: {error}");
        }
        eprintln!("the update from {} to {} succeeded", record.from, record.to);
    }

    /// Rolls back a version in trial that has gone too long without a
    /// successful poll. Returns true when the process must exit with
    /// [`RESTART_EXIT_CODE`].
    pub fn trial_expired(&mut self) -> Result<bool> {
        self.trial_expired_at(now())
    }

    fn trial_expired_at(&mut self, now: u64) -> Result<bool> {
        match &self.record {
            Some(record)
                if record.state == RecordState::Trial
                    && record.to == self.version
                    && now >= record.since.saturating_add(TRIAL_CONTACT_LIMIT.as_secs()) =>
            {
                let record = record.clone();
                Ok(matches!(
                    rollback(&self.state_dir, record, Failure::NoContact)?,
                    Startup::Restart
                ))
            }
            _ => Ok(false),
        }
    }

    /// Sends the result of the last update to the Server once.
    pub async fn deliver(&mut self, api: &Api) {
        let Some(record) = self.record.as_mut() else {
            return;
        };
        if record.reported || record.state == RecordState::Trial {
            return;
        }
        let state = match record.state {
            RecordState::Succeeded => AgentUpdateState::Succeeded,
            _ => AgentUpdateState::Failed,
        };
        match api
            .agent_update_report(&record.to, state, record.error_code.as_deref())
            .await
        {
            // A 409 means the Server has nothing to follow; there is no point in repeating it.
            Ok(_) => {
                record.reported = true;
                if let Err(error) = write_record(&self.state_dir, record) {
                    eprintln!("could not record the reported update: {error}");
                }
            }
            Err(error) => eprintln!("could not report the update result; will retry: {error}"),
        }
    }

    /// The update the last successful poll requested, once.
    pub fn take_request(&mut self) -> Option<String> {
        self.requested.take()
    }
}

fn rollback(state_dir: &Path, mut record: Record, failure: Failure) -> Result<Startup> {
    eprintln!(
        "rolling back from {} to {}: {}",
        record.to,
        record.from,
        failure.code()
    );
    managed::activate(state_dir, &record.from)
        .with_context(|| format!("roll back to {}", record.from))?;
    record.state = RecordState::Failed;
    record.error_code = Some(failure.code().to_owned());
    record.reported = false;
    write_record(state_dir, &record)?;
    Ok(Startup::Restart)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::detail::testing::{MockServer, Route};
    use ring::{
        rand::SystemRandom,
        signature::{Ed25519KeyPair, KeyPair},
    };

    const OWN: &str = "0.11.0";
    const NEW: &str = "0.12.0";
    const PLATFORM: &str = "linux-amd64";

    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "fleet-updater-{name}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    /// A throwaway signing key, generated for the test.
    fn key() -> Ed25519KeyPair {
        let document = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        Ed25519KeyPair::from_pkcs8(document.as_ref()).unwrap()
    }

    fn public(key: &Ed25519KeyPair) -> [u8; 32] {
        key.public_key().as_ref().try_into().unwrap()
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    /// A shell script that answers `--version` like the real executable.
    fn agent_script(version: &str) -> Vec<u8> {
        format!("#!/bin/sh\necho 'fleet-agent {version}'\n").into_bytes()
    }

    fn manifest(version: &str, binary: &[u8], size: Option<u64>) -> Vec<u8> {
        serde_json::to_vec_pretty(&serde_json::json!({
            "schema": 1, "name": "fleet-agent", "version": version, "gitCommit": "a".repeat(40),
            "binaries": [
                {"os": "linux", "arch": "amd64", "sha256": sha256_hex(binary), "size": size.unwrap_or(binary.len() as u64)},
                {"os": "macos", "arch": "arm64", "sha256": "0".repeat(64), "size": 1}
            ]
        }))
        .unwrap()
    }

    struct Release {
        manifest: Vec<u8>,
        signature: Vec<u8>,
        binary: Vec<u8>,
    }

    fn signed_release(version: &str, key: &Ed25519KeyPair) -> Release {
        let binary = agent_script(version);
        let manifest = manifest(version, &binary, None);
        Release {
            signature: key.sign(&manifest).as_ref().to_vec(),
            manifest,
            binary,
        }
    }

    /// Plays the Server: serves `release` as `version` and answers reports with `report_status`.
    fn fake_server(version: &str, release: &Release, report_status: u16) -> MockServer {
        let base = format!("/agent/v1/agent-releases/{version}");
        let routes: Vec<Route> = vec![
            (
                "GET",
                format!("{base}/manifest"),
                200,
                release.manifest.clone(),
            ),
            (
                "GET",
                format!("{base}/signature"),
                200,
                release.signature.clone(),
            ),
            (
                "GET",
                format!("{base}/binaries/{PLATFORM}"),
                200,
                release.binary.clone(),
            ),
            (
                "POST",
                "/agent/v1/agent-update/report".to_owned(),
                report_status,
                Vec::new(),
            ),
        ];
        MockServer::routes(routes)
    }

    /// A state directory with `OWN` installed and active, and an updater
    /// that believes it runs from there.
    fn installed(name: &str, keys: Vec<[u8; 32]>) -> (PathBuf, Updater) {
        let state = scratch(name);
        let source = state.join("source");
        fs::write(&source, agent_script(OWN)).unwrap();
        managed::install_and_activate(&state, &source, OWN).unwrap();
        let updater = Updater {
            state_dir: state.clone(),
            version: OWN.to_owned(),
            executable: Some(managed::current_executable(&state).canonicalize().unwrap()),
            platform: Some(PLATFORM.to_owned()),
            keys,
            smoke_timeout: Duration::from_secs(10),
        };
        (state, updater)
    }

    fn reports(server: &MockServer) -> Vec<(String, Option<String>)> {
        server
            .requests()
            .iter()
            .filter(|request| request.path == "/agent/v1/agent-update/report")
            .map(|request| {
                let body: Value = serde_json::from_str(&request.body).unwrap();
                assert!(body["version"].as_str().is_some());
                assert!(body.as_object().unwrap().contains_key("errorCode"));
                (
                    body["state"].as_str().unwrap().to_owned(),
                    body["errorCode"].as_str().map(str::to_owned),
                )
            })
            .collect()
    }

    fn failed(code: &str) -> Vec<(String, Option<String>)> {
        vec![
            ("downloading".to_owned(), None),
            ("failed".to_owned(), Some(code.to_owned())),
        ]
    }

    /// After a failed update, only the old version is installed and active.
    fn assert_untouched(state: &Path) {
        assert_eq!(
            managed::active_version(state).unwrap().as_deref(),
            Some(OWN)
        );
        assert_eq!(managed::installed_versions(state).unwrap(), [OWN]);
        assert!(read_record(state).unwrap().is_none());
    }

    #[tokio::test]
    async fn a_signed_release_is_staged_checked_and_switched_to() {
        let signer = key();
        let (state, updater) = installed("success", vec![public(&key()), public(&signer)]);
        let release = signed_release(NEW, &signer);
        let server = fake_server(NEW, &release, 204);
        let api = Api::for_loopback_test(&server.url());

        assert!(updater.apply(&api, NEW).await);
        assert_eq!(
            managed::active_version(&state).unwrap().as_deref(),
            Some(NEW)
        );
        assert_eq!(
            fs::read(managed::current_executable(&state)).unwrap(),
            release.binary
        );
        let mode = fs::metadata(managed::current_executable(&state))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o755);
        assert!(!state.join("versions/0.12.0/fleet-agent.partial").exists());
        let record = read_record(&state).unwrap().unwrap();
        assert_eq!(
            (
                record.from.as_str(),
                record.to.as_str(),
                record.state,
                record.starts
            ),
            (OWN, NEW, RecordState::Trial, 0)
        );
        assert!(record.since.abs_diff(now()) < 60);
        assert_eq!(
            reports(&server),
            [
                ("downloading".to_owned(), None),
                ("restarting".to_owned(), None)
            ]
        );
        fs::remove_dir_all(state).unwrap();
    }

    #[tokio::test]
    async fn a_tampered_manifest_is_refused_before_the_binary_is_downloaded() {
        let signer = key();
        let (state, updater) = installed("tampered", vec![public(&signer)]);
        let mut release = signed_release(NEW, &signer);
        // Same signature, one byte of the signed manifest changed.
        let position = release.manifest.len() - 3;
        release.manifest[position] ^= 1;
        let server = fake_server(NEW, &release, 204);
        assert!(
            !updater
                .apply(&Api::for_loopback_test(&server.url()), NEW)
                .await
        );
        assert_eq!(reports(&server), failed("agent_update_untrusted"));
        assert!(
            !server
                .requests()
                .iter()
                .any(|request| request.path.contains("/binaries/"))
        );
        assert_untouched(&state);
        fs::remove_dir_all(state).unwrap();
    }

    #[tokio::test]
    async fn a_release_signed_with_an_unknown_key_is_refused() {
        let (state, updater) = installed("wrong-key", vec![public(&key())]);
        let server = fake_server(NEW, &signed_release(NEW, &key()), 204);
        assert!(
            !updater
                .apply(&Api::for_loopback_test(&server.url()), NEW)
                .await
        );
        assert_eq!(reports(&server), failed("agent_update_untrusted"));
        assert_untouched(&state);

        // An Agent built without any release key refuses every update.
        let (empty, mut unkeyed) = installed("no-keys", Vec::new());
        unkeyed.keys = Vec::new();
        let signer = key();
        let server = fake_server(NEW, &signed_release(NEW, &signer), 204);
        assert!(
            !unkeyed
                .apply(&Api::for_loopback_test(&server.url()), NEW)
                .await
        );
        assert_eq!(reports(&server), failed("agent_update_untrusted"));
        fs::remove_dir_all(state).unwrap();
        fs::remove_dir_all(empty).unwrap();
    }

    #[tokio::test]
    async fn older_and_mislabelled_releases_are_refused() {
        let signer = key();
        let (state, updater) = installed("downgrade", vec![public(&signer)]);
        // A genuine older release, replayed as an update.
        for older in ["0.10.0", "0.11.0-rc.1"] {
            let server = fake_server(older, &signed_release(older, &signer), 204);
            assert!(
                !updater
                    .apply(&Api::for_loopback_test(&server.url()), older)
                    .await
            );
            assert_eq!(reports(&server), failed("agent_update_downgrade"));
        }
        // A genuine older release served under a newer name.
        let server = fake_server(NEW, &signed_release("0.10.0", &signer), 204);
        assert!(
            !updater
                .apply(&Api::for_loopback_test(&server.url()), NEW)
                .await
        );
        assert_eq!(reports(&server), failed("agent_update_invalid_manifest"));
        assert_untouched(&state);

        // The version this Agent already runs is reported as done and nothing is downloaded.
        let server = fake_server(OWN, &signed_release(OWN, &signer), 204);
        assert!(
            !updater
                .apply(&Api::for_loopback_test(&server.url()), OWN)
                .await
        );
        assert_eq!(server.requests().len(), 1);
        assert_eq!(reports(&server), [("succeeded".to_owned(), None)]);
        fs::remove_dir_all(state).unwrap();
    }

    #[tokio::test]
    async fn a_binary_that_does_not_match_the_signed_digest_is_deleted() {
        let signer = key();
        let (state, updater) = installed("digest", vec![public(&signer)]);
        let mut release = signed_release(NEW, &signer);
        release.binary = agent_script("9.9.9");
        let server = fake_server(NEW, &release, 204);
        assert!(
            !updater
                .apply(&Api::for_loopback_test(&server.url()), NEW)
                .await
        );
        assert_eq!(reports(&server), failed("agent_update_digest"));
        assert_untouched(&state);

        // A shorter body fails the same way.
        let mut short = signed_release(NEW, &signer);
        short.binary.pop();
        let server = fake_server(NEW, &short, 204);
        assert!(
            !updater
                .apply(&Api::for_loopback_test(&server.url()), NEW)
                .await
        );
        assert_eq!(reports(&server), failed("agent_update_digest"));
        assert_untouched(&state);
        fs::remove_dir_all(state).unwrap();
    }

    #[tokio::test]
    async fn oversized_binaries_are_refused() {
        let signer = key();
        let (state, updater) = installed("oversized", vec![public(&signer)]);
        // The manifest promises more than the Agent accepts: nothing is downloaded.
        let binary = agent_script(NEW);
        let manifest = manifest(NEW, &binary, Some(MAX_BINARY_BYTES + 1));
        let huge = Release {
            signature: signer.sign(&manifest).as_ref().to_vec(),
            manifest,
            binary,
        };
        let server = fake_server(NEW, &huge, 204);
        assert!(
            !updater
                .apply(&Api::for_loopback_test(&server.url()), NEW)
                .await
        );
        assert_eq!(reports(&server), failed("agent_update_too_large"));
        assert!(
            !server
                .requests()
                .iter()
                .any(|request| request.path.contains("/binaries/"))
        );
        assert_untouched(&state);

        // The Server sends more bytes than the signed size: the download stops.
        let mut long = signed_release(NEW, &signer);
        long.binary.extend_from_slice(&[b'#'; 4096]);
        let server = fake_server(NEW, &long, 204);
        assert!(
            !updater
                .apply(&Api::for_loopback_test(&server.url()), NEW)
                .await
        );
        assert_eq!(reports(&server), failed("agent_update_too_large"));
        assert_untouched(&state);
        fs::remove_dir_all(state).unwrap();
    }

    #[tokio::test]
    async fn a_binary_that_fails_the_smoke_test_is_removed() {
        let signer = key();
        let (state, updater) = installed("smoke", vec![public(&signer)]);
        for script in [
            b"#!/bin/sh\necho 'fleet-agent 0.12.1'\n".to_vec(),
            b"#!/bin/sh\nexit 1\n".to_vec(),
            b"\x7fELF not really".to_vec(),
        ] {
            let manifest = manifest(NEW, &script, None);
            let release = Release {
                signature: signer.sign(&manifest).as_ref().to_vec(),
                manifest,
                binary: script,
            };
            let server = fake_server(NEW, &release, 204);
            assert!(
                !updater
                    .apply(&Api::for_loopback_test(&server.url()), NEW)
                    .await
            );
            assert_eq!(reports(&server), failed("agent_update_smoke_test"));
            assert_untouched(&state);
        }
        // A binary that hangs is stopped at the time limit.
        let hanging = b"#!/bin/sh\nsleep 30\n".to_vec();
        let started = Instant::now();
        assert_eq!(
            smoke_test(
                &{
                    let path = state.join("hanging");
                    fs::write(&path, &hanging).unwrap();
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
                    path
                },
                NEW,
                Duration::from_millis(300)
            ),
            Err(Failure::SmokeTest)
        );
        assert!(started.elapsed() < Duration::from_secs(10));
        fs::remove_dir_all(state).unwrap();
    }

    #[tokio::test]
    async fn unmanaged_agents_cancelled_requests_and_missing_platforms_change_nothing() {
        let signer = key();
        let (state, mut updater) = installed("unmanaged", vec![public(&signer)]);
        let release = signed_release(NEW, &signer);

        updater.executable = Some(PathBuf::from("/opt/homebrew/bin/fleet-agent"));
        let server = fake_server(NEW, &release, 204);
        assert!(
            !updater
                .apply(&Api::for_loopback_test(&server.url()), NEW)
                .await
        );
        assert_eq!(reports(&server), failed("agent_update_unmanaged"));
        assert_eq!(server.requests().len(), 2);
        assert_untouched(&state);

        updater.executable = Some(managed::current_executable(&state).canonicalize().unwrap());
        updater.platform = Some("macos-amd64".to_owned());
        let server = fake_server(NEW, &release, 204);
        assert!(
            !updater
                .apply(&Api::for_loopback_test(&server.url()), NEW)
                .await
        );
        assert_eq!(reports(&server), failed("agent_update_platform"));
        assert_untouched(&state);

        // Cancelled between the poll and the pickup: the Server answers 409 and nothing is downloaded.
        updater.platform = Some(PLATFORM.to_owned());
        let server = fake_server(NEW, &release, 409);
        assert!(
            !updater
                .apply(&Api::for_loopback_test(&server.url()), NEW)
                .await
        );
        assert_eq!(server.requests().len(), 1);
        assert_untouched(&state);
        fs::remove_dir_all(state).unwrap();
    }

    fn trial(state: &Path, since: u64) {
        for version in ["0.10.0", OWN, NEW] {
            let source = state.join("source");
            fs::write(&source, agent_script(version)).unwrap();
            managed::install(state, &source, version).unwrap();
        }
        managed::activate(state, NEW).unwrap();
        write_record(
            state,
            &Record {
                from: OWN.to_owned(),
                to: NEW.to_owned(),
                state: RecordState::Trial,
                starts: 0,
                since,
                error_code: None,
                reported: false,
            },
        )
        .unwrap();
    }

    fn continued(startup: Startup) -> Session {
        match startup {
            Startup::Continue(session) => session,
            Startup::Restart => panic!("expected the Agent to continue"),
        }
    }

    #[tokio::test]
    async fn a_new_version_that_keeps_crashing_is_rolled_back_and_the_old_one_reports_it() {
        let state = scratch("crash-loop");
        let switched = now();
        trial(&state, switched);
        for start in 1..=3 {
            continued(Session::start_with(&state, NEW, switched + 10).unwrap());
            assert_eq!(read_record(&state).unwrap().unwrap().starts, start);
        }
        assert!(matches!(
            Session::start_with(&state, NEW, switched + 10).unwrap(),
            Startup::Restart
        ));
        assert_eq!(
            managed::active_version(&state).unwrap().as_deref(),
            Some(OWN)
        );
        let record = read_record(&state).unwrap().unwrap();
        assert_eq!(
            (record.state, record.error_code.as_deref(), record.reported),
            (RecordState::Failed, Some("agent_update_crash_loop"), false)
        );

        // The restored version reports the failure once, after which nothing is resent.
        let mut session = continued(Session::start_with(&state, OWN, switched + 20).unwrap());
        assert!(!session.trial_expired_at(switched + 10_000).unwrap());
        let server = MockServer::routes(vec![(
            "POST",
            "/agent/v1/agent-update/report".to_owned(),
            204,
            Vec::new(),
        )]);
        let api = Api::for_loopback_test(&server.url());
        session.deliver(&api).await;
        session.deliver(&api).await;
        assert_eq!(
            reports(&server),
            [(
                "failed".to_owned(),
                Some("agent_update_crash_loop".to_owned())
            )]
        );
        assert!(read_record(&state).unwrap().unwrap().reported);
        let body: Value = serde_json::from_str(&server.requests()[0].body).unwrap();
        assert_eq!(body["version"], NEW);
        fs::remove_dir_all(state).unwrap();
    }

    #[test]
    fn a_new_version_without_a_successful_poll_for_ten_minutes_is_rolled_back() {
        let state = scratch("no-contact");
        let switched = now();
        trial(&state, switched);
        let mut session = continued(Session::start_with(&state, NEW, switched + 30).unwrap());
        assert!(!session.trial_expired_at(switched + 599).unwrap());
        assert!(session.trial_expired_at(switched + 600).unwrap());
        assert_eq!(
            managed::active_version(&state).unwrap().as_deref(),
            Some(OWN)
        );
        assert_eq!(
            read_record(&state).unwrap().unwrap().error_code.as_deref(),
            Some("agent_update_no_contact")
        );

        // A restart long after the switch rolls back at once.
        let late = scratch("no-contact-late");
        trial(&late, switched);
        assert!(matches!(
            Session::start_with(&late, NEW, switched + 3600).unwrap(),
            Startup::Restart
        ));
        assert_eq!(
            managed::active_version(&late).unwrap().as_deref(),
            Some(OWN)
        );
        fs::remove_dir_all(state).unwrap();
        fs::remove_dir_all(late).unwrap();
    }

    #[tokio::test]
    async fn the_first_successful_poll_commits_the_update_and_prunes_old_versions() {
        let state = scratch("commit");
        let switched = now();
        trial(&state, switched);
        assert_eq!(
            managed::installed_versions(&state).unwrap(),
            ["0.10.0", OWN, NEW]
        );
        let mut session = continued(Session::start_with(&state, NEW, switched + 15).unwrap());
        session.poll_succeeded(Some(&AgentUpdate {
            version: "0.13.0".to_owned(),
        }));
        assert_eq!(session.take_request().as_deref(), Some("0.13.0"));
        assert_eq!(session.take_request(), None);
        // Only the new version and the one to roll back to remain.
        assert_eq!(managed::installed_versions(&state).unwrap(), [OWN, NEW]);
        assert_eq!(
            managed::active_version(&state).unwrap().as_deref(),
            Some(NEW)
        );
        let record = read_record(&state).unwrap().unwrap();
        assert_eq!((record.state, record.starts), (RecordState::Succeeded, 1));
        // Committed: neither the time limit nor later starts roll it back.
        assert!(!session.trial_expired_at(switched + 10_000).unwrap());
        continued(Session::start_with(&state, NEW, switched + 10_000).unwrap());
        continued(Session::start_with(&state, NEW, switched + 10_000).unwrap());
        continued(Session::start_with(&state, NEW, switched + 10_000).unwrap());
        continued(Session::start_with(&state, NEW, switched + 10_000).unwrap());

        // The report is retried until the Server answers, then never sent again.
        let down = MockServer::routes(Vec::new());
        session
            .deliver(&Api::for_loopback_test("http://127.0.0.1:9/"))
            .await;
        drop(down);
        assert!(!read_record(&state).unwrap().unwrap().reported);
        let server = MockServer::routes(vec![(
            "POST",
            "/agent/v1/agent-update/report".to_owned(),
            204,
            Vec::new(),
        )]);
        let api = Api::for_loopback_test(&server.url());
        session.deliver(&api).await;
        session.deliver(&api).await;
        assert_eq!(reports(&server), [("succeeded".to_owned(), None)]);
        fs::remove_dir_all(state).unwrap();
    }

    #[test]
    fn a_manual_rollback_during_the_trial_is_recorded_as_a_failure() {
        let state = scratch("manual-rollback");
        trial(&state, now());
        managed::activate(&state, OWN).unwrap();
        continued(Session::start_with(&state, OWN, now()).unwrap());
        let record = read_record(&state).unwrap().unwrap();
        assert_eq!(
            (record.state, record.error_code.as_deref()),
            (RecordState::Failed, Some("agent_update_rolled_back"))
        );
        fs::remove_dir_all(state).unwrap();
    }

    #[test]
    fn versions_compare_by_semver_precedence() {
        for (left, right, order) in [
            ("0.12.0", "0.11.0", Ordering::Greater),
            ("0.11.10", "0.11.9", Ordering::Greater),
            ("1.0.0", "0.99.99", Ordering::Greater),
            ("0.12.0", "0.12.0-rc.1", Ordering::Greater),
            ("0.12.0-rc.2", "0.12.0-rc.10", Ordering::Less),
            ("0.12.0-alpha", "0.12.0-1", Ordering::Greater),
            ("0.12.0-rc.1", "0.12.0-rc.1.1", Ordering::Less),
            ("0.12.0", "0.12.0", Ordering::Equal),
        ] {
            assert_eq!(compare_versions(left, right), Some(order), "{left} {right}");
        }
        for invalid in [
            "v0.12.0",
            "0.12",
            "0.12.0.1",
            "01.2.3",
            "0.12.0-",
            "0.12.0+build",
            "",
        ] {
            assert_eq!(compare_versions(invalid, "0.1.0"), None, "{invalid}");
        }
    }

    fn encode_base64(bytes: &[u8]) -> String {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut output = String::new();
        for chunk in bytes.chunks(3) {
            let buffer = u32::from(chunk[0]) << 16
                | u32::from(*chunk.get(1).unwrap_or(&0)) << 8
                | u32::from(*chunk.get(2).unwrap_or(&0));
            for index in 0..4 {
                output.push(if index <= chunk.len() {
                    ALPHABET[(buffer >> (18 - 6 * index) & 63) as usize] as char
                } else {
                    '='
                });
            }
        }
        output
    }

    #[test]
    fn public_keys_are_read_from_pem_and_every_embedded_key_is_valid() {
        let signer = key();
        let der = [SPKI_PREFIX.as_slice(), &public(&signer)].concat();
        let pem = format!(
            "-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----\n",
            encode_base64(&der)
        );
        assert_eq!(public_key_from_pem(&pem), Some(public(&signer)));
        let manifest = b"signed bytes";
        let signature = signer.sign(manifest);
        assert_eq!(
            verify_signature(
                manifest,
                signature.as_ref(),
                &[public_key_from_pem(&pem).unwrap()]
            ),
            Ok(())
        );
        assert_eq!(
            verify_signature(b"other bytes", signature.as_ref(), &[public(&signer)]),
            Err(Failure::Untrusted)
        );
        // An RSA or EC key, a truncated key or a private key is not an Ed25519 public key.
        assert_eq!(public_key_from_pem(&pem.replace("MCow", "MCwx")), None);
        assert_eq!(
            public_key_from_pem("-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----"),
            None
        );
        assert_eq!(public_key_from_pem(&pem.replace("PUBLIC", "PRIVATE")), None);
        assert_eq!(trusted_keys().len(), RELEASE_KEYS.len());
    }

    #[test]
    fn update_status_shows_the_last_update() {
        let state = scratch("status");
        assert_eq!(status(&state).unwrap()["lastUpdate"], Value::Null);
        trial(&state, 1);
        let value = status(&state).unwrap();
        assert_eq!(value["lastUpdate"]["to"], NEW);
        assert_eq!(value["lastUpdate"]["state"], "trial");
        assert_eq!(value["activeVersion"], NEW);
        fs::remove_dir_all(state).unwrap();
    }

    #[test]
    fn every_failure_has_a_distinct_code() {
        let all = [
            Failure::Unmanaged,
            Failure::Untrusted,
            Failure::InvalidManifest,
            Failure::Downgrade,
            Failure::Platform,
            Failure::Download,
            Failure::TooLarge,
            Failure::Digest,
            Failure::SmokeTest,
            Failure::Install,
            Failure::CrashLoop,
            Failure::NoContact,
            Failure::RolledBack,
        ];
        let codes = all
            .iter()
            .map(|failure| failure.code())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(codes.len(), all.len());
        assert!(codes.iter().all(|code| code.starts_with("agent_update_")));
    }
}
