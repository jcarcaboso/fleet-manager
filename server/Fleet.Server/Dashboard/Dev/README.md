# Dashboard development harness

Everything in this folder is for building and testing the dashboard without a Server.
It is **not** embedded in the Server assembly (the project embeds `Dashboard/Assets/*` only) and is never served.

| File | Purpose |
|---|---|
| `harness.html` | Loads the fixture, then the real files from `../Assets/` by relative path. Works from `file://`. |
| `harness-csp.html` | Same page plus the Server's CSP (`default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'`) as a `<meta>` tag. Any inline style or script is blocked and logged to the console. |
| `fixture.js` | Replaces `window.fetch` for `/dashboard/api/*` with an in-memory fake of `docs/technical-design/operator-api.md`. It derives its data from `artifacts/dashboard-prototypes/data.js` and returns only fields the contract defines. Mutations (retry, rename, revoke, remove, enrollment links, model selection, rescan) change the in-memory state and follow the Server (`PostgresFleetCoordinator`, `Transport/OperatorApi.cs`, `CliProxySelectionStore`): same order of checks, same error codes, same audit events (see "Fixture and the Server" below). Creating an enrollment link simulates the machine enrolling a few seconds later. |
| `drive.js` | Optional scripted clicks (`?drive=<scenario>`) that print PASS/FAIL lines. Used for smoke tests. |

## Use it

Open the harness in a browser (no server needed):

    file:///.../server/Fleet.Server/Dashboard/Dev/harness.html#/nodes

Routes are the dashboard's own: `#/nodes`, `#/nodes/<alias>/<overview|installed|problems|activity|security|settings>`,
`#/problems`, `#/deployments`, `#/repository`, `#/models`, `#/enrollment`, `#/audit`, `#/add`.
The harness starts signed in. Any token of 32 or more characters signs in, like the Server (shorter tokens, and tokens starting with `bad`, are rejected).

Query switches go before the `#`:

| Switch | Effect |
|---|---|
| `scope=read` / `operate` / `admin` | Session scope returned by `GET session` (default `admin`). Controls the scope does not allow are shown locked. |
| `signedout=1` | Start at the login screen. |
| `empty=1` | No machines, links, audit events or revisions. |
| `fail=<path prefix>` | `GET` routes starting with the prefix return 500 (for example `fail=nodes`). |
| `forbid=1` | Every non-GET request returns 403 `insufficient_scope`. |
| `slow=<ms>` | Delay every response. Shows the loading skeletons. |
| `pagesize=<n>` | Cap page size to exercise cursors and "load more". |
| `diag=0` | Attempts carry no phase 2 detail at all (`diagnostic`, `path` and `step` are `null`), like a Server or Agents before phase 2. |
| `xss=1` | Every failed Attempt that has detail carries a hostile `diagnostic` and `path` (`<img src=x onerror=alert(1)>`, `"><script>`) so the escaping can be checked. |
| `enroll=0` | The wizard's simulated enrollment never happens. |
| `enroll=link` | The link is consumed and the Node exists, but the Agent never checks in. |
| `expiry=<seconds>` | Links created in the wizard expire after this many seconds, whatever was requested. |
| `weirdalias=1` | The first machine is called `rack/A 100%`, to exercise path-segment encoding. |
| `delay=<alias or id>:<ms>[,...]` | Delays `GET nodes/{node}...` for that machine, to reproduce overlapping loads. |
| `lag=<text>:<ms>[,...]` | A POST whose path contains `<text>` (`rename`, `remove`, `revoke`, `retry`, `enrollment-links`, `cliproxy/selection`, `cliproxy/refresh`, `rescan`) does its work at once but answers `<ms>` later. Reproduces a mutation that completes after the user has moved on. |
| `hang=<path prefix>` | `GET` routes under the prefix never answer. Only the caller's abort ends them. |
| `iostub=1` | Drive scenarios only: replace `IntersectionObserver` with a polling stand-in (headless Chrome renders no frames after load under `--virtual-time-budget`, so the real one stops reporting). |

The fixture follows the contract's conventions: lists accept `limit` (1 to 100) and `after`, `desired-revisions`, `rollouts` and `audit`
accept `order=newest` (the default is ID order, so a client that forgets `order` sees scrambled revisions), a cursor is valid only with the
order it came from, `{node}` is one percent-encoded path segment decoded once (never the whole path), and every error is `{ code, message }`.
`window.__FIXTURE.calls` records every API call (`method`, `path`, `query`, `at`, `settled`, `aborted`) so scenarios can assert on requests: `aborted` is set when the caller's `AbortController` fired, and `settled` when the response was delivered or the call was aborted (so the calls with `settled === false` are the requests in flight).

## Attempt detail (phase 2)

By default the fixture returns the phase 2 fields (`docs/technical-design/operator-api.md`, "Phase 2: attempt detail") on `latestAttempt`, node attempts, rollout attempts and `GET issues`:
`diagnostic` (from `data.js`), `path` (relative to the Target base, never starting with `/`) and `step`, chosen by error code and Target.
They are `null` for Attempts that did not fail and for the Nodes the fixture treats as old Agents (`kitchen-mini`, `fedora-ws`: their failures carry only the error code), and for the
`lock_failed` failure of an `ai-client` Target, which has a step but no path (the lock file is outside the Target base). `data.js` predates phase 2, so its Agent versions say nothing about this.
The excerpts in `data.js` are not part of the contract and are not served.

| Scenario | Open |
|---|---|
| `detailNode` | `?drive=detailNode#/nodes/studio-mini/problems` (step chip, failing path with the Target base, diagnostic with a copy button, catalog text kept, no excerpt) |
| `detailLock` | `?drive=detailLock#/nodes/design-imac/problems` (a step without a path) |
| `detailOld` | `?drive=detailOld#/nodes/kitchen-mini/problems` (an old Agent: one quiet line, no chip) |
| `detailActivity` | `?drive=detailActivity#/nodes/studio-mini/activity` (step on the attempt row, one-line diagnostic that expands) |
| `detailProblems` | `?drive=detailProblems#/problems` (same detail on the Problems page; the path is shown as sent) |
| `detailDeployments` | `?drive=detailDeployments#/deployments` (failed attempts of a rollout with step and expandable diagnostic) |
| `detailNone` | `?drive=detailNone&diag=0#/nodes/studio-mini/problems` (no detail anywhere: only the quiet line) |
| `detailXss` | `?drive=detailXss&xss=1#/nodes/studio-mini/problems` (hostile diagnostic and path render as text on all four screens; no injected element, no `alert`) |

Run each on `harness.html` and `harness-csp.html`; the CSP harness must log no violation.

## Fixture and the Server

The fixture's mutations are checked against the Server, not against the contract's prose. What differs from a naive fake:

| Call | Behaviour |
|---|---|
| `POST nodes/rename` | Both aliases are validated first (`400 invalid_node_alias`), then the Node is found by its exact current alias (`404 node_not_found`), then a revoked Node is refused (`409 node_revoked`), then occupancy is checked (`409 node_alias_in_use`, ignoring the Node itself). Renaming to the alias the Node already has succeeds and records nothing. |
| `POST enrollment-links` | `expiresInSeconds` defaults to 900 and must be 60 to 3600 (`invalid_expiry`), then the alias must be nonblank and at most 200 characters (`invalid_alias`). The alias is **not** checked for occupancy: that happens when the Agent enrolls (the simulated enrollment refuses an alias a Node already has, a revoked link and an expired link). |
| `POST enrollment-links/{id}/revoke` | An unknown link is `400 enrollment_not_found` (the Server's legacy code and status). Revoking is idempotent and only the first revocation is audited. A used link still reads as `consumed`; the state follows `ToLink` (consumed, then revoked, then expired, then active). |
| `POST nodes/{id}/revoke` | Idempotent for the Node (the first `revokedAt` stays) but every call is audited. Targets are left alone. |
| `POST nodes/{id}/remove` | Blank confirmation alias is `400 invalid_node_alias`, then `404 node_not_found`, then `409 node_alias_changed`. The enrollment links that created the Node are deleted with it. |
| `POST nodes/{node}/retry` | A blank target is `400 invalid_request` before the Node is looked up. |
| `POST cliproxy/selection` | Checks run in the Server's order: shape (`400 invalid_selection`), catalog (`404 catalog_unavailable`), pinned models (`409 pinned_model_excluded`, including the Claude-skip rule), empty selection (`400 invalid_selection`), and last the version (`409 stale_selection`). Families in neither list are frozen to the submitted `includeNew`. |
| `POST source/rescan`, `cliproxy/selection` | The Server writes no audit event for them, and neither does the fixture. |

The `fixtureContract` scenario asserts these.

## Screenshots and smoke tests (headless Chrome)

    CHROME=.../chrome-headless-shell
    $CHROME --headless --disable-gpu --hide-scrollbars --allow-file-access-from-files \
      --user-data-dir=$(mktemp -d) --window-size=1440,900 --virtual-time-budget=5000 \
      --screenshot=/tmp/x.png "file:///.../Dev/harness.html#/nodes"

Add `--enable-logging=stderr --v=0 --dump-dom` to see console messages and the DOM. With `?drive=scan#/route` the
page appends a PASS/FAIL log (stray `undefined`/`NaN` text, `h1`, horizontal overflow) to the DOM dump.
Other scenarios: `login`, `logout`, `retry`, `revoke`, `revokeConfirm`, `remove`, `removeConfirm`, `rename`, `wizard`,
`wizardStep2`, `wizardStep3`, `revokeLink`, `scopeRead`, `models`, `sync`, `range`, `search`, `expire`, `forbid`, `fixtureContract`, and the phase 2 `detail*` scenarios below.

Scenarios that need switches and a route:

| Scenario | Open |
|---|---|
| `raceNode` | `?drive=raceNode&delay=design-imac:2500#/nodes/design-imac` (A's response arrives after B is shown; actions must still target B) |
| `raceBack` | `?drive=raceBack&delay=studio-mini:2500#/nodes/studio-mini` |
| `weirdAlias` | `?drive=weirdAlias&weirdalias=1#/nodes/rack%2FA%20100%25` |
| `wizardExpiry` | `?drive=wizardExpiry&enroll=0&expiry=8&pagesize=1#/nodes` (link found by ID with a one-item page size; polling stops at expiry) |
| `wizardClose`, `wizardRoute` | `?drive=<name>&enroll=0&pagesize=1#/nodes` (polling stops when the dialog closes or the route changes) |
| `wizardDone` | `?drive=wizardDone&pagesize=1#/nodes` |
| `wizardStalled` | `?drive=wizardStalled&enroll=link#/nodes` with a large `--virtual-time-budget` (about 15 minutes) |
| `strips` | `?drive=strips#/nodes` (strips load only for cards near the viewport) |
| `stripsScroll` | `?drive=stripsScroll&iostub=1#/nodes` |
| `stripsDrop` | `?drive=stripsDrop&slow=1500#/nodes` in a tall window (`--window-size=1440,3000`) |
| `stripsRetry` | `?drive=stripsRetry&iostub=1&fail=nodes/#/nodes` |
| `wizardFailReads` | `?drive=wizardFailReads&enroll=0&expiry=8&fail=enrollment-links/#/nodes` (every link read fails; the expired state still appears at the deadline and polling stops) |
| `wizardHang` | `?drive=wizardHang&enroll=0&expiry=8&hang=enrollment-links/#/nodes` (a link read never answers; its timeout cancels it and the expired state appears) |
| `wizardStalledFail` | `?drive=wizardStalledFail&enroll=link&fail=nodes/#/nodes` with a large `--virtual-time-budget` (about 15 minutes; every Node read fails, so only the clock ends the wait) |
| `wizardStaleCreate`, `wizardStaleCreateError` | `?drive=<name>&enroll=0&lag=enrollment-links:3000#/nodes` (the second one adds `&forbid=1`): submit a link, close the wizard, open another; the late answer or error must not reach the new wizard |
| `renameStale`, `renameTab` | `?drive=<name>&lag=rename:3000#/nodes/studio-mini/settings`: the rename answers after the user went to Audit (no redirect, caches dropped, toast) or only switched tab on the same machine (still follows to the new alias) |
| `removeStale`, `removeKeep` | `?drive=<name>&lag=remove:3000#/nodes/studio-mini/settings`: same, for remove (no redirect to the list after leaving; redirect after a tab change) |
| `revokeStale` | `?drive=revokeStale&lag=revoke:3000#/nodes/studio-mini/settings` (the late answer must not close a dialog the user opened since) |
| `modelsStale`, `modelsRefreshStale` | `?drive=modelsStale&lag=cliproxy/selection:3000#/models` and `?drive=modelsRefreshStale&lag=cliproxy/refresh:3000#/models` (the late answer must not repaint the page the user is on) |
| `syncStale` | `?drive=syncStale&lag=rescan:3000#/problems` (no reload of the page the user went to) |
| `linkRevokeStale` | `?drive=linkRevokeStale&lag=revoke:3000#/enrollment` (same, for link revocation) |
| `stripsCancel` | `?drive=stripsCancel&slow=1500&iostub=1#/nodes` in a tall window (`--window-size=1440,3000`): a search that hides cards cancels their running requests; the rest load, four at a time |
| `stripsAway` | `?drive=stripsAway&slow=1500&iostub=1#/nodes`: scrolling away cancels the requests of cards that left the viewport and frees their slots at once |
| `deployments` | `?drive=deployments&pagesize=2#/deployments` |
| `audit` | `?drive=audit&pagesize=3#/audit` |

Mutation scenarios check that a completion which arrives after the user has moved on does not redirect, repaint, reload or close anything,
and that it still invalidates what it made stale. Fixed waits in the scenarios are virtual time under `--virtual-time-budget`, so a full run takes seconds;
give the long ones (`wizardStalled`, `wizardStalledFail`) a budget of about 1100000 and the others at least 60000.

Add `--run-all-compositor-stages-before-draw` to the Chrome command so layout-dependent code (IntersectionObserver, scrolling) runs.

`--allow-file-access-from-files` is only needed so the harness can load `../../../../artifacts/...` and `../Assets/...`
as plain classic scripts; the dashboard itself uses no ES modules.
