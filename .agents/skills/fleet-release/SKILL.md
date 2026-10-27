---
name: fleet-release
description: Prepare or publish a Fleet Manager release, including the versioned Docker Hub Server and dashboard images, annotated Git tags, GitHub client archives, and Homebrew verification. Use for release work in the fleet-manager repository, not for deploying a live installation.
---

# Fleet release

Run from the Fleet Manager repository root. Read
`docs/technical-design/client-updates.md`, `deploy/homelab/README.md`,
`Dockerfile`, `dashboard/Dockerfile`, and `.github/workflows/client-artifacts.yml`
before releasing. The project's GitHub repository is `jcarcaboso/fleet-manager`.
Its Docker Hub repository is `skorcius/fleet-manager`, which holds both images:
the Server as `skorcius/fleet-manager:VERSION` and the dashboard as
`skorcius/fleet-manager:dashboard-VERSION`. Do not publish to another repository
(an earlier `skorcius/fleet-manager-dashboard` repository is not used). Confirm
the destination before publishing from a fork or to another registry.

## Scope

Distinguish preparation from publication. Preparation can update versions,
release notes, and source branches, build and smoke-test the local images, and
stage workflow artifacts. It does not authorize pushing a Docker image or a
release tag. Publish only when the user requests publication, pushing the
release tag, or publishing the release images.

Publishing a release does not authorize deploying it. Do not modify a live
installation's `.env`, restart its services, regenerate its CA, or remove its
volumes.

The GitHub workflow builds and publishes client archives. It does **not** build
or push either Docker image. That remains a manual release step.

The dashboard is its own Vue application in `dashboard/`, built by
`dashboard/Dockerfile` into an unprivileged nginx image. The Server serves no
dashboard files (only `/enroll` pages) and redirects `/dashboard` to the
dashboard address. The two images are released together, with the same version
and source commit, and both are Linux amd64.

A release therefore has four parts that share one version and one source commit:
the Server image (manual), the dashboard image (manual), the Agent and `fleet`
archives (workflow), and the Homebrew formulas (workflow).

## Prepare the source

1. Fetch `origin/master` and tags; inspect GitHub releases and registry tags.
   Do not assume an earlier prepared version was published. Confirm the intended
   version with repository state and the user's request.
2. Keep the version consistent in `Directory.Build.props`, `Dockerfile`,
   `clients/Cargo.toml`, `clients/crates/fleet-reconcile/Cargo.toml`, and local
   package entries in `clients/Cargo.lock`. Regenerate the lockfile with Cargo,
   without updating unrelated dependencies.
   `dashboard/package.json` (and the root `version` fields of its lockfile) and
   the `org.opencontainers.image.version` labels of both Dockerfiles use the same
   version; the tag workflow's version check fails a tag when any of them differs.
3. Add `docs/releases/VERSION.md` and its README link. For publication, update
   the Server image pins (`skorcius/fleet-manager:VERSION`) and the dashboard
   image pins (`skorcius/fleet-manager:dashboard-VERSION`) in README, the CLIProxy
   operations guide, and `deploy/homelab/{README.md,compose.yaml,setup.py,.env.example}`.
   Leave Homebrew formulas
   to the release workflow; never invent archive checksums.
4. Run the checks in `CONTRIBUTING.md`. Merge through a PR after CI passes.
   Register every PR with T3 Code when its PR-linking tools are available.
5. Select the exact tested `master` commit as `SHA`. Use a clean checkout or a
   disposable detached worktree at that commit for release builds. All image,
   tag, and archive provenance must refer to that same commit.

## Breaking and minor releases

A release that changes behaviour operators or scripts depend on needs more than
a version bump. Treat a change as breaking when it alters a `fleet` command's
flags, output or exit codes, removes or reshapes an Operator API or dashboard
route or address, tightens a limit, adds a database migration, or changes what an older
Agent or Server can accept. Use a minor version while the project is below 1.0.

For a breaking release, before publishing:

1. List the breaking changes by reading the merged PRs and
   `git diff vX.Y.Z..origin/master` for `clients/bins/fleet/`,
   `server/Fleet.Server/Transport/`, `server/Fleet.Server/Dashboard/`,
   `server/Fleet.Server/Persistence/Migrations/`, `dashboard/`, `deploy/homelab/`,
   `contracts/` and `docs/technical-design/operator-*.md`. Do not rely on PR titles.
   Removing the Server-served dashboard (a new container, a new published port, a
   redirect from `/dashboard`, and the same-site rule) is an example: it needs an
   Upgrade section covering the new image and service, the port to open, the
   `FLEET_DASHBOARD_*` settings, what old bookmarks do, and the Server and
   dashboard being upgraded together. The dashboard also has its own certificate
   and volume, so existing installations must run `python3 setup.py
   --add-dashboard` before `docker compose up` (the `configure` step stops
   without `dashboard.pem`); say so, and that IPv6-literal addresses are not
   supported by the dashboard.
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
5. Run the checks in `CONTRIBUTING.md` and the image smoke tests below with
   `scripts/smoke-https.py` and `scripts/smoke-dashboard.py`. Also sign in once
   in a browser at the smoke-test dashboard address with the temporary Operator
   token, because the scripts do not render the application.
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
`fleet`, `fleet-agent` and the Server-served dashboard all shipped as 0.9.0.
Starting with 0.10.0 the dashboard is a separate image.

## Publish the images before the Git tag

The current supported images are Linux amd64 on Docker Hub. Do not add
architectures, registries, or a mutable `latest` tag without a request.

```sh
VERSION=X.Y.Z
SHA=$(git rev-parse HEAD)
SERVER_IMAGE="skorcius/fleet-manager:$VERSION"
DASHBOARD_IMAGE="skorcius/fleet-manager:dashboard-$VERSION"
docker build --platform linux/amd64 \
  --label "org.opencontainers.image.revision=$SHA" -t "$SERVER_IMAGE" .
docker build --platform linux/amd64 -f dashboard/Dockerfile \
  --label "org.opencontainers.image.revision=$SHA" -t "$DASHBOARD_IMAGE" .
for image in "$SERVER_IMAGE" "$DASHBOARD_IMAGE"; do
  docker image inspect "$image" \
    --format '{{.Os}}/{{.Architecture}} {{json .Config.Labels}}'
done
```

Check that both images are Linux amd64, each version label equals `VERSION`, and
each revision label equals `SHA`. Build from the tested commit: the dashboard
image builds `dashboard/` from the same checkout, with `npm ci` against the
locked dependencies.

Smoke-test the local images together:

1. Run `scripts/smoke-dashboard-image.sh "$DASHBOARD_IMAGE"`. It starts the
   dashboard image read-only, as UID 1655 with no capabilities, a throwaway CA
   and a volume holding only `dashboard.pem`, `dashboard.key` and `ca.pem`, and
   checks `config.json`, the headers (error pages included), route fallback, 404,
   405, 414, TLS, the access log, the missing-certificate message and the
   fail-fast `FLEET_API_ORIGIN` checks (IPv6 literals among them).
2. Use an isolated Compose project, disposable PostgreSQL and runtime volumes,
   and credentials generated by `deploy/homelab/setup.py --directory TEMP_DIR
   --host localhost --port SERVER_PORT --dashboard-port DASHBOARD_PORT` with
   unused loopback ports. Set `FLEET_IMAGE` and `FLEET_DASHBOARD_IMAGE` in the
   temporary `.env` to the local images (local tags, never the published release
   names), `docker compose up -d --wait --pull never` (the Server waits for
   migrations and readiness; the dashboard waits for the Server), and confirm
   that `docker compose ps` shows `server` and `dashboard` healthy. The base
   `compose.yaml` never builds; the images come from the `docker build` commands
   above. To build the dashboard through Compose instead, add
   `-f compose.build.yaml` from `deploy/homelab/` in the checkout. Also run
   `setup.py --add-dashboard` once against a copy of the previous release's
   directory and bring that up. With `docker exec` into the dashboard container
   (read-only checks, no file contents) confirm it runs as UID 1655 and cannot
   read `/run/fleet` or the CA key.
3. With the temporary `operator.env` loaded, run `scripts/smoke-https.py` with
   `FLEET_CA_CERT`, then `scripts/smoke-dashboard.py` with `FLEET_CA_CERT` and
   `FLEET_DASHBOARD_URL` set to the temporary dashboard origin. The second script
   checks the dashboard origin over HTTPS (index, `config.json`, headers, route
   fallback, assets), that the Server's `GET /dashboard` redirects to that origin,
   CORS for it and not for another origin, and an Operator-token sign-in with a
   cookie jar.
4. Open the dashboard address in a browser (or scripted headless Chrome), sign in
   with the temporary Operator token and visit each page, watching the console
   for errors and content security policy violations.

Clean up only that temporary Compose project and its volumes, and the local test
images you do not intend to publish.

The image pushes are manual because no workflow publishes them. They need Docker
Hub credentials for `skorcius/fleet-manager` in the local credential store.
Check `docker login` state without printing credentials, and ask the user to log
in if it is missing; do not look for tokens in files or the environment.
Publishing the images and pushing the tag are separate outward-facing
steps: build and smoke-test first, report both image IDs and labels, and push only
when the user has asked for publication.

If a remote version image already exists, verify its revision and digest and
reuse it only when it matches the intended source. Do not overwrite a published
version with different content. Resolve registry authentication through the
existing Docker credential store or interactive login; never print or commit
credentials.

```sh
docker push "$SERVER_IMAGE"
docker push "$DASHBOARD_IMAGE"
docker buildx imagetools inspect "$SERVER_IMAGE"
docker buildx imagetools inspect "$DASHBOARD_IMAGE"
```

Record each remote digest, pull each digest, and verify its version and revision
labels. A local build alone is not a published image. Publish both images before
the tag: a Server without its dashboard image (or the other way round) leaves
`docker compose up` unable to start the stack.

## Tag, wait, and verify

Only after both remote images are verified:

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
formula versions, and the published Docker digests of both images. Pull updated `master` only
when the local worktree is clean. Report the tag, source SHA, both image references
and digests, GitHub release, and any unfinished verification separately.

Stop on source, test, smoke, or authentication failures. For an identified
transient upload or infrastructure failure, retry only the failed job once.
After an uncertain tag or image push, read remote state before retrying the
same operation. Do not restart publication with a replacement version or
change deployment state merely to make a release pass.
