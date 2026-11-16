mod actions;
mod agent_loop;
mod ai_client;
mod cli;
mod credentials;
mod detail;
mod disk;
mod drift;
mod enroll;
mod inspect;
mod managed;
mod protocol;
mod repair;
mod run_state;
mod service;
mod state;
mod telemetry;
#[cfg(test)]
mod test_support;
mod updater;
mod worker;

use anyhow::{Context, Result};
use clap::Parser;
use cli::{Cli, Command, UpdateCommand};
use credentials::CredentialStore;
use std::path::PathBuf;

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let home = dirs::home_dir().context("cannot resolve the user's home directory")?;
    let directory = cli
        .state_dir
        .unwrap_or_else(|| home.join(".local/state/fleet-agent"));
    if let Command::Service { action } = &cli.command {
        return service::run(*action, &absolute_path(directory)?);
    }
    if let Command::Update { action } = &cli.command {
        let directory = absolute_path(directory)?;
        return match action {
            UpdateCommand::Status => inspect::print(&updater::status(&directory)?),
            UpdateCommand::Rollback => service::rollback(&directory),
        };
    }
    // Read-only commands never create, lock or change anything.
    match &cli.command {
        Command::Status => return inspect::print(&inspect::status(&directory)?),
        Command::Targets => return inspect::print(&inspect::targets(&directory)?),
        Command::Check => return inspect::check_command(&directory).await,
        Command::Disk => return inspect::print(&inspect::disk(&directory).await?),
        _ => {}
    }
    state::private_directory(&directory)?;
    let _lock = state::lock(&directory)?;
    let store = CredentialStore::open(directory.join("credentials"))?;
    let config_path = directory.join("config.json");
    match cli.command {
        Command::Enroll(args) => enroll::run(&store, &config_path, home, args).await?,
        Command::Alias { new_alias } => {
            let mut config = state::read_json::<state::Config>(&config_path)?
                .context("Agent is not configured")?;
            let identity = store.load_identity()?.context("Agent is not enrolled")?;
            let response = agent_loop::api(&config, &identity)?
                .rename(&new_alias)
                .await?;
            config.node_alias = response.alias.clone();
            state::write_json(&config_path, &config)?;
            println!(
                "{}",
                serde_json::json!({"nodeId":response.node_id,"alias":response.alias})
            );
        }
        Command::Run { once } => agent_loop::run(&directory, &store, &config_path, once).await?,
        Command::Status
        | Command::Targets
        | Command::Check
        | Command::Disk
        | Command::Service { .. }
        | Command::Update { .. } => unreachable!("handled before the state lock"),
    }
    Ok(())
}

fn absolute_path(path: PathBuf) -> Result<PathBuf> {
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(std::env::current_dir()
            .context("resolve current directory")?
            .join(path))
    }
}
