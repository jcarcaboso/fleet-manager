# Desired-state model

## Purpose

The canonical source repository stores reviewable Skill content and the
declarations that decide which Nodes should receive it. Operators maintain
group directories, optional Node selections, and Target paths. They do not
maintain a second catalog of groups or Skills in YAML.

This document fixes the semantics. Exact YAML field names may change during
technical design if the meaning remains intact.

## Source layout

```text
fleet.yml
agents/
  personal/
    AGENTS.md
  work/
    AGENTS.md
skills/
  definitive/
    code-review/
      SKILL.md
      references/
    typescript/
      SKILL.md
  testing/
    new-reviewer/
      SKILL.md
  in-progress/
    experimental-agent/
      SKILL.md
```

The convention is:

```text
skills/<group-name>/<skill-name>/
agents/<source-name>/AGENTS.md
```

The Server discovers groups from the immediate directories below `skills/`.
Every immediate child directory of a discovered group is a Skill. A group may
contain one Skill when an Operator needs a narrowly assigned collection.
The `skills/` and `agents/` roots are independent and optional. If either root
is absent, the Server discovers no content of that type. A manifest still fails
when it explicitly selects a group or agent source that does not exist.
The legacy `groups/` source directory and top-level `groups` manifest field are
invalid. Move the directories and remove the field in one source commit.

Group, Skill, and agent source names use lowercase letters, numbers, and
hyphens. This avoids case collisions between common macOS and Linux
filesystems.

The Server discovers agent sources directly from the immediate directories
below `agents/`; `fleet.yml` does not declare a separate catalog. Each source
directory contains exactly one `AGENTS.md`. Fleet treats its bytes as opaque
and caps it at 1 MiB.

## Skill directory trees

A Skill is its complete directory tree, not only its root `SKILL.md`. The root
`SKILL.md` is mandatory. Fleet recursively includes nested regular files and
directories in the Skill's Bundle. File bytes are opaque and may be text or
binary. A change to any included path, entry type, file content, or executable
bit changes the Bundle digest.

Fleet does not classify content, scan for secrets, or decide whether a file
belongs in a Skill. The author controls the source tree and is responsible for
anything committed to it. Fleet still treats every entry as untrusted input and
never executes Bundle content.

For the POC, source validation and Agent extraction accept regular files and
directories. They reject symlinks, hard links, device files, sockets, named
pipes, absolute paths, parent traversal, and any entry that would escape its
Skill root. Every path must use portable UTF-8 names. Validation rejects paths
that collide after Unicode normalization or case-insensitive comparison so one
Bundle cannot resolve differently on common macOS and Linux filesystems. Limits
cover tree depth, path length, entry count, individual file size, and total
uncompressed size.

Bundle construction orders and encodes entries deterministically so the same
tree produces the same digest on macOS and Linux. It preserves only the regular
file executable bit. Timestamps, owners, groups, and other host metadata do not
belong to a Bundle. Git cannot represent empty directories, so Fleet does not
create or preserve them. Authors can add a regular placeholder file when an
empty directory matters. The exact Bundle encoding and numeric limits remain
protocol decisions.

## Conceptual YAML

```yaml
schema: fleet/v1

targets:
  skills:
    base: home
    path: .agents/skills

nodes:
  joan-macbook:
    targets:
      skills:
        groups:
          - definitive
          - testing
      agents:
        - source: personal
          clients:
            - codex
            - opencode
        - source: work
          clients:
            - claude

  linux-workstation:
    targets:
      skills:
        path: .codex/skills
        groups:
          - definitive
      agents:
        - source: work
```

The YAML lists groups only when a Node needs a subset or a specific precedence
order. The Server discovers the group and Skill catalogs from directories at
the exact source revision. An omitted or empty `groups` array selects every
discovered group.

Each entry in `targets.agents` maps one discovered source to one or more known
AI clients. The destination adapter supplies the client-specific directory and
filename:

| AI client | Destination relative to home |
|---|---|
| Codex | `.codex/AGENTS.md` |
| OpenCode | `.config/opencode/AGENTS.md` |
| Claude Code | `.claude/CLAUDE.md` |

For example, `source: personal` resolves exactly
`agents/personal/AGENTS.md`. Omitting `clients` selects Codex, OpenCode, and
Claude Code. When `clients` is present, the source applies only to those
clients. A Node may use several sources as long as no client occurs in more
than one entry. Overlapping client mappings, unknown clients, and unknown
sources invalidate the source revision. An entry-level `clients: []` is also
invalid; use a Node-level `agents: []` to clear every supported client file.

Missing `targets.agents` means Fleet publishes no Managed-file Targets for that
Node and leaves any earlier assignments untouched. An explicit `agents: []`
publishes empty content for all supported clients, creating each instruction
file if needed. A nonempty list publishes only the selected clients and leaves
unselected client files untouched. The Agent reports an ownership conflict
instead of replacing a pre-existing file that Fleet does not own.

Deleting a referenced source makes the repository invalid and leaves the last
accepted desired revision active. To retire a source, first update every Node
that references it. Use `agents: []` and wait for that Rollout when all of its
supported client files should be cleared.

The Server owns the enrolled Node registry. Keys under `nodes` are unique Node
aliases, resolved by the Server to stable internal Node IDs. The alias is the
exact, case-sensitive name supplied at enrollment. The YAML supplies desired
configuration without an `id` field:

- an enrolled Node missing from the YAML remains registered but receives no new
  Assignment;
- an unknown Node alias makes source validation fail;
- aliases remain reserved after revocation and cannot identify a replacement
  Node; and
- credentials, enrollment tokens, and mutable Node metadata never enter Git.

An authenticated Node may change its alias to a free name. The old alias becomes
available again. Update its YAML key and commit the change before reusing that
old alias for a different Node. Previously published Assignments retain their
resolved Node IDs; an alias change does not rewrite an accepted revision.
Existing UUID-based manifests must remove each `id` field and use the enrolled
Node's current name as the mapping key. Certificate identities do not change.

## Target resolution

The Target named `skills` has one default descriptor:

```text
base = home
path = .agents/skills
```

A Node may override the relative path. The Agent, not the Server or Fleet CLI,
resolves `home` through operating-system APIs on that Node.

For the POC:

- `home` is the only allowed base;
- the path must be relative and non-empty;
- absolute paths and `..` segments are invalid;
- the resolved path must remain under the user's home after symlink-aware
  validation; and
- the Agent mutates only named Skill directories below the resolved Target.

An initial per-Node override is supported. Changing the path of an already
active Target is not an implicit move in the POC. The Server rejects that change
until a later explicit Target-relocation flow defines how to install at the new
path and clean up the old path safely.

## Group resolution

Groups are source organization and assignment policy. Agents never see them.

For each Node and Target, the Server:

1. uses the Node's nonempty `groups` array as its ordered selection;
2. otherwise selects every discovered group in group-name order;
3. discovers the Skills in each selected directory;
4. resolves each Skill to immutable Bundle content; and
5. produces one flat map of Skill name to Bundle digest.

For the example above:

```text
joan-macbook:
  code-review  -> <digest>
  typescript   -> <digest>
  new-reviewer -> <digest>

linux-workstation:
  code-review -> <digest>
  typescript  -> <digest>
```

The actual contents depend on the group directories. The Agent receives only
the flat map and its Target descriptor.

## Duplicate Skill names

A Skill should exist in exactly one group. Duplicates are accepted with warnings
in the POC so one mistake does not halt every unrelated update.

Resolution is deterministic for each Node Target:

1. consider the Node's selected groups, or every discovered group when its
   selection is omitted or empty;
2. process an explicit selection in array order, or the default selection in
   group-name order;
3. keep the first occurrence of a Skill name; and
4. skip later occurrences with the same name.

The accepted desired revision records a structured `duplicate_skill_name`
warning containing the Skill name, every source location in group-name order, and
the effective winner for each affected Node Target. Server logs also include the
warning, and Fleet CLI status must show it.

Filesystem traversal order never decides the winner. Put `definitive` before
`testing` in a Node's `groups` array when that Node needs `definitive` to win.
For Nodes that select every group by default, the lexicographically first group
name has the highest precedence.

## Source polling and publication

The POC Git adapter reads only `main`:

1. scan immediately when the Server starts;
2. poll the remote on a configurable interval, initially 30 minutes;
3. compare the exact tip identity with the last observed source revision;
4. load the complete source tree for a new tip;
5. validate the complete YAML and every complete discovered Skill tree;
6. build or reuse Bundles by content digest;
7. resolve the effective flat Skill map for every configured Node Target;
8. compare those maps with the last accepted desired revision; and
9. atomically accept the desired revision and create Assignments for affected
   Node Targets.

If several commits arrive between scans, the Server may accept only the latest
tip. Desired state is complete, so intermediate source revisions are not needed
for correctness.

If the new tip is invalid, the Server records an ingestion failure and keeps the
previous desired revision current. It never accepts a partial repository state.

A source revision that changes only documentation or other unmanaged files may
be observed without creating a Rollout. The decision depends on the resolved
desired state, not on whether the commit ID changed.

## Semantic comparison, not patch delivery

The Server may use Git diffs to avoid re-reading unchanged files, but it must
validate and resolve a complete desired snapshot before publication. Git text
diffs are not delivered to Agents.

For each Node Target, correctness comes from comparing maps:

```text
previous desired state: Skill name -> Bundle digest
new desired state:      Skill name -> Bundle digest
```

Only Node Targets whose effective map or Target descriptor changed need a new
Assignment. Unchanged Bundles retain their digest, so Agents download only
missing content even though the Assignment describes the complete desired set.

## Removal semantics

The Assignment is the complete Fleet-owned desired state for one Target:

- a desired Skill absent locally is created;
- a desired Skill with a different digest is updated;
- a Fleet-owned local Skill absent from desired state is removed; and
- an unowned local Skill is left untouched.

Removing a Skill directory, removing a group subscription, or moving a Skill to
a group that the Node does not receive can therefore remove Fleet-owned content.

Removing a Node from YAML stops new assignment. It does not implicitly erase
content from that Node in the POC. Decommissioning and remote uninstall require
an explicit future design because a removed Node may remain offline forever.
