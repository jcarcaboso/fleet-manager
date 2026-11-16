//! The managed-file transaction engine: one Fleet-owned file in a Target
//! directory, its Receipt and journal under `files/<key>/`, and recovery.

use crate::{
    DesiredFile, ErrorCode, FileAssignment, FileReconcileOutcome, MAX_FILE_BYTES, Phase,
    ReconcileError, Reconciler, Result, Step, TargetDescriptor,
    bundle::parse_digest,
    fsx::{
        IfMissing, Locked, StateFile, ensure_beneath, ensure_private_dir, lock_shared,
        read_state_file, remove_file_sync, remove_tree, sync_parent, write_json_atomic,
    },
    hex_sha256,
    observe::digest_regular_file,
    path_string, validate_id,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, fs::OpenOptions, io::Write, path::Path};
use unicode_normalization::UnicodeNormalization;

pub(crate) const FILE_SCHEMA: &str = "fleet.file/v1";
const EMPTY_FILE_DIGEST: &str =
    "sha256:b48b182ea449044fd6d169a8f504bd2704d7cbb822ef0c2c7c7ba0d99649c5f6";
const RECEIPT: StateFile = StateFile::receipt("file Receipt");
const JOURNAL: StateFile = StateFile::journal("file journal");

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
    pub(crate) fn reconcile_managed_file(
        &self,
        target: &TargetDescriptor,
        assignment: &FileAssignment,
    ) -> Result<FileReconcileOutcome> {
        validate_id(&assignment.assignment_id)?;
        validate_id(&assignment.desired_revision_id)?;
        validate_file(&assignment.file)?;
        let target_path = self.resolve_target(target, assignment.file.digest.is_some())?;
        let destination = target_path.join(&assignment.file.name);
        let lock = lock_shared(&target_path, &destination, Locked::ManagedFile, true)?;
        self.reconcile_file_locked(
            &target_path,
            &destination,
            &lock.shared,
            &lock.key,
            assignment,
        )
    }

    pub(crate) fn recover_managed_file(&self, target: &TargetDescriptor, name: &str) -> Result<()> {
        validate_file_name(name)?;
        let target_path = self.resolve_target(target, false)?;
        let destination = target_path.join(name);
        let lock = lock_shared(&target_path, &destination, Locked::ManagedFile, false)?;
        let state = self.state_dir.join("files").join(&lock.key);
        ensure_private_dir(&state, ErrorCode::Io)?;
        if state.join("journal.json").exists() {
            ensure_beneath(&self.home, &target_path, true)?;
        }
        recover_file_transaction(
            &destination,
            &lock.shared,
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
        let old = read_file_receipt(&receipt_path, target, &assignment.file.name)
            .map_err(|error| error.step_if_unset(Step::Receipt))?;
        let observed = digest_regular_file(destination)?;
        if old.is_none()
            && observed
                .as_deref()
                .is_some_and(|digest| digest != EMPTY_FILE_DIGEST)
            && assignment.file.digest.is_some()
        {
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
            return Ok(FileReconcileOutcome {
                changed: false,
                repaired: Vec::new(),
            });
        }
        // Owned content that differs from its receipt was changed outside
        // Fleet; rewriting it is a drift repair. Removing it is not.
        let repaired = match (&old, &desired) {
            (Some(receipt), Some(_)) if observed.as_ref() != Some(&receipt.digest) => {
                vec![assignment.file.name.clone()]
            }
            _ => Vec::new(),
        };

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
        ensure_private_dir(&tx_root, ErrorCode::Io)
            .map_err(|error| error.with_step(Step::Stage))?;
        let staged = tx_root.join("new");
        let backup = tx_root.join("old");
        if desired.is_some() {
            write_regular_file(&staged, &assignment.file.content)
                .map_err(|error| error.with_step(Step::Stage))?;
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
                if digest_regular_file(destination)
                    .map_err(|error| error.step_if_unset(Step::Verify))?
                    .as_ref()
                    != Some(digest)
                {
                    return Err(ReconcileError::new(
                        ErrorCode::TargetChanged,
                        "managed file verification failed",
                    )
                    .with_step(Step::Verify));
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
                )
                .map_err(|error| error.with_step(Step::Receipt))?;
            } else if receipt_path.exists() {
                remove_file_sync(&receipt_path).map_err(|error| error.with_step(Step::Receipt))?;
            }
            let mut committed = journal.clone();
            committed.phase = Phase::Committed;
            write_json_atomic(&journal_path, &committed)?;
            Ok(())
        })()
        .map_err(|error: ReconcileError| error.step_if_unset(Step::Activate));
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
        Ok(FileReconcileOutcome {
            changed: true,
            repaired,
        })
    }
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
            if size != file.content.len() as u64 || file.content.len() > MAX_FILE_BYTES {
                return Err(ReconcileError::new(
                    ErrorCode::BundleSizeMismatch,
                    "managed file size does not match its content",
                ));
            }
            if file_digest(&file.content) != *digest {
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
    let Some(receipt) = read_state_file::<FileReceipt>(path, RECEIPT, IfMissing::Absent)? else {
        return Ok(None);
    };
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
    recover_file_journal(destination, shared, receipt_path, journal_path)
        .map_err(|error| error.step_if_unset(Step::Recover))
}

fn recover_file_journal(
    destination: &Path,
    shared: &Path,
    receipt_path: &Path,
    journal_path: &Path,
) -> Result<()> {
    let Some(journal) = read_state_file::<FileJournal>(journal_path, JOURNAL, IfMissing::Absent)?
    else {
        return Ok(());
    };
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

/// The `fleet.file/v1` digest of a managed file's content, as
/// `sha256:<lowercase hex>`: SHA-256 over `fleet.file/v1\0` followed by the
/// content.
pub fn file_digest(content: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(b"fleet.file/v1\0");
    digest.update(content);
    format!("sha256:{:x}", digest.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{file_assignment, setup};
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
                desired_digest: Some(file_digest(b"new")),
            },
        )
        .unwrap();

        reconciler.recover_file(&target, "AGENTS.md").unwrap();

        assert_eq!(fs::read(destination).unwrap(), b"old");
    }
}
