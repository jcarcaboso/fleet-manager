import type { Scope } from '../types';

/**
 * Behaviour switches of the mock API. In the browser (`npm run dev:mock`) they are URL query parameters, read once at start
 * (`parseMockOptions(location.search)`); in tests they are options of `createMockServer` / `mountApp`.
 */
export interface MockOptions {
  /** Session scope returned by `GET session` and `POST login` (`?scope=read|operate|admin`, default `admin`). */
  scope: Scope;
  /** The Operator name (default `joan`). */
  actor: string;
  /** Start at the sign-in page (`?signedout=1`). */
  signedOut: boolean;
  /** No machines, links, audit events or revisions (`?empty=1`). */
  empty: boolean;
  /** `GET` routes starting with this prefix answer 500 (`?fail=nodes`). */
  fail: string | null;
  /** Every non-GET request answers 403 `insufficient_scope` (`?forbid=1`). */
  forbid: boolean;
  /** Delay every response by this many milliseconds (`?slow=400`). */
  slow: number;
  /** Cap the page size, to exercise cursors and "load more" (`?pagesize=2`). */
  pageSize: number;
  /** `false`: attempts carry no phase 2 detail, like a Server or Agents before phase 2 (`?diag=0`). */
  diag: boolean;
  /** Hostile strings in diagnostics, paths, labels, commit subjects, Operator names (`?xss=1`); the UI must show them as text. */
  xss: boolean;
  /** `false`: no `agent` property anywhere and no `agent_outdated` issue, like a Server before phase 3 (`?agent=0`). */
  agent: boolean;
  /** `false`: the wizard's simulated enrollment never happens (`?enroll=0`). */
  enroll: boolean;
  /** The link is consumed and the Node exists, but the Agent never checks in (`?enroll=link`). */
  enrollLinkOnly: boolean;
  /** The first machine is called `rack/A 100%`, to exercise path-segment encoding (`?weirdalias=1`). */
  weirdAlias: boolean;
  /** Delay `GET nodes/{node}…` for these machines (alias or ID → ms) to reproduce overlapping loads (`?delay=design-imac:2500,studio-mini:500`). */
  delay: Record<string, number>;
  /** A POST whose path contains the key does its work at once but answers later (path text → ms; `?lag=rename:3000`). */
  lag: Record<string, number>;
  /** `GET` routes under this prefix never answer; only the caller's abort ends them (`?hang=enrollment-links/`). */
  hang: string | null;
  /** How long a refreshed Agent takes to answer `POST nodes/{node}/disk-usage/refresh` (default 7000; `?diskdelay=1000`). */
  diskDelay: number;
  /** Links created by the wizard expire after this many seconds, whatever was requested (`?expiry=8`). */
  expiry: number;
  /** `false`: no revision has commit metadata, like a Server before phase 4 (`?commit=0`). Otherwise only the oldest has `commit: null`. */
  commit: boolean;
  /** `false`: `GET desired-revisions/{id}` returns `rolloutId: null` (`?norollout=1`). */
  rollout: boolean;
  /** `false`: `GET nodes/{node}` has no `drift` property, like a Server before phase 4 (`?drift=0`). */
  drift: boolean;
  /** Two issues start in a state (an acknowledged and a snoozed one), so the Problems tabs have content (`?states=1`). */
  states: boolean;
  /** Platform of machines enrolled through the wizard (`?platform=linux`, default `macos`). */
  platform: 'macos' | 'linux';
  /** Every request fails like a network error: the Server cannot be reached (`?offline=1`). */
  offline: boolean;
  /** `false`: the browser never sends the session cookie, so `GET session` after a login is 401 (`?cookie=0`): the "same site" message. */
  cookie: boolean;
  /** The Origin the browser sends with non-GET requests. */
  origin: string;
  /** `Fleet:DashboardOrigin`: the Origin that non-GET requests must carry, else 400 `invalid_origin` (`?dashboardorigin=https://other.example`). */
  dashboardOrigin: string;
}

export const DEFAULT_ORIGIN = 'https://dashboard.mock.invalid';

export function defaultMockOptions(): MockOptions {
  return {
    scope: 'admin', actor: 'joan', signedOut: false, empty: false, fail: null, forbid: false, slow: 0, pageSize: 100, diag: true, xss: false, agent: true,
    enroll: true, enrollLinkOnly: false, weirdAlias: false, delay: {}, lag: {}, hang: null, diskDelay: 7000, expiry: 0, commit: true, rollout: true, drift: true,
    states: false, platform: 'macos', offline: false, cookie: true, origin: DEFAULT_ORIGIN, dashboardOrigin: '',
  };
}

const pairs = (text: string | null): Record<string, number> =>
  Object.fromEntries((text ?? '').split(',').filter(Boolean).map(x => { const i = x.lastIndexOf(':'); return [x.slice(0, i), +x.slice(i + 1)]; }));

/** Reads the switches from a query string (`?scope=read&slow=300`). Unknown parameters are ignored. */
export function parseMockOptions(search: string): MockOptions {
  const p = new URLSearchParams(search);
  const scope = p.get('scope');
  const base = defaultMockOptions();
  return {
    ...base,
    scope: scope === 'read' || scope === 'operate' || scope === 'admin' ? scope : 'admin',
    signedOut: p.has('signedout'), empty: p.has('empty'), fail: p.get('fail'), forbid: p.has('forbid'),
    slow: +(p.get('slow') || 0), pageSize: +(p.get('pagesize') || 100),
    diag: p.get('diag') !== '0', xss: p.has('xss'), agent: p.get('agent') !== '0',
    enroll: p.get('enroll') !== '0', enrollLinkOnly: p.get('enroll') === 'link', weirdAlias: p.has('weirdalias'),
    delay: pairs(p.get('delay')), lag: pairs(p.get('lag')), hang: p.get('hang'),
    diskDelay: +(p.get('diskdelay') || 7000), expiry: +(p.get('expiry') || 0),
    commit: p.get('commit') !== '0', rollout: !p.has('norollout'), drift: p.get('drift') !== '0', states: p.has('states'),
    platform: p.get('platform') === 'linux' ? 'linux' : 'macos',
    offline: p.has('offline'), cookie: p.get('cookie') !== '0',
    origin: p.get('origin') || base.origin, dashboardOrigin: p.get('dashboardorigin') || '',
  };
}
