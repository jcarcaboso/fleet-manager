use crate::Api;
use anyhow::{Result, bail};
use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Debug, Parser)]
#[command(
    name = "fleet",
    version,
    about = "Fleet Manager operator CLI",
    after_help = "Examples:\n  fleet nodes list\n  fleet nodes rename old-alias new-alias\n  fleet enrollment create --expires-in-seconds 3600\n\nSet FLEET_SERVER_URL and FLEET_OPERATOR_TOKEN before running API commands. Help does not require either variable."
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
    /// List or rename nodes.
    Nodes(NodesArgs),
    /// Inspect rollouts.
    Rollouts(ListArgs),
    /// Inspect warnings.
    Warnings(ListArgs),
    /// Create one-time enrollment tokens.
    Enrollment(EnrollmentCommand),
    /// Revoke Operator credentials.
    Credentials(CredentialsCommand),
    /// Rescan the configured source.
    Source(SourceCommand),
}

#[derive(Debug, Args)]
pub(crate) struct NodesArgs {
    #[command(subcommand)]
    command: NodesSubcommand,
    #[arg(long = "after", hide = true)]
    legacy_after: Option<String>,
}

#[derive(Debug, Subcommand)]
enum NodesSubcommand {
    List(NodesListArgs),
    /// Change a node's alias.
    Rename {
        /// Alias currently assigned to the node.
        current_alias: String,
        /// New alias to assign to the node.
        new_alias: String,
    },
}

#[derive(Debug, Args)]
struct NodesListArgs {
    /// Opaque cursor returned by a previous list response.
    #[arg(long)]
    after: Option<String>,
}

#[derive(Debug, Args)]
pub(crate) struct ListArgs {
    #[command(subcommand)]
    command: ListCommand,
    /// Opaque cursor returned by a previous list response.
    #[arg(long)]
    after: Option<String>,
}

#[derive(Debug, Subcommand)]
enum ListCommand {
    List,
}

#[derive(Debug, Args)]
pub(crate) struct EnrollmentCommand {
    #[command(subcommand)]
    command: EnrollmentSubcommand,
}

#[derive(Debug, Subcommand)]
enum EnrollmentSubcommand {
    Create(EnrollmentCreateArgs),
}

#[derive(Debug, Args)]
struct EnrollmentCreateArgs {
    /// Lifetime of the one-time enrollment token.
    #[arg(long, default_value_t = 900)]
    expires_in_seconds: u32,
}

#[derive(Debug, Args)]
pub(crate) struct CredentialsCommand {
    #[command(subcommand)]
    command: CredentialsSubcommand,
}

#[derive(Debug, Subcommand)]
enum CredentialsSubcommand {
    Revoke { id: Uuid },
}

#[derive(Debug, Args)]
pub(crate) struct SourceCommand {
    #[command(subcommand)]
    command: SourceSubcommand,
}

#[derive(Debug, Subcommand)]
enum SourceSubcommand {
    Rescan,
}

pub(crate) async fn run(api: &Api, command: Command) -> Result<()> {
    match command {
        Command::Nodes(NodesArgs {
            command: NodesSubcommand::List(args),
            legacy_after,
        }) => {
            if legacy_after.is_some() && args.after.is_some() {
                bail!("--after may be supplied only once")
            }
            api.get_collection("nodes", args.after.as_deref().or(legacy_after.as_deref()))
                .await
        }
        Command::Nodes(NodesArgs {
            command:
                NodesSubcommand::Rename {
                    current_alias,
                    new_alias,
                },
            legacy_after,
        }) => {
            if legacy_after.is_some() {
                bail!("--after is only valid with nodes list")
            }
            api.rename_node(&current_alias, &new_alias).await
        }
        Command::Rollouts(ListArgs {
            command: ListCommand::List,
            after,
        }) => api.get_collection("rollouts", after.as_deref()).await,
        Command::Warnings(ListArgs {
            command: ListCommand::List,
            after,
        }) => api.get_collection("warnings", after.as_deref()).await,
        Command::Enrollment(EnrollmentCommand {
            command: EnrollmentSubcommand::Create(args),
        }) => api.create_enrollment(args.expires_in_seconds).await,
        Command::Credentials(CredentialsCommand {
            command: CredentialsSubcommand::Revoke { id },
        }) => api.revoke_credential(id).await,
        Command::Source(SourceCommand {
            command: SourceSubcommand::Rescan,
        }) => api.rescan().await,
    }
}
