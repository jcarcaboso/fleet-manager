//! The Skills transaction engine: a Target directory holding Fleet-owned Skill
//! directories, its Receipt and journal under `targets/<key>/`, and recovery.

use crate::{
    Assignment, ErrorCode, Phase, ReconcileError, ReconcileOutcome, Reconciler, Result, Step,
    TargetDescriptor,
    bundle::{ParsedSkill, parse_digest, validate_assignment, validate_skill_name},
    fsx::{
        IfMissing, Locked, StateFile, ensure_beneath, ensure_private_dir, lock_shared,
        read_state_file, remove_file_sync, remove_tree, sync_parent, sync_tree, write_json_atomic,
    },
    hex_sha256,
    observe::{differing_files, digest_tree},
    path_string, validate_id,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    fs::OpenOptions,
    io::{self, Write},
    path::{Path, PathBuf},
};

const RECEIPT: StateFile = StateFile::receipt("Receipt");
const JOURNAL: StateFile = StateFile::journal("journal");

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Receipt {
    version: u32,
    target: String,
    assignment_id: String,
    desired_revision_id: String,
    skills: BTreeMap<String, String>,
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

impl Reconciler {
    pub(crate) fn reconcile_skills(
        &self,
        target: &TargetDescriptor,
        assignment: &Assignment,
    ) -> Result<ReconcileOutcome> {
        validate_id(&assignment.assignment_id)?;
        validate_id(&assignment.desired_revision_id)?;
        let parsed = validate_assignment(assignment)?;
        let target_path = self.resolve_target(target, true)?;
        let lock = lock_shared(&target_path, &target_path, Locked::Target, true)?;
        self.reconcile_locked(&target_path, &lock.shared, &lock.key, assignment, parsed)
    }

    pub(crate) fn recover_skills(&self, target: &TargetDescriptor) -> Result<()> {
        let target_path = self.resolve_target(target, true)?;
        let lock = lock_shared(&target_path, &target_path, Locked::Target, false)?;
        let state = self.state_dir.join("targets").join(&lock.key);
        ensure_private_dir(&state, ErrorCode::Io)?;
        let journal = state.join("journal.json");
        if journal.exists() {
            recover(
                &target_path,
                &lock.shared,
                &state.join("receipt.json"),
                &journal,
            )?;
        }
        Ok(())
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
        let old = read_receipt(&receipt_path, target)
            .map_err(|error| error.step_if_unset(Step::Receipt))?;
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
                        observed_owned.insert(
                            name.clone(),
                            digest_tree(&path).map_err(|error| error.nested_in(name))?,
                        );
                    }
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                    Err(e) => {
                        return Err(ReconcileError::io(
                            ErrorCode::Io,
                            format!("cannot inspect owned Skill {name}"),
                            e,
                        )
                        .at_entry(name));
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
                )
                .at_entry(&skill.name));
            }
        }
        let unchanged = old.as_ref().is_some_and(|r| r.skills == desired)
            && observed_owned == desired
            && old.as_ref().is_some_and(|r| {
                r.assignment_id == assignment.assignment_id
                    && r.desired_revision_id == assignment.desired_revision_id
            });
        if unchanged {
            return Ok(ReconcileOutcome {
                changed: false,
                repaired: Vec::new(),
            });
        }
        let repaired = old
            .as_ref()
            .map(|receipt| drifted_paths(target, receipt, &observed_owned, &parsed))
            .unwrap_or_default();

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
        (|| {
            ensure_private_dir(&staged, ErrorCode::Io)?;
            ensure_private_dir(&backup, ErrorCode::Io)?;
            for skill in &parsed {
                extract_skill(&staged.join(&skill.name), skill)
                    .map_err(|error| error.nested_in(&skill.name))?;
            }
            sync_tree(&staged)
        })()
        .map_err(|error: ReconcileError| error.with_step(Step::Stage))?;

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
                let actual = digest_tree(&target.join(name))
                    .map_err(|error| error.nested_in(name).with_step(Step::Verify))?;
                if actual != *digest {
                    return Err(ReconcileError::new(
                        ErrorCode::TargetChanged,
                        format!("verification failed for {name}"),
                    )
                    .with_step(Step::Verify)
                    .at_entry(name));
                }
            }
            let receipt = Receipt {
                version: 1,
                target: path_string(target),
                assignment_id: assignment.assignment_id.clone(),
                desired_revision_id: assignment.desired_revision_id.clone(),
                skills: desired.clone(),
            };
            write_json_atomic(&receipt_path, &receipt)
                .map_err(|error| error.with_step(Step::Receipt))?;
            let mut committed = journal.clone();
            committed.phase = Phase::Committed;
            write_json_atomic(&journal_path, &committed)?;
            Ok(())
        })()
        .map_err(|error: ReconcileError| error.step_if_unset(Step::Activate));
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
        Ok(ReconcileOutcome {
            changed: true,
            repaired,
        })
    }
}

/// Entries below the Target directory of still-wanted owned Skills whose
/// observed content differs from the receipt. When the Assignment carries the
/// content the receipt recorded, the differing files are named; otherwise (the
/// Skill is also being updated, or its files cannot be listed) the Skill
/// directory is.
fn drifted_paths(
    target: &Path,
    receipt: &Receipt,
    observed: &BTreeMap<String, String>,
    parsed: &[ParsedSkill],
) -> Vec<String> {
    let mut out = Vec::new();
    for (name, digest) in &receipt.skills {
        if observed.get(name) == Some(digest) {
            continue;
        }
        // A Skill the Assignment drops is removed, not repaired.
        let Some(wanted) = parsed.iter().find(|s| s.name == *name) else {
            continue;
        };
        let files = (wanted.digest == *digest)
            .then(|| differing_files(&target.join(name), wanted))
            .flatten()
            .filter(|files| !files.is_empty());
        match files {
            Some(files) => out.extend(files.into_iter().map(|file| format!("{name}/{file}"))),
            None => out.push(name.clone()),
        }
    }
    out
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

fn read_receipt(path: &Path, target: &Path) -> Result<Option<Receipt>> {
    let Some(r) = read_state_file::<Receipt>(path, RECEIPT, IfMissing::AbsentEvenWhileReading)?
    else {
        return Ok(None);
    };
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

fn recover(target: &Path, shared: &Path, receipt_path: &Path, journal_path: &Path) -> Result<()> {
    recover_journal(target, shared, receipt_path, journal_path)
        .map_err(|error| error.step_if_unset(Step::Recover))
}

fn recover_journal(
    target: &Path,
    shared: &Path,
    receipt_path: &Path,
    journal_path: &Path,
) -> Result<()> {
    let Some(journal) = read_state_file::<Journal>(journal_path, JOURNAL, IfMissing::Fail)? else {
        unreachable!("IfMissing::Fail reports a missing journal as an error");
    };
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

fn union_names(a: &[String], b: &[String]) -> BTreeSet<String> {
    a.iter().chain(b).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{assignment, setup, skill};
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
}
