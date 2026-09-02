---
status: accepted
date: 2026-09-02
---

# Bundle complete Skill directory trees as opaque content

Fleet will represent each Skill as one complete rooted directory tree. A root
`SKILL.md` is required, and all nested regular files and directories belong to
the Skill. Fleet transports file bytes without interpreting their purpose,
detecting secrets, or executing them. Authors own the content they commit and
the Nodes to which they assign it.

Bundle construction is deterministic across macOS and Linux. File bytes,
relative paths, entry types, and the executable bit contribute to the digest.
Timestamps, owners, groups, and other host metadata do not. Empty directories
are not content because Git cannot represent them. Paths that are unsafe or
collide after Unicode normalization or case-insensitive comparison are rejected,
as are links, devices, sockets, and named pipes.

This was chosen over bundling only `SKILL.md` because Skills may depend on nested
references, scripts, assets, and binary files. It was chosen over a
content-aware package format because Fleet should not need to understand future
Skill file types to distribute them correctly.
