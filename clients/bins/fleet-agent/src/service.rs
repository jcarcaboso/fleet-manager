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

#[derive(Clone, Copy, Debug, Subcommand)]
pub enum ServiceCommand {
    /// Install the service definition and enable startup.
    Install,
    /// Start the installed service.
    Start,
    /// Stop the installed service.
    Stop,
    /// Restart the installed service.
    Restart,
    /// Show service-manager status.
    Status,
    /// Stop, disable, and remove the service definition.
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
            write_definition(&path, &launchd_plist(executable, state_dir))?;
            run_tool("launchctl", &["bootstrap", &domain, path_text], false)?;
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
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n  <key>Label</key><string>{LABEL}</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>{}</string>\n    <string>--state-dir</string>\n    <string>{}</string>\n    <string>run</string>\n  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>ProcessType</key><string>Background</string>\n</dict>\n</plist>\n",
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
    }

    #[test]
    fn service_paths_reject_control_characters() {
        assert!(validate_path(Path::new("/tmp/line\nbreak"), "state directory").is_err());
        assert!(validate_path(Path::new("/tmp/carriage\rreturn"), "state directory").is_err());
    }
}
