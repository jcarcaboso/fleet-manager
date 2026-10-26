# Separate dashboard

## Goal

Move the Operator dashboard out of the Server into its own Vue 3 + Vite +
TypeScript application in `dashboard/`. It is built, tested, versioned and
served on its own, on its own address, and talks to the Server only through the
existing `/dashboard/api` routes. The Server stops embedding and serving the
dashboard.

**Status:** implemented. The Server no longer carries the dashboard, and the
sections "Behaviour parity" and "Cleanup" below describe work that is done.

This is a breaking change for anyone who opens `https://SERVER/dashboard`:
that address redirects to the new dashboard address, and the dashboard needs
its own container.

## Decisions

| Topic | Decision |
|---|---|
| Stack | Vue 3 (Composition API, `<script setup lang="ts">`), Vite, TypeScript, Vue Router, Vitest. No UI framework, no state library, no CSS framework. |
| Address | Its own HTTPS origin, for example `https://fleet.home.arpa:7444` next to the Server at `https://fleet.home.arpa:7443`. |
| Login | Keep the existing cookie session. The Operator token is posted once and never stored by the page. The session cookie stays `HttpOnly`, `Secure`, `__Host-` and `SameSite=Strict`. |
| Site rule | The dashboard and the Server must be on the same **site**: both HTTPS and the same host or registrable domain. Ports and subdomains may differ. A different site cannot send the `SameSite=Strict` cookie, and the dashboard says so at login. |
| Server API | Unchanged routes under `/dashboard/api`. The Server adds CORS for exactly one configured origin. |
| `/enroll` | Stays on the Server. Enrollment links are parsed by the Agent as `SERVER_ORIGIN/enroll#fleet-v1=…`. |
| Why not bearer tokens | A token held by the page can be read by any script on it and is lost on reload. The cookie keeps the token away from JavaScript. `/operator/v1` still accepts bearer tokens for scripts. |

## Server contract

### Configuration

`Fleet:DashboardOrigin` (environment `Fleet__DashboardOrigin`): the dashboard's
HTTPS origin. It follows the rules of `Fleet:PublicUrl`: `https`, a host, no
userinfo, path, query or fragment. Compose sets it from `FLEET_DASHBOARD_URL`.

- Empty: the dashboard API is not mapped, and `/` and `/dashboard` return 404
  with `{ "code": "dashboard_not_configured", "message": "…" }`.
- `Fleet:PublicUrl` is still required for enrollment links and is unchanged.
- Startup validation fails for an invalid value.

### Routes

- `GET /` and `GET /dashboard` (any case, any trailing path under `/dashboard`
  that is not `/dashboard/api`) redirect with 302 to `Fleet:DashboardOrigin`
  when it is set.
- `/dashboard/{file}` no longer serves assets.
- `/enroll` is served as before. Its script and stylesheet move to exactly two
  routes, `/enroll/enroll.js` and `/enroll/enroll.css`, and `enroll.html`
  references those. The enrollment page's content security policy and headers
  are unchanged, and no other `/enroll/…` path exists.
- `/dashboard/api/*` is unchanged apart from the CORS and Origin rules below.

### CORS

For requests to `/dashboard/api/*` only, when the `Origin` header equals
`Fleet:DashboardOrigin` (exact, case-insensitive on scheme and host):

- Response headers on every response, including errors:
  `Access-Control-Allow-Origin: <the origin>`,
  `Access-Control-Allow-Credentials: true`, `Vary: Origin`.
- `OPTIONS` preflight: 204 with `Access-Control-Allow-Methods: GET, POST, OPTIONS`,
  `Access-Control-Allow-Headers: Content-Type, X-Fleet-CSRF`,
  `Access-Control-Max-Age: 600`. A preflight needs no session and no CSRF token.
- `Access-Control-Expose-Headers` is not needed.

Any other origin, and every request without `Origin`, gets no CORS headers. A
preflight from another origin gets 403 `{ "code": "invalid_origin", … }`. There
is no wildcard, no reflection of arbitrary origins, and no CORS on
`/operator/v1`, `/agent/v1`, `/enroll` or `/health`.

### CSRF and Origin

The existing checks stay, with one change: a non-`GET` request to
`/dashboard/api` must carry `Origin: <Fleet:DashboardOrigin>` (it was the
Server's public origin). The antiforgery header stays `X-Fleet-CSRF`, and the
token still comes from `GET /dashboard/api/csrf`. The session and antiforgery
cookies keep their names and attributes.

### Not changed

Authentication, scopes, rate limits, the Operator API, the Agent API, the CLI,
audit events and the database.

## Dashboard application

### Layout

```
dashboard/
  package.json  package-lock.json  vite.config.ts  index.html  tsconfig*.json
  public/config.json            development default
  src/
    main.ts  App.vue  router.ts
    api/        typed client, error types, scope helpers, session
    api/mock/   contract-faithful mock API for development and tests
    components/ shared UI (icons, status chips, modals, toasts, charts, art)
    composables/
    views/      one folder per page
    styles/     design tokens and global styles
  tests/        Vitest component and unit tests
  Dockerfile  nginx/  .dockerignore  README.md
```

### Runtime configuration

The page fetches `/config.json` (`cache: "no-store"`) before it mounts:

```json
{ "apiUrl": "https://fleet.home.arpa:7443" }
```

`apiUrl` is an origin (no path). It must be `https`, except `http://localhost`
and `http://127.0.0.1` for local development. An invalid or missing file shows
a configuration error page, not a blank screen. One build therefore works for
every deployment; the container writes `config.json` from `FLEET_API_ORIGIN`.

### API client

- Every request: `credentials: "include"`, `Accept: application/json`, and an
  `AbortSignal`. Mutations send `Content-Type: application/json` and
  `X-Fleet-CSRF`; the token comes from `GET csrf` and is fetched again once on
  `invalid_csrf`.
- Errors are `{ code, message, status }`. 401 sends the user to login with a
  notice, 403 `insufficient_scope` shows an inline message, and network failures
  say that the Server could not be reached at `apiUrl`.
- Paged lists use `limit` 1 to 100 and `after`; `order=newest` where the
  contract offers it.
- Aliases and Node references are sent as one percent-encoded path segment, as
  in `docs/technical-design/operator-api.md`.
- The Operator token is never written to storage, the URL, logs or the router
  state. After login the page keeps only `{ actor, scope }`.
- After login, `GET session` must succeed. If it returns 401 straight after a
  successful login, show: "Your browser did not send the session cookie. The
  dashboard and the Server must be on the same site."

### Behaviour parity

The current dashboard is the behavioural reference until this work merges:
`server/Fleet.Server/Dashboard/Assets/*.js` and `style.css`, with
`server/Fleet.Server/Dashboard/Dev/fixture.js` and `drive.js` as the test
reference. Every screen, route, action, state and message carries over:

- Machines, Node page (Overview, Installed, Problems, Activity, Security,
  Settings), Problems, Deployments and revision pages, Repository, Models,
  Enrollment and the Add machine wizard, Audit, login and sign-out.
- Scope gating (`read`, `operate`, `admin`), 401 and 403 handling, empty,
  loading and error states, and the hash-free URLs below.
- Stale-response protection: a response for a view that has since been replaced
  never changes the current view, and a request whose view is gone is aborted.
  Use one `AbortController` per view and Vue's scope disposal.
- Bounded polling that stops on navigation (disk refresh, Add machine wizard,
  rollout progress).
- Accessibility: status is always icon plus label, controls are keyboard
  reachable with a visible focus ring, and modals trap focus and restore it.

Routes use history mode and the same names as before, without `#`:
`/machines`, `/machines/:alias/:tab?`, `/problems`, `/deployments`,
`/deployments/:revisionId`, `/repository`, `/models`, `/enrollment`, `/audit`,
`/login`. The container serves `index.html` for these paths.

### Security rules

- No `v-html`, `innerHTML`, `eval`, `new Function` or inline event handler
  strings. A test fails the build if `v-html` or `innerHTML` appears in `src/`.
- Compatible with `default-src 'none'; script-src 'self'; style-src 'self'`:
  no inline `<script>` or `<style>`, no `style="…"` in templates that Vue
  renders as an attribute string (use classes, or bindings that set properties
  through the DOM, which the policy allows).
- Commands shown for copying (`fleet …`, `brew upgrade …`) are built only from
  validated pieces, as the current dashboard does.
- No third-party requests, fonts, analytics or CDNs.
- Dependencies are exact, locked, and audited: `npm ci` and
  `npm audit --omit=dev --audit-level=high` must pass.

### Development

- `npm run dev:mock` runs against the in-browser mock API. It needs no Server.
  The mock reproduces the contract's behaviours, including the switches that
  `Dev/README.md` documents for the current fixture.
- `npm run dev` uses `public/config.json` and talks to a real Server.
- `npm test`, `npm run typecheck` and `npm run build` must pass with no network
  and no Server.

### Tests

Vitest with Vue Test Utils and happy-dom. Every scenario in
`Dev/drive.js` becomes a test against the mock API, including the race, abort,
polling, scope, XSS and contract-shape scenarios. Visual checks use headless
Chrome screenshots of `vite preview` builds.

## Container and deployment

`dashboard/Dockerfile`: a pinned Node stage runs `npm ci` and `npm run build`; a
pinned unprivileged nginx stage serves `dist/` over HTTPS on 8443.

- The service runs read-only, as a non-root user, with all capabilities dropped
  and `no-new-privileges`, with a healthcheck, like the Server service.
- TLS: it uses the Server's certificate and key from the generated
  `runtime-config` volume (`/run/fleet/tls/server.pem`, `server.key`). The
  certificate already covers `FLEET_HOSTNAME`.
- Environment: `FLEET_API_ORIGIN` (the Server's public origin).
- Headers: `Content-Security-Policy: default-src 'none'; script-src 'self';
  style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'
  FLEET_API_ORIGIN; base-uri 'none'; frame-ancestors 'none'; form-action
  'none'`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`,
  `Cache-Control: no-store` for `index.html` and `config.json`, long-lived
  immutable caching for hashed assets, and an `index.html` fallback for the
  route paths.
- Compose gets a `dashboard` service with a `build:` section (for local builds)
  and `image: ${FLEET_DASHBOARD_IMAGE:-skorcius/fleet-manager-dashboard:0.10.0}`,
  published on `${FLEET_BIND_IP}:${FLEET_DASHBOARD_PORT:-7444}`. The Server
  service gets `Fleet__DashboardOrigin` from `FLEET_DASHBOARD_URL`
  (default `https://${FLEET_HOSTNAME}:${FLEET_DASHBOARD_PORT:-7444}`).
  `setup.py` writes both values and `.env.example` documents them.
- Release: a second image, `skorcius/fleet-manager-dashboard:VERSION`, built and
  pushed manually with the Server image. Image pins in Compose and the guides
  are updated by the release preparation PR, not by this change.

## CI

A `dashboard` job runs `npm ci`, `npm run typecheck`, `npm test`,
`npm run build` and `npm audit --omit=dev --audit-level=high` in `dashboard/`
with a pinned Node version and pinned action SHAs like the other jobs.

## Cleanup

When the new application has parity and its tests pass, remove from the Server:
every file in `server/Fleet.Server/Dashboard/Assets/` except what `/enroll`
needs (`enroll.html`, `enroll.js`, and an `enroll.css` that replaces the
`body:not(.app)` rules of `style.css`), the `Dashboard/Dev/` harness, and the
embedded-resource entries for them. The Server image then carries no dashboard.

## Verification

1. Server tests for the configuration, CORS, Origin, preflight, redirects and
   the absence of CORS elsewhere.
2. Dashboard unit, component and contract tests against the mock API.
3. The two images from this branch run together in a disposable Compose
   project. A scripted headless Chrome session loads the dashboard origin,
   signs in across origins, and visits every page, with no console errors and no
   content security policy violations. The cookie, CSRF and CORS flow must work
   with the dashboard on a different port and with a different `Origin`, and
   must fail clearly on a different site.
4. An independent review of the login, CORS and container configuration.
