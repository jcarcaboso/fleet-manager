mod ai_client;
mod cache;
mod managed_file;
mod skills;

use crate::protocol::{Api, Assignment};
use anyhow::{Result, bail};
use std::{collections::HashSet, error::Error, fmt, fs, path::Path};

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
    #[cfg(test)]
    fn name(self) -> &'static str {
        match self {
            Self::Skills => "skills",
            Self::ManagedFile => "managed-file",
            Self::AiClient => "ai-client",
        }
    }

    fn matches(self, assignment: &Assignment) -> bool {
        match self {
            Self::Skills => assignment.target_name == "skills",
            Self::ManagedFile => assignment.target_name.starts_with("agent-file/"),
            Self::AiClient => assignment.target_name.starts_with("ai-client/"),
        }
    }
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

    pub async fn apply(
        &self,
        api: &Api,
        assignment: &Assignment,
    ) -> std::result::Result<(), ActionError> {
        match registered(assignment).map_err(ActionError::invalid_assignment)? {
            ActionKind::Skills => skills::apply(self.content, assignment, self.cache),
            ActionKind::ManagedFile => managed_file::apply(self.content, assignment, self.cache),
            ActionKind::AiClient => ai_client::apply(self.ai_client, api, assignment).await,
        }
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
        .find(|action| action.matches(assignment))
        .ok_or_else(|| anyhow::anyhow!("unsupported Target descriptor"))
}

#[cfg(test)]
fn registered_action(assignment: &Assignment) -> Result<&'static str> {
    Ok(registered(assignment)?.name())
}

#[derive(Debug)]
pub struct ActionError {
    code: String,
    source: anyhow::Error,
}

impl ActionError {
    fn new(code: impl Into<String>, source: impl Into<anyhow::Error>) -> Self {
        Self {
            code: code.into(),
            source: source.into(),
        }
    }

    fn reconcile(error: fleet_reconcile::ReconcileError) -> Self {
        let code = error.code_str().to_owned();
        Self::new(code, error)
    }

    fn invalid_assignment(error: anyhow::Error) -> Self {
        Self::new("invalid_assignment", error)
    }

    pub fn code(&self) -> &str {
        &self.code
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

        registry.apply(&api, &assignment).await.unwrap();

        assert_eq!(
            std::fs::read(home.join(".codex/AGENTS.md")).unwrap(),
            content
        );
    }
}
