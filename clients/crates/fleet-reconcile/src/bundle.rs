//! Validation of Assignments and parsing of `fleet.bundle/v1` Bundles, before
//! anything on disk is touched.

use crate::{
    Assignment, DesiredSkill, ErrorCode, MAX_ASSIGNMENT_BYTES, MAX_BUNDLE_BYTES, MAX_FILE_BYTES,
    ReconcileError, Result, hex_sha256,
};
use std::collections::BTreeSet;
use unicode_normalization::UnicodeNormalization;

pub(crate) const MAGIC: &[u8; 6] = b"FLTB1\0";
pub(crate) const SCHEMA: &str = "fleet.bundle/v1";
pub(crate) const MAX_FILES: usize = 10_000;
const MAX_PATH: usize = 1_024;
pub(crate) const MAX_DEPTH: usize = 16;

#[derive(Clone)]
pub(crate) struct ParsedSkill {
    pub(crate) name: String,
    pub(crate) digest: String,
    pub(crate) files: Vec<BundleFile>,
}
#[derive(Clone)]
pub(crate) struct BundleFile {
    pub(crate) path: String,
    pub(crate) executable: bool,
    pub(crate) bytes: Vec<u8>,
}

pub(crate) fn validate_assignment(a: &Assignment) -> Result<Vec<ParsedSkill>> {
    let mut names = BTreeSet::new();
    let mut aliases = BTreeSet::new();
    let mut out = Vec::new();
    let mut total = 0u64;
    for skill in &a.skills {
        let parsed = validate_skill(skill, &mut names, &mut aliases, &mut total)
            .map_err(|error| error.nested_in(&skill.name))?;
        out.push(parsed);
    }
    Ok(out)
}

fn validate_skill(
    skill: &DesiredSkill,
    names: &mut BTreeSet<String>,
    aliases: &mut BTreeSet<String>,
    total: &mut u64,
) -> Result<ParsedSkill> {
    validate_skill_name(&skill.name)?;
    if !names.insert(skill.name.clone()) {
        return Err(ReconcileError::new(
            ErrorCode::DuplicateSkill,
            "duplicate Skill name",
        ));
    }
    let alias = skill
        .name
        .nfc()
        .flat_map(char::to_lowercase)
        .collect::<String>();
    if !aliases.insert(alias) {
        return Err(ReconcileError::new(
            ErrorCode::DuplicateSkill,
            "Skill names collide by case or Unicode normalization",
        ));
    }
    if skill.schema != SCHEMA {
        return Err(ReconcileError::new(
            ErrorCode::UnsupportedSchema,
            format!("unsupported schema for {}", skill.name),
        ));
    }
    if skill.size != skill.bundle.len() as u64 {
        return Err(ReconcileError::new(
            ErrorCode::BundleSizeMismatch,
            format!("size mismatch for {}", skill.name),
        ));
    }
    *total = total.checked_add(skill.size).ok_or_else(|| {
        ReconcileError::new(
            ErrorCode::BundleLimitExceeded,
            "assignment Bundle size overflow",
        )
    })?;
    if *total > MAX_ASSIGNMENT_BYTES {
        return Err(ReconcileError::new(
            ErrorCode::BundleLimitExceeded,
            "assignment Bundles exceed 256 MiB",
        ));
    }
    if skill.bundle.len() > MAX_BUNDLE_BYTES {
        return Err(ReconcileError::new(
            ErrorCode::BundleLimitExceeded,
            "encoded Bundle exceeds 16 MiB",
        ));
    }
    parse_digest(&skill.digest)?;
    let actual = format!("sha256:{}", hex_sha256(&skill.bundle));
    if actual != skill.digest {
        return Err(ReconcileError::new(
            ErrorCode::BundleDigestMismatch,
            format!("digest mismatch for {}", skill.name),
        ));
    }
    let files = parse_bundle(&skill.bundle)?;
    Ok(ParsedSkill {
        name: skill.name.clone(),
        digest: skill.digest.clone(),
        files,
    })
}

fn parse_bundle(bytes: &[u8]) -> Result<Vec<BundleFile>> {
    let mut p = Parser { bytes, at: 0 };
    if p.take(6)? != MAGIC {
        return Err(ReconcileError::new(
            ErrorCode::MalformedBundle,
            "invalid Bundle magic",
        ));
    }
    let count = p.u32()? as usize;
    if count > MAX_FILES {
        return Err(ReconcileError::new(
            ErrorCode::BundleLimitExceeded,
            "too many files",
        ));
    }
    let mut files = Vec::with_capacity(count);
    let mut prior: Option<Vec<u8>> = None;
    let mut aliases = BTreeSet::new();
    let mut total = 0u64;
    for _ in 0..count {
        let len = p.u32()? as usize;
        if len == 0 || len > MAX_PATH {
            return Err(ReconcileError::new(
                ErrorCode::InvalidBundlePath,
                "invalid path length",
            ));
        }
        let raw = p.take(len)?.to_vec();
        if prior.as_ref().is_some_and(|x| x >= &raw) {
            return Err(ReconcileError::new(
                ErrorCode::MalformedBundle,
                "Bundle paths are not strictly sorted",
            ));
        }
        prior = Some(raw.clone());
        let path = String::from_utf8(raw)
            .map_err(|_| ReconcileError::new(ErrorCode::InvalidBundlePath, "path is not UTF-8"))?;
        validate_bundle_path(&path)?;
        let alias = path.nfc().flat_map(char::to_lowercase).collect::<String>();
        if aliases.contains(&alias)
            || aliases.iter().any(|other: &String| {
                alias.starts_with(&format!("{other}/")) || other.starts_with(&format!("{alias}/"))
            })
        {
            return Err(ReconcileError::new(
                ErrorCode::BundlePathCollision,
                "Bundle paths collide or use a file as a directory",
            )
            .at_entry(&path));
        }
        aliases.insert(alias);
        let executable = match p.u8()? {
            0 => false,
            1 => true,
            _ => {
                return Err(ReconcileError::new(
                    ErrorCode::MalformedBundle,
                    "invalid executable flag",
                )
                .at_entry(&path));
            }
        };
        let size = p.u64()?;
        if size > MAX_FILE_BYTES as u64 {
            return Err(
                ReconcileError::new(ErrorCode::BundleLimitExceeded, "file exceeds 16 MiB")
                    .at_entry(&path),
            );
        }
        total = total.checked_add(size).ok_or_else(|| {
            ReconcileError::new(ErrorCode::BundleLimitExceeded, "content size overflow")
        })?;
        if total > MAX_ASSIGNMENT_BYTES {
            return Err(ReconcileError::new(
                ErrorCode::BundleLimitExceeded,
                "uncompressed content exceeds limit",
            ));
        }
        let size = usize::try_from(size).map_err(|_| {
            ReconcileError::new(
                ErrorCode::BundleLimitExceeded,
                "file does not fit this platform",
            )
        })?;
        files.push(BundleFile {
            path,
            executable,
            bytes: p.take(size)?.to_vec(),
        });
    }
    if p.at != bytes.len() {
        return Err(ReconcileError::new(
            ErrorCode::MalformedBundle,
            "trailing Bundle bytes",
        ));
    }
    if !files.iter().any(|entry| entry.path == "SKILL.md") {
        return Err(ReconcileError::new(
            ErrorCode::MalformedBundle,
            "Bundle does not contain root SKILL.md",
        ));
    }
    Ok(files)
}

struct Parser<'a> {
    bytes: &'a [u8],
    at: usize,
}
impl<'a> Parser<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self
            .at
            .checked_add(n)
            .ok_or_else(|| ReconcileError::new(ErrorCode::MalformedBundle, "length overflow"))?;
        let value = self
            .bytes
            .get(self.at..end)
            .ok_or_else(|| ReconcileError::new(ErrorCode::MalformedBundle, "truncated Bundle"))?;
        self.at = end;
        Ok(value)
    }
    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }
}

pub(crate) fn validate_skill_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 255
        || !name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        || name.starts_with('-')
        || name.ends_with('-')
    {
        return Err(ReconcileError::new(
            ErrorCode::InvalidSkillName,
            format!("invalid Skill name {name:?}"),
        ));
    }
    Ok(())
}

pub(crate) fn parse_digest(d: &str) -> Result<()> {
    if d.len() != 71
        || !d.starts_with("sha256:")
        || !d[7..]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        Err(ReconcileError::new(
            ErrorCode::InvalidDigest,
            "digest must be lowercase sha256 hex",
        ))
    } else {
        Ok(())
    }
}
pub(crate) fn validate_bundle_path(path: &str) -> Result<()> {
    if path.as_bytes().contains(&b'\\')
        || path.starts_with('/')
        || path != path.nfc().collect::<String>()
        || path.split('/').count() > MAX_DEPTH
        || path
            .split('/')
            .any(|s| s.is_empty() || s == "." || s == ".." || s.as_bytes().contains(&0))
    {
        Err(ReconcileError::new(
            ErrorCode::InvalidBundlePath,
            format!("invalid Bundle path {path:?}"),
        ))
    } else {
        Ok(())
    }
}
