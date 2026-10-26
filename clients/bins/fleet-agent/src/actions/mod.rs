mod ai_client;
mod cache;
mod managed_file;
mod skills;

use crate::protocol::{Api, Assignment};
use anyhow::{Result, bail};
pub use fleet_reconcile::Step;
use std::{
    collections::HashSet,
    error::Error,
    fmt, fs,
    path::{Path, PathBuf},
};

const REGISTERED: [ActionKind; 3] = [
    ActionKind::Skills,
    ActionKind::ManagedFile,
    ActionKind::AiClient,
];

#[derive(Clone, Copy)]
enum ActionKind {
    Skills,
    ManagedFile,
    AiClient,
}

impl ActionKind {
    fn name(self) -> &'static str {
        match self {
            Self::Skills => "skills",
            Self::ManagedFile => "managed-file",
            Self::AiClient => "ai-client",
        }
    }

    fn matches(self, target_name: &str) -> bool {
        match self {
            Self::Skills => target_name == "skills",
            Self::ManagedFile => target_name.starts_with("agent-file/"),
            Self::AiClient => target_name.starts_with("ai-client/"),
        }
    }
}

/// The kind of Target a name belongs to, for display.
pub fn kind_name(target_name: &str) -> &'static str {
    REGISTERED
        .into_iter()
        .find(|action| action.matches(target_name))
        .map_or("unknown", ActionKind::name)
}

pub struct Registry<'a> {
    content: &'a fleet_reconcile::Reconciler,
    ai_client: &'a crate::ai_client::Reconciler,
    cache: &'a Path,
}

impl<'a> Registry<'a> {
    pub fn new(
        content: &'a fleet_reconcile::Reconciler,
        ai_client: &'a crate::ai_client::Reconciler,
        cache: &'a Path,
    ) -> Self {
        Self {
            content,
            ai_client,
            cache,
        }
    }

    pub fn validate(&self, assignment: &Assignment) -> Result<()> {
        match registered(assignment)? {
            ActionKind::Skills => skills::validate(assignment),
            ActionKind::ManagedFile => managed_file::validate(assignment),
            ActionKind::AiClient => ai_client::validate(assignment),
        }
    }

    pub fn recover(&self, assignment: &Assignment) -> Result<()> {
        match registered(assignment)? {
            ActionKind::Skills => skills::recover(self.content, assignment),
            ActionKind::ManagedFile => managed_file::recover(self.content, assignment),
            ActionKind::AiClient => ai_client::recover(self.ai_client, assignment),
        }
    }

    pub async fn prepare(&self, api: &Api, assignment: &Assignment) -> Result<()> {
        match registered(assignment)? {
            ActionKind::Skills => skills::prepare(api, assignment, self.cache).await,
            ActionKind::ManagedFile => managed_file::prepare(api, assignment, self.cache).await,
            ActionKind::AiClient => Ok(()),
        }
    }

    /// Applies the Assignment and returns the paths of owned files that had
    /// drifted and were repaired (see `fleet_reconcile::ReconcileOutcome`).
    pub async fn apply(
        &self,
        api: &Api,
        assignment: &Assignment,
    ) -> std::result::Result<Vec<String>, ActionError> {
        let result = match registered(assignment).map_err(ActionError::invalid_assignment) {
            Ok(ActionKind::Skills) => skills::apply(self.content, assignment, self.cache),
            Ok(ActionKind::ManagedFile) => {
                managed_file::apply(self.content, assignment, self.cache)
            }
            Ok(ActionKind::AiClient) => ai_client::apply(self.ai_client, api, assignment).await,
            Err(error) => Err(error),
        };
        result.map_err(|error| error.locate(assignment))
    }

    pub fn clean_cache<'b>(&self, assignments: impl Iterator<Item = &'b Assignment>) -> Result<()> {
        let mut keep = HashSet::new();
        for assignment in assignments {
            match registered(assignment)? {
                ActionKind::Skills => skills::keep_cached(assignment, self.cache, &mut keep)?,
                ActionKind::ManagedFile => {
                    managed_file::keep_cached(assignment, self.cache, &mut keep)?
                }
                ActionKind::AiClient => {}
            }
        }
        for entry in fs::read_dir(self.cache)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                bail!("Bundle cache contains a non-file entry");
            }
            if !keep.contains(&entry.path()) {
                fs::remove_file(entry.path())?;
            }
        }
        Ok(())
    }
}

fn registered(assignment: &Assignment) -> Result<ActionKind> {
    REGISTERED
        .into_iter()
        .find(|action| action.matches(&assignment.target_name))
        .ok_or_else(|| anyhow::anyhow!("unsupported Target descriptor"))
}

#[cfg(test)]
fn registered_action(assignment: &Assignment) -> Result<&'static str> {
    Ok(registered(assignment)?.name())
}

/// A failed Action. `code` is the stable identity reported to the Server; the
/// optional step and Target-relative path only describe where it happened.
#[derive(Debug)]
pub struct ActionError {
    code: String,
    source: anyhow::Error,
    step: Option<Step>,
    path: Option<String>,
}

impl ActionError {
    fn new(code: impl Into<String>, source: impl Into<anyhow::Error>) -> Self {
        Self {
            code: code.into(),
            source: source.into(),
            step: None,
            path: None,
        }
    }

    fn reconcile(error: fleet_reconcile::ReconcileError) -> Self {
        let code = error.code_str().to_owned();
        let step = error.step();
        let path = error.path().map(str::to_owned);
        Self {
            step,
            path,
            ..Self::new(code, error)
        }
    }

    fn invalid_assignment(error: anyhow::Error) -> Self {
        Self::new("invalid_assignment", error).with_step(Step::Validate)
    }

    fn with_step(mut self, step: Step) -> Self {
        self.step = Some(step);
        self
    }

    /// Records a path only when it is safe to report (relative, no `..`).
    fn with_path(mut self, path: &Path) -> Self {
        self.path = fleet_reconcile::report_path(path);
        self
    }

    /// An invalid Assignment is not about a file on disk, so point at what it
    /// names: its Target, and the managed file inside it.
    fn locate(mut self, assignment: &Assignment) -> Self {
        if self.path.is_none() && self.code == "invalid_assignment" {
            let mut path = PathBuf::from(&assignment.target.path);
            if let Some(file) = &assignment.file {
                path.push(&file.name);
            }
            self = self.with_path(&path);
        }
        self
    }

    #[cfg(test)]
    pub fn test_error(code: &str, source: anyhow::Error) -> Self {
        Self::new(code, source)
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn step(&self) -> Option<Step> {
        self.step
    }

    pub fn path(&self) -> Option<&str> {
        self.path.as_deref()
    }

    /// Display of the error and each of its sources, joined with ": ". It is
    /// not yet sanitized for the Server.
    pub fn diagnostic_chain(&self) -> String {
        let mut text = String::new();
        for cause in self.source.chain() {
            let message = cause.to_string();
            // Some errors repeat their source in their own message.
            if message.is_empty() || text.ends_with(&message) {
                continue;
            }
            if !text.is_empty() {
                text.push_str(": ");
            }
            text.push_str(&message);
        }
        text
    }
}

impl fmt::Display for ActionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.source.fmt(formatter)
    }
}

impl Error for ActionError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.source.source()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{AssignmentFile, TargetDescriptor};
    use rcgen::{CertifiedKey, generate_simple_self_signed};
    use sha2::{Digest, Sha256};
    use std::path::PathBuf;
    use uuid::Uuid;

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .canonicalize()
                .unwrap()
                .join(format!("fleet-actions-{}", Uuid::new_v4()));
            crate::state::private_directory(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn managed_file_assignment() -> Assignment {
        Assignment {
            assignment_id: Uuid::nil(),
            attempt_id: Uuid::nil(),
            rollout_id: Uuid::nil(),
            desired_revision_id: Uuid::nil(),
            target_name: "agent-file/codex".to_owned(),
            target: TargetDescriptor {
                base: "home".to_owned(),
                path: ".codex".to_owned(),
            },
            skills: Vec::new(),
            file: Some(AssignmentFile {
                name: "AGENTS.md".to_owned(),
                bundle_digest: None,
                size: None,
                schema: None,
            }),
            ai_client: None,
        }
    }

    #[test]
    fn assignment_is_dispatched_to_one_registered_action() {
        let assignment = managed_file_assignment();

        assert_eq!(registered_action(&assignment).unwrap(), "managed-file");
    }

    #[tokio::test]
    async fn managed_file_assignment_reconciles_through_the_registry() {
        let root = TestRoot::new();
        let home = root.0.join("home");
        let state_root = root.0.join("state");
        let cache_root = root.0.join("cache");
        crate::state::private_directory(&home).unwrap();
        crate::state::private_directory(&state_root).unwrap();
        crate::state::private_directory(&cache_root).unwrap();
        let content = b"# Fleet instructions\n";
        let mut digest = Sha256::new();
        digest.update(b"fleet.file/v1\0");
        digest.update(content);
        let digest = format!("sha256:{:x}", digest.finalize());
        crate::state::write_bytes(&cache::path(&cache_root, &digest).unwrap(), content).unwrap();

        let content_reconciler =
            fleet_reconcile::Reconciler::new(&home, state_root.join("targets")).unwrap();
        let ai_reconciler =
            crate::ai_client::Reconciler::new(&home, state_root.join("ai-clients")).unwrap();
        let registry = Registry::new(&content_reconciler, &ai_reconciler, &cache_root);
        let mut assignment = managed_file_assignment();
        assignment.file = Some(AssignmentFile {
            name: "AGENTS.md".to_owned(),
            bundle_digest: Some(digest),
            size: Some(content.len() as i64),
            schema: Some("fleet.file/v1".to_owned()),
        });
        let CertifiedKey { cert, .. } =
            generate_simple_self_signed(vec!["fleet.example".to_owned()]).unwrap();
        let api = Api::new("https://fleet.example", cert.pem().as_bytes(), None).unwrap();

        assert!(registry.apply(&api, &assignment).await.unwrap().is_empty());

        assert_eq!(
            std::fs::read(home.join(".codex/AGENTS.md")).unwrap(),
            content
        );

        // Drift repaired by a later apply is surfaced as a Home-relative path.
        assert!(registry.apply(&api, &assignment).await.unwrap().is_empty());
        std::fs::write(home.join(".codex/AGENTS.md"), b"edited").unwrap();
        assert_eq!(
            registry.apply(&api, &assignment).await.unwrap(),
            [".codex/AGENTS.md"]
        );
        assert_eq!(
            std::fs::read(home.join(".codex/AGENTS.md")).unwrap(),
            content
        );
    }

    struct Fixture {
        root: TestRoot,
        home: PathBuf,
        cache: PathBuf,
        content: fleet_reconcile::Reconciler,
        ai: crate::ai_client::Reconciler,
    }

    impl Fixture {
        fn new() -> Self {
            let root = TestRoot::new();
            let home = root.0.join("home");
            let state_root = root.0.join("state");
            let cache = root.0.join("cache");
            for directory in [&home, &state_root, &cache] {
                crate::state::private_directory(directory).unwrap();
            }
            let content =
                fleet_reconcile::Reconciler::new(&home, state_root.join("targets")).unwrap();
            let ai =
                crate::ai_client::Reconciler::new(&home, state_root.join("ai-clients")).unwrap();
            Self {
                home: std::fs::canonicalize(home).unwrap(),
                root,
                cache,
                content,
                ai,
            }
        }

        async fn apply(
            &self,
            api: &Api,
            assignment: &Assignment,
        ) -> Result<Vec<String>, ActionError> {
            Registry::new(&self.content, &self.ai, &self.cache)
                .apply(api, assignment)
                .await
        }

        fn homes(&self) -> crate::detail::Redactor {
            crate::detail::Redactor::new(
                std::slice::from_ref(&self.home),
                &self.root.0.join("state"),
            )
        }
    }

    fn offline_api() -> Api {
        Api::for_loopback_test("http://127.0.0.1:1/")
    }

    /// A one-file Skill Bundle, cached under `digest` when `cached` is given.
    fn skill_assignment(fixture: &Fixture, path: &str, name: &str, corrupt: bool) -> Assignment {
        let mut bundle = b"FLTB1\0".to_vec();
        bundle.extend(1u32.to_be_bytes());
        bundle.extend(8u32.to_be_bytes());
        bundle.extend(b"SKILL.md");
        bundle.push(0);
        bundle.extend(1u64.to_be_bytes());
        bundle.push(b'x');
        let digest = format!("sha256:{:x}", Sha256::digest(&bundle));
        if corrupt {
            *bundle.last_mut().unwrap() = b'y';
        }
        crate::state::write_bytes(&cache::path(&fixture.cache, &digest).unwrap(), &bundle).unwrap();
        let mut assignment = managed_file_assignment();
        assignment.target_name = "skills".to_owned();
        assignment.target.path = path.to_owned();
        assignment.file = None;
        assignment.skills = vec![crate::protocol::AssignmentSkill {
            name: name.to_owned(),
            bundle_digest: digest,
            size: bundle.len() as i64,
            schema: "fleet.bundle/v1".to_owned(),
        }];
        assignment
    }

    #[tokio::test]
    async fn skill_failures_carry_code_step_and_relative_path() {
        let fixture = Fixture::new();
        let api = offline_api();
        std::fs::create_dir_all(fixture.home.join(".agents/skills/alpha")).unwrap();

        let assignment = skill_assignment(&fixture, ".agents/skills", "alpha", false);
        let error = fixture.apply(&api, &assignment).await.unwrap_err();
        assert_eq!(error.code(), "ownership_conflict");
        assert_eq!(error.step(), Some(Step::Validate));
        assert_eq!(error.path(), Some(".agents/skills/alpha"));

        let assignment = skill_assignment(&fixture, ".agents/skills", "beta", true);
        let error = fixture.apply(&api, &assignment).await.unwrap_err();
        assert_eq!(error.code(), "bundle_digest_mismatch");
        assert_eq!(error.step(), Some(Step::Verify));
        assert_eq!(error.path(), Some(".agents/skills/beta"));
        let detail = crate::detail::build(&error, &fixture.homes());
        assert!(detail.diagnostic.contains("digest mismatch for beta"));
        assert_eq!(detail.path.as_deref(), Some(".agents/skills/beta"));
        assert_eq!(detail.step, Some(Step::Verify));
    }

    #[tokio::test]
    async fn filesystem_escape_reports_the_target_and_hides_the_home_directory() {
        let fixture = Fixture::new();
        let outside = fixture.root.0.join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, fixture.home.join(".linked")).unwrap();
        let assignment = skill_assignment(&fixture, ".linked/skills", "alpha", false);

        let error = fixture
            .apply(&offline_api(), &assignment)
            .await
            .unwrap_err();

        assert_eq!(error.code(), "filesystem_escape");
        assert_eq!(error.path(), Some(".linked/skills"));
        let detail = crate::detail::build(&error, &fixture.homes());
        assert!(
            detail.diagnostic.contains("~/.linked"),
            "{}",
            detail.diagnostic
        );
        assert!(!detail.diagnostic.contains(fixture.home.to_str().unwrap()));
    }

    #[tokio::test]
    async fn managed_file_failures_carry_code_step_and_relative_path() {
        let fixture = Fixture::new();
        let api = offline_api();
        let content = b"# Fleet\n";
        let mut digest = Sha256::new();
        digest.update(b"fleet.file/v1\0");
        digest.update(content);
        let digest = format!("sha256:{:x}", digest.finalize());
        crate::state::write_bytes(&cache::path(&fixture.cache, &digest).unwrap(), content).unwrap();
        let mut assignment = managed_file_assignment();
        assignment.file = Some(AssignmentFile {
            name: "AGENTS.md".to_owned(),
            bundle_digest: Some(digest),
            size: Some(content.len() as i64),
            schema: Some("fleet.file/v1".to_owned()),
        });
        std::fs::create_dir(fixture.home.join(".codex")).unwrap();
        std::fs::write(fixture.home.join(".codex/AGENTS.md"), b"personal notes").unwrap();

        let error = fixture.apply(&api, &assignment).await.unwrap_err();
        assert_eq!(error.code(), "ownership_conflict");
        assert_eq!(error.step(), Some(Step::Validate));
        assert_eq!(error.path(), Some(".codex/AGENTS.md"));
        let detail = crate::detail::build(&error, &fixture.homes());
        assert!(!detail.diagnostic.contains("personal notes"));

        // An invalid Assignment points at what it names.
        assignment.target.base = "elsewhere".to_owned();
        let error = fixture.apply(&api, &assignment).await.unwrap_err();
        assert_eq!(error.code(), "invalid_assignment");
        assert_eq!(error.step(), Some(Step::Validate));
        assert_eq!(error.path(), Some(".codex/AGENTS.md"));
    }

    #[tokio::test]
    async fn invalid_assignments_omit_paths_that_are_not_relative() {
        let fixture = Fixture::new();
        let api = offline_api();
        let mut assignment = managed_file_assignment();
        assignment.target_name = "unregistered".to_owned();
        let error = fixture.apply(&api, &assignment).await.unwrap_err();
        assert_eq!(error.code(), "invalid_assignment");
        assert_eq!(error.step(), Some(Step::Validate));
        assert_eq!(error.path(), Some(".codex/AGENTS.md"));

        for unsafe_path in ["../outside", "/etc", "a/../../b"] {
            assignment.target.path = unsafe_path.to_owned();
            let error = fixture.apply(&api, &assignment).await.unwrap_err();
            assert_eq!(error.code(), "invalid_assignment");
            assert_eq!(error.path(), None, "{unsafe_path}");
        }
    }

    fn ai_client_assignment(client: &str, path: &str, mode: &str) -> Assignment {
        let mut assignment = managed_file_assignment();
        assignment.target_name = format!("ai-client/{client}");
        assignment.target.path = path.to_owned();
        assignment.file = None;
        assignment.ai_client = Some(crate::protocol::AiClientAssignment {
            schema: "fleet.ai-client/v1".to_owned(),
            client: client.to_owned(),
            mode: mode.to_owned(),
            base_url: (mode == "cliproxy").then(|| "https://proxy.example/v1".to_owned()),
            model: None,
        });
        assignment
    }

    #[tokio::test]
    async fn ai_client_configuration_failure_names_the_file_without_its_content() {
        let fixture = Fixture::new();
        let secret = "SECRET-TOKEN-4f9c";
        let ai_state = fixture.root.0.join("state/ai-clients");
        crate::state::write_bytes(
            &ai_state.join("codex-receipt.json"),
            br#"{"version":1,"client":"codex","configExisted":true,"originalModel":null,
            "expectedModel":"m","expectedBaseUrl":"https://proxy.example/v1","expectedKeyPath":"/k"}"#,
        )
        .unwrap();
        std::fs::create_dir(fixture.home.join(".codex")).unwrap();
        std::fs::write(
            fixture.home.join(".codex/config.toml"),
            format!("api_key = \"{secret}\" broken\n"),
        )
        .unwrap();
        let assignment = ai_client_assignment("codex", ".codex", "native");

        let error = fixture
            .apply(&offline_api(), &assignment)
            .await
            .unwrap_err();

        assert_eq!(error.code(), "ai_client_reconcile_failed");
        assert_eq!(error.step(), Some(Step::Configure));
        assert_eq!(error.path(), Some(".codex/config.toml"));
        let detail = crate::detail::build(&error, &fixture.homes());
        assert!(detail.diagnostic.contains("invalid Codex TOML at line 1"));
        assert!(!detail.diagnostic.contains(secret), "{}", detail.diagnostic);
        assert_eq!(detail.path.as_deref(), Some(".codex/config.toml"));
    }

    #[tokio::test]
    async fn ai_client_fetch_failure_is_a_download_step_without_a_file_path() {
        let fixture = Fixture::new();
        let assignment = ai_client_assignment("claude", ".claude", "cliproxy");

        let error = fixture
            .apply(&offline_api(), &assignment)
            .await
            .unwrap_err();

        assert_eq!(error.code(), "ai_client_reconcile_failed");
        assert_eq!(error.step(), Some(Step::Download));
        assert_eq!(error.path(), None);
        let detail = crate::detail::build(&error, &fixture.homes());
        assert!(detail.diagnostic.starts_with("fetch CLIProxy credential"));
    }

    #[tokio::test]
    async fn invalid_ai_client_assignment_is_reported_as_invalid_assignment() {
        let fixture = Fixture::new();
        let mut assignment = ai_client_assignment("codex", ".codex", "native");
        assignment.ai_client.as_mut().unwrap().schema = "other".to_owned();

        let error = fixture
            .apply(&offline_api(), &assignment)
            .await
            .unwrap_err();

        assert_eq!(error.code(), "invalid_assignment");
        assert_eq!(error.step(), Some(Step::Validate));
        assert_eq!(error.path(), Some(".codex"));
    }
}
