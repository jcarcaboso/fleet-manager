# Example source repository

Copy this directory into a Git repository whose default branch is `main`.
Enroll a Node first, then replace `example-node` in `fleet.yml` with its exact
enrollment name. That name is the Node alias, unique within the Workspace. The
Server resolves it to the internal Node ID. Unknown aliases fail validation.
Aliases are case-sensitive and remain reserved after revocation.

The Server discovers `definitive` and `testing` below `skills/`. The empty
`groups` array assigns both to the example Node, in group-name order. Each
immediate child below a group is a Skill, and each Skill requires a root
`SKILL.md`. Source revisions must contain both `skills/` and `agents/`; Git does
not track an empty directory.

The Server discovers the `personal` source from
`agents/personal/AGENTS.md`. The example maps it to Codex and OpenCode under the
Node's `targets.agents`. Omit `clients` to install one source for every
supported AI client.
