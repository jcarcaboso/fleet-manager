# Bundle format

Fleet encodes each Skill tree as `fleet.bundle/v1`. The Bundle is a byte string
with this layout. All integers use unsigned, big-endian encoding.

```text
6 bytes   ASCII "FLTB1" followed by NUL
u32       file count
repeated file count times, sorted by UTF-8 path bytes:
  u32     path byte count
  bytes   NFC-normalized relative UTF-8 path
  u8      executable flag, 0 or 1
  u64     content byte count
  bytes   opaque file content
```

The digest is lowercase `sha256:` followed by the SHA-256 digest of the complete
encoded byte string in hexadecimal. Paths use `/` as their separator. The
encoder includes regular files only because Git has no empty directory entry.
Directory structure follows from file paths.

Before encoding, source ingestion rejects absolute paths, `.` and `..` path
segments, backslashes, invalid UTF-8, links, submodules, and paths that collide
after NFC normalization and case-insensitive comparison. The executable flag is
set only for Git mode `100755`; mode `100644` clears it. No timestamps, owners,
groups, or other host metadata enter the encoding.

Version 1 limits a source snapshot to 10,000 files, 16 path segments, 1,024
UTF-8 bytes per path, 16 MiB per source file, 256 MiB of source file content,
and 1 MiB for `fleet.yml`. Each encoded Bundle, including its header, paths, and
entry metadata, is limited to 16 MiB. Implementations may lower these limits
through configuration but must not accept a Bundle that exceeds the configured
values.
