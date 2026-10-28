use anyhow::{Context, Result, bail};
use clap::Subcommand;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::{
    env, fs,
    io::{ErrorKind, Write},
    path::Path,
    process::Command,
};

#[cfg(any(test, target_os = "macos"))]
const LABEL: &str = "dev.fleet.agent";

/// Name of the log file, in the `logs` directory of the state directory, that
/// the launchd service written by `service install` sends its output to.
pub const LOG_FILE: &str = "agent.log";
/// Longest the log grows before [`trim_log`] starts it again.
const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;

/// Who defines the background service of this user, by the definition files
/// found. The Homebrew formula's `brew services` and `fleet-agent service`
/// write different ones, under different names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Manager {
    /// Written by `fleet-agent service install`.
    FleetAgent,
    /// Written by `brew services`, with this launchd label or systemd unit.
    Homebrew(&'static str),
}

impl Manager {
    pub fn name(self) -> &'static str {
        match self {
            Self::FleetAgent => "fleet-agent",
            Self::Homebrew(_) => "homebrew",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::FleetAgent if cfg!(target_os = "macos") => "dev.fleet.agent",
            Self::FleetAgent => "fleet-agent.service",
            Self::Homebrew(label) => label,
        }
    }
}

/// Homebrew's current and legacy names for the `fleet-agent` service.
const HOMEBREW_LAUNCHD: [&str; 2] = ["sh.brew.fleet-agent", "homebrew.mxcl.fleet-agent"];
const HOMEBREW_SYSTEMD: [&str; 2] = [
    "sh.brew.fleet-agent.service",
    "homebrew.fleet-agent.service",
];

fn own_definition(home: &Path) -> std::path::PathBuf {
    if cfg!(target_os = "macos") {
        home.join("Library/LaunchAgents/dev.fleet.agent.plist")
    } else {
        home.join(".config/systemd/user/fleet-agent.service")
    }
}

fn homebrew_definitions(home: &Path) -> Vec<(&'static str, std::path::PathBuf)> {
    if cfg!(target_os = "macos") {
        HOMEBREW_LAUNCHD
            .map(|label| {
                (
                    label,
                    home.join(format!("Library/LaunchAgents/{label}.plist")),
                )
            })
            .into()
    } else {
        HOMEBREW_SYSTEMD
            .map(|unit| (unit, home.join(format!(".config/systemd/user/{unit}"))))
            .into()
    }
}

/// The service definitions installed for this user, `fleet-agent`'s own
/// first. Read-only: it only looks for the files.
pub fn installed(home: &Path) -> Vec<Manager> {
    let mut found = Vec::new();
    if own_definition(home).symlink_metadata().is_ok() {
        found.push(Manager::FleetAgent);
    }
    found.extend(
        homebrew_definitions(home)
            .into_iter()
            .find(|(_, path)| path.symlink_metadata().is_ok())
            .map(|(label, _)| Manager::Homebrew(label)),
    );
    found
}

/// Refuses actions that `fleet-agent service` cannot carry out correctly
/// because Homebrew manages the service: they would act on a service that is
/// not the one running (or start a second Agent next to it), and point to
/// `brew services` instead.
fn check_managers(action: ServiceCommand, installed: &[Manager]) -> Result<()> {
    let own = installed.contains(&Manager::FleetAgent);
    let homebrew = installed.iter().find_map(|manager| match manager {
        Manager::Homebrew(label) => Some(*label),
        Manager::FleetAgent => None,
    });
    let brew = match action {
        ServiceCommand::Install | ServiceCommand::Start => "start",
        ServiceCommand::Stop | ServiceCommand::Uninstall => "stop",
        ServiceCommand::Restart => "restart",
        ServiceCommand::Status => "info",
    };
    match (homebrew, own, action) {
        (Some(label), false, ServiceCommand::Install) => bail!(
            "the Agent is installed as the Homebrew service {label}; manage it with `brew services` \
             (for example `brew services restart fleet-agent`), or run `brew services stop fleet-agent` \
             before `fleet-agent service install` so that only one service runs the Agent"
        ),
        (Some(label), false, _) => bail!(
            "the Agent runs as the Homebrew service {label}, not as a fleet-agent service; \
             use `brew services {brew} fleet-agent`"
        ),
        (
            Some(label),
            true,
            ServiceCommand::Install | ServiceCommand::Start | ServiceCommand::Restart,
        ) => bail!(
            "both the Homebrew service {label} and the fleet-agent service are installed, and only one \
             Agent can run; remove one with `brew services stop fleet-agent` or `fleet-agent service uninstall`"
        ),
        (
            None,
            false,
            ServiceCommand::Start
            | ServiceCommand::Stop
            | ServiceCommand::Restart
            | ServiceCommand::Status,
        ) => {
            bail!("the fleet-agent service is not installed; run `fleet-agent service install`")
        }
        _ => Ok(()),
    }
}

/// Starts the service log again once it exceeds 10 MiB, keeping the previous
/// one as `agent.log.1`. launchd keeps the log open in append mode, so the
/// file is copied and truncated rather than renamed. Errors are ignored: the
/// log must never stop the Agent.
pub fn trim_log(state_dir: &Path) {
    let path = state_dir.join("logs").join(LOG_FILE);
    if fs::metadata(&path).is_ok_and(|metadata| metadata.len() > MAX_LOG_BYTES)
        && fs::copy(&path, path.with_extension("log.1")).is_ok()
        && let Ok(file) = fs::OpenOptions::new().write(true).open(&path)
    {
        let _ = file.set_len(0);
    }
}

#[derive(Clone, Copy, Debug, Subcommand)]
pub enum ServiceCommand {
    /// Install the service definition and enable startup. Not read-only.
    Install,
    /// Start the installed service. Not read-only.
    Start,
    /// Stop the installed service. Not read-only.
    Stop,
    /// Restart the installed service. Not read-only.
    Restart,
    /// Show service-manager status. Read-only and safe to run while the service runs.
    Status,
    /// Stop, disable, and remove the service definition. Not read-only.
    Uninstall,
}

pub fn run(action: ServiceCommand, state_dir: &Path) -> Result<()> {
    if !state_dir.is_absolute() {
        bail!("the service state directory must be an absolute path");
    }
    validate_path(state_dir, "state directory")?;
    let executable = env::current_exe()
        .context("resolve the fleet-agent executable")?
        .canonicalize()
        .context("resolve the fleet-agent executable path")?;
    let home = dirs::home_dir().context("cannot resolve the user's home directory")?;
    validate_path(&executable, "executable")?;
    check_managers(action, &installed(&home))?;
    #[cfg(target_os = "linux")]
    return linux(action, state_dir, &executable, &home);
    #[cfg(target_os = "macos")]
    return macos(action, state_dir, &executable, &home);
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    bail!("service management is supported only on Linux and macOS");
}

fn run_tool(program: &str, args: &[&str], tolerate_failure: bool) -> Result<()> {
    let status = Command::new(program)
        .args(args)
        .status()
        .with_context(|| format!("run {program}"))?;
    if !status.success() && !tolerate_failure {
        bail!("{program} exited with {status}");
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn tool_succeeds(program: &str, args: &[&str]) -> Result<bool> {
    Ok(Command::new(program)
        .args(args)
        .status()
        .with_context(|| format!("run {program}"))?
        .success())
}

fn write_definition(path: &Path, contents: &str) -> Result<()> {
    let parent = path.parent().context("service definition has no parent")?;
    fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    for attempt in 0..100 {
        let temporary = parent.join(format!(
            ".fleet-agent.{}.{}.tmp",
            std::process::id(),
            attempt
        ));
        let opened = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary);
        let mut file = match opened {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(error).with_context(|| format!("create {}", temporary.display()));
            }
        };
        file.write_all(contents.as_bytes())
            .with_context(|| format!("write {}", temporary.display()))?;
        file.sync_all()
            .with_context(|| format!("sync {}", temporary.display()))?;
        return fs::rename(&temporary, path).with_context(|| format!("install {}", path.display()));
    }
    bail!(
        "cannot allocate a temporary service definition in {}",
        parent.display()
    )
}

fn validate_path(path: &Path, description: &str) -> Result<()> {
    let text = path
        .to_str()
        .with_context(|| format!("{description} is not valid UTF-8"))?;
    if text.chars().any(char::is_control) {
        bail!("{description} contains a character that service definitions cannot represent");
    }
    Ok(())
}

fn remove_definition(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("remove {}", path.display())),
    }
}

#[cfg(target_os = "linux")]
fn linux(action: ServiceCommand, state_dir: &Path, executable: &Path, home: &Path) -> Result<()> {
    let path = home.join(".config/systemd/user/fleet-agent.service");
    let ctl = |args: &[&str], tolerate| run_tool("systemctl", args, tolerate);
    match action {
        ServiceCommand::Install => {
            write_definition(&path, &systemd_unit(executable, state_dir))?;
            ctl(&["--user", "daemon-reload"], false).context(
                "systemd user manager is unavailable; fleet-agent requires systemd --user on Linux",
            )?;
            ctl(&["--user", "enable", "fleet-agent.service"], false)?;
        }
        ServiceCommand::Start => ctl(&["--user", "start", "fleet-agent.service"], false)?,
        ServiceCommand::Stop => ctl(&["--user", "stop", "fleet-agent.service"], false)?,
        ServiceCommand::Restart => ctl(&["--user", "restart", "fleet-agent.service"], false)?,
        ServiceCommand::Status => ctl(&["--user", "status", "fleet-agent.service"], false)?,
        ServiceCommand::Uninstall => {
            if path.exists() {
                ctl(
                    &["--user", "disable", "--now", "fleet-agent.service"],
                    false,
                )?;
            }
            remove_definition(&path)?;
            ctl(&["--user", "daemon-reload"], false)?;
        }
    }
    Ok(())
}

#[cfg(any(test, target_os = "linux"))]
fn systemd_quote(path: &Path) -> String {
    let mut quoted = String::from("\"");
    for character in path.to_string_lossy().chars() {
        match character {
            '%' => quoted.push_str("%%"),
            '$' => quoted.push_str("$$"),
            '\\' => quoted.push_str("\\\\"),
            '"' => quoted.push_str("\\\""),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            '\t' => quoted.push_str("\\t"),
            value if value.is_control() => {
                for byte in value.to_string().bytes() {
                    quoted.push_str(&format!("\\x{byte:02x}"));
                }
            }
            value => quoted.push(value),
        }
    }
    quoted.push('"');
    quoted
}

#[cfg(any(test, target_os = "linux"))]
fn systemd_unit(executable: &Path, state_dir: &Path) -> String {
    format!(
        "[Unit]\nDescription=Fleet Manager Node Agent\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart={} --state-dir {} run\nRestart=on-failure\nRestartSec=15s\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\n\n[Install]\nWantedBy=default.target\n",
        systemd_quote(executable),
        systemd_quote(state_dir)
    )
}

#[cfg(target_os = "macos")]
fn macos(action: ServiceCommand, state_dir: &Path, executable: &Path, home: &Path) -> Result<()> {
    let path = home.join("Library/LaunchAgents/dev.fleet.agent.plist");
    let output = Command::new("id").arg("-u").output().context("run id -u")?;
    if !output.status.success() {
        bail!("id -u exited with {}", output.status);
    }
    let uid = String::from_utf8(output.stdout).context("id -u returned invalid text")?;
    let domain = format!("gui/{}", uid.trim());
    let target = format!("{domain}/{LABEL}");
    let path_text = path
        .to_str()
        .context("LaunchAgent path is not valid UTF-8")?;
    match action {
        ServiceCommand::Install => {
            if path.exists() {
                run_tool("launchctl", &["bootout", &target], true)?;
            }
            // launchd creates the log file but not its directory.
            let logs = state_dir.join("logs");
            fs::create_dir_all(&logs).with_context(|| format!("create {}", logs.display()))?;
            fs::set_permissions(&logs, std::os::unix::fs::PermissionsExt::from_mode(0o700))
                .with_context(|| format!("protect {}", logs.display()))?;
            write_definition(&path, &launchd_plist(executable, state_dir))?;
            run_tool("launchctl", &["bootstrap", &domain, path_text], false)?;
            println!(
                "Service logs: {}",
                state_dir.join("logs").join(LOG_FILE).display()
            );
        }
        ServiceCommand::Start => {
            // bootstrap handles a stopped service; kickstart handles one already loaded.
            run_tool("launchctl", &["bootstrap", &domain, path_text], true)?;
            run_tool("launchctl", &["kickstart", &target], false)?;
        }
        ServiceCommand::Stop => {
            if tool_succeeds("launchctl", &["print", &target])? {
                run_tool("launchctl", &["bootout", &target], false)?;
            }
        }
        ServiceCommand::Restart => {
            if path.exists() {
                run_tool("launchctl", &["bootout", &target], true)?;
            }
            run_tool("launchctl", &["bootstrap", &domain, path_text], false)?;
        }
        ServiceCommand::Status => run_tool("launchctl", &["print", &target], false)?,
        ServiceCommand::Uninstall => {
            if path.exists() && tool_succeeds("launchctl", &["print", &target])? {
                run_tool("launchctl", &["bootout", &target], false)?;
            }
            remove_definition(&path)?;
        }
    }
    Ok(())
}

#[cfg(any(test, target_os = "macos"))]
fn xml(path: &Path) -> String {
    path.to_string_lossy()
        .chars()
        .map(|c| match c {
            '&' => "&amp;".into(),
            '<' => "&lt;".into(),
            '>' => "&gt;".into(),
            '"' => "&quot;".into(),
            '\'' => "&apos;".into(),
            _ => c.to_string(),
        })
        .collect()
}

#[cfg(any(test, target_os = "macos"))]
fn launchd_plist(executable: &Path, state_dir: &Path) -> String {
    let log = xml(&state_dir.join("logs").join(LOG_FILE));
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n  <key>Label</key><string>{LABEL}</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>{}</string>\n    <string>--state-dir</string>\n    <string>{}</string>\n    <string>run</string>\n  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>ProcessType</key><string>Background</string>\n  <key>StandardOutPath</key><string>{log}</string>\n  <key>StandardErrorPath</key><string>{log}</string>\n</dict>\n</plist>\n",
        xml(executable),
        xml(state_dir)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn systemd_definition_quotes_paths_and_specifiers() {
        let unit = systemd_unit(
            Path::new("/opt/Fleet Agent/%agent/$bin"),
            Path::new("/tmp/a b/%state/$dir"),
        );
        assert!(unit.contains(
            "ExecStart=\"/opt/Fleet Agent/%%agent/$$bin\" --state-dir \"/tmp/a b/%%state/$$dir\" run"
        ));
        assert!(unit.contains("UMask=0077\nNoNewPrivileges=true\nPrivateTmp=true"));
    }
    #[test]
    fn launchd_definition_uses_argument_array_and_xml_escaping() {
        let plist = launchd_plist(
            Path::new("/Applications/Fleet & Agent"),
            Path::new("/tmp/<state>"),
        );
        assert!(plist.contains("<string>/Applications/Fleet &amp; Agent</string>"));
        assert!(plist.contains("<string>/tmp/&lt;state&gt;</string>"));
        assert!(plist.contains(
            "<key>StandardOutPath</key><string>/tmp/&lt;state&gt;/logs/agent.log</string>"
        ));
        assert!(plist.contains(
            "<key>StandardErrorPath</key><string>/tmp/&lt;state&gt;/logs/agent.log</string>"
        ));
    }

    #[test]
    fn homebrew_service_is_detected_and_never_driven_by_fleet_agent_service() {
        use ServiceCommand::*;
        let brew = Manager::Homebrew(HOMEBREW_LAUNCHD[0]);
        for action in [Install, Start, Stop, Restart, Status, Uninstall] {
            let error = check_managers(action, &[brew]).unwrap_err().to_string();
            assert!(error.contains(HOMEBREW_LAUNCHD[0]), "{error}");
            assert!(error.contains("brew services"), "{error}");
        }
        assert!(
            check_managers(Stop, &[brew])
                .unwrap_err()
                .to_string()
                .contains("brew services stop fleet-agent")
        );
        // Both installed: never start a second Agent, but the own service can go.
        for action in [Install, Start, Restart] {
            assert!(check_managers(action, &[Manager::FleetAgent, brew]).is_err());
        }
        for action in [Stop, Status, Uninstall] {
            assert!(check_managers(action, &[Manager::FleetAgent, brew]).is_ok());
        }
        // Nothing installed: only install and uninstall make sense.
        assert!(check_managers(Install, &[]).is_ok());
        assert!(check_managers(Uninstall, &[]).is_ok());
        for action in [Start, Stop, Restart, Status] {
            let error = check_managers(action, &[]).unwrap_err().to_string();
            assert!(error.contains("not installed"), "{error}");
        }
        for action in [Install, Start, Stop, Restart, Status, Uninstall] {
            assert!(check_managers(action, &[Manager::FleetAgent]).is_ok());
        }
    }

    #[test]
    fn installed_definitions_are_found_by_file() {
        let home = std::env::temp_dir().join(format!("fleet-service-{}", std::process::id()));
        let own = own_definition(&home);
        let (label, homebrew) = homebrew_definitions(&home).pop().unwrap();
        assert!(installed(&home).is_empty());
        fs::create_dir_all(homebrew.parent().unwrap()).unwrap();
        fs::write(&homebrew, "").unwrap();
        assert_eq!(installed(&home), [Manager::Homebrew(label)]);
        fs::create_dir_all(own.parent().unwrap()).unwrap();
        fs::write(&own, "").unwrap();
        assert_eq!(
            installed(&home),
            [Manager::FleetAgent, Manager::Homebrew(label)]
        );
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn oversized_log_starts_again_and_keeps_the_previous_one() {
        let state = std::env::temp_dir().join(format!("fleet-log-{}", std::process::id()));
        let logs = state.join("logs");
        fs::create_dir_all(&logs).unwrap();
        let log = logs.join(LOG_FILE);
        fs::write(&log, "small").unwrap();
        trim_log(&state);
        assert_eq!(fs::read(&log).unwrap(), b"small");
        fs::write(&log, vec![b'x'; MAX_LOG_BYTES as usize + 1]).unwrap();
        trim_log(&state);
        assert_eq!(fs::metadata(&log).unwrap().len(), 0);
        assert_eq!(
            fs::metadata(logs.join("agent.log.1")).unwrap().len(),
            MAX_LOG_BYTES + 1
        );
        fs::remove_dir_all(&state).unwrap();
        // A missing log is not an error.
        trim_log(&state);
    }

    #[test]
    fn service_paths_reject_control_characters() {
        assert!(validate_path(Path::new("/tmp/line\nbreak"), "state directory").is_err());
        assert!(validate_path(Path::new("/tmp/carriage\rreturn"), "state directory").is_err());
    }
}
