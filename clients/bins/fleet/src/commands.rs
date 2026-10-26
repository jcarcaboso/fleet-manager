use crate::Api;
use crate::error::CliError;
use crate::{doctor, selection};
use clap::{Args, Parser, Subcommand};
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::path::PathBuf;
use uuid::Uuid;

const TOP_HELP: &str = "\
Fleet Manager keeps AI-client Skills and configuration in sync on a set of machines (nodes).
Every command prints exactly one JSON document on stdout. Errors are one JSON line on stderr:
  {\"error\": {\"code\": \"node_not_found\", \"message\": \"...\", \"status\": 404}}

Setup:
  export FLEET_SERVER_URL=https://fleet.example
  export FLEET_OPERATOR_TOKEN=<operator token>   (environment only; there is no token flag)

Start here:
  fleet doctor                    every open problem, its explanation, and the commands that fix it
  fleet nodes list                all machines with freshness and target counts
  fleet nodes show <node>         one machine in detail (alias or UUID)
  fleet explain <error-code>      what an error code means and how to fix it

Exit codes:
  0 ok   2 usage error   3 authentication or authorization failed (401/403, including a token
  scope that is too low)   4 not found   5 conflict (409)   6 other server or transport error
  10 `fleet doctor` found error-severity issues (its JSON is still printed on stdout)

Token scopes: read (every list/show command), operate (retry, nodes disk --refresh, source rescan, models select and
refresh), admin (enrollment, rename, revoke, remove). Destructive commands need --yes.
Help does not require FLEET_SERVER_URL or FLEET_OPERATOR_TOKEN.";

#[derive(Debug, Parser)]
#[command(
    name = "fleet",
    version,
    about = "Fleet Manager operator CLI: inspect machines, diagnose problems and fix them (JSON output)",
    after_help = TOP_HELP
)]
pub(crate) struct Cli {
    /// Fleet Server base URL. Defaults to FLEET_SERVER_URL.
    #[arg(long, env = "FLEET_SERVER_URL")]
    pub(crate) server_url: String,
    /// Permit plain HTTP only when the server host is loopback.
    #[arg(long)]
    pub(crate) allow_http: bool,
    /// PEM CA certificate for a private Fleet Server trust root.
    #[arg(long, value_name = "FILE")]
    pub(crate) ca_cert: Option<PathBuf>,
    #[command(subcommand)]
    pub(crate) command: Command,
}

#[derive(Debug, Subcommand)]
pub(crate) enum Command {
    /// List, inspect, rename, revoke or remove machines (nodes).
    Nodes(NodesArgs),
    /// Re-queue a failed target on a node so the agent applies it again.
    #[command(
        after_help = "Needs scope operate. Example:\n  fleet retry studio-mini ai-client/claude\n\nOnly a target whose current assignment failed can be retried. Find targets with `fleet nodes show <node>`."
    )]
    Retry {
        /// Node alias (exact, case-sensitive) or node ID (UUID).
        node: String,
        /// Target name as shown by `nodes show`, for example `skills` or `ai-client/claude`.
        target: String,
    },
    /// List open issues (problems) with severity, error code and suggested commands.
    Issues(IssuesCommand),
    /// Browse the error catalog of every agent and server error code.
    Errors(ErrorsCommand),
    /// Explain one error code: title, explanation and fix steps.
    #[command(
        after_help = "Examples:\n  fleet explain lock_failed\n  fleet explain ai_client_reconcile_failed"
    )]
    Explain {
        /// Error code, for example `lock_failed`. Codes appear as `errorCode` in issues and attempts.
        code: String,
    },
    /// Report every open issue with its explanation; exits 10 when error-severity issues exist.
    #[command(
        after_help = "Prints {\"ok\": bool, \"issues\": [{...issue, \"explanation\": {title, explanation, fix} | null}], \"summary\": {\"errors\": n, \"warnings\": n}}.\nEach issue's `commands` array lists fleet commands that inspect or fix it.\nA failed-Target issue also carries `diagnostic`, `path` and `step` from the latest failed attempt (null when the Agent sent none); read them before choosing a fix.\nExit 0 when no issue has severity error (warnings alone are ok); exit 10 when at least one does.\n\nExamples:\n  fleet doctor\n  fleet doctor | jq '.issues[].commands[]'"
    )]
    Doctor,
    /// List rollouts or inspect one rollout's attempts.
    Rollouts(RolloutsArgs),
    /// List desired revisions (source revisions published for rollout).
    Revisions(RevisionsCommand),
    /// List source warnings.
    Warnings(WarningsArgs),
    /// List source scan history, newest first.
    Scans(ScansCommand),
    /// Show source status or ask the Server to rescan the Git source.
    Source(SourceCommand),
    /// List audit events, optionally for one node.
    Audit(AuditCommand),
    /// Create enrollment tokens and manage enrollment links for new machines.
    Enrollment(EnrollmentCommand),
    /// Revoke Operator credentials.
    Credentials(CredentialsCommand),
    /// Inspect and change the CLIProxy model catalog and selection.
    Models(ModelsCommand),
}

/// Shared by every command that changes or destroys something that cannot be undone.
#[derive(Debug, Args)]
pub(crate) struct Confirm {
    /// Confirm the destructive action. Ask the human operator before passing it.
    #[arg(long)]
    yes: bool,
    /// Make only read-only requests and print what would happen; changes nothing.
    #[arg(long)]
    dry_run: bool,
}

#[derive(Debug, Args)]
pub(crate) struct AfterArgs {
    /// Opaque cursor returned as nextCursor by a previous list response.
    #[arg(long)]
    after: Option<String>,
}

/// Paging for lists that the Server can also return newest first (`order=newest`).
#[derive(Debug, Args)]
pub(crate) struct NewestArgs {
    /// Opaque cursor returned as nextCursor by a previous list response.
    /// Use it with the same --newest setting that produced it.
    #[arg(long)]
    after: Option<String>,
    /// Newest first (sends order=newest). Without it the Server lists in ID order, which is not chronological.
    #[arg(long)]
    newest: bool,
}

impl NewestArgs {
    fn filters(&self) -> Vec<(&'static str, &'static str)> {
        self.newest
            .then_some(("order", "newest"))
            .into_iter()
            .collect()
    }
}

// ---- nodes -------------------------------------------------------------------------------

#[derive(Debug, Args)]
#[command(
    after_help = "Examples:\n  fleet nodes list\n  fleet nodes show studio-mini\n  fleet nodes attempts studio-mini --target skills\n  fleet nodes checkins studio-mini --hours 24\n  fleet nodes disk studio-mini\n  fleet nodes rename old-alias new-alias\n  fleet nodes revoke studio-mini --dry-run\n\n<node> is an exact, case-sensitive alias or a node UUID. Quote aliases that contain spaces."
)]
pub(crate) struct NodesArgs {
    #[command(subcommand)]
    command: NodesSubcommand,
    #[arg(long = "after", hide = true)]
    legacy_after: Option<String>,
}

#[derive(Debug, Subcommand)]
enum NodesSubcommand {
    /// List nodes: alias, platform, freshness, target-state counts, current revision, disk and Agent summary (version, outdated, OS, hostname).
    #[command(
        after_help = "Examples:\n  fleet nodes list\n  fleet nodes list --after <nextCursor>"
    )]
    List(AfterArgs),
    /// Show one node: credential validity, each target's state, latest attempt and error code, disk and `agent` (version, latestVersion, outdated, OS, install method; null before Agent 0.9.0).
    #[command(
        after_help = "Examples:\n  fleet nodes show studio-mini\n  fleet nodes show 00000000-0000-0000-0000-000000000001"
    )]
    Show {
        /// Node alias (exact, case-sensitive) or node ID (UUID).
        node: String,
    },
    /// List a node's attempt history across targets, newest first.
    #[command(
        after_help = "Examples:\n  fleet nodes attempts studio-mini\n  fleet nodes attempts studio-mini --target ai-client/claude --after <nextCursor>"
    )]
    Attempts {
        /// Node alias (exact, case-sensitive) or node ID (UUID).
        node: String,
        /// Only attempts for this target name.
        #[arg(long)]
        target: Option<String>,
        /// Opaque cursor returned as nextCursor by a previous list response.
        #[arg(long)]
        after: Option<String>,
    },
    /// Show how many times a node polled the Server in each recent UTC hour.
    #[command(
        after_help = "Examples:\n  fleet nodes checkins studio-mini\n  fleet nodes checkins studio-mini --hours 24"
    )]
    Checkins {
        /// Node alias (exact, case-sensitive) or node ID (UUID).
        node: String,
        /// How many past hours to return, 1 to 168. The Server default is 168.
        #[arg(long, value_parser = clap::value_parser!(u16).range(1..=168))]
        hours: Option<u16>,
    },
    /// Show a node's disk usage: used, available and total bytes per volume, or null if it never reported.
    #[command(
        after_help = "Without --refresh this only reads. With --refresh it asks the Agent to measure again (needs scope operate); the Agent answers on its next poll.\nExamples:\n  fleet nodes disk studio-mini\n  fleet nodes disk studio-mini --refresh\n\nOutput: {\"node\": <alias>, \"disk\": {\"measuredAt\", \"refreshRequestedAt\", \"volumes\": [{\"label\", \"totalBytes\", \"usedBytes\", \"availableBytes\", \"usedPercent\"}]} or null}.\nWith --refresh it prints the 202 reply: {\"refreshRequestedAt\": <time>}. Run `fleet nodes disk <node>` again after the Agent's next poll and compare measuredAt with refreshRequestedAt.\nAgents before 0.9.0 never report disk usage and never answer a refresh."
    )]
    Disk {
        /// Node alias (exact, case-sensitive) or node ID (UUID).
        node: String,
        /// Ask the Agent to measure now instead of reading the last measurement. Needs scope operate.
        #[arg(long)]
        refresh: bool,
    },
    /// Change a node's alias. Update the alias in the source `fleet.yml` afterwards.
    #[command(after_help = "Needs scope admin. Example:\n  fleet nodes rename old-alias new-alias")]
    Rename {
        /// Alias currently assigned to the node.
        current_alias: String,
        /// New alias to assign to the node.
        new_alias: String,
    },
    /// Revoke a node's credentials so it can no longer poll. Destructive; needs --yes.
    #[command(
        after_help = "Needs scope admin and --yes. Never run without the human operator's approval.\nExamples:\n  fleet nodes revoke studio-mini --dry-run\n  fleet nodes revoke studio-mini --yes"
    )]
    Revoke {
        /// Node alias (exact, case-sensitive) or node ID (UUID).
        node: String,
        #[command(flatten)]
        confirm: Confirm,
    },
    /// Delete a node and its history from the Server. Destructive; needs --yes.
    #[command(
        after_help = "Needs scope admin and --yes. Never run without the human operator's approval.\nThe CLI confirms with the node's current alias automatically.\nExamples:\n  fleet nodes remove studio-mini --dry-run\n  fleet nodes remove studio-mini --yes"
    )]
    Remove {
        /// Node alias (exact, case-sensitive) or node ID (UUID).
        node: String,
        #[command(flatten)]
        confirm: Confirm,
    },
}

// ---- issues and errors --------------------------------------------------------------------

#[derive(Debug, Args)]
#[command(after_help = "Example:\n  fleet issues list")]
pub(crate) struct IssuesCommand {
    #[command(subcommand)]
    command: IssuesSubcommand,
}

#[derive(Debug, Subcommand)]
enum IssuesSubcommand {
    /// List open issues, errors first. Not paged; `fleet doctor` adds explanations.
    #[command(
        after_help = "Example:\n  fleet issues list\n\nEach issue has severity (error or warning), code, errorCode, nodeName, target and a `commands` array."
    )]
    List,
}

#[derive(Debug, Args)]
#[command(after_help = "Example:\n  fleet errors list")]
pub(crate) struct ErrorsCommand {
    #[command(subcommand)]
    command: ErrorsSubcommand,
}

#[derive(Debug, Subcommand)]
enum ErrorsSubcommand {
    /// List every catalog entry: code, source, title, explanation and fix steps.
    #[command(
        after_help = "Example:\n  fleet errors list\n\nTo look up one code use `fleet explain <code>`."
    )]
    List,
}

// ---- rollouts, revisions, warnings, scans, source, audit ----------------------------------

#[derive(Debug, Args)]
#[command(
    after_help = "Examples:\n  fleet rollouts list\n  fleet rollouts attempts 550e8400-e29b-41d4-a716-446655440000"
)]
pub(crate) struct RolloutsArgs {
    #[command(subcommand)]
    command: RolloutsSubcommand,
    #[arg(long = "after", hide = true)]
    legacy_after: Option<String>,
}

#[derive(Debug, Subcommand)]
enum RolloutsSubcommand {
    /// List rollouts with per-state attempt counts.
    #[command(
        after_help = "Examples:\n  fleet rollouts list\n  fleet rollouts list --newest\n  fleet rollouts list --newest --after <nextCursor>\n\nWithout --newest the Server lists rollouts in ID order, which is not chronological. Use --newest to find recent rollouts."
    )]
    List(NewestArgs),
    /// List every node's attempt in one rollout.
    #[command(
        after_help = "Examples:\n  fleet rollouts attempts 550e8400-e29b-41d4-a716-446655440000"
    )]
    Attempts {
        /// Rollout ID (UUID) from `rollouts list`.
        rollout_id: Uuid,
        /// Opaque cursor returned as nextCursor by a previous list response.
        #[arg(long)]
        after: Option<String>,
    },
}

#[derive(Debug, Args)]
#[command(after_help = "Examples:\n  fleet revisions list --newest")]
pub(crate) struct RevisionsCommand {
    #[command(subcommand)]
    command: RevisionsSubcommand,
}

#[derive(Debug, Subcommand)]
enum RevisionsSubcommand {
    /// List desired revisions: source revisions the Server accepted for rollout.
    #[command(
        after_help = "Examples:\n  fleet revisions list\n  fleet revisions list --newest\n  fleet revisions list --newest --after <nextCursor>\n\nWithout --newest the Server lists revisions in ID order, which is not chronological. With --newest the first item is the newest revision."
    )]
    List(NewestArgs),
}

#[derive(Debug, Args)]
#[command(
    after_help = "Examples:\n  fleet warnings list\n  fleet warnings list --after <nextCursor>"
)]
pub(crate) struct WarningsArgs {
    #[command(subcommand)]
    command: WarningsSubcommand,
    #[arg(long = "after", hide = true)]
    legacy_after: Option<String>,
}

#[derive(Debug, Subcommand)]
enum WarningsSubcommand {
    /// List warnings found while reading the source repository.
    #[command(
        after_help = "Examples:\n  fleet warnings list\n  fleet warnings list --after <nextCursor>"
    )]
    List(AfterArgs),
}

#[derive(Debug, Args)]
#[command(after_help = "Example:\n  fleet scans list")]
pub(crate) struct ScansCommand {
    #[command(subcommand)]
    command: ScansSubcommand,
}

#[derive(Debug, Subcommand)]
enum ScansSubcommand {
    /// List source scans, newest first: outcome (accepted, unchanged, invalid, failed) and code.
    #[command(
        after_help = "Examples:\n  fleet scans list\n  fleet scans list --after <nextCursor>"
    )]
    List(AfterArgs),
}

#[derive(Debug, Args)]
#[command(after_help = "Examples:\n  fleet source status\n  fleet source rescan")]
pub(crate) struct SourceCommand {
    #[command(subcommand)]
    command: SourceSubcommand,
}

#[derive(Debug, Subcommand)]
enum SourceSubcommand {
    /// Show the latest source scan: revision, outcome and any error code.
    #[command(after_help = "Example:\n  fleet source status")]
    Status,
    /// Ask the Server to read the Git source now. Needs scope operate.
    #[command(
        after_help = "Example:\n  fleet source rescan\n\nThen check the result with `fleet source status` or `fleet scans list`."
    )]
    Rescan,
}

#[derive(Debug, Args)]
#[command(
    after_help = "Examples:\n  fleet audit list --newest\n  fleet audit list --newest --node studio-mini\n  fleet audit list --newest --after <nextCursor>"
)]
pub(crate) struct AuditCommand {
    #[command(subcommand)]
    command: AuditSubcommand,
}

#[derive(Debug, Subcommand)]
enum AuditSubcommand {
    /// List audit events. Add --newest to start with the most recent.
    #[command(
        after_help = "Examples:\n  fleet audit list --newest\n  fleet audit list --newest --node studio-mini\n\nWithout --newest the Server lists events in ID order, which is not chronological. Use --newest to see what changed recently."
    )]
    List {
        /// Only events for this node (alias or UUID).
        #[arg(long)]
        node: Option<String>,
        /// Opaque cursor returned as nextCursor by a previous list response.
        /// Use it with the same --newest setting that produced it.
        #[arg(long)]
        after: Option<String>,
        /// Newest first (sends order=newest).
        #[arg(long)]
        newest: bool,
    },
}

// ---- enrollment and credentials -----------------------------------------------------------

#[derive(Debug, Args)]
#[command(
    after_help = "All enrollment commands need scope admin. Examples:\n  fleet enrollment create --expires-in-seconds 3600\n  fleet enrollment links list\n  fleet enrollment links create laptop --expires-in-seconds 900\n  fleet enrollment links revoke 550e8400-e29b-41d4-a716-446655440000 --dry-run"
)]
pub(crate) struct EnrollmentCommand {
    #[command(subcommand)]
    command: EnrollmentSubcommand,
}

#[derive(Debug, Subcommand)]
enum EnrollmentSubcommand {
    /// Create a one-time enrollment token. The response contains the secret token once.
    #[command(
        after_help = "Needs scope admin. Example:\n  fleet enrollment create --expires-in-seconds 3600\n\nTreat the printed token as a secret; do not paste it into logs or chats."
    )]
    Create(EnrollmentCreateArgs),
    /// List, create or revoke enrollment links (enrollment URLs bound to an alias).
    #[command(
        after_help = "Examples:\n  fleet enrollment links list\n  fleet enrollment links create laptop\n  fleet enrollment links revoke <id> --dry-run"
    )]
    Links(LinksCommand),
}

#[derive(Debug, Args)]
struct EnrollmentCreateArgs {
    /// Lifetime of the one-time enrollment token.
    #[arg(long, default_value_t = 900)]
    expires_in_seconds: u32,
}

#[derive(Debug, Args)]
pub(crate) struct LinksCommand {
    #[command(subcommand)]
    command: LinksSubcommand,
}

#[derive(Debug, Subcommand)]
enum LinksSubcommand {
    /// List enrollment links with state active, consumed, expired or revoked. Tokens are never shown.
    #[command(
        after_help = "Examples:\n  fleet enrollment links list\n  fleet enrollment links list --after <nextCursor>"
    )]
    List(AfterArgs),
    /// Create an enrollment link for a new machine with the given alias.
    #[command(
        after_help = "Example:\n  fleet enrollment links create laptop --expires-in-seconds 900"
    )]
    Create {
        /// Alias the new node will receive.
        alias: String,
        /// Lifetime of the link.
        #[arg(long, default_value_t = 900)]
        expires_in_seconds: u32,
    },
    /// Revoke an unused enrollment link. Destructive; needs --yes.
    #[command(
        after_help = "Needs --yes. Examples:\n  fleet enrollment links revoke 550e8400-e29b-41d4-a716-446655440000 --dry-run\n  fleet enrollment links revoke 550e8400-e29b-41d4-a716-446655440000 --yes"
    )]
    Revoke {
        /// Link ID (UUID) from `enrollment links list`.
        id: Uuid,
        #[command(flatten)]
        confirm: Confirm,
    },
}

#[derive(Debug, Args)]
#[command(after_help = "Needs scope admin. Example:\n  fleet credentials revoke <id> --dry-run")]
pub(crate) struct CredentialsCommand {
    #[command(subcommand)]
    command: CredentialsSubcommand,
}

#[derive(Debug, Subcommand)]
enum CredentialsSubcommand {
    /// Revoke a credential by ID. Destructive; needs --yes.
    #[command(
        after_help = "Needs --yes. There is no read-only lookup for a credential ID, so --dry-run\nonly echoes the target. Find IDs with `fleet nodes show <node>` (credential.credentialId).\nExamples:\n  fleet credentials revoke 550e8400-e29b-41d4-a716-446655440000 --dry-run\n  fleet credentials revoke 550e8400-e29b-41d4-a716-446655440000 --yes"
    )]
    Revoke {
        /// Credential ID (UUID).
        id: Uuid,
        #[command(flatten)]
        confirm: Confirm,
    },
}

// ---- models -------------------------------------------------------------------------------

#[derive(Debug, Args)]
#[command(
    after_help = "Examples:\n  fleet models status\n  fleet models selection\n  fleet models refresh\n  fleet models select --disable-family gemini\n  fleet models select --include-new false --enable-model gpt-5.1"
)]
pub(crate) struct ModelsCommand {
    #[command(subcommand)]
    command: ModelsSubcommand,
}

#[derive(Debug, Subcommand)]
enum ModelsSubcommand {
    /// Show CLIProxy catalog health: each base URL, model count and last sync.
    #[command(after_help = "Example:\n  fleet models status")]
    Status,
    /// Show the model selection: per base URL the models, selection policy and version.
    #[command(after_help = "Example:\n  fleet models selection")]
    Selection,
    /// Change which CLIProxy models Fleet offers. Needs scope operate.
    Select(SelectArgs),
    /// Fetch the model catalog from CLIProxy now. Needs scope operate.
    #[command(after_help = "Example:\n  fleet models refresh\n\nThen check `fleet models status`.")]
    Refresh,
}

/// Flags are changes applied on top of the current policy, which is read first.
#[derive(Debug, Args)]
#[command(
    after_help = "The command reads the current selection, applies your changes, and saves the whole policy\nwith the version it read. If someone else saved in between, it fails with code stale_selection\n(exit 5); run it again. A model is selected when it has an override, else when its family is\nenabled, else when its family is not disabled and --include-new is true. The Server rejects a\nselection that would exclude a model an assignment pins (pinned_model_excluded, exit 5) or\nselect nothing (invalid_selection).\n\nExamples:\n  fleet models select --disable-family gemini\n  fleet models select --enable-family gpt-5 --disable-model gpt-5-codex\n  fleet models select --base-url https://proxy.home.arpa --include-new false\n  fleet models select --include-new false --dry-run"
)]
pub(crate) struct SelectArgs {
    /// CLIProxy base URL. Optional when exactly one catalog exists.
    #[arg(long, value_name = "URL")]
    pub(crate) base_url: Option<String>,
    /// Policy version to replace. Defaults to the version just read; set it to pin the edit.
    #[arg(long, value_name = "N")]
    pub(crate) selection_version: Option<u64>,
    /// Whether model families first seen later are selected by default.
    #[arg(long, value_name = "BOOL")]
    pub(crate) include_new: Option<bool>,
    /// Hide Claude models from non-Claude AI clients.
    #[arg(long, value_name = "BOOL")]
    pub(crate) skip_claude_models_for_other_clients: Option<bool>,
    /// Select a whole model family such as `gpt-5` or `claude`. Repeatable.
    #[arg(long, value_name = "FAMILY")]
    pub(crate) enable_family: Vec<String>,
    /// Deselect a whole model family. Repeatable.
    #[arg(long, value_name = "FAMILY")]
    pub(crate) disable_family: Vec<String>,
    /// Force one model ID on, regardless of its family. Repeatable.
    #[arg(long, value_name = "MODEL")]
    pub(crate) enable_model: Vec<String>,
    /// Force one model ID off, regardless of its family. Repeatable.
    #[arg(long, value_name = "MODEL")]
    pub(crate) disable_model: Vec<String>,
    /// Remove a per-model override so its family decides again. Repeatable.
    #[arg(long, value_name = "MODEL")]
    pub(crate) clear_model_override: Vec<String>,
    /// Print the request that would be sent after reading the selection; change nothing.
    #[arg(long)]
    dry_run: bool,
}

// ---- dispatch -----------------------------------------------------------------------------

/// What the process should report after a command ran successfully.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Done,
    /// `fleet doctor` printed its document and found error-severity issues.
    DoctorFoundErrors,
}

pub(crate) fn emit<T: Serialize>(value: &T) -> Result<(), CliError> {
    let text = serde_json::to_string(value)
        .map_err(|_| CliError::transport("encode_failed", "could not encode output"))?;
    println!("{text}");
    Ok(())
}

fn to_value<T: Serialize>(value: T) -> Result<Value, CliError> {
    serde_json::to_value(value)
        .map_err(|_| CliError::transport("encode_failed", "could not encode output"))
}

fn merge_after(legacy: Option<String>, after: Option<String>) -> Result<Option<String>, CliError> {
    if legacy.is_some() && after.is_some() {
        return Err(CliError::usage(
            "invalid_argument",
            "--after may be supplied only once",
        ));
    }
    Ok(after.or(legacy))
}

fn reject_legacy_after(legacy: Option<String>, only: &str) -> Result<(), CliError> {
    if legacy.is_some() {
        return Err(CliError::usage(
            "invalid_argument",
            format!("--after is only valid with {only}"),
        ));
    }
    Ok(())
}

enum Mode {
    Run,
    DryRun,
}

/// Destructive commands do nothing without `--yes`, unless `--dry-run` asks for a preview.
fn gate(confirm: &Confirm, command: &str) -> Result<Mode, CliError> {
    if confirm.dry_run {
        Ok(Mode::DryRun)
    } else if confirm.yes {
        Ok(Mode::Run)
    } else {
        Err(CliError::usage(
            "confirmation_required",
            format!(
                "`fleet {command}` is destructive and was not run; ask the human operator, then re-run with --yes (or use --dry-run to preview)"
            ),
        ))
    }
}

fn dry_run(action: &str, target: Value, request: Value) -> Value {
    json!({"dryRun": true, "action": action, "target": target, "request": request})
}

fn invalid_response() -> CliError {
    CliError::transport(
        "invalid_response",
        "Fleet Server response had an unexpected shape",
    )
}

/// A short, stable view of a `GET nodes/{node}` response.
fn node_target(node: &Value) -> Value {
    let mut target = Map::new();
    for key in [
        "nodeId",
        "name",
        "platform",
        "freshness",
        "revoked",
        "lastContactAt",
        "summary",
    ] {
        if let Some(value) = node.get(key) {
            target.insert(key.to_owned(), value.clone());
        }
    }
    Value::Object(target)
}

fn string_field<'a>(value: &'a Value, key: &str) -> Result<&'a str, CliError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(invalid_response)
}

pub(crate) async fn run(api: &Api, command: Command) -> Result<Outcome, CliError> {
    if matches!(command, Command::Doctor) {
        let issues = api.get(&["issues"], &[]).await?;
        let has_items = issues
            .get("items")
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty());
        let catalog = if has_items {
            api.get(&["errors"], &[]).await?
        } else {
            Value::Null
        };
        let (document, failed) = doctor::report(&issues, &catalog)?;
        emit(&document)?;
        return Ok(if failed {
            Outcome::DoctorFoundErrors
        } else {
            Outcome::Done
        });
    }
    emit(&dispatch(api, command).await?)?;
    Ok(Outcome::Done)
}

async fn dispatch(api: &Api, command: Command) -> Result<Value, CliError> {
    match command {
        Command::Doctor => unreachable!("handled by run"),
        Command::Nodes(NodesArgs {
            command,
            legacy_after,
        }) => nodes(api, command, legacy_after).await,
        Command::Retry { node, target } => {
            api.post(
                &["nodes", &node, "retry"],
                Some(&json!({ "target": target })),
            )
            .await
        }
        Command::Issues(IssuesCommand {
            command: IssuesSubcommand::List,
        }) => api.get(&["issues"], &[]).await,
        Command::Errors(ErrorsCommand {
            command: ErrorsSubcommand::List,
        }) => api.get(&["errors"], &[]).await,
        Command::Explain { code } => api.get(&["errors", &code], &[]).await,
        Command::Rollouts(RolloutsArgs {
            command,
            legacy_after,
        }) => match command {
            RolloutsSubcommand::List(args) => {
                let filters = args.filters();
                let after = merge_after(legacy_after, args.after)?;
                to_value(api.list(&["rollouts"], &filters, after.as_deref()).await?)
            }
            RolloutsSubcommand::Attempts { rollout_id, after } => {
                reject_legacy_after(legacy_after, "rollouts list")?;
                to_value(
                    api.list(
                        &["rollouts", &rollout_id.to_string(), "attempts"],
                        &[],
                        after.as_deref(),
                    )
                    .await?,
                )
            }
        },
        Command::Revisions(RevisionsCommand {
            command: RevisionsSubcommand::List(args),
        }) => to_value(
            api.list(
                &["desired-revisions"],
                &args.filters(),
                args.after.as_deref(),
            )
            .await?,
        ),
        Command::Warnings(WarningsArgs {
            command: WarningsSubcommand::List(args),
            legacy_after,
        }) => to_value(
            api.get_collection(
                "warnings",
                merge_after(legacy_after, args.after)?.as_deref(),
            )
            .await?,
        ),
        Command::Scans(ScansCommand {
            command: ScansSubcommand::List(args),
        }) => to_value(
            api.list(&["source", "scans"], &[], args.after.as_deref())
                .await?,
        ),
        Command::Source(SourceCommand { command }) => match command {
            SourceSubcommand::Status => api.get(&["source", "status"], &[]).await,
            SourceSubcommand::Rescan => api.rescan().await,
        },
        Command::Audit(AuditCommand {
            command:
                AuditSubcommand::List {
                    node,
                    after,
                    newest,
                },
        }) => {
            let filters: Vec<(&str, &str)> = node
                .as_deref()
                .map(|n| ("node", n))
                .into_iter()
                .chain(newest.then_some(("order", "newest")))
                .collect();
            to_value(api.list(&["audit"], &filters, after.as_deref()).await?)
        }
        Command::Enrollment(EnrollmentCommand { command }) => enrollment(api, command).await,
        Command::Credentials(CredentialsCommand {
            command: CredentialsSubcommand::Revoke { id, confirm },
        }) => match gate(&confirm, "credentials revoke")? {
            Mode::DryRun => Ok(dry_run(
                "credentials revoke",
                json!({"credentialId": id}),
                json!({"method": "POST", "path": format!("credentials/{id}/revoke")}),
            )),
            Mode::Run => api.revoke_credential(id).await,
        },
        Command::Models(ModelsCommand { command }) => match command {
            ModelsSubcommand::Status => api.get(&["cliproxy", "status"], &[]).await,
            ModelsSubcommand::Selection => api.get(&["cliproxy", "selection"], &[]).await,
            ModelsSubcommand::Refresh => api.post(&["cliproxy", "refresh"], None).await,
            ModelsSubcommand::Select(args) => {
                let current = api.get(&["cliproxy", "selection"], &[]).await?;
                let body = selection::build_body(&current, &args)?;
                if args.dry_run {
                    return Ok(dry_run(
                        "models select",
                        json!({"baseUrl": body["baseUrl"], "version": body["version"]}),
                        json!({"method": "POST", "path": "cliproxy/selection", "body": body}),
                    ));
                }
                api.post(&["cliproxy", "selection"], Some(&body)).await
            }
        },
    }
}

async fn nodes(
    api: &Api,
    command: NodesSubcommand,
    legacy_after: Option<String>,
) -> Result<Value, CliError> {
    match command {
        NodesSubcommand::List(args) => to_value(
            api.get_collection("nodes", merge_after(legacy_after, args.after)?.as_deref())
                .await?,
        ),
        other => {
            reject_legacy_after(legacy_after, "nodes list")?;
            node_command(api, other).await
        }
    }
}

async fn node_command(api: &Api, command: NodesSubcommand) -> Result<Value, CliError> {
    match command {
        NodesSubcommand::List(_) => unreachable!("handled by nodes"),
        NodesSubcommand::Show { node } => api.get(&["nodes", &node], &[]).await,
        NodesSubcommand::Attempts {
            node,
            target,
            after,
        } => {
            let filters: Vec<(&str, &str)> = target
                .as_deref()
                .map(|t| ("target", t))
                .into_iter()
                .collect();
            to_value(
                api.list(&["nodes", &node, "attempts"], &filters, after.as_deref())
                    .await?,
            )
        }
        NodesSubcommand::Checkins { node, hours } => {
            let hours = hours.map(|hours| hours.to_string());
            let query: Vec<(&str, &str)> =
                hours.as_deref().map(|h| ("hours", h)).into_iter().collect();
            api.get(&["nodes", &node, "checkins"], &query).await
        }
        NodesSubcommand::Disk { node, refresh } => {
            if refresh {
                return api
                    .post(&["nodes", &node, "disk-usage", "refresh"], None)
                    .await;
            }
            let detail = api.get(&["nodes", &node], &[]).await?;
            Ok(json!({
                "node": detail.get("name").cloned().unwrap_or_else(|| json!(node)),
                "disk": detail.get("disk").cloned().unwrap_or(Value::Null),
            }))
        }
        NodesSubcommand::Rename {
            current_alias,
            new_alias,
        } => to_value(api.rename_node(&current_alias, &new_alias).await?),
        NodesSubcommand::Revoke { node, confirm } => {
            let mode = gate(&confirm, "nodes revoke")?;
            let detail = api.get(&["nodes", &node], &[]).await?;
            let node_id = string_field(&detail, "nodeId")?;
            let path = format!("nodes/{node_id}/revoke");
            match mode {
                Mode::DryRun => Ok(dry_run(
                    "nodes revoke",
                    node_target(&detail),
                    json!({"method": "POST", "path": path}),
                )),
                Mode::Run => api.post(&["nodes", node_id, "revoke"], None).await,
            }
        }
        NodesSubcommand::Remove { node, confirm } => {
            let mode = gate(&confirm, "nodes remove")?;
            let detail = api.get(&["nodes", &node], &[]).await?;
            let node_id = string_field(&detail, "nodeId")?;
            let body = json!({"alias": string_field(&detail, "name")?});
            match mode {
                Mode::DryRun => Ok(dry_run(
                    "nodes remove",
                    node_target(&detail),
                    json!({"method": "POST", "path": format!("nodes/{node_id}/remove"), "body": body}),
                )),
                Mode::Run => api.post(&["nodes", node_id, "remove"], Some(&body)).await,
            }
        }
    }
}

async fn enrollment(api: &Api, command: EnrollmentSubcommand) -> Result<Value, CliError> {
    match command {
        EnrollmentSubcommand::Create(args) => api.create_enrollment(args.expires_in_seconds).await,
        EnrollmentSubcommand::Links(LinksCommand { command }) => match command {
            LinksSubcommand::List(args) => to_value(
                api.get_collection("enrollment-links", args.after.as_deref())
                    .await?,
            ),
            LinksSubcommand::Create {
                alias,
                expires_in_seconds,
            } => {
                let body = json!({"alias": alias, "expiresInSeconds": expires_in_seconds});
                api.post(&["enrollment-links"], Some(&body)).await
            }
            LinksSubcommand::Revoke { id, confirm } => {
                let mode = gate(&confirm, "enrollment links revoke")?;
                match mode {
                    Mode::DryRun => {
                        let link = find_link(api, id).await?;
                        Ok(dry_run(
                            "enrollment links revoke",
                            link,
                            json!({"method": "POST", "path": format!("enrollment-links/{id}/revoke")}),
                        ))
                    }
                    Mode::Run => {
                        api.post(&["enrollment-links", &id.to_string(), "revoke"], None)
                            .await
                    }
                }
            }
        },
    }
}

/// Finds one link by walking the paged list. Stops after 20 pages (2,000 links).
async fn find_link(api: &Api, id: Uuid) -> Result<Value, CliError> {
    let wanted = id.to_string();
    let mut after: Option<String> = None;
    for _ in 0..20 {
        let page = api
            .list(&["enrollment-links"], &[], after.as_deref())
            .await?;
        if let Some(link) = page.items.into_iter().find(|link| {
            link.get("id")
                .and_then(Value::as_str)
                .is_some_and(|candidate| candidate.eq_ignore_ascii_case(&wanted))
        }) {
            return Ok(link);
        }
        match page.next_cursor {
            Some(cursor) => after = Some(cursor),
            None => break,
        }
    }
    Err(CliError::not_found(
        "enrollment_link_not_found",
        "no enrollment link has that ID",
    ))
}
