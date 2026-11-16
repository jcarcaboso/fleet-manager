//! The [`Redactor`]: which locations a diagnostic sent to the Server may show.

use std::{
    fs,
    path::{Path, PathBuf},
};

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
