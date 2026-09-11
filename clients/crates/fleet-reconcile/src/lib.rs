//! Crash-recoverable reconciliation of Fleet-owned Skill directories.
//!
//! A [`Reconciler`] is synchronous. It verifies every supplied bundle before it
//! takes the target lock or changes the target. Callers may also hold a global
//! agent-state lock, but the reconciler uses a lock beside the target so agents
//! with different private state directories still serialize mutations.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt, fs,
    fs::{File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
};
use unicode_normalization::UnicodeNormalization;

const MAGIC: &[u8; 6] = b"FLTB1\0";
const SCHEMA: &str = "fleet.bundle/v1";
const FILE_SCHEMA: &str = "fleet.file/v1";
const MAX_BUNDLE: usize = 16 * 1024 * 1024;
const MAX_FILES: usize = 10_000;
const MAX_PATH: usize = 1_024;
const MAX_DEPTH: usize = 16;
const MAX_FILE: usize = 16 * 1024 * 1024;
const MAX_TOTAL: u64 = 256 * 1024 * 1024;
const MAX_STATE_FILE: u64 = 2 * 1024 * 1024;

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
    pub target: PathBuf,
    pub file: String,
    pub assignment_id: String,
    pub desired_revision_id: String,
    pub changed: bool,
    pub owned_digest: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReconcileOutcome {
    pub target: PathBuf,
    pub assignment_id: String,
    pub desired_revision_id: String,
    pub changed: bool,
    pub owned_skills: BTreeMap<String, String>,
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

#[derive(Debug)]
pub struct ReconcileError {
    code: ErrorCode,
    message: String,
    source: Option<io::Error>,
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
    fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            source: None,
        }
    }
    fn io(code: ErrorCode, message: impl Into<String>, source: io::Error) -> Self {
        Self {
            code,
            message: message.into(),
            source: Some(source),
        }
    }
}
impl ErrorCode {
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

#[derive(Clone)]
struct ParsedSkill {
    name: String,
    digest: String,
    files: Vec<BundleFile>,
}
#[derive(Clone)]
struct BundleFile {
    path: String,
    executable: bool,
    bytes: Vec<u8>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Receipt {
    version: u32,
    target: String,
    assignment_id: String,
    desired_revision_id: String,
    skills: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
enum Phase {
    Applying,
    Committed,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Journal {
    version: u32,
    target: String,
    transaction: String,
    phase: Phase,
    old_receipt: Option<Receipt>,
    old_names: Vec<String>,
    new_names: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct FileReceipt {
    version: u32,
    target: String,
    name: String,
    assignment_id: String,
    desired_revision_id: String,
    digest: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct FileJournal {
    version: u32,
    target: String,
    name: String,
    transaction: String,
    phase: Phase,
    old_receipt: Option<FileReceipt>,
    old_present: bool,
    desired_digest: Option<String>,
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
        validate_id(&assignment.assignment_id)?;
        validate_id(&assignment.desired_revision_id)?;
        let parsed = validate_assignment(assignment)?;
        let target_path = self.resolve_target(target)?;
        let key = hex_sha256(target_path.as_os_str().to_string_lossy().as_bytes());
        let shared = target_path
            .parent()
            .ok_or_else(|| ReconcileError::new(ErrorCode::InvalidTarget, "target has no parent"))?
            .join(".fleet-reconcile")
            .join(&key);
        ensure_private_dir(&shared, ErrorCode::Io)?;
        reject_symlink_path(&shared, ErrorCode::FilesystemEscape)?;
        let lock = open_lock(&shared.join("lock"))?;
        lock.lock()
            .map_err(|e| ReconcileError::io(ErrorCode::LockFailed, "cannot lock target", e))?;
        self.reconcile_locked(&target_path, &shared, &key, assignment, parsed)
    }

    /// Recovers an interrupted target mutation without requiring an Assignment
    /// or Bundle bytes. Call this before the first network request after startup.
    pub fn recover(&self, target: &TargetDescriptor) -> Result<()> {
        let target_path = self.resolve_target(target)?;
        let key = hex_sha256(target_path.as_os_str().to_string_lossy().as_bytes());
        let shared = target_path
            .parent()
            .ok_or_else(|| ReconcileError::new(ErrorCode::InvalidTarget, "target has no parent"))?
            .join(".fleet-reconcile")
            .join(&key);
        ensure_private_dir(&shared, ErrorCode::Io)?;
        let lock = open_lock(&shared.join("lock"))?;
        lock.lock()
            .map_err(|e| ReconcileError::io(ErrorCode::LockFailed, "cannot lock target", e))?;
        let state = self.state_dir.join("targets").join(key);
        ensure_private_dir(&state, ErrorCode::Io)?;
        let journal = state.join("journal.json");
        if journal.exists() {
            recover(&target_path, &shared, &state.join("receipt.json"), &journal)?;
        }
        Ok(())
    }

    pub fn reconcile_file(
        &self,
        target: &TargetDescriptor,
        assignment: &FileAssignment,
    ) -> Result<FileReconcileOutcome> {
        validate_id(&assignment.assignment_id)?;
        validate_id(&assignment.desired_revision_id)?;
        validate_file(&assignment.file)?;
        let target_path = self.resolve_target_for_file(target, assignment.file.digest.is_some())?;
        let destination = target_path.join(&assignment.file.name);
        let key = hex_sha256(destination.as_os_str().to_string_lossy().as_bytes());
        let shared = target_path
            .parent()
            .ok_or_else(|| {
                ReconcileError::new(
                    ErrorCode::InvalidTarget,
                    "managed file Target has no parent",
                )
            })?
            .join(".fleet-reconcile")
            .join(&key);
        ensure_private_dir(&shared, ErrorCode::Io)?;
        reject_symlink_path(&shared, ErrorCode::FilesystemEscape)?;
        let lock = open_lock(&shared.join("lock"))?;
        lock.lock().map_err(|e| {
            ReconcileError::io(ErrorCode::LockFailed, "cannot lock managed file", e)
        })?;
        self.reconcile_file_locked(&target_path, &destination, &shared, &key, assignment)
    }

    pub fn recover_file(&self, target: &TargetDescriptor, name: &str) -> Result<()> {
        validate_file_name(name)?;
        let target_path = self.resolve_target_for_file(target, false)?;
        let destination = target_path.join(name);
        let key = hex_sha256(destination.as_os_str().to_string_lossy().as_bytes());
        let shared = target_path
            .parent()
            .ok_or_else(|| {
                ReconcileError::new(
                    ErrorCode::InvalidTarget,
                    "managed file Target has no parent",
                )
            })?
            .join(".fleet-reconcile")
            .join(&key);
        ensure_private_dir(&shared, ErrorCode::Io)?;
        let lock = open_lock(&shared.join("lock"))?;
        lock.lock().map_err(|e| {
            ReconcileError::io(ErrorCode::LockFailed, "cannot lock managed file", e)
        })?;
        let state = self.state_dir.join("files").join(&key);
        ensure_private_dir(&state, ErrorCode::Io)?;
        if state.join("journal.json").exists() {
            ensure_beneath(&self.home, &target_path, true)?;
        }
        recover_file_transaction(
            &destination,
            &shared,
            &state.join("receipt.json"),
            &state.join("journal.json"),
        )
    }

    fn reconcile_file_locked(
        &self,
        target: &Path,
        destination: &Path,
        shared: &Path,
        key: &str,
        assignment: &FileAssignment,
    ) -> Result<FileReconcileOutcome> {
        let state = self.state_dir.join("files").join(key);
        ensure_private_dir(&state, ErrorCode::Io)?;
        let receipt_path = state.join("receipt.json");
        let journal_path = state.join("journal.json");
        ensure_beneath(
            &self.home,
            target,
            assignment.file.digest.is_some() || journal_path.exists(),
        )?;
        recover_file_transaction(destination, shared, &receipt_path, &journal_path)?;
        let old = read_file_receipt(&receipt_path, target, &assignment.file.name)?;
        let observed = digest_regular_file(destination)?;
        if old.is_none() && observed.is_some() && assignment.file.digest.is_some() {
            return Err(ReconcileError::new(
                ErrorCode::OwnershipConflict,
                format!("{} exists without Fleet ownership", assignment.file.name),
            ));
        }
        let desired = assignment.file.digest.clone();
        let unchanged = match (&old, &desired, &observed) {
            (None, None, _) => true,
            (Some(receipt), Some(wanted), Some(actual)) => {
                receipt.digest == *wanted
                    && actual == wanted
                    && receipt.assignment_id == assignment.assignment_id
                    && receipt.desired_revision_id == assignment.desired_revision_id
            }
            _ => false,
        };
        if unchanged {
            return Ok(file_outcome(target, assignment, false));
        }

        let tx = hex_sha256(
            format!(
                "{}\0{}",
                assignment.assignment_id, assignment.desired_revision_id
            )
            .as_bytes(),
        );
        let tx_root = shared.join(format!("txn-{tx}"));
        if tx_root.exists() {
            remove_tree(&tx_root)?;
        }
        ensure_private_dir(&tx_root, ErrorCode::Io)?;
        let staged = tx_root.join("new");
        let backup = tx_root.join("old");
        if desired.is_some() {
            write_regular_file(&staged, &assignment.file.content)?;
        }
        let journal = FileJournal {
            version: 1,
            target: path_string(target),
            name: assignment.file.name.clone(),
            transaction: tx,
            phase: Phase::Applying,
            old_receipt: old.clone(),
            old_present: observed.is_some(),
            desired_digest: desired.clone(),
        };
        write_json_atomic(&journal_path, &journal)?;
        let operation = (|| {
            if destination.exists() {
                fs::rename(destination, &backup).map_err(|e| {
                    ReconcileError::io(ErrorCode::Io, "cannot back up managed file", e)
                })?;
                sync_parent(destination)?;
            }
            if desired.is_some() {
                fs::rename(&staged, destination).map_err(|e| {
                    ReconcileError::io(ErrorCode::Io, "cannot activate managed file", e)
                })?;
                sync_parent(destination)?;
            }
            if let Some(digest) = &desired {
                if digest_regular_file(destination)?.as_ref() != Some(digest) {
                    return Err(ReconcileError::new(
                        ErrorCode::TargetChanged,
                        "managed file verification failed",
                    ));
                }
                write_json_atomic(
                    &receipt_path,
                    &FileReceipt {
                        version: 1,
                        target: path_string(target),
                        name: assignment.file.name.clone(),
                        assignment_id: assignment.assignment_id.clone(),
                        desired_revision_id: assignment.desired_revision_id.clone(),
                        digest: digest.clone(),
                    },
                )?;
            } else if receipt_path.exists() {
                remove_file_sync(&receipt_path)?;
            }
            let mut committed = journal.clone();
            committed.phase = Phase::Committed;
            write_json_atomic(&journal_path, &committed)?;
            Ok(())
        })();
        if let Err(error) = operation {
            if let Err(recovery) =
                recover_file_transaction(destination, shared, &receipt_path, &journal_path)
            {
                return Err(ReconcileError::new(
                    ErrorCode::RecoveryFailed,
                    format!("{error}; rollback failed: {recovery}"),
                ));
            }
            return Err(error);
        }
        remove_tree(&tx_root)?;
        remove_file_sync(&journal_path)?;
        Ok(file_outcome(target, assignment, true))
    }

    fn resolve_target(&self, target: &TargetDescriptor) -> Result<PathBuf> {
        self.resolve_target_with_create(target, true)
    }

    fn resolve_target_for_file(&self, target: &TargetDescriptor, create: bool) -> Result<PathBuf> {
        self.resolve_target_with_create(target, create)
    }

    fn resolve_target_with_create(
        &self,
        target: &TargetDescriptor,
        create: bool,
    ) -> Result<PathBuf> {
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

    fn reconcile_locked(
        &self,
        target: &Path,
        shared: &Path,
        key: &str,
        assignment: &Assignment,
        parsed: Vec<ParsedSkill>,
    ) -> Result<ReconcileOutcome> {
        ensure_beneath(&self.home, target, true)?;
        let state = self.state_dir.join("targets").join(key);
        ensure_private_dir(&state, ErrorCode::Io)?;
        let receipt_path = state.join("receipt.json");
        let journal_path = state.join("journal.json");
        if journal_path.exists() {
            recover(target, shared, &receipt_path, &journal_path)?;
        }
        let old = read_receipt(&receipt_path, target)?;
        let desired: BTreeMap<_, _> = parsed
            .iter()
            .map(|s| (s.name.clone(), s.digest.clone()))
            .collect();

        let mut observed_owned = BTreeMap::new();
        if let Some(receipt) = &old {
            for name in receipt.skills.keys() {
                let path = target.join(name);
                match fs::symlink_metadata(&path) {
                    Ok(_) => {
                        // Computing the digest also rejects links, special files,
                        // invalid names, and over-limit observed trees before a
                        // transaction can use them as rollback material.
                        observed_owned.insert(name.clone(), digest_tree(&path)?);
                    }
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                    Err(e) => {
                        return Err(ReconcileError::io(
                            ErrorCode::Io,
                            format!("cannot inspect owned Skill {name}"),
                            e,
                        ));
                    }
                }
            }
        }
        for skill in &parsed {
            let path = target.join(&skill.name);
            let owned = old
                .as_ref()
                .is_some_and(|r| r.skills.contains_key(&skill.name));
            if path.exists() && !owned {
                return Err(ReconcileError::new(
                    ErrorCode::OwnershipConflict,
                    format!("Skill {} exists without Fleet ownership", skill.name),
                ));
            }
        }
        let unchanged = old.as_ref().is_some_and(|r| r.skills == desired)
            && observed_owned == desired
            && old.as_ref().is_some_and(|r| {
                r.assignment_id == assignment.assignment_id
                    && r.desired_revision_id == assignment.desired_revision_id
            });
        if unchanged {
            return Ok(outcome(target, assignment, false, desired));
        }

        let tx = hex_sha256(
            format!(
                "{}\0{}",
                assignment.assignment_id, assignment.desired_revision_id
            )
            .as_bytes(),
        );
        let tx_root = shared.join(format!("txn-{tx}"));
        if tx_root.exists() {
            remove_tree(&tx_root)?;
        }
        let staged = tx_root.join("new");
        let backup = tx_root.join("old");
        ensure_private_dir(&staged, ErrorCode::Io)?;
        ensure_private_dir(&backup, ErrorCode::Io)?;
        for skill in &parsed {
            extract_skill(&staged.join(&skill.name), skill)?;
        }
        sync_tree(&staged)?;

        let old_names = observed_owned.keys().cloned().collect();
        let journal = Journal {
            version: 1,
            target: path_string(target),
            transaction: tx.clone(),
            phase: Phase::Applying,
            old_receipt: old.clone(),
            old_names,
            new_names: desired.keys().cloned().collect(),
        };
        write_json_atomic(&journal_path, &journal)?;
        let operation = (|| {
            for name in union_names(&journal.old_names, &journal.new_names) {
                let current = target.join(&name);
                if current.exists() {
                    fs::rename(&current, backup.join(&name)).map_err(|e| {
                        ReconcileError::io(ErrorCode::Io, format!("cannot back up {name}"), e)
                    })?;
                    sync_parent(&current)?;
                }
                let new = staged.join(&name);
                if new.exists() {
                    fs::rename(&new, &current).map_err(|e| {
                        ReconcileError::io(ErrorCode::Io, format!("cannot activate {name}"), e)
                    })?;
                    sync_parent(&current)?;
                }
            }
            for (name, digest) in &desired {
                if digest_tree(&target.join(name))? != *digest {
                    return Err(ReconcileError::new(
                        ErrorCode::TargetChanged,
                        format!("verification failed for {name}"),
                    ));
                }
            }
            let receipt = Receipt {
                version: 1,
                target: path_string(target),
                assignment_id: assignment.assignment_id.clone(),
                desired_revision_id: assignment.desired_revision_id.clone(),
                skills: desired.clone(),
            };
            write_json_atomic(&receipt_path, &receipt)?;
            let mut committed = journal.clone();
            committed.phase = Phase::Committed;
            write_json_atomic(&journal_path, &committed)?;
            Ok(())
        })();
        if let Err(error) = operation {
            if let Err(recovery) = recover(target, shared, &receipt_path, &journal_path) {
                return Err(ReconcileError::new(
                    ErrorCode::RecoveryFailed,
                    format!("{error}; rollback failed: {recovery}"),
                ));
            }
            return Err(error);
        }
        remove_tree(&tx_root)?;
        remove_file_sync(&journal_path)?;
        Ok(outcome(target, assignment, true, desired))
    }
}

fn outcome(
    target: &Path,
    a: &Assignment,
    changed: bool,
    skills: BTreeMap<String, String>,
) -> ReconcileOutcome {
    ReconcileOutcome {
        target: target.to_owned(),
        assignment_id: a.assignment_id.clone(),
        desired_revision_id: a.desired_revision_id.clone(),
        changed,
        owned_skills: skills,
    }
}

fn validate_assignment(a: &Assignment) -> Result<Vec<ParsedSkill>> {
    let mut names = BTreeSet::new();
    let mut aliases = BTreeSet::new();
    let mut out = Vec::new();
    let mut total = 0u64;
    for skill in &a.skills {
        validate_skill_name(&skill.name)?;
        if !names.insert(skill.name.clone()) {
            return Err(ReconcileError::new(
                ErrorCode::DuplicateSkill,
                "duplicate Skill name",
            ));
        }
        let alias = skill
            .name
            .nfc()
            .flat_map(char::to_lowercase)
            .collect::<String>();
        if !aliases.insert(alias) {
            return Err(ReconcileError::new(
                ErrorCode::DuplicateSkill,
                "Skill names collide by case or Unicode normalization",
            ));
        }
        if skill.schema != SCHEMA {
            return Err(ReconcileError::new(
                ErrorCode::UnsupportedSchema,
                format!("unsupported schema for {}", skill.name),
            ));
        }
        if skill.size != skill.bundle.len() as u64 {
            return Err(ReconcileError::new(
                ErrorCode::BundleSizeMismatch,
                format!("size mismatch for {}", skill.name),
            ));
        }
        total = total.checked_add(skill.size).ok_or_else(|| {
            ReconcileError::new(
                ErrorCode::BundleLimitExceeded,
                "assignment Bundle size overflow",
            )
        })?;
        if total > MAX_TOTAL {
            return Err(ReconcileError::new(
                ErrorCode::BundleLimitExceeded,
                "assignment Bundles exceed 256 MiB",
            ));
        }
        if skill.bundle.len() > MAX_BUNDLE {
            return Err(ReconcileError::new(
                ErrorCode::BundleLimitExceeded,
                "encoded Bundle exceeds 16 MiB",
            ));
        }
        parse_digest(&skill.digest)?;
        let actual = format!("sha256:{}", hex_sha256(&skill.bundle));
        if actual != skill.digest {
            return Err(ReconcileError::new(
                ErrorCode::BundleDigestMismatch,
                format!("digest mismatch for {}", skill.name),
            ));
        }
        let files = parse_bundle(&skill.bundle)?;
        out.push(ParsedSkill {
            name: skill.name.clone(),
            digest: skill.digest.clone(),
            files,
        });
    }
    Ok(out)
}

fn parse_bundle(bytes: &[u8]) -> Result<Vec<BundleFile>> {
    let mut p = Parser { bytes, at: 0 };
    if p.take(6)? != MAGIC {
        return Err(ReconcileError::new(
            ErrorCode::MalformedBundle,
            "invalid Bundle magic",
        ));
    }
    let count = p.u32()? as usize;
    if count > MAX_FILES {
        return Err(ReconcileError::new(
            ErrorCode::BundleLimitExceeded,
            "too many files",
        ));
    }
    let mut files = Vec::with_capacity(count);
    let mut prior: Option<Vec<u8>> = None;
    let mut aliases = BTreeSet::new();
    let mut total = 0u64;
    for _ in 0..count {
        let len = p.u32()? as usize;
        if len == 0 || len > MAX_PATH {
            return Err(ReconcileError::new(
                ErrorCode::InvalidBundlePath,
                "invalid path length",
            ));
        }
        let raw = p.take(len)?.to_vec();
        if prior.as_ref().is_some_and(|x| x >= &raw) {
            return Err(ReconcileError::new(
                ErrorCode::MalformedBundle,
                "Bundle paths are not strictly sorted",
            ));
        }
        prior = Some(raw.clone());
        let path = String::from_utf8(raw)
            .map_err(|_| ReconcileError::new(ErrorCode::InvalidBundlePath, "path is not UTF-8"))?;
        validate_bundle_path(&path)?;
        let alias = path.nfc().flat_map(char::to_lowercase).collect::<String>();
        if aliases.contains(&alias)
            || aliases.iter().any(|other: &String| {
                alias.starts_with(&format!("{other}/")) || other.starts_with(&format!("{alias}/"))
            })
        {
            return Err(ReconcileError::new(
                ErrorCode::BundlePathCollision,
                "Bundle paths collide or use a file as a directory",
            ));
        }
        aliases.insert(alias);
        let executable = match p.u8()? {
            0 => false,
            1 => true,
            _ => {
                return Err(ReconcileError::new(
                    ErrorCode::MalformedBundle,
                    "invalid executable flag",
                ));
            }
        };
        let size = p.u64()?;
        if size > MAX_FILE as u64 {
            return Err(ReconcileError::new(
                ErrorCode::BundleLimitExceeded,
                "file exceeds 16 MiB",
            ));
        }
        total = total.checked_add(size).ok_or_else(|| {
            ReconcileError::new(ErrorCode::BundleLimitExceeded, "content size overflow")
        })?;
        if total > MAX_TOTAL {
            return Err(ReconcileError::new(
                ErrorCode::BundleLimitExceeded,
                "uncompressed content exceeds limit",
            ));
        }
        let size = usize::try_from(size).map_err(|_| {
            ReconcileError::new(
                ErrorCode::BundleLimitExceeded,
                "file does not fit this platform",
            )
        })?;
        files.push(BundleFile {
            path,
            executable,
            bytes: p.take(size)?.to_vec(),
        });
    }
    if p.at != bytes.len() {
        return Err(ReconcileError::new(
            ErrorCode::MalformedBundle,
            "trailing Bundle bytes",
        ));
    }
    if !files.iter().any(|entry| entry.path == "SKILL.md") {
        return Err(ReconcileError::new(
            ErrorCode::MalformedBundle,
            "Bundle does not contain root SKILL.md",
        ));
    }
    Ok(files)
}

struct Parser<'a> {
    bytes: &'a [u8],
    at: usize,
}
impl<'a> Parser<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self
            .at
            .checked_add(n)
            .ok_or_else(|| ReconcileError::new(ErrorCode::MalformedBundle, "length overflow"))?;
        let value = self
            .bytes
            .get(self.at..end)
            .ok_or_else(|| ReconcileError::new(ErrorCode::MalformedBundle, "truncated Bundle"))?;
        self.at = end;
        Ok(value)
    }
    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }
}

fn validate_skill_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 255
        || !name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        || name.starts_with('-')
        || name.ends_with('-')
    {
        return Err(ReconcileError::new(
            ErrorCode::InvalidSkillName,
            format!("invalid Skill name {name:?}"),
        ));
    }
    Ok(())
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
fn parse_digest(d: &str) -> Result<()> {
    if d.len() != 71
        || !d.starts_with("sha256:")
        || !d[7..]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        Err(ReconcileError::new(
            ErrorCode::InvalidDigest,
            "digest must be lowercase sha256 hex",
        ))
    } else {
        Ok(())
    }
}
fn validate_bundle_path(path: &str) -> Result<()> {
    if path.as_bytes().contains(&b'\\')
        || path.starts_with('/')
        || path != path.nfc().collect::<String>()
        || path.split('/').count() > MAX_DEPTH
        || path
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == ".." || s.as_bytes().contains(&0))
    {
        Err(ReconcileError::new(
            ErrorCode::InvalidBundlePath,
            format!("invalid Bundle path {path:?}"),
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

fn ensure_beneath(home: &Path, target: &Path, create: bool) -> Result<()> {
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
                    format!("symlink in target path: {}", at.display()),
                ));
            }
            Ok(m) if !m.is_dir() => {
                return Err(ReconcileError::new(
                    ErrorCode::NonRegularEntry,
                    format!("target ancestor is not a directory: {}", at.display()),
                ));
            }
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound && create => {
                fs::create_dir(&at).map_err(|e| {
                    ReconcileError::io(ErrorCode::Io, format!("cannot create {}", at.display()), e)
                })?;
                sync_parent(&at)?;
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => {
                return Err(ReconcileError::io(
                    ErrorCode::Io,
                    format!("cannot inspect {}", at.display()),
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

fn reject_symlink_path(path: &Path, code: ErrorCode) -> Result<()> {
    let mut at = PathBuf::new();
    for c in path.components() {
        at.push(c);
        if let Ok(m) = fs::symlink_metadata(&at)
            && m.file_type().is_symlink()
        {
            return Err(ReconcileError::new(
                code,
                format!("symlink in path: {}", at.display()),
            ));
        }
    }
    Ok(())
}

fn ensure_private_dir(path: &Path, code: ErrorCode) -> Result<()> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
                return Err(ReconcileError::new(
                    code,
                    format!(
                        "private path component is not a real directory: {}",
                        current.display()
                    ),
                ));
            }
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|e| {
                    ReconcileError::io(code, format!("cannot create {}", current.display()), e)
                })?;
            }
            Err(e) => {
                return Err(ReconcileError::io(
                    code,
                    format!("cannot inspect {}", current.display()),
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

fn extract_skill(root: &Path, skill: &ParsedSkill) -> Result<()> {
    fs::create_dir(root).map_err(|e| {
        ReconcileError::io(ErrorCode::Io, format!("cannot stage {}", skill.name), e)
    })?;
    for entry in &skill.files {
        let path = root.join(entry.path.split('/').collect::<PathBuf>());
        if !path.starts_with(root) {
            return Err(ReconcileError::new(
                ErrorCode::FilesystemEscape,
                "staged path escaped Skill root",
            ));
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                ReconcileError::io(ErrorCode::Io, "cannot create staged directory", e)
            })?;
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| ReconcileError::io(ErrorCode::Io, "cannot create staged file", e))?;
        file.write_all(&entry.bytes)
            .map_err(|e| ReconcileError::io(ErrorCode::Io, "cannot write staged file", e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(if entry.executable {
                0o755
            } else {
                0o644
            }))
            .map_err(|e| ReconcileError::io(ErrorCode::Io, "cannot set executable bit", e))?;
        }
        file.sync_all()
            .map_err(|e| ReconcileError::io(ErrorCode::Io, "cannot sync staged file", e))?;
    }
    Ok(())
}

fn digest_tree(root: &Path) -> Result<String> {
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
        if encoded.len() > MAX_BUNDLE {
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
        let meta = fs::symlink_metadata(&path)
            .map_err(|e| ReconcileError::io(ErrorCode::Io, "cannot inspect Skill entry", e))?;
        if meta.file_type().is_symlink() || (!meta.is_dir() && !meta.is_file()) {
            return Err(ReconcileError::new(
                ErrorCode::NonRegularEntry,
                format!("non-regular Skill entry: {}", path.display()),
            ));
        }
        #[cfg(unix)]
        if meta.is_file() && {
            use std::os::unix::fs::MetadataExt;
            meta.nlink() != 1
        } {
            return Err(ReconcileError::new(
                ErrorCode::NonRegularEntry,
                format!("hard-linked Skill entry: {}", path.display()),
            ));
        }
        if meta.is_dir() {
            collect_files(root, &path, out, limits)?;
            continue;
        }
        if meta.len() > MAX_FILE as u64 {
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
        if limits.content_bytes > MAX_TOTAL {
            return Err(ReconcileError::new(
                ErrorCode::BundleLimitExceeded,
                "observed Skill content exceeds limit",
            ));
        }
        let mut bytes = Vec::with_capacity(meta.len() as usize);
        File::open(&path)
            .map(|f| f.take(MAX_FILE as u64 + 1))
            .and_then(|mut f| f.read_to_end(&mut bytes))
            .map_err(|e| ReconcileError::io(ErrorCode::Io, "cannot read Skill file", e))?;
        if bytes.len() > MAX_FILE {
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
            if limits.content_bytes > MAX_TOTAL {
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

fn validate_file(file: &DesiredFile) -> Result<()> {
    validate_file_name(&file.name)?;
    match (&file.digest, file.size, &file.schema) {
        (None, None, None) if file.content.is_empty() => Ok(()),
        (Some(digest), Some(size), Some(schema)) => {
            parse_digest(digest)?;
            if schema != FILE_SCHEMA {
                return Err(ReconcileError::new(
                    ErrorCode::UnsupportedSchema,
                    "unsupported managed file schema",
                ));
            }
            if size != file.content.len() as u64 || file.content.len() > MAX_FILE {
                return Err(ReconcileError::new(
                    ErrorCode::BundleSizeMismatch,
                    "managed file size does not match its content",
                ));
            }
            if format!("sha256:{}", hex_file_sha256(&file.content)) != *digest {
                return Err(ReconcileError::new(
                    ErrorCode::BundleDigestMismatch,
                    "managed file digest does not match its content",
                ));
            }
            Ok(())
        }
        _ => Err(ReconcileError::new(
            ErrorCode::InvalidAssignment,
            "managed file metadata is incomplete",
        )),
    }
}

fn validate_file_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 255
        || name == "."
        || name == ".."
        || name.as_bytes().contains(&b'/')
        || name.as_bytes().contains(&b'\\')
        || name.as_bytes().contains(&0)
        || name != name.nfc().collect::<String>()
    {
        return Err(ReconcileError::new(
            ErrorCode::InvalidBundlePath,
            "managed file name must be one portable path segment",
        ));
    }
    Ok(())
}

fn digest_regular_file(path: &Path) -> Result<Option<String>> {
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
    if metadata.len() > MAX_FILE as u64 {
        return Err(ReconcileError::new(
            ErrorCode::BundleLimitExceeded,
            "managed file exceeds 16 MiB",
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)
        .map(|file| file.take(MAX_FILE as u64 + 1))
        .and_then(|mut file| file.read_to_end(&mut bytes))
        .map_err(|error| ReconcileError::io(ErrorCode::Io, "cannot read managed file", error))?;
    if bytes.len() > MAX_FILE {
        return Err(ReconcileError::new(
            ErrorCode::BundleLimitExceeded,
            "managed file grew beyond 16 MiB while reading",
        ));
    }
    Ok(Some(format!("sha256:{}", hex_file_sha256(&bytes))))
}

fn write_regular_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| ReconcileError::io(ErrorCode::Io, "cannot stage managed file", error))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o644))
            .map_err(|error| {
                ReconcileError::io(ErrorCode::Io, "cannot set managed file permissions", error)
            })?;
    }
    (&file)
        .write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| ReconcileError::io(ErrorCode::Io, "cannot sync managed file", error))
}

fn read_file_receipt(path: &Path, target: &Path, name: &str) -> Result<Option<FileReceipt>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(ReconcileError::io(
                ErrorCode::Io,
                "cannot inspect file Receipt",
                error,
            ));
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > MAX_STATE_FILE {
        return Err(ReconcileError::new(
            ErrorCode::CorruptReceipt,
            "file Receipt is not a bounded regular file",
        ));
    }
    let bytes = fs::read(path)
        .map_err(|error| ReconcileError::io(ErrorCode::Io, "cannot read file Receipt", error))?;
    let receipt: FileReceipt = serde_json::from_slice(&bytes).map_err(|_| {
        ReconcileError::new(ErrorCode::CorruptReceipt, "file Receipt is invalid JSON")
    })?;
    if receipt.version != 1
        || receipt.target != path_string(target)
        || receipt.name != name
        || validate_file_name(&receipt.name).is_err()
        || parse_digest(&receipt.digest).is_err()
    {
        return Err(ReconcileError::new(
            ErrorCode::CorruptReceipt,
            "file Receipt binding or contents are invalid",
        ));
    }
    Ok(Some(receipt))
}

fn recover_file_transaction(
    destination: &Path,
    shared: &Path,
    receipt_path: &Path,
    journal_path: &Path,
) -> Result<()> {
    let metadata = match fs::symlink_metadata(journal_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(ReconcileError::io(
                ErrorCode::RecoveryFailed,
                "cannot inspect file journal",
                error,
            ));
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > MAX_STATE_FILE {
        return Err(ReconcileError::new(
            ErrorCode::RecoveryFailed,
            "file journal is not a bounded regular file",
        ));
    }
    let bytes = fs::read(journal_path).map_err(|error| {
        ReconcileError::io(ErrorCode::RecoveryFailed, "cannot read file journal", error)
    })?;
    let journal: FileJournal = serde_json::from_slice(&bytes)
        .map_err(|_| ReconcileError::new(ErrorCode::RecoveryFailed, "file journal is corrupt"))?;
    let target = destination.parent().ok_or_else(|| {
        ReconcileError::new(ErrorCode::RecoveryFailed, "managed file has no parent")
    })?;
    if journal.version != 1
        || journal.target != path_string(target)
        || destination.file_name().and_then(|x| x.to_str()) != Some(journal.name.as_str())
        || validate_file_name(&journal.name).is_err()
        || journal.transaction.len() != 64
        || journal
            .desired_digest
            .as_deref()
            .is_some_and(|digest| parse_digest(digest).is_err())
    {
        return Err(ReconcileError::new(
            ErrorCode::RecoveryFailed,
            "file journal binding is invalid",
        ));
    }
    let transaction = shared.join(format!("txn-{}", journal.transaction));
    if journal.phase == Phase::Committed {
        if transaction.exists() {
            remove_tree(&transaction)?;
        }
        remove_file_sync(journal_path)?;
        return Ok(());
    }
    let backup = transaction.join("old");
    if backup.exists() {
        if destination.exists() {
            let actual = digest_regular_file(destination)?;
            if journal.desired_digest.as_ref() != actual.as_ref() {
                return Err(ReconcileError::new(
                    ErrorCode::RecoveryFailed,
                    "managed file changed during recovery",
                ));
            }
            fs::remove_file(destination).map_err(|error| {
                ReconcileError::io(
                    ErrorCode::RecoveryFailed,
                    "cannot remove interrupted managed file",
                    error,
                )
            })?;
        }
        fs::rename(&backup, destination).map_err(|error| {
            ReconcileError::io(
                ErrorCode::RecoveryFailed,
                "cannot restore managed file",
                error,
            )
        })?;
        sync_parent(destination)?;
    } else if !journal.old_present {
        if destination.exists() {
            let actual = digest_regular_file(destination)?;
            if journal.desired_digest.as_ref() != actual.as_ref() {
                return Err(ReconcileError::new(
                    ErrorCode::RecoveryFailed,
                    "managed file changed during recovery",
                ));
            }
            fs::remove_file(destination).map_err(|error| {
                ReconcileError::io(
                    ErrorCode::RecoveryFailed,
                    "cannot roll back managed file creation",
                    error,
                )
            })?;
            sync_parent(destination)?;
        }
    } else {
        let actual = digest_regular_file(destination)?;
        let old_digest = journal.old_receipt.as_ref().map(|receipt| &receipt.digest);
        if actual.as_ref() != old_digest {
            return Err(ReconcileError::new(
                ErrorCode::RecoveryFailed,
                "managed file backup is missing",
            ));
        }
    }
    match journal.old_receipt {
        Some(receipt) => write_json_atomic(receipt_path, &receipt)?,
        None if receipt_path.exists() => remove_file_sync(receipt_path)?,
        None => {}
    }
    if transaction.exists() {
        remove_tree(&transaction)?;
    }
    remove_file_sync(journal_path)
}

fn file_outcome(target: &Path, assignment: &FileAssignment, changed: bool) -> FileReconcileOutcome {
    FileReconcileOutcome {
        target: target.to_owned(),
        file: assignment.file.name.clone(),
        assignment_id: assignment.assignment_id.clone(),
        desired_revision_id: assignment.desired_revision_id.clone(),
        changed,
        owned_digest: assignment.file.digest.clone(),
    }
}

fn read_receipt(path: &Path, target: &Path) -> Result<Option<Receipt>> {
    match fs::symlink_metadata(path) {
        Ok(meta)
            if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX_STATE_FILE =>
        {
            return Err(ReconcileError::new(
                ErrorCode::CorruptReceipt,
                "Receipt is not a bounded regular file",
            ));
        }
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(ReconcileError::io(
                ErrorCode::Io,
                "cannot inspect Receipt",
                e,
            ));
        }
    }
    match fs::read(path) {
        Ok(bytes) => {
            let r: Receipt = serde_json::from_slice(&bytes).map_err(|_| {
                ReconcileError::new(ErrorCode::CorruptReceipt, "Receipt is invalid JSON")
            })?;
            if r.version != 1
                || r.target != path_string(target)
                || r.skills
                    .iter()
                    .any(|(n, d)| validate_skill_name(n).is_err() || parse_digest(d).is_err())
            {
                return Err(ReconcileError::new(
                    ErrorCode::CorruptReceipt,
                    "Receipt binding or contents are invalid",
                ));
            }
            Ok(Some(r))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(ReconcileError::io(ErrorCode::Io, "cannot read Receipt", e)),
    }
}

fn recover(target: &Path, shared: &Path, receipt_path: &Path, journal_path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(journal_path)
        .map_err(|e| ReconcileError::io(ErrorCode::RecoveryFailed, "cannot inspect journal", e))?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX_STATE_FILE {
        return Err(ReconcileError::new(
            ErrorCode::RecoveryFailed,
            "journal is not a bounded regular file",
        ));
    }
    let bytes = fs::read(journal_path)
        .map_err(|e| ReconcileError::io(ErrorCode::RecoveryFailed, "cannot read journal", e))?;
    let journal: Journal = serde_json::from_slice(&bytes)
        .map_err(|_| ReconcileError::new(ErrorCode::RecoveryFailed, "journal is corrupt"))?;
    if journal.version != 1
        || journal.target != path_string(target)
        || journal.transaction.len() != 64
    {
        return Err(ReconcileError::new(
            ErrorCode::RecoveryFailed,
            "journal binding is invalid",
        ));
    }
    let tx = shared.join(format!("txn-{}", journal.transaction));
    let backup = tx.join("old");
    if journal.phase == Phase::Committed {
        if tx.exists() {
            remove_tree(&tx)?;
        }
        remove_file_sync(journal_path)?;
        return Ok(());
    }
    for name in union_names(&journal.old_names, &journal.new_names) {
        validate_skill_name(&name).map_err(|_| {
            ReconcileError::new(
                ErrorCode::RecoveryFailed,
                "journal contains invalid Skill name",
            )
        })?;
        let current = target.join(&name);
        let old = backup.join(&name);
        if old.exists() {
            if current.exists() {
                remove_tree(&current)?;
            }
            fs::rename(&old, &current).map_err(|e| {
                ReconcileError::io(
                    ErrorCode::RecoveryFailed,
                    format!("cannot restore {name}"),
                    e,
                )
            })?;
            sync_parent(&current)?;
        } else if !journal.old_names.contains(&name) && current.exists() {
            remove_tree(&current)?;
        } else if journal.old_names.contains(&name) && !current.exists() {
            return Err(ReconcileError::new(
                ErrorCode::RecoveryFailed,
                format!("backup for {name} is missing"),
            ));
        }
    }
    match journal.old_receipt {
        Some(r) => write_json_atomic(receipt_path, &r)?,
        None => {
            if receipt_path.exists() {
                remove_file_sync(receipt_path)?
            }
        }
    }
    if tx.exists() {
        remove_tree(&tx)?;
    }
    remove_file_sync(journal_path)?;
    Ok(())
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<()> {
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
fn sync_tree(path: &Path) -> Result<()> {
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
fn sync_parent(path: &Path) -> Result<()> {
    File::open(path.parent().unwrap())
        .and_then(|f| f.sync_all())
        .map_err(|e| ReconcileError::io(ErrorCode::Io, "cannot sync parent directory", e))
}
fn remove_file_sync(path: &Path) -> Result<()> {
    fs::remove_file(path)
        .map_err(|e| ReconcileError::io(ErrorCode::Io, "cannot remove state file", e))?;
    sync_parent(path)
}
fn remove_tree(path: &Path) -> Result<()> {
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
fn union_names(a: &[String], b: &[String]) -> BTreeSet<String> {
    a.iter().chain(b).cloned().collect()
}
fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
fn hex_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        use fmt::Write as _;
        write!(&mut out, "{b:02x}").unwrap();
    }
    out
}

fn hex_file_sha256(bytes: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(b"fleet.file/v1\0");
    digest.update(bytes);
    format!("{:x}", digest.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> io::Result<Self> {
            let p = std::env::temp_dir().canonicalize().unwrap().join(format!(
                "fleet-reconcile-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&p)?;
            Ok(Self(p))
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn bundle(entries: &[(&str, bool, &[u8])]) -> Vec<u8> {
        let mut v = MAGIC.to_vec();
        v.extend((entries.len() as u32).to_be_bytes());
        for (p, x, b) in entries {
            v.extend((p.len() as u32).to_be_bytes());
            v.extend(p.as_bytes());
            v.push(u8::from(*x));
            v.extend((b.len() as u64).to_be_bytes());
            v.extend(*b);
        }
        v
    }
    fn skill(name: &str, entries: &[(&str, bool, &[u8])]) -> DesiredSkill {
        let b = bundle(entries);
        DesiredSkill {
            name: name.into(),
            digest: format!("sha256:{}", hex_sha256(&b)),
            size: b.len() as u64,
            schema: SCHEMA.into(),
            bundle: b,
        }
    }
    fn setup() -> (TestDir, Reconciler, TargetDescriptor) {
        let t = TestDir::new().unwrap();
        let h = t.path().join("home");
        let s = t.path().join("state");
        fs::create_dir(&h).unwrap();
        let r = Reconciler::new(&h, &s).unwrap();
        (
            t,
            r,
            TargetDescriptor {
                base: TargetBase::Home,
                path: "skills".into(),
            },
        )
    }
    fn assignment(id: &str, skills: Vec<DesiredSkill>) -> Assignment {
        Assignment {
            assignment_id: id.into(),
            desired_revision_id: format!("rev-{id}"),
            skills,
        }
    }
    fn file_assignment(id: &str, name: &str, content: Option<&[u8]>) -> FileAssignment {
        let (digest, size, schema, bytes) = match content {
            Some(content) => (
                Some(format!("sha256:{}", hex_file_sha256(content))),
                Some(content.len() as u64),
                Some(FILE_SCHEMA.to_owned()),
                content.to_vec(),
            ),
            None => (None, None, None, Vec::new()),
        };
        FileAssignment {
            assignment_id: id.into(),
            desired_revision_id: format!("rev-{id}"),
            file: DesiredFile {
                name: name.into(),
                digest,
                size,
                schema,
                content: bytes,
            },
        }
    }
    #[test]
    fn managed_file_installs_updates_and_removes_owned_content() {
        let (_temporary, reconciler, mut target) = setup();
        target.path = ".codex".into();
        assert!(
            reconciler
                .reconcile_file(&target, &file_assignment("1", "AGENTS.md", Some(b"one")))
                .unwrap()
                .changed
        );
        assert_eq!(
            fs::read(reconciler.home.join(".codex/AGENTS.md")).unwrap(),
            b"one"
        );
        reconciler
            .reconcile_file(&target, &file_assignment("2", "AGENTS.md", Some(b"two")))
            .unwrap();
        assert_eq!(
            fs::read(reconciler.home.join(".codex/AGENTS.md")).unwrap(),
            b"two"
        );
        reconciler
            .reconcile_file(&target, &file_assignment("3", "AGENTS.md", Some(b"")))
            .unwrap();
        assert!(reconciler.home.join(".codex/AGENTS.md").is_file());
        assert!(
            fs::read(reconciler.home.join(".codex/AGENTS.md"))
                .unwrap()
                .is_empty()
        );
        reconciler
            .reconcile_file(&target, &file_assignment("4", "AGENTS.md", None))
            .unwrap();
        assert!(!reconciler.home.join(".codex/AGENTS.md").exists());
    }
    #[test]
    fn managed_file_refuses_to_replace_unowned_content() {
        let (_temporary, reconciler, mut target) = setup();
        target.path = ".claude".into();
        fs::create_dir(reconciler.home.join(".claude")).unwrap();
        fs::write(reconciler.home.join(".claude/CLAUDE.md"), b"personal").unwrap();
        let error = reconciler
            .reconcile_file(&target, &file_assignment("1", "CLAUDE.md", Some(b"fleet")))
            .unwrap_err();
        assert_eq!(error.code(), ErrorCode::OwnershipConflict);
        assert_eq!(
            fs::read(reconciler.home.join(".claude/CLAUDE.md")).unwrap(),
            b"personal"
        );
    }
    #[test]
    fn managed_file_removal_does_not_create_an_excluded_client_directory() {
        let (_temporary, reconciler, mut target) = setup();
        target.path = ".claude".into();

        let outcome = reconciler
            .reconcile_file(&target, &file_assignment("1", "CLAUDE.md", None))
            .unwrap();

        assert!(!outcome.changed);
        assert!(!reconciler.home.join(".claude").exists());
    }
    #[test]
    fn managed_file_repairs_owned_drift() {
        let (_temporary, reconciler, mut target) = setup();
        target.path = ".config/opencode".into();
        let assignment = file_assignment("1", "AGENTS.md", Some(b"fleet"));
        reconciler.reconcile_file(&target, &assignment).unwrap();
        fs::write(reconciler.home.join(".config/opencode/AGENTS.md"), b"drift").unwrap();
        assert!(
            reconciler
                .reconcile_file(&target, &assignment)
                .unwrap()
                .changed
        );
        assert_eq!(
            fs::read(reconciler.home.join(".config/opencode/AGENTS.md")).unwrap(),
            b"fleet"
        );
    }
    #[test]
    fn managed_file_recovery_restores_the_previous_content() {
        let (_temporary, reconciler, mut target) = setup();
        target.path = ".codex".into();
        reconciler
            .reconcile_file(&target, &file_assignment("1", "AGENTS.md", Some(b"old")))
            .unwrap();
        let target_path = reconciler.home.join(".codex");
        let destination = target_path.join("AGENTS.md");
        let key = hex_sha256(destination.as_os_str().to_string_lossy().as_bytes());
        let shared = target_path
            .parent()
            .unwrap()
            .join(".fleet-reconcile")
            .join(&key);
        let transaction = "c".repeat(64);
        let transaction_root = shared.join(format!("txn-{transaction}"));
        fs::create_dir_all(&transaction_root).unwrap();
        fs::rename(&destination, transaction_root.join("old")).unwrap();
        fs::write(&destination, b"new").unwrap();
        let state = reconciler.state_dir.join("files").join(&key);
        let old_receipt =
            read_file_receipt(&state.join("receipt.json"), &target_path, "AGENTS.md").unwrap();
        write_json_atomic(
            &state.join("journal.json"),
            &FileJournal {
                version: 1,
                target: path_string(&target_path),
                name: "AGENTS.md".into(),
                transaction,
                phase: Phase::Applying,
                old_receipt,
                old_present: true,
                desired_digest: Some(format!("sha256:{}", hex_file_sha256(b"new"))),
            },
        )
        .unwrap();

        reconciler.recover_file(&target, "AGENTS.md").unwrap();

        assert_eq!(fs::read(destination).unwrap(), b"old");
    }
    #[test]
    fn install_update_remove_and_preserve_unowned() {
        let (_t, r, d) = setup();
        let a = assignment(
            "1",
            vec![
                skill("alpha", &[("SKILL.md", false, b"one")]),
                skill("beta", &[("SKILL.md", false, b"b")]),
            ],
        );
        assert!(r.reconcile(&d, &a).unwrap().changed);
        fs::create_dir(r.home.join("skills/local")).unwrap();
        fs::write(r.home.join("skills/local/x"), b"x").unwrap();
        let b = assignment("2", vec![skill("alpha", &[("SKILL.md", false, b"two")])]);
        r.reconcile(&d, &b).unwrap();
        assert_eq!(
            fs::read(r.home.join("skills/alpha/SKILL.md")).unwrap(),
            b"two"
        );
        assert!(!r.home.join("skills/beta").exists());
        assert!(r.home.join("skills/local/x").exists());
    }
    #[test]
    fn refuses_unowned_conflict() {
        let (_t, r, d) = setup();
        fs::create_dir_all(r.home.join("skills/alpha")).unwrap();
        fs::write(r.home.join("skills/alpha/SKILL.md"), b"x").unwrap();
        let e = r
            .reconcile(
                &d,
                &assignment("1", vec![skill("alpha", &[("SKILL.md", false, b"x")])]),
            )
            .unwrap_err();
        assert_eq!(e.code(), ErrorCode::OwnershipConflict);
    }
    #[test]
    fn nested_and_executable_round_trip() {
        let (_t, r, d) = setup();
        r.reconcile(
            &d,
            &assignment(
                "1",
                vec![skill(
                    "alpha",
                    &[("SKILL.md", false, b"x"), ("bin/run", true, b"#!")],
                )],
            ),
        )
        .unwrap();
        assert_eq!(
            fs::read(r.home.join("skills/alpha/bin/run")).unwrap(),
            b"#!"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_ne!(
                fs::metadata(r.home.join("skills/alpha/bin/run"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o111,
                0
            );
        }
    }
    #[test]
    fn rejects_digest_before_parse() {
        let (_t, r, d) = setup();
        let mut s = skill("alpha", &[("SKILL.md", false, b"x")]);
        s.bundle.truncate(3);
        s.size = 3;
        let e = r.reconcile(&d, &assignment("1", vec![s])).unwrap_err();
        assert_eq!(e.code(), ErrorCode::BundleDigestMismatch);
    }
    #[test]
    fn rejects_traversal_and_collision() {
        let (_t, r, d) = setup();
        let e = r
            .reconcile(
                &d,
                &assignment("1", vec![skill("alpha", &[("../x", false, b"x")])]),
            )
            .unwrap_err();
        assert_eq!(e.code(), ErrorCode::InvalidBundlePath);
        let e = r
            .reconcile(
                &d,
                &assignment(
                    "2",
                    vec![skill("alpha", &[("A", false, b"x"), ("a", false, b"y")])],
                ),
            )
            .unwrap_err();
        assert_eq!(e.code(), ErrorCode::BundlePathCollision);
    }
    #[test]
    fn repairs_owned_drift() {
        let (_t, r, d) = setup();
        r.reconcile(
            &d,
            &assignment("1", vec![skill("alpha", &[("SKILL.md", false, b"x")])]),
        )
        .unwrap();
        fs::write(r.home.join("skills/alpha/SKILL.md"), b"edit").unwrap();
        let current = assignment("1", vec![skill("alpha", &[("SKILL.md", false, b"x")])]);
        assert!(r.reconcile(&d, &current).unwrap().changed);
        assert_eq!(
            fs::read(r.home.join("skills/alpha/SKILL.md")).unwrap(),
            b"x"
        );
    }
    #[test]
    fn restores_missing_owned_skill_and_preserves_unowned() {
        let (_t, r, d) = setup();
        let current = assignment("1", vec![skill("alpha", &[("SKILL.md", false, b"x")])]);
        r.reconcile(&d, &current).unwrap();
        fs::remove_dir_all(r.home.join("skills/alpha")).unwrap();
        fs::create_dir(r.home.join("skills/local")).unwrap();
        fs::write(r.home.join("skills/local/data"), b"local").unwrap();
        assert!(r.reconcile(&d, &current).unwrap().changed);
        assert_eq!(
            fs::read(r.home.join("skills/alpha/SKILL.md")).unwrap(),
            b"x"
        );
        assert_eq!(
            fs::read(r.home.join("skills/local/data")).unwrap(),
            b"local"
        );
    }
    #[test]
    fn corrupt_receipt_blocks_changes() {
        let (_t, r, d) = setup();
        r.reconcile(
            &d,
            &assignment("1", vec![skill("alpha", &[("SKILL.md", false, b"x")])]),
        )
        .unwrap();
        let key = hex_sha256(
            r.home
                .join("skills")
                .as_os_str()
                .to_string_lossy()
                .as_bytes(),
        );
        fs::write(
            r.state_dir.join("targets").join(key).join("receipt.json"),
            b"no",
        )
        .unwrap();
        let e = r.reconcile(&d, &assignment("2", vec![])).unwrap_err();
        assert_eq!(e.code(), ErrorCode::CorruptReceipt);
        assert!(r.home.join("skills/alpha").exists());
    }
    #[test]
    fn interrupted_apply_rolls_back() {
        let (_t, r, d) = setup();
        let one = assignment("1", vec![skill("alpha", &[("SKILL.md", false, b"old")])]);
        r.reconcile(&d, &one).unwrap();
        let target = r.home.join("skills");
        let key = hex_sha256(target.as_os_str().to_string_lossy().as_bytes());
        let shared = target.parent().unwrap().join(".fleet-reconcile").join(&key);
        let tx = "a".repeat(64);
        let root = shared.join(format!("txn-{tx}"));
        fs::create_dir_all(root.join("old")).unwrap();
        fs::rename(target.join("alpha"), root.join("old/alpha")).unwrap();
        fs::create_dir(target.join("alpha")).unwrap();
        fs::write(target.join("alpha/SKILL.md"), b"new").unwrap();
        let state = r.state_dir.join("targets").join(&key);
        let old = read_receipt(&state.join("receipt.json"), &target).unwrap();
        let j = Journal {
            version: 1,
            target: path_string(&target),
            transaction: tx,
            phase: Phase::Applying,
            old_receipt: old,
            old_names: vec!["alpha".into()],
            new_names: vec!["alpha".into()],
        };
        write_json_atomic(&state.join("journal.json"), &j).unwrap();
        let out = r.reconcile(&d, &one).unwrap();
        assert!(!out.changed);
        assert_eq!(fs::read(target.join("alpha/SKILL.md")).unwrap(), b"old");
    }

    #[test]
    fn recovery_restores_observed_drift_snapshot() {
        let (_t, r, d) = setup();
        let one = assignment("1", vec![skill("alpha", &[("SKILL.md", false, b"old")])]);
        r.reconcile(&d, &one).unwrap();
        let target = r.home.join("skills");
        fs::write(target.join("alpha/SKILL.md"), b"local drift").unwrap();
        let key = hex_sha256(target.as_os_str().to_string_lossy().as_bytes());
        let shared = target.parent().unwrap().join(".fleet-reconcile").join(&key);
        let tx = "b".repeat(64);
        let root = shared.join(format!("txn-{tx}"));
        fs::create_dir_all(root.join("old")).unwrap();
        fs::rename(target.join("alpha"), root.join("old/alpha")).unwrap();
        fs::create_dir(target.join("alpha")).unwrap();
        fs::write(target.join("alpha/SKILL.md"), b"new").unwrap();
        let state = r.state_dir.join("targets").join(&key);
        let old = read_receipt(&state.join("receipt.json"), &target).unwrap();
        write_json_atomic(
            &state.join("journal.json"),
            &Journal {
                version: 1,
                target: path_string(&target),
                transaction: tx,
                phase: Phase::Applying,
                old_receipt: old,
                old_names: vec!["alpha".into()],
                new_names: vec!["alpha".into()],
            },
        )
        .unwrap();
        r.recover(&d).unwrap();
        assert_eq!(
            fs::read(target.join("alpha/SKILL.md")).unwrap(),
            b"local drift"
        );
    }

    #[test]
    fn oversized_sparse_drift_fails_before_reading_content() {
        let (_t, r, d) = setup();
        let current = assignment("1", vec![skill("alpha", &[("SKILL.md", false, b"x")])]);
        r.reconcile(&d, &current).unwrap();
        OpenOptions::new()
            .write(true)
            .open(r.home.join("skills/alpha/SKILL.md"))
            .unwrap()
            .set_len(MAX_FILE as u64 + 1)
            .unwrap();
        let error = r.reconcile(&d, &current).unwrap_err();
        assert_eq!(error.code(), ErrorCode::BundleLimitExceeded);
    }

    #[test]
    fn deeply_nested_drift_is_bounded() {
        let (_t, r, d) = setup();
        let current = assignment("1", vec![skill("alpha", &[("SKILL.md", false, b"x")])]);
        r.reconcile(&d, &current).unwrap();
        let mut deep = r.home.join("skills/alpha");
        for _ in 0..=MAX_DEPTH {
            deep.push("d");
        }
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("file"), b"x").unwrap();
        let error = r.reconcile(&d, &current).unwrap_err();
        assert_eq!(error.code(), ErrorCode::InvalidBundlePath);
    }
}
