//! End-to-end tests through the public API, and the fixtures that the
//! module-level tests share.

use crate::{
    bundle::{MAGIC, MAX_DEPTH, SCHEMA},
    managed_file::FILE_SCHEMA,
    *,
};
use std::fs::{self, OpenOptions};
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(0);
pub(crate) struct TestDir(PathBuf);
impl TestDir {
    pub(crate) fn new() -> io::Result<Self> {
        let p = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "fleet-reconcile-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&p)?;
        Ok(Self(p))
    }
    pub(crate) fn path(&self) -> &Path {
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
pub(crate) fn skill(name: &str, entries: &[(&str, bool, &[u8])]) -> DesiredSkill {
    let b = bundle(entries);
    DesiredSkill {
        name: name.into(),
        digest: format!("sha256:{}", hex_sha256(&b)),
        size: b.len() as u64,
        schema: SCHEMA.into(),
        bundle: b,
    }
}
pub(crate) fn setup() -> (TestDir, Reconciler, TargetDescriptor) {
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
pub(crate) fn assignment(id: &str, skills: Vec<DesiredSkill>) -> Assignment {
    Assignment {
        assignment_id: id.into(),
        desired_revision_id: format!("rev-{id}"),
        skills,
    }
}
pub(crate) fn file_assignment(id: &str, name: &str, content: Option<&[u8]>) -> FileAssignment {
    let (digest, size, schema, bytes) = match content {
        Some(content) => (
            Some(file_digest(content)),
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
fn managed_file_claims_an_empty_unowned_file() {
    let (_temporary, reconciler, mut target) = setup();
    target.path = ".codex".into();
    fs::create_dir(reconciler.home.join(".codex")).unwrap();
    fs::write(reconciler.home.join(".codex/AGENTS.md"), b"").unwrap();

    let assignment = file_assignment("1", "AGENTS.md", Some(b"fleet"));
    assert!(
        reconciler
            .reconcile_file(&target, &assignment)
            .unwrap()
            .changed
    );
    assert_eq!(
        fs::read(reconciler.home.join(".codex/AGENTS.md")).unwrap(),
        b"fleet"
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
fn reports_repaired_skill_drift_as_modified_deleted_and_added_files() {
    let (_t, r, d) = setup();
    let entries: &[(&str, bool, &[u8])] = &[
        ("SKILL.md", false, b"x"),
        ("docs/a.md", false, b"a"),
        ("docs/b.md", false, b"b"),
    ];
    let current = assignment("1", vec![skill("alpha", entries)]);
    let clean = r.reconcile(&d, &current).unwrap();
    assert!(clean.changed && clean.repaired.is_empty());
    assert!(r.reconcile(&d, &current).unwrap().repaired.is_empty());

    let alpha = r.home.join("skills/alpha");
    fs::write(alpha.join("SKILL.md"), b"edit").unwrap();
    fs::remove_file(alpha.join("docs/a.md")).unwrap();
    fs::write(alpha.join("extra.md"), b"new").unwrap();
    let repaired = r.reconcile(&d, &current).unwrap();
    assert!(repaired.changed);
    assert_eq!(
        repaired.repaired,
        [
            "skills/alpha/SKILL.md",
            "skills/alpha/docs/a.md",
            "skills/alpha/extra.md"
        ]
    );
    assert!(r.reconcile(&d, &current).unwrap().repaired.is_empty());

    // A deleted Skill directory reports its files.
    fs::remove_dir_all(&alpha).unwrap();
    assert_eq!(
        r.reconcile(&d, &current).unwrap().repaired,
        [
            "skills/alpha/SKILL.md",
            "skills/alpha/docs/a.md",
            "skills/alpha/docs/b.md"
        ]
    );
}

#[test]
fn new_revisions_and_removals_are_not_drift() {
    let (_t, r, d) = setup();
    let first = assignment("1", vec![skill("alpha", &[("SKILL.md", false, b"x")])]);
    r.reconcile(&d, &first).unwrap();
    let second = assignment("2", vec![skill("alpha", &[("SKILL.md", false, b"y")])]);
    let updated = r.reconcile(&d, &second).unwrap();
    assert!(updated.changed && updated.repaired.is_empty());
    let third = assignment("3", vec![skill("alpha", &[("SKILL.md", false, b"y")])]);
    let renewed = r.reconcile(&d, &third).unwrap();
    assert!(renewed.changed && renewed.repaired.is_empty());
    // A drifted Skill that the Assignment drops is removed, not repaired.
    fs::write(r.home.join("skills/alpha/SKILL.md"), b"edit").unwrap();
    let removed = r.reconcile(&d, &assignment("4", vec![])).unwrap();
    assert!(removed.changed && removed.repaired.is_empty());
}

#[test]
fn drift_in_a_skill_that_is_also_updated_reports_the_skill_directory() {
    let (_t, r, d) = setup();
    r.reconcile(
        &d,
        &assignment("1", vec![skill("alpha", &[("SKILL.md", false, b"x")])]),
    )
    .unwrap();
    fs::write(r.home.join("skills/alpha/SKILL.md"), b"edit").unwrap();
    let outcome = r
        .reconcile(
            &d,
            &assignment("2", vec![skill("alpha", &[("SKILL.md", false, b"y")])]),
        )
        .unwrap();
    assert_eq!(outcome.repaired, ["skills/alpha"]);
}

#[test]
fn repaired_paths_are_safe_sorted_unique_and_capped() {
    let base = Path::new("skills");
    let mut entries: Vec<String> = (0..30).rev().map(|i| format!("s/f{i:02}.md")).collect();
    entries.push("s/f05.md".into());
    entries.push("s/../escape".into());
    entries.push("s/bad\u{7}name".into());
    entries.push("s/back\\slash".into());
    entries.push("x".repeat(513));
    let paths = repaired_paths(base, entries);
    assert_eq!(paths.len(), MAX_REPAIRED_PATHS);
    assert_eq!(paths[0], "skills/s/f00.md");
    assert_eq!(paths[19], "skills/s/f19.md");
    assert!(paths.windows(2).all(|w| w[0] < w[1]));
    let unsafe_only = repaired_paths(base, vec!["../x".into(), "a/../b".into()]);
    assert!(unsafe_only.is_empty());
    assert!(repaired_paths(Path::new("/abs"), vec!["a".into()]).is_empty());
}

#[test]
fn many_drifted_files_are_capped_in_the_outcome() {
    let (_t, r, d) = setup();
    let mut names: Vec<String> = vec!["SKILL.md".into()];
    names.extend((0..30).map(|i| format!("f{i:02}.md")));
    let entries: Vec<(&str, bool, &[u8])> = names
        .iter()
        .map(|n| (n.as_str(), false, &b"x"[..]))
        .collect();
    let current = assignment("1", vec![skill("alpha", &entries)]);
    r.reconcile(&d, &current).unwrap();
    for name in &names {
        fs::write(r.home.join("skills/alpha").join(name), b"edit").unwrap();
    }
    let outcome = r.reconcile(&d, &current).unwrap();
    assert_eq!(outcome.repaired.len(), MAX_REPAIRED_PATHS);
    assert_eq!(outcome.repaired[0], "skills/alpha/SKILL.md");
    assert_eq!(outcome.repaired[1], "skills/alpha/f00.md");
}

#[test]
fn reports_repaired_managed_file_drift_only() {
    let (_t, r, mut target) = setup();
    target.path = ".config/opencode".into();
    let first = file_assignment("1", "AGENTS.md", Some(b"fleet"));
    let installed = r.reconcile_file(&target, &first).unwrap();
    assert!(installed.changed && installed.repaired.is_empty());
    assert!(
        r.reconcile_file(&target, &first)
            .unwrap()
            .repaired
            .is_empty()
    );
    let path = r.home.join(".config/opencode/AGENTS.md");

    fs::write(&path, b"drift").unwrap();
    assert_eq!(
        r.reconcile_file(&target, &first).unwrap().repaired,
        [".config/opencode/AGENTS.md"]
    );
    fs::remove_file(&path).unwrap();
    assert_eq!(
        r.reconcile_file(&target, &first).unwrap().repaired,
        [".config/opencode/AGENTS.md"]
    );

    // A new revision over clean content is an update.
    let second = file_assignment("2", "AGENTS.md", Some(b"fleet 2"));
    let updated = r.reconcile_file(&target, &second).unwrap();
    assert!(updated.changed && updated.repaired.is_empty());
    // Removing a drifted owned file is a removal.
    fs::write(&path, b"drift").unwrap();
    let removal = file_assignment("3", "AGENTS.md", None);
    let removed = r.reconcile_file(&target, &removal).unwrap();
    assert!(removed.changed && removed.repaired.is_empty());
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
fn oversized_sparse_drift_fails_before_reading_content() {
    let (_t, r, d) = setup();
    let current = assignment("1", vec![skill("alpha", &[("SKILL.md", false, b"x")])]);
    r.reconcile(&d, &current).unwrap();
    OpenOptions::new()
        .write(true)
        .open(r.home.join("skills/alpha/SKILL.md"))
        .unwrap()
        .set_len(MAX_FILE_BYTES as u64 + 1)
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

fn target_key(r: &Reconciler, d: &TargetDescriptor) -> String {
    hex_sha256(
        r.home
            .join(&d.path)
            .as_os_str()
            .to_string_lossy()
            .as_bytes(),
    )
}

#[test]
fn failures_keep_their_codes_and_report_step_and_relative_path() {
    let (_t, r, mut d) = setup();
    d.path = ".agents/skills".into();
    let one = assignment("1", vec![skill("alpha", &[("SKILL.md", false, b"x")])]);

    // lock: the lock file is not a regular file.
    let shared = r
        .home
        .join(".agents/.fleet-reconcile")
        .join(target_key(&r, &d));
    fs::create_dir_all(shared.join("lock")).unwrap();
    let error = r.reconcile(&d, &one).unwrap_err();
    assert_eq!(error.code_str(), "lock_failed");
    assert_eq!(error.step(), Some(Step::Lock));
    assert_eq!(error.path(), Some(".agents/skills"));
    fs::remove_dir(shared.join("lock")).unwrap();

    // ownership conflict names the Skill directory.
    fs::create_dir_all(r.home.join(".agents/skills/alpha")).unwrap();
    let error = r.reconcile(&d, &one).unwrap_err();
    assert_eq!(error.code_str(), "ownership_conflict");
    assert_eq!(error.step(), Some(Step::Validate));
    assert_eq!(error.path(), Some(".agents/skills/alpha"));
    fs::remove_dir(r.home.join(".agents/skills/alpha")).unwrap();

    // corrupt Receipt.
    r.reconcile(&d, &one).unwrap();
    let state = r.state_dir.join("targets").join(target_key(&r, &d));
    fs::write(state.join("receipt.json"), b"{broken").unwrap();
    let error = r.reconcile(&d, &one).unwrap_err();
    assert_eq!(error.code_str(), "corrupt_receipt");
    assert_eq!(error.step(), Some(Step::Receipt));
    assert_eq!(error.path(), Some(".agents/skills"));

    // corrupt recovery journal.
    fs::write(state.join("journal.json"), b"{broken").unwrap();
    let error = r.reconcile(&d, &one).unwrap_err();
    assert_eq!(error.code_str(), "recovery_failed");
    assert_eq!(error.step(), Some(Step::Recover));
    assert_eq!(error.path(), Some(".agents/skills"));
    let error = r.recover(&d).unwrap_err();
    assert_eq!(error.code_str(), "recovery_failed");
    assert_eq!(error.path(), Some(".agents/skills"));
}

#[test]
fn bundle_failures_name_the_skill_and_entry() {
    let (_t, r, d) = setup();

    let mut wrong_digest = skill("alpha", &[("SKILL.md", false, b"x")]);
    wrong_digest.digest = format!("sha256:{}", "0".repeat(64));
    let error = r
        .reconcile(&d, &assignment("1", vec![wrong_digest]))
        .unwrap_err();
    assert_eq!(error.code_str(), "bundle_digest_mismatch");
    assert_eq!(error.step(), Some(Step::Verify));
    assert_eq!(error.path(), Some("skills/alpha"));

    let mut wrong_size = skill("beta", &[("SKILL.md", false, b"x")]);
    wrong_size.size += 1;
    let error = r
        .reconcile(&d, &assignment("2", vec![wrong_size]))
        .unwrap_err();
    assert_eq!(error.code_str(), "bundle_size_mismatch");
    assert_eq!(error.path(), Some("skills/beta"));

    let mut schema = skill("gamma", &[("SKILL.md", false, b"x")]);
    schema.schema = "fleet.bundle/v0".into();
    let error = r.reconcile(&d, &assignment("3", vec![schema])).unwrap_err();
    assert_eq!(error.code_str(), "unsupported_schema");
    assert_eq!(error.step(), Some(Step::Verify));
    assert_eq!(error.path(), Some("skills/gamma"));

    let collision = skill(
        "delta",
        &[
            ("SKILL.md", false, b"x"),
            ("a", false, b"1"),
            ("a/b", false, b"2"),
        ],
    );
    let error = r
        .reconcile(&d, &assignment("4", vec![collision]))
        .unwrap_err();
    assert_eq!(error.code_str(), "bundle_path_collision");
    assert_eq!(error.path(), Some("skills/delta/a/b"));

    // A bundle path that is unsafe is never copied into `path`.
    let unsafe_path = skill("eps", &[("../x", false, b"1"), ("SKILL.md", false, b"x")]);
    let error = r
        .reconcile(&d, &assignment("5", vec![unsafe_path]))
        .unwrap_err();
    assert_eq!(error.code_str(), "invalid_bundle_path");
    assert_eq!(error.path(), Some("skills/eps"));

    // Failures that are not about a path carry none.
    let error = r
        .reconcile(&d, &assignment(&"i".repeat(300), Vec::new()))
        .unwrap_err();
    assert_eq!(error.code_str(), "invalid_assignment");
    assert_eq!(error.step(), Some(Step::Validate));
    assert_eq!(error.path(), None);
}

#[test]
fn observed_drift_failures_name_the_entry() {
    let (_t, r, d) = setup();
    let current = assignment("1", vec![skill("alpha", &[("SKILL.md", false, b"x")])]);
    r.reconcile(&d, &current).unwrap();
    let link = r.home.join("skills/alpha/link");
    std::os::unix::fs::symlink("SKILL.md", &link).unwrap();
    let error = r.reconcile(&d, &current).unwrap_err();
    assert_eq!(error.code_str(), "non_regular_entry");
    assert_eq!(error.path(), Some("skills/alpha/link"));
}

#[test]
fn target_escape_and_managed_file_failures_report_relative_paths() {
    let (t, r, mut d) = setup();
    let outside = t.path().join("outside");
    fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, r.home.join(".linked")).unwrap();
    d.path = ".linked/skills".into();
    let error = r
        .reconcile(
            &d,
            &assignment("1", vec![skill("a", &[("SKILL.md", false, b"x")])]),
        )
        .unwrap_err();
    assert_eq!(error.code_str(), "filesystem_escape");
    assert_eq!(error.path(), Some(".linked/skills"));
    assert!(!error.diagnostic().is_empty());

    d.path = ".claude".into();
    fs::create_dir(r.home.join(".claude")).unwrap();
    fs::write(r.home.join(".claude/CLAUDE.md"), b"personal").unwrap();
    let error = r
        .reconcile_file(&d, &file_assignment("2", "CLAUDE.md", Some(b"fleet")))
        .unwrap_err();
    assert_eq!(error.code_str(), "ownership_conflict");
    assert_eq!(error.step(), Some(Step::Validate));
    assert_eq!(error.path(), Some(".claude/CLAUDE.md"));

    let mut schema = file_assignment("3", "AGENTS.md", Some(b"fleet"));
    schema.file.schema = Some("fleet.file/v0".into());
    let error = r.reconcile_file(&d, &schema).unwrap_err();
    assert_eq!(error.code_str(), "unsupported_schema");
    assert_eq!(error.path(), Some(".claude/AGENTS.md"));

    let mut digest = file_assignment("4", "AGENTS.md", Some(b"fleet"));
    digest.file.content = b"other".to_vec();
    digest.file.size = Some(5);
    let error = r.reconcile_file(&d, &digest).unwrap_err();
    assert_eq!(error.code_str(), "bundle_digest_mismatch");
    assert_eq!(error.step(), Some(Step::Verify));
    assert_eq!(error.path(), Some(".claude/AGENTS.md"));
}

#[test]
fn reported_paths_are_always_safe_relative_paths() {
    for unsafe_path in [
        "/etc/passwd",
        "../x",
        "a/../b",
        "",
        ".",
        "a\\b",
        "a/\u{7}b",
        "C:/secret",
        "z:secret",
    ] {
        assert_eq!(report_path(Path::new(unsafe_path)), None, "{unsafe_path:?}");
    }
    assert_eq!(
        report_path(Path::new("a/b/c.md")).as_deref(),
        Some("a/b/c.md")
    );
    assert_eq!(report_path(&PathBuf::from("x".repeat(513))), None);
    assert!(report_path(&PathBuf::from("x".repeat(512))).is_some());
    assert!(report_path(&PathBuf::from("😀".repeat(256))).is_some());
    assert!(report_path(&PathBuf::from("😀".repeat(257))).is_none());
    // Non-reportable targets are omitted, not rewritten.
    let (_t, r, mut d) = setup();
    d.path = "../escape".into();
    let error = r
        .reconcile(
            &d,
            &assignment("1", vec![skill("a", &[("SKILL.md", false, b"x")])]),
        )
        .unwrap_err();
    assert_eq!(error.code_str(), "invalid_target");
    assert_eq!(error.path(), None);
}

#[test]
fn step_wire_names_match_the_contract() {
    for (step, name) in [
        (Step::Lock, "lock"),
        (Step::Download, "download"),
        (Step::Verify, "verify"),
        (Step::Stage, "stage"),
        (Step::Activate, "activate"),
        (Step::Recover, "recover"),
        (Step::Receipt, "receipt"),
        (Step::Configure, "configure"),
        (Step::Validate, "validate"),
    ] {
        assert_eq!(step.as_str(), name);
        assert_eq!(serde_json::to_string(&step).unwrap(), format!("\"{name}\""));
    }
}

#[test]
fn hex_sha256_output_is_pinned() {
    // State directory names on deployed Nodes are this hash of the Target (or
    // managed file) path text; a different output would orphan their state.
    assert_eq!(
        hex_sha256(b"/home/user/.agents/skills"),
        "e186e068ff1063186bc305ea59f2b55683b5a8201e0758a4e0341773c49bba03"
    );
    assert_eq!(
        hex_sha256(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    // The byte-by-byte `{:02x}` encoding this crate used before.
    for input in [&b""[..], b"abc", b"\0\x01\xff", &[0x0a; 1000]] {
        let mut reference = String::new();
        for byte in Sha256::digest(input) {
            reference.push_str(&format!("{byte:02x}"));
        }
        assert_eq!(hex_sha256(input), reference);
    }
}

#[test]
fn file_digest_is_domain_separated_and_pinned() {
    assert_eq!(
        file_digest(b""),
        "sha256:b48b182ea449044fd6d169a8f504bd2704d7cbb822ef0c2c7c7ba0d99649c5f6"
    );
    assert_eq!(
        file_digest(b"hello"),
        "sha256:8129004c75fa93440e93aa4083ce13961906c04eb59c566a21353dd929f6d003"
    );
}
