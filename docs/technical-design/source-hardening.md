# Source ingestion hardening

The Git adapter keeps one bare mirror in a private directory. It rejects a
mirror path that is a symbolic link, sets the mirror root to user-only access,
and rejects symbolic links anywhere inside the mirror before and after fetch.
After fetch it totals regular-file sizes and rejects a mirror larger than 512
MiB by default.

Fleet initializes an empty mirror directory and writes a format marker. It
rejects a populated directory without that marker. On every scan it replaces
the mirror-local Git configuration with the small bare-repository configuration
Fleet owns, rejects alternate object stores, and fetches the validated URL
directly. This keeps `remote.*.uploadpack`, includes, URL rewrites, and other
preseeded repository configuration out of the fetch path.

The post-fetch size check is a backstop, not an in-flight storage quota. Git may
write a pack larger than the limit before Fleet can inspect it. Deployments must
place the mirror on a filesystem or volume with an enforced quota. The quota
must leave enough space for Git's temporary pack plus the retained mirror.

Fleet starts Git directly without a shell. Every command has an output limit
and timeout, and the complete scan has a separate timeout. Fleet kills the Git
process tree as soon as standard output exceeds its limit. Standard error is
drained through a fixed buffer and is never returned in diagnostics because a
remote may include credentials or repository content in an error.

Git runs with terminal prompts, askpass, credential helpers, hooks, recursive
submodules, the `ext` transport, and HTTP redirects disabled. Fleet accepts
HTTPS, SSH, and absolute local-file remotes. It rejects plain HTTP and the Git
protocol. The local-file transport exists for fixtures and operator-controlled
local repositories.

SSH remains an external program and reads the service account's OpenSSH
configuration, including host keys and identity selection. Fleet forces batch
mode but cannot prove that an SSH alias resolves to one network destination.
Deployments that require an outbound destination allowlist must enforce it with
network policy. Private repositories should use SSH with a dedicated read-only
deploy key until Fleet has an explicit HTTPS credential adapter. Fleet rejects
credentials embedded in HTTPS URLs because URLs can appear in process and
configuration diagnostics. HTTPS currently supports unauthenticated
repositories.

The default limits are 180 seconds for one complete scan, 120 seconds for one
Git command, 512 MiB for the completed mirror, and 100,000 mirror entries. The
Server reads overrides from `Source:ScanTimeoutSeconds`,
`Source:GitCommandTimeoutSeconds`, `Source:MaxMirrorBytes`, and
`Source:MaxMirrorEntries`. Raising them requires checking process memory,
database Bundle limits, polling latency, and the mirror volume quota together.

Source warnings are also bounded before publication. A warning message may
contain at most 2,048 characters, matching the coordination contract. Source
ingestion rejects a revision with `warning_too_large` when complete duplicate
resolution details do not fit that limit.
