# Example source repository

Copy this directory into a Git repository whose default branch is `main`.
Enroll a Node first, then replace `00000000-0000-0000-0000-000000000000` in
`fleet.yml` with the Node ID returned by Fleet. Source ingestion rejects the
placeholder because every configured Node ID must already exist in the Server.

The `definitive` group has precedence over `testing` because it appears first.
Each immediate child below a group is a Skill, and each Skill requires a root
`SKILL.md`.
