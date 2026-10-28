//! Failure detail for Attempts.
//!
//! After an Attempt fails, the Agent reports its stable error code as before.
//! Once the Server has accepted that failed report, the Agent also sends a
//! bounded description of the failure on a separate route. The description is
//! kept in its own state file, `pending-detail.json`, and never in the run
//! state: the run state rejects unknown fields, so an older Agent must still be
//! able to read it after a downgrade.
//!
//! Sending detail is best effort. It never delays or blocks the report, and no
//! failure here is fatal to a cycle.

use crate::{
    actions::ActionError,
    protocol::{Api, AttemptDetail, ProtocolError},
    state,
};
use anyhow::Result;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use time::OffsetDateTime;
use uuid::Uuid;

/// State file holding the newest detail that has not been delivered yet.
pub const PENDING_FILE: &str = "pending-detail.json";

/// Longest `diagnostic`, in UTF-16 code units as the Server counts them.
const MAX_DIAGNOSTIC_UNITS: usize = 2048;
/// Longest `path`, in UTF-16 code units.
const MAX_PATH_UNITS: usize = 512;
/// Pending detail older than this is dropped instead of retried.
const MAX_AGE_SECONDS: i64 = 24 * 60 * 60;
/// Upper bound for one delivery so that a slow Server cannot hold up the loop.
const SEND_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_PENDING_BYTES: u64 = 16 * 1024;

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingDetail {
    pub attempt_id: Uuid,
    /// Creation time as Unix seconds.
    pub created_at: i64,
    pub detail: AttemptDetail,
}

impl PendingDetail {
    fn is_valid(&self) -> bool {
        let detail = &self.detail;
        let units = detail.diagnostic.encode_utf16().count();
        (1..=MAX_DIAGNOSTIC_UNITS).contains(&units)
            && detail.path.as_deref().is_none_or(|path| {
                path.encode_utf16().count() <= MAX_PATH_UNITS
                    && fleet_reconcile::report_path(Path::new(path)).as_deref() == Some(path)
            })
    }
}

/// What happened to the pending detail during one delivery attempt.
#[derive(Debug, PartialEq, Eq)]
pub enum Delivery {
    /// The failed report for this Attempt has not been accepted yet.
    Waiting,
    Sent,
    /// Removed without sending, with the reason.
    Dropped(&'static str),
    /// Kept for a later cycle.
    Retry,
}

/// Home directory prefixes to hide from diagnostics: the installation home and,
/// when it differs, the account's real home directory.
pub fn home_prefixes(configured: &Path) -> Vec<PathBuf> {
    let mut homes = vec![configured.to_owned()];
    if let Some(home) = dirs::home_dir()
        && home != configured
    {
        homes.push(home);
    }
    homes
}

pub fn now() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

/// Builds the detail to send for a failed Action.
pub fn build(error: &ActionError, redactor: &Redactor) -> AttemptDetail {
    let mut diagnostic = sanitize_diagnostic(&error.diagnostic_chain(), redactor);
    if diagnostic.is_empty() {
        // The Server requires at least one character.
        diagnostic = error.code().to_owned();
    }
    AttemptDetail {
        diagnostic,
        path: error
            .path()
            .filter(|path| path.encode_utf16().count() <= MAX_PATH_UNITS)
            .map(str::to_owned),
        step: error.step(),
    }
}

/// Prepares error text for the Server: removes control characters other than
/// newline and tab, hides locations (see [`Redactor`]), and truncates to at
/// most 2048 UTF-16 code units on a character boundary, ending in `…` when
/// text was cut. Truncation comes last, so it measures the redacted text.
pub fn sanitize_diagnostic(raw: &str, redactor: &Redactor) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .collect();
    truncate_utf16(&redactor.redact(&cleaned), MAX_DIAGNOSTIC_UNITS)
}

/// Hides where things live on the machine. The diagnostic may contain only
/// these locations:
///
/// 1. The home directory becomes `~` and the Agent state directory becomes
///    `<state-dir>`, where the text names exactly that directory or something
///    below it. Aliases are included: the configured and the account home, the
///    state directory as given, made absolute, and canonicalized (macOS
///    `/var` is really `/private/var`). They are computed once, in
///    [`Redactor::new`]; the longest prefix wins.
/// 2. Every other absolute path (`/x/y`, `\\server\share`, `C:\x`) becomes
///    `<path>/<last component>`, or `<path>` when the last component is not
///    safe to show (`.` or `..`).
///
/// Both rules apply only to a whole path token. A token starts at the
/// beginning of the text or after whitespace, a quote (`"`, `'`, `` ` ``),
/// `(`, `[`, `{`, `<`, `=`, `,` or `;`, or after a `:` (as in `PATH=/a:/b`,
/// but not in `https://`). A home or state directory matches only when the
/// next character is the end of the text, a separator (`/`, `\`), whitespace,
/// a quote, one of `) ] } > , ; ! ?`, a `:` followed by whitespace or the end
/// of the text, or a `.` that is not followed by a name character. So
/// `/private/Users/joan/x` is not under `/Users/joan` and `/home/joan+backup/x`
/// is not under `/home/joan`; both fall to rule 2. A path token ends at
/// whitespace, a quote, one of `) ] } > , ;` or a `:` followed by whitespace or
/// the end; trailing `. ! ?` are not part of it. A path containing spaces is
/// cut at the first space.
#[derive(Debug, Default)]
pub struct Redactor {
    /// Longest first, so a state directory inside the home wins.
    prefixes: Vec<(String, &'static str)>,
}

impl Redactor {
    pub fn new(homes: &[PathBuf], state_dir: &Path) -> Self {
        let mut prefixes: Vec<(String, &'static str)> = Vec::new();
        let roots = homes
            .iter()
            .map(|home| (home.as_path(), "~"))
            .chain([(state_dir, "<state-dir>")]);
        for (root, replacement) in roots {
            for alias in aliases(root) {
                if !prefixes.iter().any(|(known, _)| *known == alias) {
                    prefixes.push((alias, replacement));
                }
            }
        }
        prefixes.sort_by_key(|(prefix, _)| std::cmp::Reverse(prefix.len()));
        Self { prefixes }
    }

    pub fn redact(&self, text: &str) -> String {
        let mut result = String::with_capacity(text.len());
        let mut previous: Option<char> = None;
        let mut index = 0;
        while index < text.len() {
            let rest = &text[index..];
            let Some(c) = rest.chars().next() else { break };
            if starts_token(previous, rest) {
                if let Some((length, replacement)) = self.match_root(rest) {
                    result.push_str(replacement);
                    previous = rest[..length].chars().next_back();
                    index += length;
                    continue;
                }
                if let Some(length) = absolute_path_length(rest) {
                    result.push_str(&hide_path(&rest[..length]));
                    previous = rest[..length].chars().next_back();
                    index += length;
                    continue;
                }
            }
            result.push(c);
            previous = Some(c);
            index += c.len_utf8();
        }
        result
    }

    fn match_root(&self, rest: &str) -> Option<(usize, &'static str)> {
        self.prefixes.iter().find_map(|(prefix, replacement)| {
            let after = rest.strip_prefix(prefix.as_str())?;
            ends_root(after).then_some((prefix.len(), *replacement))
        })
    }
}

/// The spellings of an absolute `root` to hide: as given, made absolute and
/// canonical. Relative roots are ignored, since they could match anything.
fn aliases(root: &Path) -> Vec<String> {
    let mut found = Vec::new();
    let candidates = [
        Some(root.to_owned()),
        std::path::absolute(root).ok(),
        fs::canonicalize(root).ok(),
    ];
    for candidate in candidates.into_iter().flatten() {
        let Some(text) = candidate.to_str() else {
            continue;
        };
        let text = text.trim_end_matches(['/', '\\']);
        if candidate.is_absolute() && !text.is_empty() && !found.iter().any(|f| f == text) {
            found.push(text.to_owned());
        }
    }
    found
}

fn is_name_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '-')
}

/// Whether a path token starts here. `previous` is the character before `rest`.
fn starts_token(previous: Option<char>, rest: &str) -> bool {
    match previous {
        None => true,
        Some(c) if c.is_whitespace() => true,
        Some('"' | '\'' | '`' | '(' | '[' | '{' | '<' | '=' | ',' | ';') => true,
        // A list separator, but not the colon of `https://`.
        Some(':') => !rest.starts_with("//"),
        Some(_) => false,
    }
}

/// Whether a home or state directory that is followed by `after` ends there.
fn ends_root(after: &str) -> bool {
    let mut chars = after.chars();
    match chars.next() {
        None => true,
        Some(c) if c.is_whitespace() => true,
        Some('/' | '\\' | '"' | '\'' | '`' | ')' | ']' | '}' | '>' | ',' | ';' | '!' | '?') => true,
        Some(':') => chars.next().is_none_or(char::is_whitespace),
        // A dot ends a sentence unless a name continues after it.
        Some('.') => !chars.next().is_some_and(is_name_char),
        Some(_) => false,
    }
}

/// The length of the absolute path token at the start of `rest`, if there is one.
fn absolute_path_length(rest: &str) -> Option<usize> {
    let bytes = rest.as_bytes();
    let rooted = rest.starts_with('/')
        || rest.starts_with("\\\\")
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'/' | b'\\'));
    if !rooted {
        return None;
    }
    let mut end = rest.len();
    let mut chars = rest.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        let stops = c.is_whitespace()
            || matches!(c, '"' | '\'' | '`' | ')' | ']' | '}' | '>' | ',' | ';')
            || (c == ':' && chars.peek().is_none_or(|(_, next)| next.is_whitespace()));
        if stops {
            end = at;
            break;
        }
    }
    // Sentence punctuation after the path is not part of it, but `..` is.
    let token = &rest[..end];
    let last = token.rsplit(['/', '\\']).next().unwrap_or_default();
    if !last.is_empty() && last.chars().all(|c| c == '.') {
        return Some(end);
    }
    Some(token.trim_end_matches(['.', '!', '?']).len())
}

/// Replaces an absolute path by `<path>/<last component>`.
fn hide_path(path: &str) -> String {
    let trailing = path.len() - path.trim_end_matches(['/', '\\']).len();
    let name = path[..path.len() - trailing]
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default();
    // A drive such as `C:` is not a name.
    let name = if name.len() == 2 && name.ends_with(':') {
        ""
    } else {
        name
    };
    match name {
        "" if trailing > 0 && path.chars().all(|c| matches!(c, '/' | '\\')) => path.to_owned(),
        "" | "." | ".." => "<path>".to_owned(),
        name => format!("<path>/{name}"),
    }
}

fn truncate_utf16(text: &str, limit: usize) -> String {
    if text.encode_utf16().count() <= limit {
        return text.to_owned();
    }
    // The ellipsis is one UTF-16 code unit and must fit inside the limit.
    let budget = limit - 1;
    let mut units = 0;
    let mut result = String::new();
    for c in text.chars() {
        units += c.len_utf16();
        if units > budget {
            break;
        }
        result.push(c);
    }
    result.push('…');
    result
}

/// Stores `detail` as the only pending detail, replacing any older one.
pub fn save(
    directory: &Path,
    attempt_id: Uuid,
    detail: &AttemptDetail,
    created_at: i64,
) -> Result<()> {
    let pending = PendingDetail {
        attempt_id,
        created_at,
        detail: detail.clone(),
    };
    state::write_json(&directory.join(PENDING_FILE), &pending)
}

/// Reads the pending detail. A missing file is `None`; a corrupt, oversized,
/// unsafe or otherwise unreadable one is discarded, never an error.
pub fn load(directory: &Path) -> Option<PendingDetail> {
    let path = directory.join(PENDING_FILE);
    if let Err(error) = fs::symlink_metadata(&path)
        && error.kind() == std::io::ErrorKind::NotFound
    {
        return None;
    }
    match read(&path) {
        Some(pending) => Some(pending),
        None => {
            eprintln!("discarding unreadable {PENDING_FILE}");
            // A directory or link cannot be replaced atomically; try both removals.
            if fs::remove_file(&path).is_err() {
                let _ = fs::remove_dir_all(&path);
            }
            None
        }
    }
}

/// Whether a readable pending detail exists. It never changes the state
/// directory, so `status` can use it.
pub fn is_pending(directory: &Path) -> bool {
    read(&directory.join(PENDING_FILE)).is_some()
}

fn read(path: &Path) -> Option<PendingDetail> {
    let bytes = state::read_bytes(path, MAX_PENDING_BYTES).ok()?;
    let pending: PendingDetail = serde_json::from_slice(&bytes).ok()?;
    pending.is_valid().then_some(pending)
}

fn clear(directory: &Path) {
    if let Err(error) = fs::remove_file(directory.join(PENDING_FILE))
        && error.kind() != std::io::ErrorKind::NotFound
    {
        eprintln!("could not remove {PENDING_FILE}: {error}");
    }
}

/// Whether a failed send means the detail can never be accepted. Any 4xx but
/// 408 and 429 is final; a 404 also covers Servers that predate detail.
fn is_final_rejection(error: &ProtocolError) -> bool {
    matches!(
        error,
        ProtocolError::Http(status)
            if status.is_client_error()
                && *status != StatusCode::REQUEST_TIMEOUT
                && *status != StatusCode::TOO_MANY_REQUESTS
    ) || matches!(error, ProtocolError::RequestTooLarge { .. })
}

/// Decides, without any network access, whether `pending` should not be sent
/// now. Expiry is checked first: detail 24 hours old (or dated that far in the
/// future, after a clock change) is removed even while the failed report for
/// its Attempt is still unacknowledged, so it cannot outlive its limit when the
/// Server never accepts that report. Detail for the unacknowledged Attempt
/// otherwise waits. `None` means it can be sent.
pub fn precheck(
    directory: &Path,
    pending: &PendingDetail,
    unacknowledged: Option<Uuid>,
    now: i64,
) -> Option<Delivery> {
    let age = now.saturating_sub(pending.created_at);
    if !(-MAX_AGE_SECONDS..MAX_AGE_SECONDS).contains(&age) {
        clear(directory);
        return Some(Delivery::Dropped("expired"));
    }
    (unacknowledged == Some(pending.attempt_id)).then_some(Delivery::Waiting)
}

/// Sends `pending` once and keeps or removes the state file as the policy
/// says. `unacknowledged` is the Attempt of a terminal report the Server has
/// not accepted yet; detail for that Attempt waits unless it has expired (see [`precheck`]). The Server's response body
/// is ignored.
pub async fn deliver(
    client: &Api,
    directory: &Path,
    pending: &PendingDetail,
    unacknowledged: Option<Uuid>,
    now: i64,
) -> Delivery {
    if let Some(outcome) = precheck(directory, pending, unacknowledged, now) {
        return outcome;
    }
    let sent = tokio::time::timeout(
        SEND_TIMEOUT,
        client.attempt_detail(pending.attempt_id, &pending.detail),
    )
    .await;
    match sent {
        Ok(Ok(())) => {
            clear(directory);
            Delivery::Sent
        }
        Ok(Err(error)) if is_final_rejection(&error) => {
            clear(directory);
            Delivery::Dropped("rejected by the Server")
        }
        Ok(Err(_)) | Err(_) => Delivery::Retry,
    }
}

/// A loopback HTTP server for tests: records requests and answers with scripted
/// responses (the last one repeats).
#[cfg(test)]
pub mod testing {
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::{SocketAddr, TcpListener, TcpStream},
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, Ordering},
        },
        thread::JoinHandle,
    };

    #[derive(Clone, Debug)]
    pub struct Request {
        pub method: String,
        pub path: String,
        /// Lower-case header names with trimmed values.
        pub headers: Vec<(String, String)>,
        pub body: String,
    }

    impl Request {
        pub fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.as_str())
        }
    }

    pub struct MockServer {
        address: SocketAddr,
        requests: Arc<Mutex<Vec<Request>>>,
        stop: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
    }

    /// A response the route server sends for `method` and `path`.
    pub type Route = (&'static str, String, u16, Vec<u8>);

    impl MockServer {
        pub fn start(responses: Vec<(u16, &'static str)>) -> Self {
            let mut served = 0;
            Self::serve(move |_| {
                let (status, body) = responses[served.min(responses.len() - 1)];
                served += 1;
                (status, body.as_bytes().to_vec())
            })
        }

        /// Answers each request from the first route with its method and path,
        /// and every other request with 404.
        pub fn routes(routes: Vec<Route>) -> Self {
            Self::serve(move |request| {
                routes
                    .iter()
                    .find(|(method, path, _, _)| *method == request.method && *path == request.path)
                    .map_or((404, Vec::new()), |(_, _, status, body)| {
                        (*status, body.clone())
                    })
            })
        }

        fn serve(mut respond: impl FnMut(&Request) -> (u16, Vec<u8>) + Send + 'static) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let stop = Arc::new(AtomicBool::new(false));
            let thread = {
                let (requests, stop) = (requests.clone(), stop.clone());
                std::thread::spawn(move || {
                    for stream in listener.incoming() {
                        if stop.load(Ordering::SeqCst) {
                            break;
                        }
                        let Ok(stream) = stream else { continue };
                        let Some(request) = read_request(&stream) else {
                            continue;
                        };
                        let (status, body) = respond(&request);
                        requests.lock().unwrap().push(request);
                        let mut stream = stream;
                        let _ = write!(
                            stream,
                            "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = stream.write_all(&body);
                    }
                })
            };
            Self {
                address,
                requests,
                stop,
                thread: Some(thread),
            }
        }

        pub fn url(&self) -> String {
            format!("http://{}/", self.address)
        }

        pub fn requests(&self) -> Vec<Request> {
            self.requests.lock().unwrap().clone()
        }
    }

    impl Drop for MockServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            let _ = TcpStream::connect(self.address);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    fn read_request(stream: &TcpStream) -> Option<Request> {
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).ok()?;
        let mut parts = line.split_whitespace();
        let (method, path) = (parts.next()?.to_owned(), parts.next()?.to_owned());
        let mut length = 0;
        let mut headers = Vec::new();
        loop {
            line.clear();
            reader.read_line(&mut line).ok()?;
            if line == "\r\n" || line.is_empty() {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                let name = name.to_ascii_lowercase();
                if name == "content-length" {
                    length = value.trim().parse().ok()?;
                }
                headers.push((name, value.trim().to_owned()));
            }
        }
        let mut body = vec![0; length];
        reader.read_exact(&mut body).ok()?;
        Some(Request {
            method,
            path,
            headers,
            body: String::from_utf8_lossy(&body).into_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{testing::MockServer, *};
    use crate::actions::Step;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .canonicalize()
                .unwrap()
                .join(format!("fleet-detail-{}", Uuid::new_v4()));
            state::private_directory(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn detail(diagnostic: &str) -> AttemptDetail {
        AttemptDetail {
            diagnostic: diagnostic.to_owned(),
            path: Some(".claude/settings.json".to_owned()),
            step: Some(Step::Lock),
        }
    }

    fn units(text: &str) -> usize {
        text.encode_utf16().count()
    }

    fn redactor(homes: &[&str], state_dir: &str) -> Redactor {
        let homes: Vec<PathBuf> = homes.iter().map(PathBuf::from).collect();
        Redactor::new(&homes, Path::new(state_dir))
    }

    fn homes() -> Redactor {
        redactor(&["/home/joan"], "/var/lib/fleet-agent")
    }

    fn sanitize(raw: &str, redactor: &Redactor) -> String {
        sanitize_diagnostic(raw, redactor)
    }

    #[test]
    fn sanitizing_removes_control_characters_except_newline_and_tab() {
        let raw = "a\u{0}b\u{7}c\nd\te\u{1b}[31m red\r\u{85}\u{7f}end";
        assert_eq!(
            sanitize_diagnostic(raw, &Redactor::default()),
            "abc\nd\te[31m redend"
        );
    }

    #[test]
    fn sanitizing_replaces_the_home_directory_on_path_boundaries() {
        let homes = redactor(&["/home/joan/", "/Users/joan"], "/state");
        assert_eq!(
            sanitize_diagnostic(
                "cannot open /home/joan/.codex/config.toml and /Users/joan/x: denied",
                &homes
            ),
            "cannot open ~/.codex/config.toml and ~/x: denied"
        );
        assert_eq!(sanitize_diagnostic("at /home/joan", &homes), "at ~");
        assert_eq!(sanitize_diagnostic("see /home/joan.", &homes), "see ~.");
        assert_eq!(sanitize_diagnostic("(/home/joan)", &homes), "(~)");
        for other in [
            "/home/joanna/x",
            "/home/joan.bak/x",
            "/home/joan-2/x",
            "/home/joan_2",
        ] {
            // Not the home, but still an absolute path.
            let name = other.rsplit('/').next().unwrap();
            assert_eq!(sanitize_diagnostic(other, &homes), format!("<path>/{name}"));
        }
        // A root home would rewrite every path, so it is ignored.
        assert_eq!(
            sanitize_diagnostic("/etc/x", &redactor(&["/"], "")),
            "<path>/x"
        );
    }

    #[test]
    fn sanitizing_truncates_to_the_utf16_limit_on_a_character_boundary() {
        let exact = "a".repeat(2048);
        assert_eq!(sanitize_diagnostic(&exact, &Redactor::default()), exact);

        let long = sanitize_diagnostic(&"a".repeat(2049), &Redactor::default());
        assert_eq!(units(&long), 2048);
        assert_eq!(long, format!("{}…", "a".repeat(2047)));

        // Two-byte characters.
        let accents = sanitize_diagnostic(&"é".repeat(3000), &Redactor::default());
        assert_eq!(units(&accents), 2048);
        assert!(accents.ends_with('…'));

        // Surrogate pairs count twice and are never split.
        let emoji = sanitize_diagnostic(&"😀".repeat(2000), &Redactor::default());
        assert!(units(&emoji) <= 2048);
        let kept = emoji.strip_suffix('…').unwrap();
        assert_eq!(kept, "😀".repeat(kept.chars().count()));
        assert_eq!(kept.chars().count(), 1023);

        // Text whose last character straddles the limit.
        let straddle = format!("{}😀tail", "a".repeat(2046));
        let cut = sanitize_diagnostic(&straddle, &Redactor::default());
        assert_eq!(cut, format!("{}…", "a".repeat(2046)));
        assert!(units(&cut) <= 2048);
    }

    #[test]
    fn the_state_directory_is_replaced_like_the_home() {
        let r = redactor(&["/home/joan"], "/tmp/run/external-state");
        assert_eq!(
            sanitize(
                "Io: private path component is not a real directory: /tmp/run/external-state/targets",
                &r
            ),
            "Io: private path component is not a real directory: <state-dir>/targets"
        );
        assert_eq!(
            sanitize("in /tmp/run/external-state.", &r),
            "in <state-dir>."
        );
        assert_eq!(
            sanitize(
                "'/tmp/run/external-state/a' and (/tmp/run/external-state)",
                &r
            ),
            "'<state-dir>/a' and (<state-dir>)"
        );
        // A sibling is not the state directory.
        assert_eq!(
            sanitize("/tmp/run/external-state2/targets", &r),
            "<path>/targets"
        );
        // A state directory inside the home is hidden as the state directory.
        let nested = redactor(&["/home/joan"], "/home/joan/.local/state/fleet-agent");
        assert_eq!(
            sanitize(
                "/home/joan/.local/state/fleet-agent/x and /home/joan/y",
                &nested
            ),
            "<state-dir>/x and ~/y"
        );
    }

    #[test]
    fn other_absolute_paths_keep_only_their_last_component() {
        let r = homes();
        let cases = [
            (
                "cannot open /etc/passwd: denied",
                "cannot open <path>/passwd: denied",
            ),
            ("cannot open /etc/passwd", "cannot open <path>/passwd"),
            ("x=\"/opt/tool/bin/run\" failed", "x=\"<path>/run\" failed"),
            ("(/srv/data/)", "(<path>/data)"),
            ("see /var/log/x.log.", "see <path>/x.log."),
            ("PATH=/usr/bin:/bin: nope", "PATH=<path>/bin: nope"),
            ("at /a/b/../..", "at <path>"),
            ("at /..", "at <path>"),
            (
                "share \\\\server\\share\\file.txt ok",
                "share <path>/file.txt ok",
            ),
            ("drive C:\\Users\\bob\\x.txt ok", "drive <path>/x.txt ok"),
            ("drive D:/data/y ok", "drive <path>/y ok"),
            (
                "line one\n/tmp/secret/token.json\n",
                "line one\n<path>/token.json\n",
            ),
            ("/home/joan/ok /tmp/no", "~/ok <path>/no"),
        ];
        for (raw, expected) in cases {
            assert_eq!(sanitize(raw, &r), expected, "{raw}");
        }
        // Not paths: relative paths, urls, fractions, a lone slash.
        for plain in [
            "a/b/c",
            "https://example.com/x/y",
            "read/write",
            "1/2",
            "a / b",
            "~/x",
            "./x ../y",
            "key:value",
        ] {
            assert_eq!(sanitize(plain, &r), plain);
        }
    }

    #[test]
    fn home_matches_respect_path_component_boundaries() {
        let r = redactor(&["/Users/joan", "/home/joan"], "/state");
        assert_eq!(
            sanitize("/private/Users/joan/x", &r),
            "<path>/x",
            "a longer root must not be cut in the middle"
        );
        assert_eq!(sanitize("/home/joan+backup/x", &r), "<path>/x");
        assert_eq!(
            sanitize("/home/joan2/x /statement/y", &r),
            "<path>/x <path>/y"
        );
        assert_eq!(sanitize("x/home/joan/y", &r), "x/home/joan/y");
        // Starts and ends that do count as boundaries.
        for (raw, expected) in [
            ("/home/joan", "~"),
            ("/home/joan/", "~/"),
            ("a=/home/joan/x", "a=~/x"),
            ("[/home/joan]", "[~]"),
            ("\"/home/joan\"", "\"~\""),
            ("'/home/joan/x'", "'~/x'"),
            ("`/home/joan`", "`~`"),
            ("f: /home/joan: denied", "f: ~: denied"),
            ("/home/joan:", "~:"),
            ("/home/joan, /Users/joan; ok", "~, ~; ok"),
            ("/home/joan.", "~."),
            ("/home/joan?", "~?"),
            ("/home/joan\tx", "~\tx"),
        ] {
            assert_eq!(sanitize(raw, &r), expected, "{raw}");
        }
        // A colon, dot or plus inside a name continues it.
        assert_eq!(sanitize("/home/joan:x/y", &r), "<path>/y");
        assert_eq!(sanitize("/home/joan.d/y", &r), "<path>/y");
    }

    #[test]
    fn canonical_aliases_of_the_home_and_state_directory_are_hidden() {
        let base = TestDir::new();
        let real_home = base.0.join("real-home");
        let real_state = base.0.join("real-state");
        fs::create_dir_all(real_home.join(".claude")).unwrap();
        fs::create_dir_all(real_state.join("targets")).unwrap();
        let home_link = base.0.join("home-link");
        let state_link = base.0.join("state-link");
        std::os::unix::fs::symlink(&real_home, &home_link).unwrap();
        std::os::unix::fs::symlink(&real_state, &state_link).unwrap();

        let r = Redactor::new(std::slice::from_ref(&home_link), &state_link);
        let text = format!(
            "{}/x {}/.claude {}/targets {}/targets",
            home_link.display(),
            real_home.display(),
            real_state.display(),
            state_link.display()
        );
        assert_eq!(
            sanitize(&text, &r),
            "~/x ~/.claude <state-dir>/targets <state-dir>/targets"
        );
        // A relative root is never used as a prefix.
        let relative = Redactor::new(&[PathBuf::from("home")], Path::new("state"));
        assert_eq!(sanitize("home/state", &relative), "home/state");
    }

    #[test]
    fn truncation_measures_the_redacted_text() {
        let r = redactor(&["/home/joan"], "/tmp/some/long/external-state-directory");
        // Each repeat shrinks from 58 bytes to 12 once redacted.
        let raw = "/tmp/some/long/external-state-directory/targets ".repeat(100);
        let text = sanitize(&raw, &r);
        assert_eq!(units(&text), units(&"<state-dir>/targets ".repeat(100)));
        assert!(!text.contains("/tmp"));
        assert!(!text.ends_with('…'));

        // Redaction cannot hide an overlong text from the limit.
        let long = format!("{} {}", "/etc/a/b", "😀".repeat(2000));
        let cut = sanitize(&long, &r);
        assert!(units(&cut) <= 2048);
        assert!(cut.starts_with("<path>/b 😀"));
        assert!(cut.ends_with('…'));
        assert!(!cut.contains("/etc"));
    }

    #[test]
    fn home_is_replaced_before_the_length_limit_applies() {
        let long_home = format!("/home/{}", "h".repeat(100));
        let raw = format!("{long_home}/{}", "x".repeat(2040));
        let text = sanitize_diagnostic(&raw, &redactor(&[&long_home], ""));
        assert_eq!(units(&text), 2042);
        assert!(text.starts_with("~/x"));
    }

    #[test]
    fn built_detail_joins_the_error_chain_and_never_comes_out_empty() {
        let error = crate::actions::ActionError::test_error(
            "lock_failed",
            anyhow::anyhow!("root /home/joan/x")
                .context("middle")
                .context("top"),
        );
        let built = build(&error, &homes());
        assert_eq!(built.diagnostic, "top: middle: root ~/x");
        assert_eq!(built.path, None);
        assert_eq!(built.step, None);

        let blank = crate::actions::ActionError::test_error("io", anyhow::anyhow!("\u{1}\u{2}"));
        assert_eq!(build(&blank, &Redactor::default()).diagnostic, "io");
    }

    #[test]
    fn pending_detail_round_trips_and_keeps_only_the_newest() {
        let dir = TestDir::new();
        assert!(load(&dir.0).is_none());
        assert!(!is_pending(&dir.0));
        let (first, second) = (Uuid::new_v4(), Uuid::new_v4());
        save(&dir.0, first, &detail("one"), 100).unwrap();
        save(&dir.0, second, &detail("two"), 200).unwrap();

        assert!(is_pending(&dir.0));
        let pending = load(&dir.0).unwrap();
        assert_eq!(pending.attempt_id, second);
        assert_eq!(pending.created_at, 200);
        assert_eq!(pending.detail, detail("two"));

        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(dir.0.join(PENDING_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        let written: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.0.join(PENDING_FILE)).unwrap()).unwrap();
        assert_eq!(written["attemptId"], second.to_string());
        assert_eq!(written["detail"]["step"], "lock");
    }

    #[test]
    fn corrupt_unreadable_or_invalid_pending_detail_is_discarded() {
        let dir = TestDir::new();
        let file = dir.0.join(PENDING_FILE);
        let valid = serde_json::json!({
            "attemptId": Uuid::new_v4(), "createdAt": 1,
            "detail": {"diagnostic": "x", "path": "a/b", "step": "lock"}
        });
        let bad: Vec<Vec<u8>> = vec![
            b"{broken".to_vec(),
            Vec::new(),
            vec![0xff, 0xfe],
            vec![b' '; 20 * 1024],
            serde_json::to_vec(&serde_json::json!({"attemptId": "nope"})).unwrap(),
            serde_json::to_vec(&{
                let mut value = valid.clone();
                value["extra"] = true.into();
                value
            })
            .unwrap(),
            serde_json::to_vec(&{
                let mut value = valid.clone();
                value["detail"]["step"] = "teleport".into();
                value
            })
            .unwrap(),
            serde_json::to_vec(&{
                let mut value = valid.clone();
                value["detail"]["diagnostic"] = "".into();
                value
            })
            .unwrap(),
            serde_json::to_vec(&{
                let mut value = valid.clone();
                value["detail"]["path"] = "../escape".into();
                value
            })
            .unwrap(),
            serde_json::to_vec(&{
                let mut value = valid.clone();
                value["detail"]["diagnostic"] = "x".repeat(3000).into();
                value
            })
            .unwrap(),
        ];
        for bytes in bad {
            fs::write(&file, &bytes).unwrap();
            // Checking never touches the file; loading discards it.
            assert!(!is_pending(&dir.0));
            assert!(file.exists());
            assert!(load(&dir.0).is_none());
            assert!(!file.exists());
        }
        fs::write(&file, serde_json::to_vec(&valid).unwrap()).unwrap();
        assert!(load(&dir.0).is_some());
    }

    #[test]
    fn a_directory_or_link_in_place_of_the_file_is_discarded() {
        let dir = TestDir::new();
        let file = dir.0.join(PENDING_FILE);
        fs::create_dir(&file).unwrap();
        assert!(load(&dir.0).is_none());
        assert!(!file.exists());
        std::os::unix::fs::symlink("/etc/hostname", &file).unwrap();
        assert!(load(&dir.0).is_none());
        assert!(!file.exists());
        // A new detail can always be saved afterwards.
        save(&dir.0, Uuid::new_v4(), &detail("again"), 1).unwrap();
        assert!(load(&dir.0).is_some());
    }

    fn sample(created_at: i64) -> PendingDetail {
        PendingDetail {
            attempt_id: Uuid::new_v4(),
            created_at,
            detail: detail("lock is held"),
        }
    }

    #[tokio::test]
    async fn delivery_posts_the_detail_and_ignores_the_response_body() {
        for (status, body) in [(204, ""), (200, "not json at all"), (200, "{\"bad\":")] {
            let dir = TestDir::new();
            let server = MockServer::start(vec![(status, body)]);
            let client = Api::for_loopback_test(&server.url());
            let pending = sample(1_000);
            save(
                &dir.0,
                pending.attempt_id,
                &pending.detail,
                pending.created_at,
            )
            .unwrap();

            let outcome = deliver(&client, &dir.0, &pending, None, 1_001).await;

            assert_eq!(outcome, Delivery::Sent, "status {status}");
            assert!(!dir.0.join(PENDING_FILE).exists());
            let requests = server.requests();
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].method, "POST");
            assert_eq!(
                requests[0].path,
                format!("/agent/v1/attempts/{}/detail", pending.attempt_id)
            );
            let body: serde_json::Value = serde_json::from_str(&requests[0].body).unwrap();
            assert_eq!(
                body,
                serde_json::json!({
                    "diagnostic": "lock is held",
                    "path": ".claude/settings.json",
                    "step": "lock"
                })
            );
        }
    }

    #[tokio::test]
    async fn optional_fields_are_omitted_from_the_request() {
        let server = MockServer::start(vec![(204, "")]);
        let client = Api::for_loopback_test(&server.url());
        let only = AttemptDetail {
            diagnostic: "boom".to_owned(),
            path: None,
            step: None,
        };
        client.attempt_detail(Uuid::nil(), &only).await.unwrap();
        assert_eq!(server.requests()[0].body, r#"{"diagnostic":"boom"}"#);
    }

    #[tokio::test]
    async fn client_errors_other_than_timeout_and_rate_limit_drop_the_detail() {
        for status in [400, 401, 403, 404, 409, 410, 422, 451] {
            let dir = TestDir::new();
            let server = MockServer::start(vec![(status, r#"{"code":"attempt_not_found"}"#)]);
            let client = Api::for_loopback_test(&server.url());
            let pending = sample(10);
            save(&dir.0, pending.attempt_id, &pending.detail, 10).unwrap();

            let outcome = deliver(&client, &dir.0, &pending, None, 11).await;

            assert!(matches!(outcome, Delivery::Dropped(_)), "status {status}");
            assert!(!dir.0.join(PENDING_FILE).exists(), "status {status}");
        }
    }

    #[tokio::test]
    async fn timeouts_rate_limits_and_server_errors_keep_the_detail() {
        for status in [408, 429, 500, 502, 503, 504] {
            let dir = TestDir::new();
            let server = MockServer::start(vec![(status, "")]);
            let client = Api::for_loopback_test(&server.url());
            let pending = sample(10);
            save(&dir.0, pending.attempt_id, &pending.detail, 10).unwrap();

            let outcome = deliver(&client, &dir.0, &pending, None, 11).await;

            assert_eq!(outcome, Delivery::Retry, "status {status}");
            assert_eq!(load(&dir.0).unwrap(), pending, "status {status}");
        }
    }

    #[tokio::test]
    async fn an_unreachable_server_keeps_the_detail_and_a_later_cycle_sends_it() {
        let dir = TestDir::new();
        let pending = sample(10);
        save(&dir.0, pending.attempt_id, &pending.detail, 10).unwrap();
        let closed = {
            let server = MockServer::start(vec![(204, "")]);
            server.url()
        };
        let offline = Api::for_loopback_test(&closed);
        assert_eq!(
            deliver(&offline, &dir.0, &pending, None, 11).await,
            Delivery::Retry
        );
        assert!(dir.0.join(PENDING_FILE).exists());

        let server = MockServer::start(vec![(204, "")]);
        let online = Api::for_loopback_test(&server.url());
        let again = load(&dir.0).unwrap();
        assert_eq!(
            deliver(&online, &dir.0, &again, None, 12).await,
            Delivery::Sent
        );
        assert!(!dir.0.join(PENDING_FILE).exists());
    }

    #[tokio::test]
    async fn detail_expires_after_twenty_four_hours_without_a_request() {
        let day = 24 * 60 * 60;
        let server = MockServer::start(vec![(204, "")]);
        let client = Api::for_loopback_test(&server.url());
        for age in [day, day + 1, 30 * day] {
            let dir = TestDir::new();
            let pending = sample(1_000_000);
            save(
                &dir.0,
                pending.attempt_id,
                &pending.detail,
                pending.created_at,
            )
            .unwrap();
            let outcome = deliver(&client, &dir.0, &pending, None, 1_000_000 + age).await;
            assert_eq!(outcome, Delivery::Dropped("expired"), "age {age}");
            assert!(!dir.0.join(PENDING_FILE).exists());
        }
        // A creation time far in the future (clock changes) is not kept forever.
        let dir = TestDir::new();
        let pending = sample(1_000_000 + 2 * day);
        save(
            &dir.0,
            pending.attempt_id,
            &pending.detail,
            pending.created_at,
        )
        .unwrap();
        assert_eq!(
            deliver(&client, &dir.0, &pending, None, 1_000_000).await,
            Delivery::Dropped("expired")
        );
        assert!(server.requests().is_empty());

        // One second younger than the limit is still sent.
        let dir = TestDir::new();
        let pending = sample(1_000_000);
        save(
            &dir.0,
            pending.attempt_id,
            &pending.detail,
            pending.created_at,
        )
        .unwrap();
        let outcome = deliver(&client, &dir.0, &pending, None, 1_000_000 + day - 1).await;
        assert_eq!(outcome, Delivery::Sent);
    }

    #[tokio::test]
    async fn an_oversized_request_is_never_sent_and_is_dropped() {
        let dir = TestDir::new();
        let server = MockServer::start(vec![(204, "")]);
        let client = Api::for_loopback_test(&server.url());
        let huge = AttemptDetail {
            diagnostic: "x".repeat(32 * 1024),
            path: None,
            step: None,
        };
        assert!(matches!(
            client.attempt_detail(Uuid::nil(), &huge).await,
            Err(ProtocolError::RequestTooLarge { .. })
        ));
        let pending = PendingDetail {
            attempt_id: Uuid::nil(),
            created_at: 1,
            detail: huge,
        };
        std::fs::write(dir.0.join(PENDING_FILE), "{}").unwrap();
        assert!(matches!(
            deliver(&client, &dir.0, &pending, None, 2).await,
            Delivery::Dropped(_)
        ));
        assert!(server.requests().is_empty());
    }

    #[tokio::test]
    async fn detail_expires_even_while_its_failed_report_is_not_accepted() {
        let day = 24 * 60 * 60;
        let server = MockServer::start(vec![(204, "")]);
        let client = Api::for_loopback_test(&server.url());
        for (now, expected) in [
            (1_000_000 + day - 1, Delivery::Waiting),
            (1_000_000 + day, Delivery::Dropped("expired")),
            (1_000_000 + 30 * day, Delivery::Dropped("expired")),
            // Dated far in the future, as after a clock change.
            (1_000_000 - day - 1, Delivery::Dropped("expired")),
        ] {
            let dir = TestDir::new();
            let pending = sample(1_000_000);
            save(&dir.0, pending.attempt_id, &pending.detail, 1_000_000).unwrap();
            let held = Some(pending.attempt_id);

            assert_eq!(precheck(&dir.0, &pending, held, now), Some(expected));
            let outcome = deliver(&client, &dir.0, &pending, held, now).await;
            let expired = matches!(outcome, Delivery::Dropped(_));
            assert_eq!(dir.0.join(PENDING_FILE).exists(), !expired, "now {now}");
        }
        assert!(server.requests().is_empty());

        // Nothing holds it back: it can be sent.
        let dir = TestDir::new();
        let pending = sample(5);
        assert_eq!(precheck(&dir.0, &pending, None, 6), None);
    }

    #[tokio::test]
    async fn detail_waits_while_its_failed_report_is_not_accepted() {
        let dir = TestDir::new();
        let server = MockServer::start(vec![(204, "")]);
        let client = Api::for_loopback_test(&server.url());
        let pending = sample(10);
        save(&dir.0, pending.attempt_id, &pending.detail, 10).unwrap();

        let outcome = deliver(&client, &dir.0, &pending, Some(pending.attempt_id), 11).await;

        assert_eq!(outcome, Delivery::Waiting);
        assert!(server.requests().is_empty());
        assert!(dir.0.join(PENDING_FILE).exists());

        // An unrelated unacknowledged report does not hold it back.
        let other = Some(Uuid::new_v4());
        assert_eq!(
            deliver(&client, &dir.0, &pending, other, 11).await,
            Delivery::Sent
        );
    }
}
