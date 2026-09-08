mod credentials;
mod protocol;
mod state;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use credentials::{CredentialStore, StoredIdentity};
use protocol::{Api, Assignment, ConvergenceState};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

#[derive(Parser)]
#[command(version, about = "Fleet Manager Node Agent")]
struct Cli {
    /// Private durable state directory. Defaults to ~/.local/state/fleet-agent.
    #[arg(long, global = true)]
    state_dir: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Create this Node's identity using a one-time enrollment token.
    Enroll {
        #[arg(long)]
        server_url: String,
        /// Public PEM CA certificate for the Fleet Server.
        #[arg(long)]
        ca_cert: PathBuf,
        #[arg(long)]
        alias: String,
        /// Token text or enrollment-create JSON. Otherwise reads FLEET_ENROLLMENT_TOKEN.
        #[arg(long)]
        token_file: Option<PathBuf>,
        /// Home directory under which Skills may be installed.
        #[arg(long)]
        home: Option<PathBuf>,
    },
    /// Poll and reconcile continuously, or once for a deployment check.
    Run {
        #[arg(long)]
        once: bool,
    },
    /// Print local identity and pending report metadata without credentials.
    Status,
    /// Change this Node's alias using its own client certificate.
    Alias { new_alias: String },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PendingReport {
    attempt_id: Uuid,
    succeeded: bool,
    error_code: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RunState {
    active: Option<Assignment>,
    pending_assignment: Option<Assignment>,
    pending_report: Option<PendingReport>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let home = dirs::home_dir().context("cannot resolve the user's home directory")?;
    let directory = cli
        .state_dir
        .unwrap_or_else(|| home.join(".local/state/fleet-agent"));
    state::private_directory(&directory)?;
    let _lock = state::lock(&directory)?;
    let store = CredentialStore::open(directory.join("credentials"))?;
    let config_path = directory.join("config.json");
    match cli.command {
        Command::Enroll {
            server_url,
            ca_cert,
            alias,
            token_file,
            home: requested_home,
        } => {
            if store.load_identity()?.is_some() {
                bail!("this Agent is already enrolled; use status or alias");
            }
            if alias.trim().is_empty() || alias.chars().count() > 200 {
                bail!("alias must be nonblank and at most 200 characters");
            }
            let ca = String::from_utf8(state::read_bytes(&ca_cert, 256 * 1024)?)
                .context("CA certificate must be PEM text")?;
            let home = fs::canonicalize(requested_home.unwrap_or(home))
                .context("resolve installation home")?;
            let config = state::Config {
                server_url,
                ca_pem: ca,
                node_alias: alias,
                home,
            };
            let api = Api::new(&config.server_url, config.ca_pem.as_bytes(), None)?;
            if let Some(previous) = state::read_json::<state::Config>(&config_path)?
                && (previous.server_url != config.server_url
                    || previous.ca_pem != config.ca_pem
                    || previous.node_alias != config.node_alias
                    || previous.home != config.home)
            {
                bail!(
                    "unfinished enrollment belongs to different settings; retry with the original settings"
                );
            }
            state::write_json(&config_path, &config)?;
            let raw = match token_file {
                Some(path) => String::from_utf8(state::read_bytes(&path, 64 * 1024)?)?,
                None => std::env::var("FLEET_ENROLLMENT_TOKEN")
                    .context("provide --token-file or FLEET_ENROLLMENT_TOKEN")?,
            };
            let token = if raw.trim_start().starts_with('{') {
                serde_json::from_str::<serde_json::Value>(&raw)
                    .context("invalid enrollment token JSON")?
                    .get("token")
                    .and_then(|value| value.as_str())
                    .context("enrollment JSON requires token")?
                    .to_owned()
            } else {
                raw.trim().to_owned()
            };
            if token.is_empty() || token.len() > 4096 {
                bail!("invalid enrollment token length");
            }
            let pending = store.load_or_generate_pending()?;
            let response = api
                .enroll(
                    &token,
                    &pending.csr_pem,
                    &config.node_alias,
                    std::env::consts::OS,
                )
                .await?;
            store.complete_enrollment(&pending, &response)?;
            store.clear_pending()?;
            println!(
                "{}",
                serde_json::json!({"nodeId":response.node_id,"alias":config.node_alias,"enrolled":true})
            );
        }
        Command::Status => {
            let config = state::read_json::<state::Config>(&config_path)?
                .context("Agent is not configured")?;
            let identity = store
                .load_identity()?
                .context("Agent enrollment is incomplete")?;
            let run =
                state::read_json::<RunState>(&directory.join("run.json"))?.unwrap_or_default();
            println!(
                "{}",
                serde_json::json!({"nodeId":identity.node_id,"workspaceId":identity.workspace_id,
                "alias":config.node_alias,"expiresAt":identity.expires_at,"stateDirectory":directory,
                "pendingReport":run.pending_report.is_some(),"activeAssignment":run.active.map(|a|a.assignment_id)})
            );
        }
        Command::Alias { new_alias } => {
            let mut config = state::read_json::<state::Config>(&config_path)?
                .context("Agent is not configured")?;
            let identity = store.load_identity()?.context("Agent is not enrolled")?;
            let response = api(&config, &identity)?.rename(&new_alias).await?;
            config.node_alias = response.alias.clone();
            state::write_json(&config_path, &config)?;
            println!(
                "{}",
                serde_json::json!({"nodeId":response.node_id,"alias":response.alias})
            );
        }
        Command::Run { once } => {
            let config = state::read_json::<state::Config>(&config_path)?
                .context("Agent is not configured")?;
            let mut identity = store.load_identity()?.context("Agent is not enrolled")?;
            let cache = directory.join("bundles");
            state::private_directory(&cache)?;
            let reconciler =
                fleet_reconcile::Reconciler::new(&config.home, directory.join("targets"))?;
            let path = directory.join("run.json");
            let mut run = state::read_json::<RunState>(&path)?.unwrap_or_default();
            loop {
                let result = cycle(
                    &config,
                    &store,
                    &mut identity,
                    &mut run,
                    &path,
                    &cache,
                    &reconciler,
                )
                .await;
                let delay = match result {
                    Ok(delay) => delay,
                    Err(error) if once => return Err(error),
                    Err(error) => {
                        let rejected = error
                            .downcast_ref::<protocol::ProtocolError>()
                            .is_some_and(|e| e.is_auth_failure());
                        eprintln!("Agent cycle failed: {error}");
                        if rejected { 300 } else { 30 }
                    }
                };
                if once {
                    break;
                }
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(delay.clamp(5, 3600))) => {},
                    result = tokio::signal::ctrl_c() => { result?; break; }
                }
            }
        }
    }
    Ok(())
}

fn api(config: &state::Config, identity: &StoredIdentity) -> Result<Api> {
    Ok(Api::new(
        &config.server_url,
        config.ca_pem.as_bytes(),
        Some(&identity.identity_pem()),
    )?)
}

fn target(assignment: &Assignment) -> Result<fleet_reconcile::TargetDescriptor> {
    if assignment.target_name != "skills" || assignment.target.base != "home" {
        bail!("unsupported Target descriptor");
    }
    Ok(fleet_reconcile::TargetDescriptor {
        base: fleet_reconcile::TargetBase::Home,
        path: PathBuf::from(&assignment.target.path),
    })
}

fn cache_path(cache: &Path, digest: &str) -> Result<PathBuf> {
    let hex = digest
        .strip_prefix("sha256:")
        .context("unsupported Bundle digest")?;
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        bail!("invalid Bundle digest");
    }
    Ok(cache.join(hex))
}

fn clean_cache(cache: &Path, run: &RunState) -> Result<()> {
    let mut keep = HashSet::new();
    for assignment in run.active.iter().chain(run.pending_assignment.iter()) {
        for skill in &assignment.skills {
            keep.insert(cache_path(cache, &skill.bundle_digest)?);
        }
    }
    for entry in fs::read_dir(cache)? {
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

fn local_assignment(assignment: &Assignment, cache: &Path) -> Result<fleet_reconcile::Assignment> {
    let mut total = 0u64;
    let mut skills = Vec::new();
    if assignment.skills.len() > 10_000 {
        bail!("Assignment contains too many Skills");
    }
    for skill in &assignment.skills {
        if skill.size < 0 || skill.size > 16 * 1024 * 1024 {
            bail!("Bundle exceeds 16 MiB");
        }
        total = total
            .checked_add(skill.size as u64)
            .context("Assignment size overflow")?;
        if total > 256 * 1024 * 1024 {
            bail!("Assignment exceeds 256 MiB");
        }
        skills.push(fleet_reconcile::DesiredSkill {
            name: skill.name.clone(),
            digest: skill.bundle_digest.clone(),
            size: skill.size as u64,
            schema: skill.schema.clone(),
            bundle: state::read_bytes(&cache_path(cache, &skill.bundle_digest)?, 16 * 1024 * 1024)?,
        });
    }
    Ok(fleet_reconcile::Assignment {
        assignment_id: assignment.assignment_id.to_string(),
        desired_revision_id: assignment.desired_revision_id.to_string(),
        skills,
    })
}

fn verify_bundle(skill: &protocol::AssignmentSkill, bytes: &[u8]) -> bool {
    skill.schema == "fleet.bundle/v1"
        && skill.size >= 0
        && bytes.len() as i64 == skill.size
        && format!("sha256:{:x}", Sha256::digest(bytes)) == skill.bundle_digest
}

async fn ensure_bundles(client: &Api, assignment: &Assignment, cache: &Path) -> Result<()> {
    let mut total = 0u64;
    if assignment.skills.len() > 10_000 {
        bail!("Assignment contains too many Skills");
    }
    for skill in &assignment.skills {
        let size = u64::try_from(skill.size).context("invalid Bundle size")?;
        total = total
            .checked_add(size)
            .context("Assignment size overflow")?;
        if size > 16 * 1024 * 1024 || total > 256 * 1024 * 1024 || skill.schema != "fleet.bundle/v1"
        {
            bail!("unsupported Bundle size or schema");
        }
        let destination = cache_path(cache, &skill.bundle_digest)?;
        let valid = match fs::symlink_metadata(&destination) {
            Ok(metadata) => {
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    bail!("unsafe Bundle cache entry");
                }
                if metadata.len() <= 16 * 1024 * 1024
                    && verify_bundle(skill, &state::read_bytes(&destination, 16 * 1024 * 1024)?)
                {
                    true
                } else {
                    fs::remove_file(&destination)?;
                    false
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.into()),
        };
        if !valid {
            let bundle = client.bundle(skill).await?;
            if bundle.digest != skill.bundle_digest
                || bundle.schema != skill.schema
                || !verify_bundle(skill, &bundle.bytes)
            {
                bail!("downloaded Bundle failed integrity validation");
            }
            state::write_bytes(&destination, &bundle.bytes)?;
        }
    }
    Ok(())
}

async fn deliver_report(client: &Api, run: &mut RunState, path: &Path) -> Result<()> {
    if let Some(report) = &run.pending_report {
        let expected = if report.succeeded {
            ConvergenceState::Succeeded
        } else {
            ConvergenceState::Failed
        };
        let acknowledged = client
            .report(report.attempt_id, expected, report.error_code.as_deref())
            .await?;
        if !matches!(acknowledged.outcome, protocol::ReportOutcome::Stale)
            && acknowledged.state != expected
        {
            bail!("Server did not acknowledge the saved terminal state");
        }
        run.pending_report = None;
        state::write_json(path, run)?;
    }
    Ok(())
}

async fn cycle(
    config: &state::Config,
    store: &CredentialStore,
    identity: &mut StoredIdentity,
    run: &mut RunState,
    path: &Path,
    cache: &Path,
    reconciler: &fleet_reconcile::Reconciler,
) -> Result<u64> {
    for assignment in run.active.iter().chain(run.pending_assignment.iter()) {
        reconciler.recover(&target(assignment)?)?;
    }
    let expires = OffsetDateTime::parse(&identity.expires_at, &Rfc3339)
        .context("invalid credential expiration")?;
    if expires <= OffsetDateTime::now_utc() {
        bail!("Node certificate expired; Operator-assisted enrollment is required");
    }
    if expires - OffsetDateTime::now_utc() < time::Duration::days(1) {
        let pending = store.load_or_generate_pending()?;
        let renewed = api(config, identity)?.renew(&pending.csr_pem).await?;
        store.complete_renewal(&pending, &renewed)?;
        store.clear_pending()?;
        *identity = store
            .load_identity()?
            .context("renewed identity was not saved")?;
    }
    let client = api(config, identity)?;
    deliver_report(&client, run, path).await?;
    let poll = client.poll().await?;
    if poll.node_id != identity.node_id || poll.workspace_id != identity.workspace_id {
        bail!("Server returned another Node or Workspace identity");
    }
    let delay = poll.next_poll_seconds;
    if let Some(assignment) = poll.assignment {
        target(&assignment)?;
        if let Some(active) = &run.active
            && active.target.path != assignment.target.path
        {
            bail!("Target path cannot change after installation");
        }
        if assignment.skills.len() > 10_000
            || assignment
                .skills
                .iter()
                .try_fold(0u64, |sum, s| {
                    u64::try_from(s.size)
                        .ok()
                        .and_then(|size| sum.checked_add(size))
                })
                .is_none_or(|sum| sum > 256 * 1024 * 1024)
        {
            bail!("Assignment exceeds the supported size budget");
        }
        run.pending_assignment = Some(assignment);
        state::write_json(path, run)?;
    }
    clean_cache(cache, run)?;
    if let Some(assignment) = run.pending_assignment.clone() {
        ensure_bundles(&client, &assignment, cache).await?;
        let applying = client
            .report(assignment.attempt_id, ConvergenceState::Applying, None)
            .await?;
        if matches!(applying.outcome, protocol::ReportOutcome::Stale) {
            run.pending_assignment = None;
            run.pending_report = Some(PendingReport {
                attempt_id: assignment.attempt_id,
                succeeded: false,
                error_code: Some("assignment_superseded".to_owned()),
            });
            state::write_json(path, run)?;
            deliver_report(&client, run, path).await?;
            return Ok(5);
        }
        if applying.state != ConvergenceState::Applying {
            bail!("Server did not acknowledge applying state");
        }
        let outcome = reconciler.reconcile(
            &target(&assignment)?,
            &local_assignment(&assignment, cache)?,
        );
        run.pending_assignment = None;
        run.pending_report = Some(PendingReport {
            attempt_id: assignment.attempt_id,
            succeeded: outcome.is_ok(),
            error_code: outcome
                .as_ref()
                .err()
                .map(|error| error.code_str().to_owned()),
        });
        if outcome.is_ok() {
            run.active = Some(assignment);
        }
        state::write_json(path, run)?;
        deliver_report(&client, run, path).await?;
        clean_cache(cache, run)?;
        outcome?;
        println!("{{\"outcome\":\"succeeded\"}}");
    } else if let Some(active) = &run.active {
        ensure_bundles(&client, active, cache).await?;
        reconciler.reconcile(&target(active)?, &local_assignment(active, cache)?)?;
    }
    Ok(delay)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_require_explicit_enrollment_settings_and_do_not_accept_raw_tokens() {
        assert!(Cli::try_parse_from(["fleet-agent", "run", "--once"]).is_ok());
        assert!(Cli::try_parse_from(["fleet-agent", "enroll"]).is_err());
        assert!(
            Cli::try_parse_from([
                "fleet-agent",
                "enroll",
                "--server-url",
                "https://fleet",
                "--ca-cert",
                "ca.pem",
                "--alias",
                "node",
                "--token",
                "secret"
            ])
            .is_err()
        );
        assert!(
            Cli::try_parse_from([
                "fleet-agent",
                "--state-dir",
                "/tmp/agent",
                "alias",
                "renamed"
            ])
            .is_ok()
        );
    }

    #[test]
    fn bundle_cache_rejects_digest_path_injection() {
        for digest in [
            "../identity.json",
            "sha256:../identity.json",
            "sha256:ABCDEF",
            "sha512:abc",
        ] {
            assert!(cache_path(Path::new("/cache"), digest).is_err());
        }
        assert_eq!(
            cache_path(Path::new("/cache"), &format!("sha256:{}", "a".repeat(64))).unwrap(),
            PathBuf::from("/cache").join("a".repeat(64))
        );
    }
}
