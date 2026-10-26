---
name: fleet-release
description: Prepare or publish a Fleet Manager release, including versioned Docker Hub server images, annotated Git tags, GitHub client archives, and Homebrew verification. Use for release work in the fleet-manager repository, not for deploying a live installation.
---

# Fleet release

Run from the Fleet Manager repository root. Read
`docs/technical-design/client-updates.md`, `deploy/homelab/README.md`,
`Dockerfile`, and `.github/workflows/client-artifacts.yml` before releasing.
The project's GitHub repository is `jcarcaboso/fleet-manager` and Docker Hub
repository is `skorcius/fleet-manager`. Confirm the destination before publishing
from a fork or to another registry.

## Scope

Distinguish preparation from publication. Preparation can update versions,
release notes, and source branches, build and smoke-test a local image, and
stage workflow artifacts. It does not authorize pushing a Docker image or a
release tag. Publish only when the user requests publication, pushing the
release tag, or publishing the release image.

Publishing a release does not authorize deploying it. Do not modify a live
installation's `.env`, restart its services, regenerate its CA, or remove its
volumes.

The GitHub workflow builds and publishes client archives. It does **not** build
or push the Server Docker image. That remains a manual release step.

The dashboard (frontend) is embedded in the Server image from
`server/Fleet.Server/Dashboard/Assets/` and served at `/dashboard`. There is no
separate frontend image or artifact: publishing the Server image publishes the
dashboard, and a dashboard change needs a new Server image and version. The
`Dashboard/Dev/` harness is not embedded and is never published.

A release therefore has three parts that share one version and one source commit:
the Server image with the dashboard (manual), the Agent and `fleet` archives
(workflow), and the Homebrew formulas (workflow).

## Prepare the source

1. Fetch `origin/master` and tags; inspect GitHub releases and registry tags.
   Do not assume an earlier prepared version was published. Confirm the intended
   version with repository state and the user's request.
2. Keep the version consistent in `Directory.Build.props`, `Dockerfile`,
   `clients/Cargo.toml`, `clients/crates/fleet-reconcile/Cargo.toml`, and local
   package entries in `clients/Cargo.lock`. Regenerate the lockfile with Cargo,
   without updating unrelated dependencies.
3. Add `docs/releases/VERSION.md` and its README link. For publication, update
   the Server image pins in README, the CLIProxy operations guide, and
   `deploy/homelab/{README.md,compose.yaml,setup.py}`. Leave Homebrew formulas to
   the release workflow; never invent archive checksums.
4. Run the checks in `CONTRIBUTING.md`. Merge through a PR after CI passes.
   Register every PR with T3 Code when its PR-linking tools are available.
5. Select the exact tested `master` commit as `SHA`. Use a clean checkout or a
   disposable detached worktree at that commit for release builds. All image,
   tag, and archive provenance must refer to that same commit.

## Breaking and minor releases

A release that changes behaviour operators or scripts depend on needs more than
a version bump. Treat a change as breaking when it alters a `fleet` command's
flags, output or exit codes, removes or reshapes an Operator API or dashboard
route, tightens a limit, adds a database migration, or changes what an older
Agent or Server can accept. Use a minor version while the project is below 1.0.

For a breaking release, before publishing:

1. List the breaking changes by reading the merged PRs and
   `git diff vX.Y.Z..origin/master` for `clients/bins/fleet/`,
   `server/Fleet.Server/Transport/`, `server/Fleet.Server/Dashboard/`,
   `server/Fleet.Server/Persistence/Migrations/`, `contracts/` and
   `docs/technical-design/operator-*.md`. Do not rely on PR titles.
2. In `docs/releases/VERSION.md`, add a **Breaking changes** section and an
   **Upgrade** section. Give the upgrade order (Server first when Agents tolerate
   an older Server, otherwise Agents first, as in 0.8.1), the migrations and
   whether they run concurrently or lock tables, the backup command from
   `docs/technical-design/backup-restore.md`, and what an older Agent or Server
   shows after a partial upgrade. State what was not verified, such as macOS code
   that CI only compiles.
3. Confirm every PR the release depends on reached `origin/master`. A PR whose
   base branch was already merged lands in that old branch, not `master`; check
   with `git merge-base --is-ancestor <pr-head> origin/master` and open a PR to
   `master` if it is not an ancestor.
4. Update documentation that names removed or renamed UI, commands or routes.
   Search for their labels and paths.
5. Run the checks in `CONTRIBUTING.md` and the image smoke test below with
   `scripts/smoke-https.py`. Also open `/dashboard` once on the smoke-test Server
   with the temporary Operator token, because the smoke script does not exercise
   the dashboard assets.
6. Check compatibility on the same smoke-test Server instead of trusting the
   notes. Build the previous release's Agent from its tag in a scratch directory
   (`git archive vX.Y.Z clients | tar -x -C DIR`, then `cargo build --locked -p
   fleet-agent` with its own `CARGO_TARGET_DIR`), enroll it with a temporary
   alias and run `run --once`; it must poll without errors and show as fresh.
   Then enroll and run the new Agent, and confirm `fleet nodes show` returns the
   machine details and disk usage it reports and `fleet doctor` works. Remove
   the temporary Compose project, volumes, image and scratch directories.
7. Ask for review of the Breaking changes section from someone who runs the
   installation before tagging.

Version 0.9.0 is the first release with this process. Its breaking changes are
the `fleet --yes` gate, JSON errors and exit codes, `{code,message}` Operator
API errors and the 1 to 100 `limit`, the removed `GET /dashboard/api/diagnostics`
route and the rebuilt dashboard, with six migrations. The Server image,
`fleet`, `fleet-agent` and the dashboard all ship as 0.9.0.

## Publish the Server image before the Git tag

The current supported Server image is Linux amd64 on Docker Hub. Do not add
architectures, registries, or a mutable `latest` tag without a request.

```sh
VERSION=X.Y.Z
SHA=$(git rev-parse HEAD)
IMAGE="skorcius/fleet-manager:$VERSION"
docker build --platform linux/amd64 \
  --label "org.opencontainers.image.revision=$SHA" -t "$IMAGE" .
docker image inspect "$IMAGE" \
  --format '{{.Os}}/{{.Architecture}} {{json .Config.Labels}}'
```

Check that the image is Linux amd64, its version label equals `VERSION`, and
its revision label equals `SHA`. Smoke-test this local image using an isolated
Compose project, disposable PostgreSQL and runtime volumes, and credentials
generated by `deploy/homelab/setup.py --directory TEMP_DIR`. Set `FLEET_IMAGE`
to the local image, choose an unused loopback port, wait for migrations and
readiness, then run `scripts/smoke-https.py` with that temporary Operator
environment and `FLEET_CA_CERT`. Clean up only that temporary Compose project
and its volumes.

The image push is manual because no workflow publishes it. It needs Docker Hub
credentials for `skorcius/fleet-manager` in the local credential store. Check
`docker login` state without printing credentials, and ask the user to log in if
it is missing; do not look for tokens in files or the environment. Publishing the
image and pushing the tag are separate outward-facing steps: build and smoke-test
first, report the image ID and labels, and push only when the user has asked for
publication.

If a remote version image already exists, verify its revision and digest and
reuse it only when it matches the intended source. Do not overwrite a published
version with different content. Resolve registry authentication through the
existing Docker credential store or interactive login; never print or commit
credentials.

```sh
docker push "$IMAGE"
docker buildx imagetools inspect "$IMAGE"
```

Record the remote digest, pull that digest, and verify its version and revision
labels. A local build alone is not a published image.

## Tag, wait, and verify

Only after the remote image is verified:

```sh
git tag -a "v$VERSION" "$SHA" -m "Fleet Manager $VERSION"
git push origin "refs/tags/v$VERSION"
```

If the tag already exists, check its peeled commit and resume the existing
workflow instead of moving or recreating it. Never force-push release tags.

Watch the tag-triggered `client-artifacts.yml` run. It creates the GitHub release
and uploads six archives plus six adjacent checksums, tests generated Homebrew
formulas on both macOS architectures, then updates the formulas on `master`.
Do not create a competing GitHub release or draft before that workflow.

Verify the release assets, their checksums and `BUILD.json` provenance, both
formula versions, and the published Docker digest. Pull updated `master` only
when the local worktree is clean. Report the tag, source SHA, image reference
and digest, GitHub release, and any unfinished verification separately.

Stop on source, test, smoke, or authentication failures. For an identified
transient upload or infrastructure failure, retry only the failed job once.
After an uncertain tag or image push, read remote state before retrying the
same operation. Do not restart publication with a replacement version or
change deployment state merely to make a release pass.
