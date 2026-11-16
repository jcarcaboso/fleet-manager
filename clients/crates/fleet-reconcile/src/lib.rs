//! Crash-recoverable reconciliation of Fleet-owned Skill directories.
//!
//! A [`Reconciler`] is synchronous. It verifies every supplied bundle before it
//! takes the target lock or changes the target. Callers may also hold a global
//! agent-state lock, but the reconciler uses a lock beside the target so agents
//! with different private state directories still serialize mutations.
//!
//! Modules: `bundle` parses and validates Assignments and Bundles, `observe`
//! digests what is on disk, `fsx` holds the filesystem primitives (containment,
//! private directories, the shared target lock, atomic state files), and
//! `skills` and `managed_file` are the two transaction engines. This file keeps
//! the public types, the [`Reconciler`] entry points and target resolution.

mod bundle;
mod fsx;
mod managed_file;
mod observe;
mod skills;
#[cfg(test)]
mod tests;

pub use managed_file::file_digest;

use fsx::{ensure_beneath, ensure_private_dir, reject_symlink_path};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fmt, fs, io,
    path::{Component, Path, PathBuf},
};

/// Largest encoded Bundle one Skill may have.
pub const MAX_BUNDLE_BYTES: usize = 16 * 1024 * 1024;
/// Largest single file: a file inside a Bundle, an observed Skill file, or a
/// managed file.
pub const MAX_FILE_BYTES: usize = 16 * 1024 * 1024;
/// Largest total of one Assignment: the sum of its encoded Bundles, and the
/// uncompressed content of one Bundle or observed Skill.
pub const MAX_ASSIGNMENT_BYTES: u64 = 256 * 1024 * 1024;
/// Most repaired paths one reconcile reports.
pub const MAX_REPAIRED_PATHS: usize = 20;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TargetBase {
    Home,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TargetDescriptor {
    pub base: TargetBase,
    pub path: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DesiredSkill {
    pub name: String,
    pub digest: String,
    pub size: u64,
    pub schema: String,
    pub bundle: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Assignment {
    pub assignment_id: String,
    pub desired_revision_id: String,
    pub skills: Vec<DesiredSkill>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DesiredFile {
    pub name: String,
    pub digest: Option<String>,
    pub size: Option<u64>,
    pub schema: Option<String>,
    pub content: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileAssignment {
    pub assignment_id: String,
    pub desired_revision_id: String,
    pub file: DesiredFile,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileReconcileOutcome {
    pub changed: bool,
    /// Home-relative paths of owned content that had drifted from the receipt
    /// and was repaired: sorted, unique, at most `MAX_REPAIRED_PATHS`, and
    /// only paths that `report_path` accepts.
    pub repaired: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReconcileOutcome {
    pub changed: bool,
    /// See `FileReconcileOutcome::repaired`.
    pub repaired: Vec<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub enum ErrorCode {
    InvalidHome,
    InvalidStateDirectory,
    InvalidTarget,
    InvalidAssignment,
    InvalidSkillName,
    DuplicateSkill,
    InvalidDigest,
    BundleSizeMismatch,
    UnsupportedSchema,
    BundleDigestMismatch,
    MalformedBundle,
    BundleLimitExceeded,
    InvalidBundlePath,
    BundlePathCollision,
    FilesystemEscape,
    NonRegularEntry,
    OwnershipConflict,
    MissingOwnedSkill,
    OwnedSkillDrift,
    CorruptReceipt,
    TargetChanged,
    LockFailed,
    Io,
    RecoveryFailed,
}

/// Phase of an Attempt in which a failure happened. The names are the wire
/// values of the Operator API attempt-detail contract.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum Step {
    Lock,
    Download,
    Verify,
    Stage,
    Activate,
    Recover,
    Receipt,
    Configure,
    Validate,
}

impl Step {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Lock => "lock",
            Self::Download => "download",
            Self::Verify => "verify",
            Self::Stage => "stage",
            Self::Activate => "activate",
            Self::Recover => "recover",
            Self::Receipt => "receipt",
            Self::Configure => "configure",
            Self::Validate => "validate",
        }
    }
}

/// A reconciliation failure. Its [`ErrorCode`] is the stable identity; the
/// optional [`Step`] and Target-relative path only describe where it happened.
#[derive(Debug)]
pub struct ReconcileError {
    code: ErrorCode,
    message: String,
    source: Option<io::Error>,
    step: Option<Step>,
    /// Location relative to the Target (or Skill) that raised the error; it is
    /// turned into `path` when the error leaves the public API.
    entry: Option<String>,
    path: Option<String>,
}

impl ReconcileError {
    pub fn code(&self) -> ErrorCode {
        self.code
    }
    pub fn code_str(&self) -> &'static str {
        self.code.as_str()
    }
    pub fn diagnostic(&self) -> &str {
        &self.message
    }
    /// Phase in which the failure happened, when it is known.
    pub fn step(&self) -> Option<Step> {
        self.step.or_else(|| self.code.default_step())
    }
    /// Path of the offending entry relative to the Home base, never absolute
    /// and never containing `..`. `None` when it is unknown or not safe to
    /// report.
    pub fn path(&self) -> Option<&str> {
        self.path.as_deref()
    }
    fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            source: None,
            step: None,
            entry: None,
            path: None,
        }
    }
    fn io(code: ErrorCode, message: impl Into<String>, source: io::Error) -> Self {
        Self {
            source: Some(source),
            ..Self::new(code, message)
        }
    }
    fn with_step(mut self, step: Step) -> Self {
        self.step = Some(step);
        self
    }
    fn step_if_unset(mut self, step: Step) -> Self {
        self.step.get_or_insert(step);
        self
    }
    fn at_entry(mut self, entry: impl Into<String>) -> Self {
        self.entry = Some(entry.into());
        self
    }
    /// Places an entry reported by a nested parser below `parent`.
    fn nested_in(mut self, parent: &str) -> Self {
        self.entry = Some(match self.entry.take() {
            Some(inner) if !inner.is_empty() => format!("{parent}/{inner}"),
            _ => parent.to_owned(),
        });
        self
    }
    /// Resolves the reported path below the Target path `base`. Errors that are
    /// about the Target itself fall back to `base` (plus `default_entry`, such
    /// as a managed file name).
    fn anchored(mut self, base: &Path, default_entry: Option<&str>) -> Self {
        if self.path.is_some() {
            return self;
        }
        let entry = match self.entry.take() {
            Some(entry) => Some(entry),
            None if self.code.names_target() => Some(default_entry.unwrap_or_default().to_owned()),
            None => None,
        };
        self.path = entry.and_then(|entry| {
            if entry.is_empty() {
                report_path(base)
            } else {
                report_path(&base.join(entry))
            }
        });
        self
    }
}

/// Formats `path` for reporting to the Server: only a short, portable, relative
/// path that stays below its base (no root, `.`, `..`, empty or control
/// characters) is returned.
pub fn report_path(path: &Path) -> Option<String> {
    // Reject Windows drive prefixes on Unix as well: reports are consumed
    // across platforms, where a drive-relative path is not a safe relative path.
    let raw = path.to_str()?;
    let bytes = raw.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return None;
    }
    let mut parts = Vec::new();
    for component in path.components() {
        let Component::Normal(part) = component else {
            return None;
        };
        let part = part.to_str()?;
        if part.is_empty() || part.contains('\\') || part.chars().any(char::is_control) {
            return None;
        }
        parts.push(part);
    }
    let joined = parts.join("/");
    (!joined.is_empty() && joined.encode_utf16().count() <= 512).then_some(joined)
}

impl ErrorCode {
    /// The step that normally raises this code, used unless the raising site
    /// knows better.
    const fn default_step(self) -> Option<Step> {
        match self {
            Self::InvalidHome
            | Self::InvalidStateDirectory
            | Self::InvalidTarget
            | Self::InvalidAssignment
            | Self::InvalidSkillName
            | Self::DuplicateSkill
            | Self::FilesystemEscape
            | Self::NonRegularEntry
            | Self::OwnershipConflict
            | Self::MissingOwnedSkill => Some(Step::Validate),
            Self::InvalidDigest
            | Self::BundleSizeMismatch
            | Self::UnsupportedSchema
            | Self::BundleDigestMismatch
            | Self::MalformedBundle
            | Self::BundleLimitExceeded
            | Self::InvalidBundlePath
            | Self::BundlePathCollision
            | Self::OwnedSkillDrift
            | Self::TargetChanged => Some(Step::Verify),
            Self::CorruptReceipt => Some(Step::Receipt),
            Self::LockFailed => Some(Step::Lock),
            Self::RecoveryFailed => Some(Step::Recover),
            Self::Io => None,
        }
    }

    /// Whether an error with this code concerns the Target (or managed file)
    /// being reconciled when it names no more specific entry.
    const fn names_target(self) -> bool {
        matches!(
            self,
            Self::InvalidTarget
                | Self::FilesystemEscape
                | Self::NonRegularEntry
                | Self::OwnershipConflict
                | Self::MissingOwnedSkill
                | Self::OwnedSkillDrift
                | Self::CorruptReceipt
                | Self::TargetChanged
                | Self::LockFailed
                | Self::RecoveryFailed
                | Self::UnsupportedSchema
                | Self::BundleSizeMismatch
                | Self::BundleDigestMismatch
        )
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidHome => "invalid_home",
            Self::InvalidStateDirectory => "invalid_state_directory",
            Self::InvalidTarget => "invalid_target",
            Self::InvalidAssignment => "invalid_assignment",
            Self::InvalidSkillName => "invalid_skill_name",
            Self::DuplicateSkill => "duplicate_skill",
            Self::InvalidDigest => "invalid_digest",
            Self::BundleSizeMismatch => "bundle_size_mismatch",
            Self::UnsupportedSchema => "unsupported_schema",
            Self::BundleDigestMismatch => "bundle_digest_mismatch",
            Self::MalformedBundle => "malformed_bundle",
            Self::BundleLimitExceeded => "bundle_limit_exceeded",
            Self::InvalidBundlePath => "invalid_bundle_path",
            Self::BundlePathCollision => "bundle_path_collision",
            Self::FilesystemEscape => "filesystem_escape",
            Self::NonRegularEntry => "non_regular_entry",
            Self::OwnershipConflict => "ownership_conflict",
            Self::MissingOwnedSkill => "missing_owned_skill",
            Self::OwnedSkillDrift => "owned_skill_drift",
            Self::CorruptReceipt => "corrupt_receipt",
            Self::TargetChanged => "target_changed",
            Self::LockFailed => "lock_failed",
            Self::Io => "io",
            Self::RecoveryFailed => "recovery_failed",
        }
    }
}
impl fmt::Display for ReconcileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}
impl std::error::Error for ReconcileError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source.as_ref().map(|e| e as _)
    }
}
type Result<T> = std::result::Result<T, ReconcileError>;

#[derive(Debug)]
pub struct Reconciler {
    home: PathBuf,
    state_dir: PathBuf,
}

// Journal phase of both transaction engines (`skills` and `managed_file`).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
enum Phase {
    Applying,
    Committed,
}

impl Reconciler {
    pub fn new(home: impl Into<PathBuf>, state_dir: impl Into<PathBuf>) -> Result<Self> {
        let home = home.into();
        if !home.is_absolute() {
            return Err(ReconcileError::new(
                ErrorCode::InvalidHome,
                "home must be absolute",
            ));
        }
        let meta = fs::symlink_metadata(&home)
            .map_err(|e| ReconcileError::io(ErrorCode::InvalidHome, "cannot inspect home", e))?;
        if !meta.file_type().is_dir() || meta.file_type().is_symlink() {
            return Err(ReconcileError::new(
                ErrorCode::InvalidHome,
                "home must be a real directory",
            ));
        }
        let home = fs::canonicalize(&home)
            .map_err(|e| ReconcileError::io(ErrorCode::InvalidHome, "cannot resolve home", e))?;
        let state_dir = state_dir.into();
        if !state_dir.is_absolute() {
            return Err(ReconcileError::new(
                ErrorCode::InvalidStateDirectory,
                "state directory must be absolute",
            ));
        }
        ensure_private_dir(&state_dir, ErrorCode::InvalidStateDirectory)?;
        reject_symlink_path(&state_dir, ErrorCode::InvalidStateDirectory)?;
        let state_dir = fs::canonicalize(&state_dir).map_err(|e| {
            ReconcileError::io(
                ErrorCode::InvalidStateDirectory,
                "cannot resolve state directory",
                e,
            )
        })?;
        Ok(Self { home, state_dir })
    }

    pub fn reconcile(
        &self,
        target: &TargetDescriptor,
        assignment: &Assignment,
    ) -> Result<ReconcileOutcome> {
        self.reconcile_skills(target, assignment)
            .map(|mut outcome| {
                outcome.repaired = repaired_paths(&target.path, outcome.repaired);
                outcome
            })
            .map_err(|error| error.anchored(&target.path, None))
    }

    /// Recovers an interrupted target mutation without requiring an Assignment
    /// or Bundle bytes. Call this before the first network request after startup.
    pub fn recover(&self, target: &TargetDescriptor) -> Result<()> {
        self.recover_skills(target)
            .map_err(|error| error.anchored(&target.path, None))
    }

    pub fn reconcile_file(
        &self,
        target: &TargetDescriptor,
        assignment: &FileAssignment,
    ) -> Result<FileReconcileOutcome> {
        self.reconcile_managed_file(target, assignment)
            .map(|mut outcome| {
                outcome.repaired = repaired_paths(&target.path, outcome.repaired);
                outcome
            })
            .map_err(|error| error.anchored(&target.path, Some(&assignment.file.name)))
    }

    pub fn recover_file(&self, target: &TargetDescriptor, name: &str) -> Result<()> {
        self.recover_managed_file(target, name)
            .map_err(|error| error.anchored(&target.path, Some(name)))
    }

    /// Resolves the Target below home, creating missing directories when
    /// `create` is set, and refuses one that overlaps the private state
    /// directory.
    fn resolve_target(&self, target: &TargetDescriptor, create: bool) -> Result<PathBuf> {
        match target.base {
            TargetBase::Home => {}
        }
        validate_relative(&target.path, false).map_err(|_| {
            ReconcileError::new(
                ErrorCode::InvalidTarget,
                "target path must be a non-empty portable relative path",
            )
        })?;
        if target
            .path
            .components()
            .any(|component| component.as_os_str() == ".fleet-reconcile")
        {
            return Err(ReconcileError::new(
                ErrorCode::InvalidTarget,
                "target path conflicts with the reconciliation state directory",
            ));
        }
        let candidate = self.home.join(&target.path);
        ensure_beneath(&self.home, &candidate, create)?;
        let overlaps_state = if candidate.exists() {
            let resolved = fs::canonicalize(&candidate).map_err(|e| {
                ReconcileError::io(ErrorCode::InvalidTarget, "cannot resolve target", e)
            })?;
            resolved.starts_with(&self.state_dir) || self.state_dir.starts_with(&resolved)
        } else {
            candidate.starts_with(&self.state_dir) || self.state_dir.starts_with(&candidate)
        };
        if overlaps_state {
            return Err(ReconcileError::new(
                ErrorCode::InvalidTarget,
                "target and private state directory must not overlap",
            ));
        }
        Ok(candidate)
    }
}

/// Anchors Target-directory-relative entries at the Target path and keeps
/// only reportable ones: sorted, unique, and at most `MAX_REPAIRED_PATHS`.
fn repaired_paths(base: &Path, entries: Vec<String>) -> Vec<String> {
    let mut paths: Vec<String> = entries
        .iter()
        .filter_map(|entry| report_path(&base.join(entry)))
        .collect();
    paths.sort();
    paths.dedup();
    paths.truncate(MAX_REPAIRED_PATHS);
    paths
}

fn validate_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 256 || id.chars().any(char::is_control) {
        Err(ReconcileError::new(
            ErrorCode::InvalidAssignment,
            "assignment and revision IDs must be bounded non-control strings",
        ))
    } else {
        Ok(())
    }
}

fn validate_relative(path: &Path, allow_empty: bool) -> std::result::Result<(), ()> {
    if path.is_absolute() || (!allow_empty && path.as_os_str().is_empty()) {
        return Err(());
    }
    for c in path.components() {
        match c {
            Component::Normal(s) if !s.is_empty() => {}
            _ => return Err(()),
        }
    }
    Ok(())
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
/// Lowercase hex SHA-256. State directory names (`.fleet-reconcile/<key>`,
/// `targets/<key>`, `files/<key>`) are derived from it, so its output must
/// never change; `tests::hex_sha256_output_is_pinned` holds it.
fn hex_sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
