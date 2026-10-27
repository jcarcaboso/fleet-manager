# Fleet Manager dashboard

The Operator dashboard as its own application: Vue 3 (Composition API, `<script setup lang="ts">`), Vite, TypeScript, Vue
Router and Vitest. No UI framework, no state library, no CSS framework. The only runtime dependencies are `vue` and
`vue-router`. It is built, tested, versioned and served on its own address and talks to the Server only through
`/dashboard/api`. The design and rules are in [`docs/plans/separate-dashboard.md`](../docs/plans/separate-dashboard.md); every
route and response shape is in [`docs/technical-design/operator-api.md`](../docs/technical-design/operator-api.md) and
[`contracts/operator/*.json`](../contracts/operator).

**Status.** Every page of the previous, Server-embedded dashboard is ported: Machines, the machine page with its six tabs,
Problems, Deployments and revision pages, Repository, Models, Enrollment with the Add machine wizard, and Audit, with the shell,
sign-in, the typed API client, the session, the stale-response and polling protection, the shared components, the styles, the
mock API and the tests. The Server no longer serves a dashboard; it redirects `/dashboard` here.

## Run it

Node 24 or newer. Everything runs from `dashboard/`.

| Command | What it does |
|---|---|
| `npm ci` | Installs the locked, exactly pinned dependencies. |
| `npm run dev` | Vite dev server (`http://127.0.0.1:5173`) against a **real Server**, using `public/config.json`. |
| `npm run dev:mock` | Dev server against the **in-browser mock API**. No Server and no `config.json` needed. Switches are URL parameters, see [Mock API](#mock-api). |
| `npm test` | `vitest run`: unit, component and contract tests (happy-dom). No network, no Server. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run e2e` | Browser tests (Playwright) of the mock bundle under the production Content-Security-Policy. See [End-to-end tests](#end-to-end-tests-playwright). |
| `npm run e2e:ui` | The same suite in Playwright's UI mode, for debugging. |
| `npm run e2e:real` | The real-stack journeys against a running Server and dashboard; skipped without `FLEET_E2E_*` variables. `scripts/e2e-stack.sh` builds, seeds, runs and removes a disposable stack. |
| `npm run typecheck` | `vue-tsc --noEmit` over `src/`, `tests/` and `vite.config.ts` (TypeScript `strict`). |
| `npm run build` | Typecheck, then `vite build` into `dist/` (hashed assets, the CSS in its own file, nothing inlined). |
| `npm run preview` | Serves `dist/` on `http://127.0.0.1:4173` for a visual check. |
| `npm run build:mock` | Builds the mock-mode app into `dist-mock/` (for screenshots and browser checks; never deployed). |

The normal build contains no mock code: the mock is imported only when `import.meta.env.VITE_MOCK === '1'`, which only
`--mode mock` sets (`.env.mock`).

## Configuration

The page fetches `/config.json` with `cache: "no-store"` before it mounts:

```json
{ "apiUrl": "https://fleet.home.arpa:7443" }
```

`apiUrl` is the Server's origin. `src/config.ts` validates it: `https`, except `http://localhost` and `http://127.0.0.1`; an
origin only (no path, query, fragment or user info). A missing file, invalid JSON, a missing or invalid `apiUrl` shows the
configuration error page (`views/ConfigError/ConfigErrorView.vue`) instead of a blank screen. One build works for every
deployment; the container writes `config.json` from `FLEET_API_ORIGIN`. `public/config.json` is the development default
(`https://localhost:7443`).

In mock mode and in tests no config is fetched (`MOCK_API_URL = https://mock.fleet.invalid`).

### Pointing at a real Server

The session is the Server's cookie (`__Host-Fleet-Session`, `HttpOnly`, `Secure`, `SameSite=Strict`). Therefore:

- **Same site.** The dashboard and the Server must both be HTTPS and on the same host or registrable domain (ports and
  subdomains may differ). A different site never sends the cookie. After a successful login the dashboard calls `GET session`;
  if that is 401 it says: *"Your browser did not send the session cookie. The dashboard and the Server must be on the same site."*
- **CORS and Origin.** The Server must have `Fleet__DashboardOrigin` set to the dashboard's exact origin (for example
  `https://fleet.home.arpa:7444`). It adds CORS for that origin only and requires `Origin: <that origin>` on non-GET requests.
- **Development.** `npm run dev` serves HTTP by default, which a `SameSite=Strict` `Secure` cookie from an HTTPS Server will
  not follow. Serve the dev server over HTTPS on a host that is on the same site as the Server:
  `DEV_TLS_CERT=/path/cert.pem DEV_TLS_KEY=/path/key.pem DEV_HOST=localhost npm run dev`, set `public/config.json` (or serve
  your own `/config.json`) to the Server, and set the Server's `Fleet__DashboardOrigin=https://localhost:5173`.
- A Node alias of `.` or `..` cannot be addressed (browsers normalise those path segments); the Server rejects them with 400 anyway.

## Layout

```
dashboard/
  package.json  package-lock.json  vite.config.ts  tsconfig.json  index.html  env.d.ts  .env.mock
  public/            config.json (dev default), favicon.svg
  src/
    main.ts          entry: loads config (or starts the mock), mounts the app or the config error page
    app.ts           createFleetApp({ config, fetch, history }) -> { app, router, ctx }
    App.vue          just <AppShell/>
    config.ts        runtime config loading and validation
    legacyHash.ts    translates an old `#/nodes/...` bookmark into the new path at start-up (see Routes)
    context.ts       the shared context (client, session, stores) and useFleet()/useApi()/useSession()/useToasts()
    router.ts        route table, guards, route helpers
    api/             types.ts  client.ts  session.ts  messages.ts
    api/mock/        dataset.ts  server.ts  bind.ts  options.ts  browser.ts  index.ts
    components/      shared UI (AppShell, icons, status, modal, toasts, charts, art, ...)
    composables/     useView, useLoad, catalog, summary, toasts, tooltip, modalStack, useClipboard, useNow, ...
    lib/             pure TypeScript: format, model, targets, status, icons, charts, audit, lanes, errors
    styles/          tokens.css base.css components.css layout.css pages.css overlays.css live.css (imported by styles/index.ts)
    views/           one folder per page (see Routes)
  tests/             helpers/ (app, mock, fetch, contracts) and the tests
  e2e/               Playwright: mock/ (the browser suite), real/ (journeys against a real stack), support/ (fixture rules, helpers)
  playwright.config.ts  playwright.real.config.ts
```

The old dashboard's `style.css` is ported verbatim (every class name and rule; only the `body:not(.app)` rules of the Server's
`/enroll` page are dropped), split into contiguous slices that are imported in the original order. `<body class="app">` is set in
`index.html`; the CSS depends on it. Views reuse the existing class names; do not rename or restructure the CSS.

## Routes

History mode, no `#`. The container serves `index.html` for these paths.

| Path | Route name | View |
|---|---|---|
| `/` | redirect to `machines` | |
| `/login` | `login` (public) | `views/Login/LoginView.vue` **(done)** |
| `/machines` | `machines` | `views/Machines/MachinesView.vue` |
| `/machines/:alias/:tab?` | `node` | `views/Node/NodeView.vue` with `OverviewTab.vue`, `InstalledTab.vue`, `ProblemsTab.vue`, `ActivityTab.vue`, `SecurityTab.vue`, `SettingsTab.vue` |
| `/problems` | `problems` | `views/Problems/ProblemsView.vue` |
| `/deployments` | `deployments` | `views/Deployments/DeploymentsView.vue` |
| `/deployments/:revisionId` | `revision` | `views/Revision/RevisionView.vue` |
| `/repository` | `repository` | `views/Repository/RepositoryView.vue` |
| `/models` | `models` | `views/Models/ModelsView.vue` |
| `/enrollment` | `enrollment` | `views/Enrollment/EnrollmentView.vue`; the Add machine wizard is `views/Enrollment/AddMachineWizard.vue` |
| `/audit` | `audit` | `views/Audit/AuditView.vue` |
| anything else | `notFound` | `views/NotFound/NotFoundView.vue` **(done)** |

- `:alias` is one percent-encoded path segment (`rack/A 100%` is `/machines/rack%2FA%20100%25`); the router decodes it once. Build
  links with `nodeRoute(aliasOrId, tab?)`, never by string concatenation. `:tab` is one of `NODE_TABS`; an unknown tab means Overview
  (`normalizeTab`). Each tab component takes the loaded machine as an optional `node` prop from `NodeView`.
- `/deployments/:revisionId` is the revision page for a UUID. The old dashboard also accepted `/deployments/<short SHA>` as the
  list scrolled to that revision: the router redirects any non-UUID id to `/deployments?revision=<value>` (replace), and
  `DeploymentsView` scrolls to `route.query.revision` (`isRevisionId(id)` is the test).
- The old `#/add` route (the wizard opened over the gallery) is not a route: any page opens the wizard with
  `useFleet().wizard.show()`; `AppShell` mounts `AddMachineWizard.vue` while `wizard.open` is true. `/machines?add=1` (what the old
  `#/add` bookmark becomes) opens it over the gallery and cleans the address.
- **Old bookmarks.** The Server redirects `/dashboard` here and browsers keep the fragment, so a bookmark
  `https://SERVER/dashboard#/nodes/studio-mini/problems` arrives as `https://DASHBOARD/#/nodes/studio-mini/problems`. `createFleetApp`
  (without a test history) calls `applyLegacyHash()` (`src/legacyHash.ts`) before the router reads the address; it replaces the
  address (no history entry) by the path of the same page: `#/nodes` is `/machines`, `#/nodes/<alias>[/<tab>]` is
  `/machines/<alias>[/<tab>]` (the alias exactly as it was encoded, `rack%2FA` stays `rack%2FA`), `#/problems`, `#/deployments[/<id>]`,
  `#/repository`, `#/models`, `#/enrollment` and `#/audit` keep their names, `#/add` is `/machines?add=1`. Anything else (including `#/`)
  is left alone. The table is `legacyHashPath()`, tested in `tests/legacy-hash.test.ts`.
- `<RouterView>` renders the page with `:key="routeViewKey(route)"` (route name plus machine alias and revision ID). A page
  reused for another machine is a **new component**: its state, requests and polls are gone. Switching tabs on the same machine
  keeps it: the machine and its issues are read again, quietly (no skeleton, stale answers dropped), when a tab change comes more than
  15 s after the last read (`STALE_MS` in `views/Node/nodePage.ts`; the old dashboard's rule), and any route change (Back, Forward, a tab
  link) closes the Revoke and Remove dialogs. After a navigation the first heading that mounts takes keyboard focus (`PageHead`, `EmptyState h="h1"`,
  `ErrorState`); when only the tab changes, `TabNav` focuses the active tab.
- After a navigation the router also hides a tooltip that the old page left (`router.afterEach` in `AppShell`).
- `pagehide` (the page may return from the back/forward cache as it was) clears the token field and closes the Add machine wizard, which
  drops its one-time enrollment link and stops its polling.
- Guards: every non-public route first restores the session once (`GET session`). Signed out: redirect to `/login`, keeping the
  intended path in `?redirect=` (not for `/` and `/machines`). `safeRedirect()` only accepts paths of this app. A session that ends
  while a page is open (401) also goes to `/login?redirect=<current>` with the notice "Your session ended. Sign in again.". If the
  first `GET session` fails with anything but 401 (Server unreachable) the shell shows "Could not load the dashboard" with
  "Try again".

## The shared API for view authors

### Context: `useFleet()` (`src/context.ts`)

```ts
const { api, session, catalog, summary, toasts, shared, wizard, shell, openState, renameNotes, gallery, enrollmentBus, config } = useFleet();
```

| Member | Type | Use |
|---|---|---|
| `api` | `ApiClient` | the typed client (also `useApi()`) |
| `session` | `Session` | `state.actor`, `state.scope`, `can(level)` (also `useSession()`) |
| `catalog` | `ErrorCatalog` | `await catalog.load()`, `catalog.get(code)`, `catalog.title(code)`, `catalog.map`, `catalog.loaded` |
| `summary` | `NavSummary` | `summary.refresh(force?)` after something that changes problems or catalogs (the shell refreshes on navigation, at most every 20 s); `summary.state.errors`, `.modelsBad`, `.issues` |
| `toasts` | `ToastStore` | `toasts.push(title, { tone?, text?, sticky? })`, `toasts.fail(error, title?)` (also `useToasts()`) |
| `shared` | `SharedState` | `syncing`, `lastSync`, `refreshing`, `lastRefresh`: state of the Sync and Refresh buttons that appear on several pages |
| `wizard` | `WizardState` | `show()`, `hide()`, `open` |
| `shell` | `ShellState` | `markLoaded()` (footer "Loaded 14:30 UTC"), `focusPending` |
| `openState` | `Map<string, boolean>` | `<details>` open state by key (used by `DiagLine`, `FileList`) |
| `renameNotes` | `Map<string, string>` | the "Renamed from …" sentence for the page a rename opens, by the new alias; taken by that page, dropped when the navigation fails or the session ends |
| `gallery` | `GalleryPrefs` | grouping, sort, Retired open and the search text of the Machines page; kept between visits (like the old module-level state). The search is cleared when a link is created (`enrollmentBus.created`), when a machine is renamed or removed, and at sign-out |
| `enrollmentBus` | `EnrollmentBus` | what the Enrollment page, the gallery and the Add machine wizard tell each other (`version`, `created`, `revoked()`, `request`, `formMsg`); reset at sign-out |

`createFleetContext({ config, fetch })` builds it. The client, session, catalog, summary and toasts are reset when the session
starts or ends, and so is every other piece of state that belongs to one Operator: the wizard, the shared Sync/Refresh results, the
rename notes, the gallery search and the enrollment bus (one watcher in `context.ts`; add new per-session state there). In tests use `mountApp()` / `componentHarness()` (below).

### API client (`src/api/client.ts`)

```ts
interface ApiClient {
  readonly apiUrl: string;
  get<T>(path: string, params?: QueryParams, opts?: { signal?: AbortSignal }): Promise<T>;
  post<T>(path: string, body?: unknown, opts?: { signal?: AbortSignal; login?: boolean }): Promise<T>;
  put<T>(...): Promise<T>;                       // same mutation path; no current route uses it (CORS allows GET, POST, OPTIONS only)
  page<T>(path, params?, opts?): Promise<{ items: T[]; nextCursor: string | null }>;   // limit defaults to 100
  all<T>(path, { params?, maxPages = 10, signal? }): Promise<{ items: T[]; truncated: boolean }>;
  renewCsrf(signal?): Promise<void>;  clearCsrf(): void;
}
class ApiError extends Error { status: number; code: string | null; details: ErrorBody | null; silent: boolean }
```

`path` is relative to `/dashboard/api/` and **you** encode path segments: ``api.get<NodeDetail>(`nodes/${segment(alias)}`, undefined, { signal })``
(`segment` is `encodeURIComponent`; `enc` from `lib/format` is the same). Response and request types are in `src/api/types.ts`
(`NodeListItem`, `NodeDetail`, `NodeAttempt`, `CheckinsResponse`, `Issue`, `IssuesResponse`, `ErrorCatalogEntry`, `SourceStatus`,
`SourceScan`, `DesiredRevisionItem`, `DesiredRevisionDetail`, `RolloutItem`, `RolloutDetail`, `RolloutAttempt`, `RevisionWarning`,
`AuditEvent`, `EnrollmentLink`, `CreateEnrollmentLinkResponse`, `CliProxyStatus`, `CatalogSelection`, `SaveSelectionRequest`,
`SelectionPolicy`, `RetryRequest/Response`, `RenameRequest/Response`, …). A property a Server from before a phase does not send is
optional there (`agent?`, `disk?`, `drift?`, `commit?`, `path?`, `step?`, `state?`): code must tolerate `undefined`.

Behaviour (ported from `api.js`):

- Every request: `credentials: "include"`, `cache: "no-store"`, `Accept: application/json`, the signal. Mutations also send
  `Content-Type: application/json` and `X-Fleet-CSRF`; the token is fetched lazily with `GET csrf`, kept in memory only, and fetched
  again **once** when the Server answers `invalid_csrf`.
- Errors are `ApiError`s with the user-facing `message` (from `src/api/messages.ts`, falling back by status), the Server's `code`,
  the `status` and the parsed body in `details` (for example `pinned_model_excluded` carries `models`).
- **Silent errors** (`error.silent`): a call cancelled through its signal (`code: 'cancelled'`) and a 401 that the shell already
  handled (`code: 'unauthorized'`). Never show them. `toasts.fail(e)` skips them; use `soft` and `isSilent` from `lib/errors`.
- 401 (not login): calls the session's hook, which ends the session and sends the visitor to `/login`. 403 `insufficient_scope`: an
  ordinary visible error; show it inline (`ErrorState` renders status 403 as "Your token cannot open this").
- Network failure: `code: 'network_error'`, "Could not reach the Server at <apiUrl>. …".
- A response that arrives after the caller aborted is dropped (rejects as cancelled).
- Paged lists: `limit` 1 to 100, `after`, and `order: 'newest'` for `desired-revisions`, `rollouts` and `audit`. A cursor is valid
  only with the `order` it came from. Use `all` for lists a screen needs whole (machines, warnings, links), `page` for the rest.

### Session (`src/api/session.ts`)

`session.state` is reactive: `{ actor, scope, status: 'unknown' | 'signedOut' | 'signedIn', notice, bootError }`.
`session.can('read' | 'operate' | 'admin')` (`admin` includes `operate` includes `read`), `session.scopeLabel()`, `scopeTitle()`,
`denied(level)` ("Needs the admin scope. Your token has read access."), `restore()`, `ensure()`, `retryBoot()`,
`login(token)`, `logout()`, `takeNotice()`. Only `{ actor, scope }` is kept; the Operator token is passed to `post('login')` once
(`src/api/session.ts` is the only code allowed to do that) and the login view clears the field before the request.

### Stale-response protection and polling (`useLoad`, `useView`, `Token`, `lib/lanes.ts`)

The key shared piece. Every load a view starts is tied to the component scope and to a generation counter, so a response for a
load that has been replaced, or whose view is gone, can never change state, and its request is aborted.

```ts
const { data, error, loading, refreshing, run, reload } = useLoad(async token => {
  const [nodes, issues] = await Promise.all([
    api.all<NodeListItem>('nodes', { maxPages: 5, signal: token.signal }),
    api.get<IssuesResponse>('issues', undefined, { signal: token.signal }).catch(soft),   // a failing extra read degrades the page
  ]);
  return { nodes: nodes.items.map(fromList), issues: issues?.items ?? [] };
});
```

- `useLoad(loader, { immediate = true, key?, view?, keepData? })`. `loader(token)` receives a `Token`. Each `run()` aborts the
  previous run's signal and starts a new generation. `data` / `error` / `loading` are committed **only if the token is still
  current**; a superseded or aborted run changes nothing. `run({ quiet: true })` refreshes in the background: `loading` stays
  false, `refreshing` is true, the old data stays. `run()` never rejects. `key: () => route.params.x` reloads when it changes. **`reload()` is for the user's own Refresh / Try again / Check again:** like `run()`, but it sets `shell.focusPending`, so the heading that mounts when the loading state gives way to the page takes the keyboard focus (the pressed button was replaced, and focus would fall to `<body>`). Use `run({ quiet: true })` for background refreshes that keep the page.
- `Token`: `signal` (pass it to every API call), `isCurrent()`, `check()` (throws the silent `SupersededError`; call it after an
  `await` that does not use the API client), `guard(promise)`.
- `useView({ key? })` gives the raw pieces: `visit()` (a token for "the user is still on this page": take it before a mutation, check
  `isCurrent()` after the `await` before redirecting, repainting or closing anything, because the user may have moved on),
  `lane()` (an independent "only the newest counts" sequence, for example saves), `poll(...)`, `signal`, `alive`.
- **Bounded polling** stops on its own and when the view goes away:

  ```ts
  const view = useView();
  view.poll(token => api.get<NodeDetail>(`nodes/${segment(id)}`, undefined, { signal: token.signal }), {
    intervalMs: 5000,                 // between the end of a tick and the start of the next (ticks never overlap)
    timeoutMs: 150_000,               // at the deadline the tick in flight is aborted, polling stops, onTimeout runs
    done: node => node.disk?.refreshRequestedAt === null,     // return true to stop
    onTimeout: () => { /* "No answer yet…" */ },
    // also: maxTicks, immediate (default true), onError (return 'stop'), onStop(reason)
  });
  ```
- `superseded()` / `SupersededError` (`lib/errors`): thrown by `token.check()`; silent, so a view that rethrows it is ignored by
  `useLoad` and by `toasts.fail`. `soft(e)` turns any non-silent failure into `null` for reads that may fail without failing the page.
- Tests for this: `tests/composables/lanes.test.ts`, `useLoad.test.ts`, and `tests/app/stale.test.ts` (a probe view inside the real app).

### Components (`src/components`)

Status is always icon plus label. Nothing renders data as markup (`MdText` turns backticks into `<code>` elements).

| Component | Props / use |
|---|---|
| `Icon` | `name: IconName` (the 39 icons of the old set, same names and paths). Add `class`. |
| `StatusGlyph`, `StatusPill`, `StateTag` | `level` + `kind`; pill adds `label`; `StateTag :state="'failed'"` for Assignment/Attempt states |
| `PageHead` | `title`, `sub`, `#actions` slot (the `<h1>`, focused after navigation) |
| `EmptyState`, `ErrorState`, `InlineError`, `LoadingBlock` | empty/error/loading blocks; `ErrorState` emits `retry`; `LoadingBlock kind="cards"` for the gallery |
| `Modal` | `title`, `subtitle`, `icon`, `tone`, `wide`, `persistent`; default slot body, `#footer`; emits `close`. Focus trap, Escape and backdrop close, focus restored, `aria-modal`; teleports into `#modal-root` |
| `ConfirmDialog` | `title`, `confirmLabel`, `danger`, `busy`, `error`, `confirmPhrase` (typed alias); emits `confirm`, `close` |
| `ToastHost` | mounted by the shell; push toasts with `useToasts()` |
| `CopyButton`, `CopyBox` | `text` / `cmd`; Clipboard API with a textarea fallback; "Copied" / "Press Ctrl+C" |
| `ScopeButton`, `ScopeGate`, `LockNote` | `level`; a locked button stays focusable, explains itself and makes no request |
| `TabNav` | `items: TabItem[]`, `current`, `label` (link tabs with counts) |
| `Segbar`, `Legend`, `ChipsFilter`, `StepsList` | state bars from `stateParts(counts)`, filter chips (`v-model`), numbered steps |
| `CheckinStrip`, `CheckinChart`, `GapList` | check-in charts from `GET nodes/{node}/checkins` buckets (hover, arrow keys) |
| `DeviceArt` | `node`, `health` (needs the gradients that `AppShell` mounts) |
| `FailureDetail`, `StepChip`, `DiagLine`, `FileList`, `Timeline` | Attempt detail (step, failing path, diagnostic), expandable lines, the Activity timeline |
| `ChangeChips`, `IssueBanner`, `IssueActions` | revision diff chips, acknowledged/snoozed banner, Acknowledge/Snooze/Reopen (emits `state`, does not call the API) |
| `Countdown`, `CountdownBar`, `RevChip`, `Avatar`, `MdText`, `BrandMark` | small pieces |

Dynamic widths and positions use `:style="{ width: … }"` bindings, which Vue applies through the DOM and the CSP allows; never put
a `style="…"` string in a template. Tooltips: any element with `data-tip="value|label\nextra row"`. Overlays: `Modal` (not hand-made
`position: fixed` boxes). Page title: `useDocumentTitle(() => alias)`. Live clocks: `useNow()`.

### Helpers (`src/lib`, pure TypeScript, tested)

- `format.ts`: `num`, `plural`, `listText`, `shortSha`, `shortId`, `hostOf`, `isUuid`, `platformLabel`, `enc`, `ms`, `valid`, `span`,
  `fmtTime`, `fmtDay`, `fmtFull`, `fmtYearFull`, `rel`, `until`, `dayKey`, `dayLabel`, `clock`, `countdownText`, `bytes` (GiB/TiB with
  one decimal), `percent`, `digestShort`, `mdParts`, `SEC/MIN/HOUR/DAY`, `now()`. All times are UTC.
- `targets.ts`: `targetKind`, `targetClient`, `targetLabel`, `targetShort`, `targetIcon`, `targetWhere`, `stepLabel`, `failPath`,
  `hasDetail`, `NO_DETAIL`, `tstate`, `attemptVerb`, `STATES`, `stateParts`, `emptyCounts`, `addCounts`, `countTotal`.
- `model.ts`: view models `fromList`, `fromDetail`; `health(n, failures, catalog.title)`, `isAttention`, `seenText`; disk (`diskVolume`,
  `diskDetail`, `diskLevel`, `diskOf`, `diskHot`, `DISK_WARN`, `DISK_CRIT`); Agent (`agentInfo`, `osText`, `agentOutdated`, `upgradePlan`,
  `fixSteps`, `SEMVER`); certificates (`certText`, `certFlag`); issues (`issueLevel`, `issueKind`, `issueBadge`, `sortIssues`,
  `issuesByNode`, `failuresFromIssues`, `issueSection`, `issueState`, `isOpen`, `errorCount`, `SNOOZE`, `patchIssue`); revisions and rollouts
  (`commit`, `revTitle`, `revisionDetail`, `rolloutDetail`, `nodeRank`, `drift`, `recentDrift`); `scanOutcome`.
- `audit.ts`: `auditLabel`, `auditIcon`, `actorName`, `actorRole`. `charts.ts`: geometry and text for the check-in charts.
- **Commands built for copying use validated pieces only.** `upgradePlan` puts a version into a command only when it matches
  `SEMVER`; the commands of an issue (`issue.commands`) come from the Server and are shown with `CopyBox` as text. Never build a
  shell command by interpolating Server strings that were not validated.

### Writing a view

```vue
<script setup lang="ts">
import { computed } from 'vue';
import type { IssuesResponse } from '@/api/types';
import PageHead from '@/components/PageHead.vue';
import ErrorState from '@/components/ErrorState.vue';
import LoadingBlock from '@/components/LoadingBlock.vue';
import { useFleet } from '@/context';
import { useLoad } from '@/composables/useLoad';
import { sortIssues } from '@/lib/model';

const { api, catalog, shell } = useFleet();
const { data, error, loading, reload } = useLoad(async token => {
  const [issues] = await Promise.all([api.get<IssuesResponse>('issues', undefined, { signal: token.signal }), catalog.load()]);
  shell.markLoaded();
  return sortIssues(issues.items);
});
</script>

<template>
  <LoadingBlock v-if="loading && !data" />
  <div v-else class="wrap">
    <ErrorState v-if="error" :error="error" what="Problems" @retry="reload()" />
    <template v-else-if="data"><PageHead title="Problems" sub="…" /> … </template>
  </div>
</template>
```

Test it against the mock (`tests/app/stale.test.ts` and `tests/router.test.ts` are the models):

```ts
const app = await mountApp({ path: '/problems', mock: { scope: 'read' } });   // shell + router + fresh session + fresh mock
await app.go('/problems');                                                    // navigate and let lazy routes and promises settle
expect(app.wrapper.find('#view h1').text()).toBe('Problems');
expect(app.mock.calls.filter(c => c.method === 'POST')).toHaveLength(0);       // assert on requests
app.unmount();                                                                 // in afterEach
```

## Mock API

`src/api/mock/` is a contract-faithful, in-memory implementation of every route, ported from the old `Dev/fixture.js` (and
`artifacts/dashboard-prototypes/data.js`, now `dataset.ts`: 14 machines, 5 revisions, rollouts, two CLIProxy catalogs, links, audit).
It is a `fetch` replacement that the client takes through its `fetch` option; no global is patched. It follows the Server: the
Origin check (400 `invalid_origin`), then the CSRF token (400 `invalid_csrf`), then scope (403 `insufficient_scope`), then validation
and lookups in the Server's order, with the same codes, `order=newest` and `(order, offset)` cursors, audit events on mutations, a
simulated Agent that enrolls a few seconds after a link is created and answers disk refreshes after `diskdelay`. Its own tests are
`tests/mock/contract.test.ts` (ports of the old `fixtureContract` and `fixturePhase4`, plus a shape comparison with every
`contracts/operator/*.json`) and `tests/mock/bodies.test.ts` (request bodies and the CSRF token).

**Request bodies are bound like the Server binds them** (`src/api/mock/bind.ts`). The Server reads each body into a C# record with
`UnmappedMemberHandling = Disallow`: an unknown member, a value of the wrong type (`hours: "4"`, `expiresInSeconds: 900.5`), a missing
`[JsonRequired]` member (`id` and `action` of `issues/state`), no body, invalid JSON or a body that is not an object is
`400 invalid_request` ("The request is malformed or a parameter is invalid.") before the route runs (after authentication, before the
Origin, CSRF and scope checks, because ASP.NET binds the arguments first). A member that is not required and missing keeps the record's
default and the route's own check answers (`alias` missing on `nodes/rename` is `invalid_node_alias`, `expiresInSeconds` missing is 900).
Member names match without regard to case. The shapes are `login {token}`, `nodes/rename {currentAlias, alias}`,
`nodes/{id}/retry {target}`, `nodes/{id}/remove {alias}`, `issues/state {id, action, hours?}`, `enrollment-links {alias, expiresInSeconds}`
and `cliproxy/selection {baseUrl, version, policy {includeNew, disabledFamilies, modelOverrides, enabledFamilies,
skipClaudeModelsForOtherClients}}`; the routes without a body parameter (`revoke`, `disk-usage/refresh`, `logout`, `source/rescan`,
`cliproxy/refresh`) ignore what is posted, like the Server. When a route changes in `OperatorApi.cs` / `WireModels.cs`, change `SHAPES`.
A refused call has `call.malformed === true`.

**The CSRF token is bound to the identity**, as the real antiforgery token is: `mock.state.csrf` changes at login and at logout, and a
request that still carries the earlier one is `400 invalid_csrf` (the client then asks for a new token and retries once; `call.status`
shows the 400). A client that forgets `clearCsrf()` after login or logout therefore shows an extra 400 in `mock.calls`, which
`tests/mock/bodies.test.ts` checks for.

```ts
const mock = createMockServer({ scope: 'read', pageSize: 2 });       // options as in the table below
const api = createApiClient({ apiUrl: MOCK_API_URL, fetch: mock.fetch });
mock.calls   // every call: { method, path, query, body, headers, at, settled, aborted, status, malformed }
mock.state   // { signedIn, scope, actor, csrf }   mock.nodes / links / audit / issueStates   mock.dispose() stops the simulated Agents
```

In `dev:mock` the switches are query parameters of the page you open (read once at start, so a reload without them resets them);
`window.__MOCK` exposes the server. In tests pass them as options (`mountApp({ mock: { … } })`, `createMockServer({ … })`).

| URL parameter | Option | Effect |
|---|---|---|
| `scope=read\|operate\|admin` | `scope` | Session scope (default `admin`). Controls the scope does not allow are locked. |
| `signedout=1` | `signedOut` | Start at the sign-in page. Any token of 32 to 1024 characters not starting with `bad` signs in. |
| `empty=1` | `empty` | No machines, links, audit events or revisions. |
| `fail=<prefix>` | `fail` | `GET` routes starting with the prefix answer 500 (`fail=nodes`). |
| `forbid=1` | `forbid` | Every non-GET request answers 403 `insufficient_scope`. |
| `slow=<ms>` | `slow` | Delay every response (shows the loading states). |
| `pagesize=<n>` | `pageSize` | Cap the page size to exercise cursors and "load more". |
| `diag=0` | `diag: false` | No phase 2 attempt detail (`diagnostic`, `path`, `step` null). |
| `xss=1` | `xss` | Hostile strings in diagnostics, paths, volume labels, Agent report, commit subject and author, Skill name, drift path and Operator name. Views must show them as text. |
| `agent=0` | `agent: false` | No `agent` property and no `agent_outdated` issue (a Server before phase 3). |
| `diskdelay=<ms>` | `diskDelay` | How long a refreshed Agent takes to answer `POST nodes/{node}/disk-usage/refresh` (default 7000). Old Agents and offline machines never answer. |
| `enroll=0` / `enroll=link` | `enroll: false` / `enrollLinkOnly` | The simulated enrollment never happens / the link is consumed and the Node exists but never checks in. |
| `expiry=<s>` | `expiry` | Links created by the wizard expire after this many seconds. |
| `platform=linux` | `platform` | Platform of machines enrolled through the wizard (default `macos`). |
| `weirdalias=1` | `weirdAlias` | The first machine is called `rack/A 100%`. |
| `delay=<alias or id>:<ms>[,…]` | `delay` | Delay `GET nodes/{node}…` for that machine (overlapping loads). |
| `lag=<text>:<ms>[,…]` | `lag` | A POST whose path contains `<text>` does its work at once but answers later (a mutation that completes after the user moved on). |
| `hang=<prefix>` | `hang` | `GET` routes under the prefix never answer; only the caller's abort ends them. |
| `commit=0` | `commit: false` | No revision has commit metadata (a Server before phase 4). |
| `norollout=1` | `rollout: false` | `desired-revisions/{id}.rolloutId` is null. |
| `drift=0` | `drift: false` | `nodes/{node}` has no `drift` property. |
| `states=1` | `states` | An acknowledged and a snoozed issue exist from the start. |
| `offline=1` | `offline` | Every request fails like a network error. |
| `cookie=0` | `cookie: false` | The browser never sends the session cookie: login succeeds, `GET session` after it is 401 (the "same site" message). |
| `csrfcookie=0` | `csrfCookie: false` | The browser also drops the antiforgery cookie, as on another site: every mutation, login included, is 400 `invalid_csrf` and the client shows the "same site" message. |
| `origin=<url>`, `dashboardorigin=<url>` | `origin`, `dashboardOrigin` | The Origin the browser sends, and the origin the Server allows: a mismatch makes non-GET requests 400 `invalid_origin`. |

The mock's dataset is anchored at a fixed "now" and shifted to the real clock at start, so "5 min ago" holds. With fake timers
(`vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })`, which leaves `setImmediate`
alone so `flushPromises` works) it follows the fake clock.

## Tests

Vitest, `@vue/test-utils`, happy-dom. `tests/helpers/`:

- `app.ts`: `mountApp({ path?, mock?, mountApp? })` mounts the real app (shell, router with a memory history, a fresh session and a
  fresh mock) and returns `{ wrapper, router, ctx, mock, go(path), settle(), signIn(), setScope(scope), unmount() }`; `settle()` waits
  for promises and for lazy route components; `waitFor(check)` polls (and advances fake timers); `componentHarness(mockOptions)` gives
  `{ ctx, mock, router, global }` for mounting one component (`mount(Comp, { global })`); `TOKEN` / `BAD_TOKEN` are tokens the mock
  accepts and rejects; `textOf(el)`.
- `mock.ts`: `mockApi(options)` gives `{ mock, api, session }` without components. `fetch.ts`: `scriptedFetch(...replies)` for client
  tests. `contracts.ts`: reads `contracts/operator/*.json`, found relative to the test file (`import.meta.url`), not to the working
  directory; a missing directory **fails** the contract tests, they never skip.
- `console.ts` and `strict.ts`: the two guards below.
- Coverage of the foundation: config, client (CSRF retry, abort, error mapping, encoding of aliases, never touching storage), session
  and the cookie-not-sent message, route guards, the shell badges, sign-in end to end, `useLoad`/`useView`/polling, `Modal` focus trap,
  every shared component and `lib` helper, the mock against the contract, and `tests/security/source-scan.test.ts`.

### Guards that every test runs under (`tests/setup.ts`)

- **No console noise.** `console.error`, `console.warn` and Vue warnings (`config.global.config.warnHandler` of `@vue/test-utils`,
  which covers every `mount()`) are recorded and fail the test that caused them, as the old `Dev/drive.js` did. A test that expects them
  says so and gets the messages: `const logged = expectConsole('error')` (or `'warn'`, or both) from `tests/helpers/console.ts`, then
  `expect(logged.error)…`. `tests/console-guard.test.ts` covers the guard itself.
- **No refused request bodies.** Every mock created through `mountApp`, `componentHarness` or `mockApi` is watched; a test fails when
  the mock refused a body as the Server would (`call.malformed`, see Mock API), so a view that sends an unknown member fails its own
  tests. A test that sends such bodies on purpose calls `allowMalformedBodies()` (`tests/helpers/strict.ts`).
- **Keyboard focus.** Chromium drops focus to `<body>` when a focused button becomes `disabled` (Sync repository, Refresh, Retry now …);
  `composables/keepFocus.ts` (installed by `AppShell`) gives it back when the button is enabled again and the user has not pressed
  anything meanwhile (`tests/composables/keepFocus.test.ts`). `tests/app/focus.test.ts` presses every Refresh, Try again, Check again and Sync button and asserts that focus is
  on the page heading or still on the page, never on `<body>`.

## End-to-end tests (Playwright)

`npm test` runs components in happy-dom. `e2e/` runs the real bundle in a real browser, in two modes. `@playwright/test` is a pinned
**dev** dependency only; the runtime dependencies are still `vue` and `vue-router`.

### Mock mode: `npm run e2e`

Fast, no Server, runs in CI. `playwright.config.ts` starts a `webServer` that builds the mock bundle (`vite build --mode mock`) into the
private, git-ignored directory `.e2e-dist/` and serves it with `vite preview` on `http://127.0.0.1:4179` (`e2e/support/vite.e2e.config.ts`).
The preview sends the **production** `Content-Security-Policy` (read from `nginx/entrypoint.sh`, so it cannot drift; `connect-src 'self'`
because the mock API runs in the page), `Referrer-Policy`, `X-Content-Type-Options` and `Cache-Control: no-store`, and answers the
application routes with `index.html` exactly as `nginx.conf` does, including aliases with dots (`/machines/build.box`). A CSP violation
therefore fails a test instead of passing unnoticed.

Browser: Playwright's own Chromium (`npx playwright install --with-deps chromium`, what CI does), or any Chromium-family binary named by
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` (for example a `chrome-headless-shell` already on the machine); nothing is downloaded globally by the suite.
Each test starts a fresh page and therefore a fresh mock; the mock's switches ([Mock API](#mock-api)) are URL parameters:
`open(page, '/machines', { scope: 'read' })`. `window.__MOCK.calls` tells a test which requests the page made (`mockCalls`, `mockWrites`),
which is how "a locked control sends no request" is checked. Time-dependent behaviour uses Playwright's clock (`page.clock.install()`,
`page.clock.runFor(150_000)` for the 150 s disk-refresh limit, the wizard's expiry and first check-in) instead of waiting.

| File (`e2e/mock/`) | Journeys |
|---|---|
| `session.spec.ts` | sign in (token never stored), wrong token, empty field, sign out, a 401 while a page is open returns to it after signing in, `?redirect=` only to this app, the "same site" message, an unreachable Server |
| `machines.spec.ts` | cards, search, group by status/platform/OS, sort, disk meters, lazily loaded check-in strips |
| `machine-page.spec.ts` | the six tabs, retry a failed Target, disk refresh answered and unanswered, rename (and its errors), revoke, remove with alias confirmation |
| `problems.spec.ts` | tabs and counts, acknowledge, snooze, reopen, retry, the navigation badge |
| `deployments.spec.ts` | rollout, machine filters, revision page (diff, per-machine progress), compare with the previous revision, load older, attempts, short-SHA address |
| `repository-models.spec.ts` | sync, recent scans, model selection edit / save / reset / pinned-model refusal, refresh |
| `enrollment.spec.ts` | Add machine wizard to the first check-in, validation, revoking, expiry, the links list, the form |
| `audit.spec.ts` | list, filters, search, load older |
| `scopes.spec.ts` | `read`, `operate`, `admin`: locked controls explain themselves and send no request; a 403 from the Server |
| `routing.spec.ts` | old `#/…` bookmarks, deep links and reload on encoded and dotted aliases, titles, Back and Forward |
| `layout.spec.ts` | 390 × 844: no sideways scrolling on any page, dialogs inside the screen; accessibility smoke (below) |
| `focus.spec.ts` | keyboard focus after Refresh / Check again / Sync, focus trap and Escape in dialogs |
| `states.spec.ts` | error, empty and loading states, hostile text rendered as text |
| `guard.spec.ts` | the fixture rules below notice what they claim to, and the preview serves the production headers |

**Fixture rules** (`e2e/support/fixtures.ts`, `guard.ts`). Every test fails on: console errors and warnings, uncaught page errors and
unhandled rejections, Content-Security-Policy violations (a `securitypolicyviolation` listener installed with `addInitScript`, and Chromium's
own report), and requests that fail or answer 400 or above. (A request the page cancels itself, `net::ERR_ABORTED`, is not a failure: the
dashboard aborts the requests of a view that is gone, by design.) A test that expects one says so *before*, with the `allow` fixture:
`allow.console(/…/)`, `allow.pageError(/…/)`, `allow.csp(/…/)`, `allow.request(/…/)`. An allowance that matched nothing fails the test too, so
a stale one cannot hide a regression. `guard.spec.ts` proves each rule by provoking it. There is no `test.skip` in the mock suite and no
retry (`retries: 0`): a flaky test is fixed.

**Accessibility smoke, without axe-core.** `layout.spec.ts` checks, on every page, from the browser's accessibility tree (`ariaSnapshot`)
and the DOM: exactly one `h1`, `lang`, a distinct title, the `banner`, `Primary` navigation, `main` and `contentinfo` landmarks, the skip
link, an accessible name for every button, link, field and control, labelled form fields, no duplicate ids, no dangling
`aria-labelledby` / `aria-describedby`, and that dialogs are modal and named. `axe-core` was left out on purpose: it would add a
dev dependency (`@axe-core/playwright` and `axe-core`, a large rule set) for what is mostly colour contrast and ARIA validity, which this
design system's tokens and the component tests already pin down; the structural checks above catch the regressions that actually happened
in the old dashboard. Add `@axe-core/playwright` if accessibility becomes a release gate.

### Real-stack mode: `npm run e2e:real`

A smaller set of journeys (`e2e/real/`, `playwright.real.config.ts`, one worker, no traces because a trace would record the token that
was typed) against a **running** Server and dashboard: the Server's `/dashboard` redirect; sign in, wrong token and sign out; real
Agents with OS and disk in the gallery; a machine and its six tabs; a disk refresh answered when the Agent runs once; acknowledge and
reopen a problem; Add machine creating a link of the form `SERVER/enroll#fleet-v1=…` that is then revoked; every page loading; the session
cookie (`__Host-Fleet-Session`: `HttpOnly`, `Secure`, `SameSite=Strict`, no `Domain`) with the token in no storage, URL, DOM or header;
CORS (the dashboard's origin only, preflight from any other origin 403) and a real page on a third origin that cannot read the API; and,
with the optional tokens, the `read` and `operate` scopes.

| Variable | Meaning |
|---|---|
| `FLEET_E2E_DASHBOARD_URL`, `FLEET_E2E_SERVER_URL` | the two origins, for example `https://localhost:7444` and `https://localhost:7443` |
| `FLEET_E2E_OPERATOR_TOKEN` | an `admin` Operator token; read from the environment only |
| `FLEET_E2E_READ_TOKEN`, `FLEET_E2E_OPERATE_TOKEN` | optional; the scope journeys are skipped without them |
| `FLEET_E2E_IGNORE_HTTPS_ERRORS=1` | accept certificates of a private CA (off by default) |
| `FLEET_E2E_AGENT_ALIAS`, `FLEET_E2E_IDLE_ALIAS` | an enrolled machine that has reported, and one that never has |
| `FLEET_E2E_AGENT_RUN` | a command called as `COMMAND ALIAS` that runs that machine's Agent once (the disk-refresh journey) |

Without the first three, every real-stack test is skipped and the run succeeds. **`scripts/e2e-stack.sh`** does all of it on a disposable
stack: it builds the Server image (`--platform linux/amd64`) and the dashboard image (`deploy/homelab/compose.build.yaml`) under local
tags `fleet-e2e-*` (never `skorcius/*`), runs `deploy/homelab/setup.py` in a temporary directory on two free loopback ports, starts it
under a unique Compose project name, builds the Rust clients with `CARGO_TARGET_DIR` in the temporary directory, enrolls two real Agents,
adds a `read` and an `operate` Operator, runs `npm run e2e:real` and removes containers, volumes, networks, images and the directory on
exit, also on failure or Ctrl-C. It needs Docker (Compose v2), Python 3, `cargo`, `npm ci` done in `dashboard/`, and a browser. The token is
never printed or put on a command line. `--keep` leaves the stack and a private `e2e.env` for re-running single journeys;
`FLEET_E2E_CARGO_TARGET_DIR` reuses a Cargo cache; arguments after `--` go to Playwright (`scripts/e2e-stack.sh -- -g "disk refresh"`).
CI does not run this mode.

## Security rules (enforced)

`tests/security/source-scan.test.ts` fails if `src/` contains `v-html`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `eval(`,
`new Function`, `localStorage`, `sessionStorage`, `indexedDB`, `style="…"` or inline event handler strings, if the stylesheet loads
anything external, if `index.html` has an inline script or style, or if the runtime dependencies are not exactly `vue` and
`vue-router`. In short:

- Server strings (diagnostics, paths, names, commit subjects) are always rendered as text. The old dashboard escaped everything it
  put in a template string; with Vue's templates that is automatic, which is why `v-html` is banned.
- The page works under `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'
  <apiUrl>; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`: no inline script or style, no `data:` URLs (the favicon
  is a file, `assetsInlineLimit` is 0), no third-party requests, fonts or analytics.
- The Operator token is never written to storage, the URL, logs, reactive state or router state. Nothing reads or writes cookies.
- Dependencies are exact and locked: `npm ci` and `npm audit --omit=dev --audit-level=high` must pass (the CI `dashboard` job runs them).
