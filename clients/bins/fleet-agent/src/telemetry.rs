//! Agent and machine information for the dashboard.
//!
//! The report comes from cheap local sources only: the crate version,
//! `os-release` or `SystemVersion.plist` (bounded reads), `uname`,
//! `gethostname`, `getpwuid_r`, the executable path and two environment
//! variables. It never starts a process or walks a directory, and a field that
//! cannot be read is `null`.
//!
//! The reads run on a [`Worker`] thread, never on the Agent loop:
//! `getpwuid_r` can reach a directory service (NSS) that hangs, and a state
//! directory on a stuck mount makes any path lookup slow.

use std::{
    ffi::OsStr,
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::Instant,
};

use crate::{
    disk,
    protocol::{Api, TelemetryOs, TelemetryReport},
    worker::{DEFAULT_STUCK, DEFAULT_WAIT, Style, Worker},
};

/// Most a text file is read for: `os-release` and the macOS version plist are
/// about 1 KiB. A longer file is read up to this size and the cut-off last
/// line is ignored.
const MAX_FILE_BYTES: usize = 16 * 1024;

/// Longest string the Server accepts, in UTF-16 code units, except for
/// `stateDirectory`.
const MAX_TEXT_UNITS: usize = 128;
const MAX_PATH_UNITS: usize = 512;

/// `getpwuid_r` buffer: starts at 1 KiB and doubles on `ERANGE` up to this.
const MAX_PASSWD_BYTES: usize = 16 * 1024;

/// Longer than any host name (`HOST_NAME_MAX` is 64 on Linux, 255 on macOS).
const HOSTNAME_BYTES: usize = 256;

/// Starts and runs the thread that collects reports. It reads files and
/// calls `getpwuid_r`, so it gets a larger stack than the disk thread.
const STYLE: Style = Style {
    thread: "fleet-telemetry",
    what: "machine information",
    stack_bytes: 512 * 1024,
};

pub fn worker(state_directory: PathBuf, configured_home: PathBuf) -> Worker<TelemetryReport> {
    Worker::new(
        Box::new(move || {
            let homes = crate::state::home_prefixes(&configured_home);
            Some(collect(&state_directory, &homes))
        }),
        STYLE,
        DEFAULT_WAIT,
        DEFAULT_STUCK,
    )
}

/// When to report, kept in memory only. The 4-hour slots are the disk usage
/// schedule's, without Server requests.
#[derive(Debug, Default)]
pub struct Schedule {
    slots: disk::Schedule,
    /// The last report the Server accepted.
    sent: Option<TelemetryReport>,
}

impl Schedule {
    pub fn poll_succeeded(&mut self) {
        self.slots.poll_succeeded(false);
    }

    /// Due after the first successful poll, then at each slot, counted from the
    /// last attempt.
    pub fn is_due(&self, now: Instant) -> bool {
        self.slots.is_due(now)
    }

    /// Records an attempt, successful or not: a failure waits for the next slot.
    pub fn attempted(&mut self, now: Instant) {
        self.slots.attempted(now);
    }

    /// Whether `report` differs from what the Server last accepted.
    pub fn needs_sending(&self, report: &TelemetryReport) -> bool {
        self.sent.as_ref() != Some(report)
    }

    pub fn accepted(&mut self, report: TelemetryReport) {
        self.sent = Some(report);
    }
}

/// The values read from the machine, before they are cleaned.
#[derive(Debug, Default)]
struct Raw {
    os_name: Option<String>,
    os_version: Option<String>,
    kernel: Option<String>,
    arch: Option<String>,
    hostname: Option<String>,
    user: Option<String>,
    install_method: Option<&'static str>,
    service_manager: &'static str,
    state_directory: Option<String>,
}

/// Reads every source once. `homes` are the home directories to hide in the
/// state directory and to find `~/.cargo/bin`.
pub fn collect(state_directory: &Path, homes: &[PathBuf]) -> TelemetryReport {
    let (os_name, os_version) = if cfg!(target_os = "linux") {
        os_release()
    } else if cfg!(target_os = "macos") {
        macos_version(Path::new(MACOS_VERSION_PLIST))
    } else {
        (None, None)
    };
    assemble(Raw {
        os_name,
        os_version,
        kernel: kernel_release(),
        arch: Some(std::env::consts::ARCH.to_owned()),
        hostname: hostname(),
        // USER and LOGNAME may describe another account, so an unresolvable
        // effective user is reported as null.
        user: login_name(),
        install_method: std::env::current_exe().ok().map(|exe| {
            let resolved = fs::canonicalize(&exe).ok();
            install_method(&exe, resolved.as_deref(), homes, state_directory)
        }),
        service_manager: service_manager(
            std::env::var_os("INVOCATION_ID").as_deref(),
            std::env::var_os("XPC_SERVICE_NAME").as_deref(),
        ),
        state_directory: Some(tilde(state_directory, homes)),
    })
}

/// Cleans and caps every string to what the Server accepts.
fn assemble(raw: Raw) -> TelemetryReport {
    let text = |value: Option<String>| value.and_then(|v| clean(&v, MAX_TEXT_UNITS));
    TelemetryReport {
        agent_version: env!("CARGO_PKG_VERSION").to_owned(),
        os: TelemetryOs {
            name: text(raw.os_name),
            version: text(raw.os_version),
            kernel: text(raw.kernel),
        },
        arch: text(raw.arch),
        hostname: text(raw.hostname),
        user: text(raw.user),
        install_method: raw.install_method,
        service_manager: raw.service_manager,
        state_directory: raw.state_directory.and_then(|v| clean(&v, MAX_PATH_UNITS)),
    }
}

/// Removes control characters and surrounding whitespace, then cuts the text
/// to at most `max_units` UTF-16 code units (the strictest way to count
/// characters) on a character boundary. Empty text is `None`.
fn clean(raw: &str, max_units: usize) -> Option<String> {
    let mut units = 0;
    let mut text = String::new();
    for c in raw.chars().filter(|c| !c.is_control()) {
        units += c.len_utf16();
        if units > max_units {
            break;
        }
        text.push(c);
    }
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

// ---------------------------------------------------------------------------
// Operating system name and version.

const OS_RELEASE_FILES: [&str; 2] = ["/etc/os-release", "/usr/lib/os-release"];
const MACOS_VERSION_PLIST: &str = "/System/Library/CoreServices/SystemVersion.plist";

/// `NAME` and `VERSION_ID` from the first os-release file that has either.
fn os_release() -> (Option<String>, Option<String>) {
    for file in OS_RELEASE_FILES {
        let Some(text) = read_bounded(Path::new(file), MAX_FILE_BYTES) else {
            continue;
        };
        let found = parse_os_release(&text);
        if found.0.is_some() || found.1.is_some() {
            return found;
        }
    }
    (None, None)
}

fn macos_version(path: &Path) -> (Option<String>, Option<String>) {
    match read_bounded(path, MAX_FILE_BYTES) {
        Some(text) => (
            plist_string(&text, "ProductName"),
            plist_string(&text, "ProductVersion"),
        ),
        None => (None, None),
    }
}

/// Reads at most `limit` bytes as lossy UTF-8. If the file is longer, the last
/// line is dropped because it may be cut in the middle of a value.
fn read_bounded(path: &Path, limit: usize) -> Option<String> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > limit {
        bytes.truncate(limit);
        let end = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
        bytes.truncate(end);
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// `NAME` and `VERSION_ID` of an os-release file. The format is shell
/// variable assignments, one per line: `#` starts a comment line, a value may
/// be unquoted, `'single'` (literal) or `"double"` (where a backslash escapes
/// the next character). The last assignment of a name wins.
fn parse_os_release(text: &str) -> (Option<String>, Option<String>) {
    let (mut name, mut version) = (None, None);
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim_end() {
            "NAME" => name = Some(shell_value(value.trim_start())),
            "VERSION_ID" => version = Some(shell_value(value.trim_start())),
            _ => {}
        }
    }
    (name, version)
}

fn shell_value(value: &str) -> String {
    let mut out = String::new();
    let mut chars = value.chars();
    let mut quote: Option<char> = None;
    while let Some(c) = chars.next() {
        match (quote, c) {
            (None, '"' | '\'') => quote = Some(c),
            (Some(open), c) if c == open => quote = None,
            // Outside quotes a backslash escapes any character; inside double
            // quotes only the shell's special ones, otherwise it stays.
            (None, '\\') => out.extend(chars.next()),
            (Some('"'), '\\') => match chars.next() {
                Some(next @ ('"' | '\\' | '$' | '`')) => out.push(next),
                Some(next) => {
                    out.push('\\');
                    out.push(next);
                }
                None => out.push('\\'),
            },
            // An unquoted `#` after whitespace starts a trailing comment.
            (None, '#') if out.is_empty() || out.ends_with(char::is_whitespace) => break,
            (_, c) => out.push(c),
        }
    }
    out.trim().to_owned()
}

/// The `<string>` that follows `<key>name</key>` in an XML property list. This
/// is not a plist parser: it only serves the flat, Apple-written
/// `SystemVersion.plist`. Comments are ignored, CDATA is taken literally and
/// character references are decoded; no entities are resolved beyond the five
/// predefined ones. A binary plist or a missing key gives `None`.
fn plist_string(text: &str, key: &str) -> Option<String> {
    let text = strip_xml_comments(text);
    let marker = format!("<key>{key}</key>");
    let after = text[text.find(&marker)? + marker.len()..].trim_start();
    let after = after.strip_prefix("<string>")?;
    let body = &after[..after.find("</string>")?];
    if let Some(cdata) = body.strip_prefix("<![CDATA[") {
        return Some(cdata[..cdata.find("]]>")?].to_owned());
    }
    Some(xml_unescape(body))
}

/// The text without `<!-- ... -->` comments. An unterminated comment hides the
/// rest of the document.
fn strip_xml_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<!--") {
        out.push_str(&rest[..start]);
        match rest[start + 4..].find("-->") {
            Some(end) => rest = &rest[start + 4 + end + 3..],
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

/// Decodes the five predefined entities and numeric character references in
/// one pass, so `&amp;lt;` stays `&lt;`. Unknown or invalid references are
/// kept as written.
fn xml_unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        let decoded = rest.find(';').filter(|&end| end <= 12).and_then(|end| {
            let name = &rest[1..end];
            let c = match name {
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "amp" => Some('&'),
                _ => name
                    .strip_prefix("#x")
                    .or_else(|| name.strip_prefix("#X"))
                    .map(|hex| u32::from_str_radix(hex, 16))
                    .or_else(|| name.strip_prefix('#').map(str::parse::<u32>))
                    .and_then(Result::ok)
                    .and_then(char::from_u32),
            };
            c.map(|c| (c, end))
        });
        match decoded {
            Some((c, end)) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

// ---------------------------------------------------------------------------
// Install method, service manager and state directory.

/// `managed` when installed by `fleet-agent service install` in the state
/// directory, `homebrew` under a Homebrew prefix, `cargo` under
/// `~/.cargo/bin`, else `binary`. The path as the operating system reports it
/// and, when it could be resolved, its symlink-free form are both checked:
/// `/usr/local/bin` on an Intel Mac is a link into `/usr/local/Cellar`.
fn install_method(
    exe: &Path,
    resolved: Option<&Path>,
    homes: &[PathBuf],
    state_directory: &Path,
) -> &'static str {
    let paths = || [Some(exe), resolved].into_iter().flatten();
    if paths().any(|path| crate::managed::is_managed(path, state_directory)) {
        "managed"
    } else if paths().any(is_homebrew) {
        "homebrew"
    } else if paths().any(|path| {
        homes
            .iter()
            .any(|home| path.starts_with(home.join(".cargo/bin")))
    }) {
        "cargo"
    } else {
        "binary"
    }
}

fn is_homebrew(path: &Path) -> bool {
    ["/opt/homebrew", "/usr/local/Cellar", "/home/linuxbrew"]
        .iter()
        .any(|prefix| path.starts_with(prefix))
        || path
            .components()
            .any(|part| part.as_os_str() == ".linuxbrew")
}

/// `systemd` when `INVOCATION_ID` is set, `launchd` when `XPC_SERVICE_NAME` is
/// set and is not `0`, otherwise `none`.
fn service_manager(
    invocation_id: Option<&OsStr>,
    xpc_service_name: Option<&OsStr>,
) -> &'static str {
    if invocation_id.is_some() {
        "systemd"
    } else if xpc_service_name.is_some_and(|name| name.as_encoded_bytes() != b"0") {
        "launchd"
    } else {
        "none"
    }
}

/// The path with a leading home directory replaced by `~`. A home that is the
/// root would hide nothing useful and is ignored.
fn tilde(path: &Path, homes: &[PathBuf]) -> String {
    let mut best: Option<&Path> = None;
    for home in homes {
        if home.parent().is_some()
            && path.starts_with(home)
            && best.is_none_or(|b| home.as_os_str().len() > b.as_os_str().len())
        {
            best = Some(home);
        }
    }
    match best.and_then(|home| path.strip_prefix(home).ok()) {
        Some(rest) if rest.as_os_str().is_empty() => "~".to_owned(),
        Some(rest) => format!("~/{}", rest.to_string_lossy()),
        None => path.to_string_lossy().into_owned(),
    }
}

// ---------------------------------------------------------------------------
// System calls. Each is one bounded libc call; a failure gives `None`.

#[allow(clippy::unnecessary_cast)]
fn c_chars_to_string(chars: &[libc::c_char]) -> String {
    let bytes: Vec<u8> = chars
        .iter()
        .take_while(|c| **c != 0)
        // `c_char` is `i8` or `u8` depending on the target.
        .map(|c| *c as u8)
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

fn kernel_release() -> Option<String> {
    // SAFETY: a zeroed `utsname` is valid (arrays of integers), and `uname`
    // only writes inside it through a pointer that is valid for the call.
    let (code, info) = unsafe {
        let mut info: libc::utsname = std::mem::zeroed();
        (libc::uname(&mut info), info)
    };
    (code == 0).then(|| c_chars_to_string(&info.release))
}

fn hostname() -> Option<String> {
    let mut buffer = [0u8; HOSTNAME_BYTES];
    // SAFETY: the pointer and length describe `buffer`, which outlives the
    // call; `gethostname` writes at most that many bytes.
    let code = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };
    if code != 0 {
        return None;
    }
    // A truncated name is not NUL-terminated, so stop at the buffer's end too.
    let end = buffer.iter().position(|b| *b == 0).unwrap_or(buffer.len());
    Some(String::from_utf8_lossy(&buffer[..end]).into_owned())
}

/// The login name of the effective user from the password database.
fn login_name() -> Option<String> {
    let mut size = 1024;
    while size <= MAX_PASSWD_BYTES {
        let mut buffer = vec![0u8; size];
        // SAFETY: a zeroed `passwd` is valid (integers and null pointers).
        let mut entry: libc::passwd = unsafe { std::mem::zeroed() };
        let mut found: *mut libc::passwd = std::ptr::null_mut();
        // SAFETY: `entry`, `buffer` and `found` are valid for the call, and the
        // buffer length is passed as given. On success the strings in `entry`
        // point into `buffer`, which is alive until the end of this iteration.
        let code = unsafe {
            libc::getpwuid_r(
                libc::geteuid(),
                &mut entry,
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut found,
            )
        };
        if code == libc::ERANGE {
            size *= 2;
            continue;
        }
        if code != 0 || found.is_null() || entry.pw_name.is_null() {
            return None;
        }
        // SAFETY: `pw_name` is a NUL-terminated string inside `buffer`.
        let name = unsafe { std::ffi::CStr::from_ptr(entry.pw_name) };
        return Some(name.to_string_lossy().into_owned());
    }
    None
}

/// A machine information report being sent. It ends with the report if the
/// Server accepted it.
pub type Task = tokio::task::JoinHandle<Option<TelemetryReport>>;

/// One cycle's machine information work, shaped like [`disk::step`]. The
/// reads run on the worker thread and the report is a side task, with at most
/// one in flight. A report the Server did not accept is not remembered, so the
/// next slot (4 hours after this attempt) sends it again; one it accepted is
/// sent again only if the values change.
pub async fn step<F, Fut>(
    now: Instant,
    schedule: &mut Schedule,
    worker: &mut Worker<TelemetryReport>,
    in_flight: &mut Option<Task>,
    send: F,
) where
    F: FnOnce(TelemetryReport) -> Fut,
    Fut: std::future::Future<Output = bool> + Send + 'static,
{
    // The previous report finished: remember it if the Server accepted it.
    if let Some(task) = in_flight.take_if(|task| task.is_finished())
        && let Ok(Some(accepted)) = task.await
    {
        schedule.accepted(accepted);
    }
    let mut report = worker.collect(now);
    if report.is_none() && worker.is_idle() && schedule.is_due(now) {
        schedule.attempted(now);
        report = worker.measure(now).await;
    }
    let Some(report) = report else {
        return;
    };
    if !schedule.needs_sending(&report) {
        return;
    }
    if in_flight.is_some() {
        eprintln!("skipped a machine information report: the previous one is still being sent");
        return;
    }
    let sending = send(report.clone());
    *in_flight = Some(tokio::spawn(async move { sending.await.then_some(report) }));
}

/// True when the Server accepted the report. A 404 from an older Server and
/// every other failure is logged and left for the next slot.
pub async fn deliver(client: &Api, report: &TelemetryReport) -> bool {
    match client.telemetry(report).await {
        Ok(()) => true,
        Err(error) => {
            eprintln!("could not send machine information; will retry later: {error}");
            false
        }
    }
}

/// The example of the contract, for tests that need a report.
#[cfg(test)]
pub fn fixture() -> TelemetryReport {
    TelemetryReport {
        agent_version: "0.9.0".to_owned(),
        os: TelemetryOs {
            name: Some("Fedora Linux".to_owned()),
            version: Some("44".to_owned()),
            kernel: Some("7.2.11-200.fc44.x86_64".to_owned()),
        },
        arch: Some("x86_64".to_owned()),
        hostname: Some("studio-mini.home.arpa".to_owned()),
        user: Some("joan".to_owned()),
        install_method: Some("homebrew"),
        service_manager: "launchd",
        state_directory: Some("~/.local/state/fleet-agent".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::MockServer;
    use std::time::Duration;

    fn os_str(value: &str) -> Option<&OsStr> {
        Some(OsStr::new(value))
    }

    fn some(value: &str) -> Option<String> {
        Some(value.to_owned())
    }

    fn temp_file(name: &str, contents: &[u8]) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("fleet-telemetry-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join(name);
        fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn os_release_values_may_be_quoted_or_bare() {
        let text = "# comment\nNAME=\"Fedora Linux\"\nVERSION_ID=44\nID=fedora\n";
        assert_eq!(parse_os_release(text), (some("Fedora Linux"), some("44")));
        let text = "NAME='Arch Linux'\nVERSION_ID='2026.10'\n";
        assert_eq!(
            parse_os_release(text),
            (some("Arch Linux"), some("2026.10"))
        );
        let text = "  NAME = Debian GNU/Linux  \r\nVERSION_ID=\"12\"\r\n";
        assert_eq!(
            parse_os_release(text),
            (some("Debian GNU/Linux"), some("12"))
        );
    }

    #[test]
    fn os_release_escapes_comments_and_missing_keys() {
        // Escapes in double quotes; a backslash before an ordinary character stays.
        let text = r#"NAME="My \"Own\" \$OS \\ \n"
VERSION_ID=1\ 2"#;
        assert_eq!(
            parse_os_release(text),
            (some(r#"My "Own" $OS \ \n"#), some("1 2"))
        );
        // Commented-out assignments, similar names and trailing comments.
        let text = "#NAME=hidden\nPRETTY_NAME=\"Pretty\"\nNAME_X=1\nNAME=Plain # note\nVERSION_ID=\"1#2\"\n";
        assert_eq!(parse_os_release(text), (some("Plain"), some("1#2")));
        // Rolling releases have no VERSION_ID; the last assignment wins.
        assert_eq!(parse_os_release("NAME=a\nNAME=b\n"), (some("b"), None));
        assert_eq!(parse_os_release("garbage\n=\n"), (None, None));
        assert_eq!(parse_os_release(""), (None, None));
    }

    #[test]
    fn oversized_os_release_is_cut_without_using_a_partial_line() {
        let mut text = String::from("NAME=Early\n");
        text.push_str(&"# filler\n".repeat(MAX_FILE_BYTES / 9 - 2));
        // This line straddles the limit: its value would be cut.
        text.push_str("VERSION_ID=\"1234567890\"\n");
        text.push_str("ID=late\n");
        assert!(text.len() > MAX_FILE_BYTES);
        let path = temp_file("os-release", text.as_bytes());
        let read = read_bounded(&path, MAX_FILE_BYTES).unwrap();
        assert!(read.len() <= MAX_FILE_BYTES);
        assert!(read.ends_with('\n'));
        assert_eq!(parse_os_release(&read), (some("Early"), None));
        // A file exactly at the limit is read whole.
        let exact = "# x\n".repeat(MAX_FILE_BYTES / 4);
        let path = temp_file("exact", exact.as_bytes());
        assert_eq!(read_bounded(&path, MAX_FILE_BYTES).unwrap(), exact);
        // Missing and non-UTF-8 files.
        assert_eq!(read_bounded(Path::new("/nonexistent/os-release"), 16), None);
        let path = temp_file("binary", b"NAME=\xff\xfe\n");
        assert_eq!(
            parse_os_release(&read_bounded(&path, 64).unwrap()).0,
            some("\u{fffd}\u{fffd}")
        );
    }

    const PLIST: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>ProductBuildVersion</key>
	<string>24A335</string>
	<key>ProductName</key>
	<string>macOS</string>
	<key>ProductVersion</key>
	<string>15.0.1</string>
</dict>
</plist>
"#;

    #[test]
    fn macos_plist_values_are_extracted() {
        assert_eq!(plist_string(PLIST, "ProductName"), some("macOS"));
        assert_eq!(plist_string(PLIST, "ProductVersion"), some("15.0.1"));
        assert_eq!(plist_string(PLIST, "Missing"), None);
        assert_eq!(
            plist_string(
                "<key>ProductName</key><string>A &amp; B &lt;1&gt;</string>",
                "ProductName"
            ),
            some("A & B <1>")
        );
        // The key is present but is not followed by a closed string.
        assert_eq!(
            plist_string("<key>ProductName</key><integer>1</integer>", "ProductName"),
            None
        );
        assert_eq!(
            plist_string("<key>ProductName</key><string>open", "ProductName"),
            None
        );
        assert_eq!(plist_string("bplist00\u{1}", "ProductName"), None);
        // Comments between and around keys, CDATA and character references.
        assert_eq!(
            plist_string(
                "<!-- <key>ProductName</key><string>fake</string> -->\n<key>ProductName</key>\n<!-- c --><string>mac&#79;S &#x31;5</string>",
                "ProductName"
            ),
            some("macOS 15")
        );
        assert_eq!(
            plist_string(
                "<key>ProductVersion</key><string><![CDATA[15.1 <beta>]]></string>",
                "ProductVersion"
            ),
            some("15.1 <beta>")
        );
        assert_eq!(
            xml_unescape("&amp;lt; &bogus; &#xZZ; & &#9999999;"),
            "&lt; &bogus; &#xZZ; & &#9999999;"
        );
        assert_eq!(
            plist_string(
                "<!-- unterminated <key>ProductName</key><string>x</string>",
                "ProductName"
            ),
            None
        );
    }

    #[test]
    fn macos_plist_is_read_with_a_bound() {
        let path = temp_file("SystemVersion.plist", PLIST.as_bytes());
        assert_eq!(macos_version(&path), (some("macOS"), some("15.0.1")));
        assert_eq!(macos_version(Path::new("/nonexistent/plist")), (None, None));
        // Values beyond the limit are not read.
        let mut large = " ".repeat(MAX_FILE_BYTES);
        large.push_str(PLIST);
        let path = temp_file("large.plist", large.as_bytes());
        assert_eq!(macos_version(&path), (None, None));
    }

    fn homes() -> Vec<PathBuf> {
        vec![PathBuf::from("/home/joan")]
    }

    #[test]
    fn install_method_follows_the_executable_path() {
        let state = Path::new("/home/joan/.local/state/fleet-agent");
        let method = |exe: &str, resolved: Option<&str>| {
            install_method(Path::new(exe), resolved.map(Path::new), &homes(), state)
        };
        for homebrew in [
            "/opt/homebrew/bin/fleet-agent",
            "/opt/homebrew/Cellar/fleet-agent/0.9.0/bin/fleet-agent",
            "/usr/local/Cellar/fleet-agent/0.9.0/bin/fleet-agent",
            "/home/linuxbrew/.linuxbrew/bin/fleet-agent",
            "/home/joan/.linuxbrew/bin/fleet-agent",
        ] {
            assert_eq!(method(homebrew, None), "homebrew", "{homebrew}");
        }
        assert_eq!(method("/home/joan/.cargo/bin/fleet-agent", None), "cargo");
        for binary in [
            "/usr/local/bin/fleet-agent",
            "/usr/bin/fleet-agent",
            "/opt/homebrew-not/bin/fleet-agent",
            "/usr/local/Cellars/fleet-agent",
            "/home/joan/.cargo/binx/fleet-agent",
            "/home/joan/.cargo/fleet-agent",
            "/home/other/.cargo/bin/fleet-agent",
            "relative/fleet-agent",
        ] {
            assert_eq!(method(binary, None), "binary", "{binary}");
        }
        // A link in /usr/local/bin that resolves into the Cellar.
        assert_eq!(
            method(
                "/usr/local/bin/fleet-agent",
                Some("/usr/local/Cellar/fleet-agent/0.9.0/bin/fleet-agent")
            ),
            "homebrew"
        );
        // Homebrew wins over Cargo; no known home means no Cargo.
        assert_eq!(
            method(
                "/home/joan/.cargo/bin/fleet-agent",
                Some("/opt/homebrew/bin/x")
            ),
            "homebrew"
        );
        assert_eq!(
            install_method(
                Path::new("/home/joan/.cargo/bin/fleet-agent"),
                None,
                &[],
                state
            ),
            "binary"
        );
        // The service runs `current`, which resolves into the versions directory.
        assert_eq!(
            method(
                "/home/joan/.local/state/fleet-agent/current/fleet-agent",
                Some("/home/joan/.local/state/fleet-agent/versions/0.11.0/fleet-agent")
            ),
            "managed"
        );
        assert_eq!(
            method("/home/joan/.local/state/fleet-agent/fleet-agent", None),
            "binary"
        );
    }

    #[test]
    fn service_manager_comes_from_the_environment() {
        assert_eq!(service_manager(os_str("abc"), None), "systemd");
        assert_eq!(service_manager(os_str("abc"), os_str("com.x")), "systemd");
        assert_eq!(
            service_manager(None, os_str("com.example.fleet-agent")),
            "launchd"
        );
        assert_eq!(service_manager(None, os_str("0")), "none");
        assert_eq!(service_manager(None, None), "none");
    }

    #[test]
    fn the_state_directory_hides_the_home() {
        let homes = vec![PathBuf::from("/home/joan"), PathBuf::from("/Users/joan/")];
        let tilde = |path: &str| tilde(Path::new(path), &homes);
        assert_eq!(
            tilde("/home/joan/.local/state/fleet-agent"),
            "~/.local/state/fleet-agent"
        );
        assert_eq!(
            tilde("/Users/joan/Library/fleet-agent"),
            "~/Library/fleet-agent"
        );
        assert_eq!(tilde("/home/joan"), "~");
        assert_eq!(tilde("/home/joan/"), "~");
        // Whole path components only.
        assert_eq!(tilde("/home/joanna/state"), "/home/joanna/state");
        assert_eq!(tilde("/var/lib/fleet-agent"), "/var/lib/fleet-agent");
        // The longest home wins, and a root home is ignored.
        let nested = vec![PathBuf::from("/home"), PathBuf::from("/home/joan")];
        assert_eq!(super::tilde(Path::new("/home/joan/x"), &nested), "~/x");
        assert_eq!(super::tilde(Path::new("/x"), &[PathBuf::from("/")]), "/x");
    }

    #[test]
    fn text_is_cleaned_and_capped() {
        assert_eq!(
            clean("  Fedora\u{0}\n\tLinux\u{7f} ", 128),
            some("FedoraLinux")
        );
        assert_eq!(clean(" \n\t ", 128), None);
        assert_eq!(clean("", 128), None);
        assert_eq!(clean(&"a".repeat(300), 128).unwrap().len(), 128);
        // Counted in UTF-16 units, cut on a character boundary.
        let emoji = "\u{1F600}".repeat(100);
        let cut = clean(&emoji, 128).unwrap();
        assert_eq!(cut.chars().count(), 64);
        assert_eq!(cut.encode_utf16().count(), 128);
        assert_eq!(clean(&"é".repeat(200), 128).unwrap().chars().count(), 128);
    }

    #[test]
    fn assembling_applies_the_contract_limits() {
        let report = assemble(Raw {
            os_name: some(&format!("Bad\u{0}Name{}", "n".repeat(500))),
            os_version: some("  "),
            kernel: some("6.1\n"),
            arch: None,
            hostname: some(&"h".repeat(129)),
            user: some("jo\u{1b}an"),
            install_method: Some("binary"),
            service_manager: "none",
            state_directory: Some(format!("~/{}", "d".repeat(600))),
        });
        assert_eq!(report.os.name.as_deref().map(str::len), Some(128));
        assert!(report.os.name.unwrap().starts_with("BadName"));
        assert_eq!(report.os.version, None);
        assert_eq!(report.os.kernel, some("6.1"));
        assert_eq!(report.arch, None);
        assert_eq!(report.hostname.map(|h| h.len()), Some(128));
        assert_eq!(report.user, some("joan"));
        assert_eq!(report.state_directory.map(|d| d.len()), Some(512));
        assert_eq!(report.agent_version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn the_report_body_matches_the_contract_example() {
        assert_eq!(
            serde_json::to_value(fixture()).unwrap(),
            serde_json::json!({
                "agentVersion": "0.9.0",
                "os": { "name": "Fedora Linux", "version": "44", "kernel": "7.2.11-200.fc44.x86_64" },
                "arch": "x86_64",
                "hostname": "studio-mini.home.arpa",
                "user": "joan",
                "installMethod": "homebrew",
                "serviceManager": "launchd",
                "stateDirectory": "~/.local/state/fleet-agent"
            })
        );
    }

    #[test]
    fn unreadable_fields_are_explicit_nulls() {
        let report = assemble(Raw {
            service_manager: "none",
            ..Raw::default()
        });
        assert_eq!(
            serde_json::to_value(report).unwrap(),
            serde_json::json!({
                "agentVersion": env!("CARGO_PKG_VERSION"),
                "os": { "name": null, "version": null, "kernel": null },
                "arch": null,
                "hostname": null,
                "user": null,
                "installMethod": null,
                "serviceManager": "none",
                "stateDirectory": null
            })
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn collecting_here_gives_sane_values() {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/home/nobody"));
        let state = home.join(".local/state/fleet-agent");
        let report = collect(&state, std::slice::from_ref(&home));
        let version = &report.agent_version;
        assert!(
            version.split('.').count() >= 3 && version.chars().next().unwrap().is_ascii_digit(),
            "{version}"
        );
        assert_eq!(report.arch.as_deref(), Some(std::env::consts::ARCH));
        assert!(
            report
                .os
                .kernel
                .is_some_and(|k| k.chars().next().is_some_and(|c| c.is_ascii_digit()))
        );
        assert!(
            report
                .hostname
                .is_some_and(|h| !h.is_empty() && h.len() <= 128)
        );
        assert!(report.user.is_some_and(|u| !u.is_empty()));
        assert!(report.install_method.is_some());
        assert_eq!(
            report.state_directory.as_deref(),
            Some("~/.local/state/fleet-agent")
        );
        // Every string is clean.
        let json = serde_json::to_string(&collect(&state, &[home])).unwrap();
        assert!(!json.contains("\\u00"));
    }

    #[test]
    fn the_schedule_sends_after_the_first_poll_and_only_changes_at_slots() {
        let start = Instant::now();
        let slot = disk::REPORT_INTERVAL;
        let mut schedule = Schedule::default();
        assert!(!schedule.is_due(start), "no poll yet");

        schedule.poll_succeeded();
        assert!(schedule.is_due(start));
        schedule.attempted(start);
        assert!(!schedule.is_due(start + Duration::from_secs(60)));
        assert!(!schedule.is_due(start + slot - Duration::from_secs(1)));

        // Never accepted: the same values are sent again at the next slot.
        let report = fixture();
        assert!(schedule.needs_sending(&report));
        assert!(schedule.is_due(start + slot));
        schedule.attempted(start + slot);

        // Accepted: unchanged values are not sent, changed ones are.
        schedule.accepted(report.clone());
        assert!(!schedule.needs_sending(&report));
        let mut changed = report.clone();
        changed.agent_version = "0.9.1".to_owned();
        assert!(schedule.needs_sending(&changed));
        let mut renamed = report;
        renamed.hostname = some("other");
        assert!(schedule.needs_sending(&renamed));
        assert!(!schedule.is_due(start + slot + Duration::from_secs(1)));
        assert!(schedule.is_due(start + 2 * slot));
    }

    // One cycle's machine information work, as the Agent loop runs it.
    fn telemetry_worker(
        counter: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    ) -> Worker<TelemetryReport> {
        // The hostname follows the counter, so a test changes the values by
        // bumping it.
        Worker::new(
            Box::new(move || {
                let mut report = fixture();
                report.hostname = Some(format!(
                    "host-{}",
                    counter.load(std::sync::atomic::Ordering::SeqCst)
                ));
                Some(report)
            }),
            Style {
                thread: "fleet-telemetry-test",
                what: "machine information",
                stack_bytes: 512 * 1024,
            },
            Duration::from_secs(5),
            Duration::from_secs(60),
        )
    }

    async fn finish(task: &Option<Task>) {
        while task.as_ref().is_some_and(|task| !task.is_finished()) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    #[tokio::test]
    async fn machine_information_is_sent_after_the_first_poll_then_only_on_change() {
        use std::sync::{
            Arc, Mutex,
            atomic::{AtomicUsize, Ordering},
        };
        let slot = disk::REPORT_INTERVAL;
        let start = Instant::now();
        let counter = Arc::new(AtomicUsize::new(0));
        let accept = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let sent: Arc<Mutex<Vec<String>>> = Arc::default();
        let mut schedule = Schedule::default();
        let mut worker = telemetry_worker(counter.clone());
        let mut in_flight = None;
        let mut cycle =
            async |now: Instant, schedule: &mut Schedule, in_flight: &mut Option<Task>| {
                let (sent, accept) = (sent.clone(), accept.clone());
                step(now, schedule, &mut worker, in_flight, |report| async move {
                    sent.lock().unwrap().push(report.hostname.unwrap());
                    accept.load(Ordering::SeqCst)
                })
                .await;
                finish(in_flight).await;
            };

        // Not before the first successful poll.
        cycle(start, &mut schedule, &mut in_flight).await;
        assert!(sent.lock().unwrap().is_empty());

        // The first poll sends; polls in the next minutes do not.
        schedule.poll_succeeded();
        cycle(start, &mut schedule, &mut in_flight).await;
        cycle(
            start + Duration::from_secs(60),
            &mut schedule,
            &mut in_flight,
        )
        .await;
        assert_eq!(*sent.lock().unwrap(), ["host-0"]);

        // The next slot with unchanged values sends nothing.
        cycle(start + slot, &mut schedule, &mut in_flight).await;
        assert_eq!(sent.lock().unwrap().len(), 1);

        // Changed values go out at the following slot, not before.
        counter.store(1, Ordering::SeqCst);
        cycle(
            start + slot + Duration::from_secs(60),
            &mut schedule,
            &mut in_flight,
        )
        .await;
        assert_eq!(sent.lock().unwrap().len(), 1);
        accept.store(false, Ordering::SeqCst);
        cycle(start + 2 * slot, &mut schedule, &mut in_flight).await;
        assert_eq!(*sent.lock().unwrap(), ["host-0", "host-1"]);

        // The Server refused (404, 429, ...): not retried before the next slot,
        // then retried although the values did not change again.
        cycle(
            start + 2 * slot + Duration::from_secs(30 * 60),
            &mut schedule,
            &mut in_flight,
        )
        .await;
        assert_eq!(sent.lock().unwrap().len(), 2);
        accept.store(true, Ordering::SeqCst);
        cycle(start + 3 * slot, &mut schedule, &mut in_flight).await;
        assert_eq!(sent.lock().unwrap().len(), 3);
        cycle(start + 4 * slot, &mut schedule, &mut in_flight).await;
        assert_eq!(
            sent.lock().unwrap().len(),
            3,
            "accepted values are not resent"
        );
    }

    #[tokio::test]
    async fn machine_information_is_a_side_task_with_one_in_flight() {
        let start = Instant::now();
        let counter = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut schedule = Schedule::default();
        schedule.poll_succeeded();
        let mut worker = telemetry_worker(counter.clone());
        let mut in_flight = None;
        let slow = |_report: TelemetryReport| async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            true
        };
        let began = Instant::now();
        step(start, &mut schedule, &mut worker, &mut in_flight, slow).await;
        assert!(began.elapsed() < Duration::from_secs(2));
        assert!(in_flight.as_ref().is_some_and(|task| !task.is_finished()));

        // A slot arrives while the report is still being sent: dropped.
        counter.store(1, std::sync::atomic::Ordering::SeqCst);
        step(
            start + disk::REPORT_INTERVAL,
            &mut schedule,
            &mut worker,
            &mut in_flight,
            |_| async { panic!("one report at a time") },
        )
        .await;
        in_flight.take().unwrap().abort();
    }

    #[tokio::test]
    async fn machine_information_failures_are_not_remembered() {
        let server = MockServer::start(vec![(404, ""), (204, "")]);
        let client = Api::for_loopback_test(&server.url());
        let report = fixture();
        assert!(!deliver(&client, &report).await);
        assert!(deliver(&client, &report).await);
        let requests = server.requests();
        assert!(
            requests
                .iter()
                .all(|r| r.method == "PUT" && r.path == "/agent/v1/telemetry")
        );
    }
}
