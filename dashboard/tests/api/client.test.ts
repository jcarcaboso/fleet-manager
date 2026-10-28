import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, queryString, segment } from '@/api/client';
import { SESSION_COOKIE_NOT_SENT } from '@/api/messages';
import { isSilent } from '@/lib/errors';
import { jsonResponse, scriptedFetch, type Reply } from '../helpers/fetch';
import { loginClient, mockApi } from '../helpers/mock';

const API = 'https://fleet.home.arpa:7443';
const client = (...replies: Reply[]) => {
  const s = scriptedFetch(...replies);
  const hooks = { unauthorized: vi.fn(), forbidden: vi.fn() };
  return { ...s, hooks, api: createApiClient({ apiUrl: API, fetch: s.fetch, onUnauthorized: hooks.unauthorized, onForbidden: hooks.forbidden }) };
};

describe('requests', () => {
  it('sends cookies, JSON accept and the abort signal on every GET', async () => {
    const { api, seen } = client(jsonResponse({ ok: 1 }));
    const ctl = new AbortController();
    await expect(api.get('nodes', { limit: 5, after: null, q: '' }, { signal: ctl.signal })).resolves.toEqual({ ok: 1 });
    const s = seen[0]!;
    expect(s.url).toBe('https://fleet.home.arpa:7443/dashboard/api/nodes?limit=5');
    expect(s.method).toBe('GET');
    expect(s.init.credentials).toBe('include');
    expect(s.init.signal).toBe(ctl.signal);
    expect(s.init.cache).toBe('no-store');
    expect(s.headers.accept).toBe('application/json');
    expect(s.headers['x-fleet-csrf']).toBeUndefined();
    expect(s.headers['content-type']).toBeUndefined();
  });

  it('mutations fetch the CSRF token once, then send it with a JSON body', async () => {
    const { api, seen } = client(jsonResponse({ token: 'T1' }), jsonResponse({ ok: true }), jsonResponse({ ok: true }));
    await api.post('nodes/x/retry', { target: 'skills' });
    await api.post('nodes/x/retry', { target: 'skills' });
    expect(seen.map(s => `${s.method} ${s.url.replace(API + '/dashboard/api/', '')}`)).toEqual(['GET csrf', 'POST nodes/x/retry', 'POST nodes/x/retry']);
    expect(seen[1]!.headers['x-fleet-csrf']).toBe('T1');
    expect(seen[1]!.headers['content-type']).toBe('application/json');
    expect(seen[1]!.body).toEqual({ target: 'skills' });
    expect(seen[1]!.init.credentials).toBe('include');
    expect(seen[0]!.init.credentials).toBe('include');
  });

  it('sends {} for a post without a body', async () => {
    const { api, seen } = client(jsonResponse({ token: 't' }), jsonResponse({}));
    await api.post('source/rescan');
    expect(seen[1]!.body).toEqual({});
  });

  it('put goes through the same mutation path', async () => {
    const { api, seen } = client(jsonResponse({ token: 't' }), jsonResponse({}));
    await api.put('thing', { a: 1 });
    expect(seen[1]!.method).toBe('PUT');
    expect(seen[1]!.headers['x-fleet-csrf']).toBe('t');
  });

  it('retries a mutation once with a fresh token after invalid_csrf', async () => {
    const { api, seen } = client(
      jsonResponse({ token: 'old' }),
      jsonResponse({ code: 'invalid_csrf', message: 'x' }, 400),
      jsonResponse({ token: 'new' }),
      jsonResponse({ done: true }),
    );
    await expect(api.post('nodes/rename', { a: 1 })).resolves.toEqual({ done: true });
    expect(seen.map(s => s.headers['x-fleet-csrf'] ?? '-')).toEqual(['-', 'old', '-', 'new']);
  });

  it('retries only once: a second invalid_csrf is an error', async () => {
    const { api, seen } = client(jsonResponse({ token: 'a' }), jsonResponse({ code: 'invalid_csrf' }, 400), jsonResponse({ token: 'b' }), jsonResponse({ code: 'invalid_csrf' }, 400));
    await expect(api.post('x', {})).rejects.toMatchObject({ code: 'invalid_csrf', status: 400, message: 'Your session changed. Refresh the page and try again.' });
    expect(seen).toHaveLength(4);
  });

  it('never retries a GET on invalid_csrf', async () => {
    const { api, seen } = client(jsonResponse({ code: 'invalid_csrf' }, 400));
    await expect(api.get('x')).rejects.toBeInstanceOf(ApiError);
    expect(seen).toHaveLength(1);
  });

  it('forgets the token on clearCsrf, so the next mutation fetches a new one', async () => {
    const { api, seen } = client(jsonResponse({ token: 'a' }), jsonResponse({}), jsonResponse({ token: 'b' }), jsonResponse({}));
    await api.post('x');
    api.clearCsrf();
    await api.post('x');
    expect(seen[3]!.headers['x-fleet-csrf']).toBe('b');
  });
});

describe('errors', () => {
  it('maps a known code to its message and keeps code, status and details', async () => {
    const { api } = client(jsonResponse({ code: 'node_revoked', message: 'server text' }, 409));
    const error = await api.get('x').then(() => { throw new Error('expected a rejection'); }, (e: ApiError) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'node_revoked', status: 409, message: 'That machine has been revoked.', silent: false });
    expect(error.details).toEqual({ code: 'node_revoked', message: 'server text' });
  });
  it('keeps extra fields of the body (pinned_model_excluded lists models)', async () => {
    const { api } = client(jsonResponse({ code: 'pinned_model_excluded', message: 'm', models: ['gpt-6-codex'] }, 409));
    const error = await api.get('x').then(() => { throw new Error('expected a rejection'); }, (e: ApiError) => e);
    expect((error.details as unknown as { models: string[] }).models).toEqual(['gpt-6-codex']);
  });
  it('falls back by status when the code is unknown or missing', async () => {
    expect(await client(jsonResponse({ code: 'brand_new' }, 400)).api.get('x').then(() => { throw new Error('expected a rejection'); }, (e: ApiError) => e)).toMatchObject({ code: 'brand_new', message: 'The Server rejected the request (400). Refresh and try again.' });
    expect(await client(jsonResponse({}, 500)).api.get('x').then(() => { throw new Error('expected a rejection'); }, (e: ApiError) => e)).toMatchObject({ code: null, message: 'The Server had a problem (500). Try again in a moment.' });
    expect(await client(new Response('<html>', { status: 502 })).api.get('x').then(() => { throw new Error('expected a rejection'); }, (e: ApiError) => e)).toMatchObject({ code: null, status: 502 });
    expect(await client(jsonResponse({}, 403)).api.get('x').then(() => { throw new Error('expected a rejection'); }, (e: ApiError) => e)).toMatchObject({ status: 403, message: expect.stringContaining('scope') });
  });
  it('403 calls the forbidden hook and throws a visible error', async () => {
    const { api, hooks } = client(jsonResponse({ code: 'insufficient_scope', message: 'x' }, 403));
    const error = await api.get('x').then(() => { throw new Error('expected a rejection'); }, (e: ApiError) => e);
    expect(error).toMatchObject({ status: 403, code: 'insufficient_scope', silent: false });
    expect(hooks.forbidden).toHaveBeenCalledWith(error);
    expect(hooks.unauthorized).not.toHaveBeenCalled();
  });
  it('401 calls the unauthorized hook and throws a silent error', async () => {
    const { api, hooks } = client(jsonResponse({ code: 'unauthorized' }, 401));
    const error = await api.get('nodes').then(() => { throw new Error('expected a rejection'); }, (e: ApiError) => e);
    expect(error).toMatchObject({ status: 401, code: 'unauthorized', message: 'Sign in with your account.', silent: true });
    expect(isSilent(error)).toBe(true);
    expect(hooks.unauthorized).toHaveBeenCalledTimes(1);
  });
  it('a 401 on login is a rejected name or password, not an ended session', async () => {
    const { api, hooks } = client(jsonResponse({ token: 't' }), jsonResponse({ code: 'unauthorized' }, 401));
    const error = await api.post('login', { name: 'x', password: 'y' }, { login: true }).then(() => { throw new Error('expected a rejection'); }, (e: ApiError) => e);
    expect(error).toMatchObject({ status: 401, code: 'invalid_credentials', message: 'That name and password were not accepted. Check them and try again.', silent: false });
    expect(hooks.unauthorized).not.toHaveBeenCalled();
  });
  it('a network failure names the configured apiUrl', async () => {
    const { api } = client(new TypeError('Failed to fetch'));
    const error = await api.get('x').then(() => { throw new Error('expected a rejection'); }, (e: ApiError) => e);
    expect(error).toMatchObject({ code: 'network_error', status: 0, silent: false });
    expect(error.message).toContain(API);
    expect(error.message).toMatch(/Could not reach the Server/);
  });
  it('strips a trailing slash from apiUrl', async () => {
    const s = scriptedFetch(jsonResponse({}));
    await createApiClient({ apiUrl: API + '/', fetch: s.fetch }).get('x');
    expect(s.seen[0]!.url).toBe(`${API}/dashboard/api/x`);
  });
  it('an empty or non-JSON success body is null', async () => {
    expect(await client(new Response('', { status: 200 })).api.get('x')).toBeNull();
    expect(await client(new Response('oops', { status: 200 })).api.get('x')).toBeNull();
  });
});

describe('abort', () => {
  it('a request aborted by the caller rejects with a silent cancelled error and shows nothing', async () => {
    const { mock, api } = mockApi({ hang: 'nodes', signedOut: false });
    const ctl = new AbortController();
    const pending = api.get('nodes', undefined, { signal: ctl.signal }).then(() => { throw new Error('expected a rejection'); }, (e: ApiError) => e);
    ctl.abort();
    const error = await pending;
    expect(error).toMatchObject({ code: 'cancelled', silent: true, status: 0 });
    expect(mock.calls[0]).toMatchObject({ aborted: true, settled: true });
  });
  it('an already aborted signal never reaches the network', async () => {
    const { api, seen } = client(jsonResponse({}));
    const ctl = new AbortController();
    ctl.abort();
    await expect(api.get('x', undefined, { signal: ctl.signal })).rejects.toMatchObject({ code: 'cancelled', silent: true });
    await expect(api.post('x', {}, { signal: ctl.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(seen).toHaveLength(0);
  });
  it('a response that arrives after the caller aborted is dropped', async () => {
    const ctl = new AbortController();
    const { api } = client(() => { ctl.abort(); return jsonResponse({ stale: true }); });
    await expect(api.get('x', undefined, { signal: ctl.signal })).rejects.toMatchObject({ code: 'cancelled' });
  });
  it('the signal travels with the CSRF fetch and the retry too', async () => {
    const { api, seen } = client(jsonResponse({ token: 't' }), jsonResponse({}));
    const ctl = new AbortController();
    await api.post('x', {}, { signal: ctl.signal });
    expect(seen.every(s => s.init.signal === ctl.signal)).toBe(true);
  });
});

describe('paging', () => {
  it('page() defaults the limit to 100 and always returns items and a cursor', async () => {
    const { api, seen } = client(jsonResponse({ items: [1, 2], nextCursor: 'c' }), jsonResponse(null));
    expect(await api.page('audit', { order: 'newest' })).toEqual({ items: [1, 2], nextCursor: 'c' });
    expect(seen[0]!.url).toContain('?limit=100&order=newest');
    expect(await api.page('audit', { limit: 5, after: 'c' })).toEqual({ items: [], nextCursor: null });
    expect(seen[1]!.url).toContain('limit=5&after=c');
  });
  it('all() follows the cursor and reports truncation', async () => {
    const pages = [jsonResponse({ items: [1], nextCursor: 'a' }), jsonResponse({ items: [2], nextCursor: 'b' }), jsonResponse({ items: [3], nextCursor: null })];
    const full = client(...pages);
    expect(await full.api.all('nodes')).toEqual({ items: [1, 2, 3], truncated: false });
    expect(full.seen.map(s => new URL(s.url).searchParams.get('after'))).toEqual([null, 'a', 'b']);
    const cut = client(...pages);
    expect(await cut.api.all('nodes', { maxPages: 2, params: { order: 'newest' } })).toEqual({ items: [1, 2], truncated: true });
    expect(cut.seen[0]!.url).toContain('order=newest');
  });
  it('all() passes the signal to every page', async () => {
    const { api, seen } = client(jsonResponse({ items: [1], nextCursor: 'a' }), jsonResponse({ items: [2], nextCursor: null }));
    const ctl = new AbortController();
    await api.all('nodes', { signal: ctl.signal });
    expect(seen.every(s => s.init.signal === ctl.signal)).toBe(true);
  });
  it('a mock server honours order, cursors and the page size cap', async () => {
    const { api } = mockApi({ pageSize: 2 });
    const first = await api.page<{ nodeId: string }>('nodes');
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe('id:2');
    const all = await api.all<{ nodeId: string }>('nodes', { maxPages: 20 });
    expect(all.items).toHaveLength(14);
    expect(all.truncated).toBe(false);
    await expect(api.get('nodes', { limit: 0 })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(api.get('nodes', { limit: 101 })).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('paths', () => {
  it('encodes one path segment', () => {
    expect(segment('rack/A 100%')).toBe('rack%2FA%20100%25');
    expect(segment('a%2Fb')).toBe('a%252Fb');
    expect(segment('ünï')).toBe('%C3%BCn%C3%AF');
  });
  it('builds query strings and skips empty values', () => {
    expect(queryString()).toBe('');
    expect(queryString({ a: 1, b: '', c: null, d: undefined, e: 'x y', f: false, g: 0 })).toBe('?a=1&e=x%20y&f=false&g=0');
  });
  it('a machine alias with a slash, a percent sign or a space reaches the Server as one segment and resolves', async () => {
    const { api, mock } = mockApi({ weirdAlias: true });
    const alias = 'rack/A 100%';
    expect(mock.nodes[0]!.alias).toBe(alias);
    const detail = await api.get<{ name: string }>(`nodes/${segment(alias)}`);
    expect(detail.name).toBe(alias);
    expect(mock.calls[0]!.path).toBe('nodes/rack%2FA%20100%25');
    await expect(api.get(`nodes/${segment('rack/A')}`)).rejects.toMatchObject({ code: 'node_not_found' });
    await expect(api.get(`nodes/${segment('rack%2FA 100%')}`)).rejects.toMatchObject({ code: 'node_not_found' });
  });
  it('a double-encoded alias is the alias with a literal %2F in it', async () => {
    const { api, mock } = mockApi();
    mock.nodes[1]!.alias = 'a%2Fb';
    expect((await api.get<{ name: string }>(`nodes/${segment('a%2Fb')}`)).name).toBe('a%2Fb');
    expect(mock.calls[0]!.path).toBe('nodes/a%252Fb');
  });
});

describe('storage', () => {
  afterEach(() => vi.restoreAllMocks());
  it('never touches localStorage, sessionStorage or document.cookie, and the password is not kept anywhere', async () => {
    const reads: string[] = [];
    const spy = (name: string) => (): never => { reads.push(name); throw new Error(`storage was used: ${name}`); };
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(spy('setItem'));
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(spy('getItem'));
    const cookie = vi.spyOn(document, 'cookie', 'set').mockImplementation(spy('cookie'));
    const { api, session, mock } = mockApi({ signedOut: true });
    const TOKEN = 'operator-password-0123456789-abcdefghijkl';
    await session.login('joan', TOKEN);
    await api.get('nodes');
    await session.logout();
    expect(reads).toEqual([]);
    expect(cookie).not.toHaveBeenCalled();
    expect(JSON.stringify(session.state)).not.toContain(TOKEN);
    expect(mock.calls.filter(c => c.path !== 'login').every(c => !JSON.stringify(c).includes(TOKEN))).toBe(true);
    expect(mock.calls.filter(c => c.path !== 'login').some(c => JSON.stringify(c.query).includes('token'))).toBe(false);
  });
});

describe('mock origin and csrf checks', () => {
  it('a mutation from an origin the Server does not allow is 400 invalid_origin', async () => {
    const { api } = mockApi({ origin: 'https://evil.example', dashboardOrigin: 'https://dashboard.home.arpa' });
    await expect(api.post('login', { name: 'joan', password: 'x'.repeat(40) }, { login: true })).rejects.toMatchObject({ status: 400, code: 'invalid_origin' });
    await expect(api.get('csrf')).resolves.toHaveProperty('token');
  });
  it('a mutation with a wrong CSRF token is 400 invalid_csrf (before the scope check)', async () => {
    const { mock } = mockApi();
    const r = await mock.fetch('https://x.invalid/dashboard/api/issues/state', { method: 'POST', headers: { 'X-Fleet-CSRF': 'wrong', 'Content-Type': 'application/json' }, body: '{"id":"x","action":"reopen"}' });
    expect(r.status).toBe(400);
    expect((await r.json()).code).toBe('invalid_csrf');
  });
  it('after login the follow-up is authorised', async () => {
    const { api } = mockApi({ signedOut: true });
    await expect(api.get('session')).rejects.toMatchObject({ status: 401 });
    await loginClient(api);
    await expect(api.get('session')).resolves.toEqual({ actor: 'joan', scope: 'admin', mustChangePassword: false });
  });
  it('SESSION_COOKIE_NOT_SENT text is the documented sentence', () => {
    expect(SESSION_COOKIE_NOT_SENT).toBe('Your browser did not send the session cookie. The dashboard and the Server must be on the same site.');
  });
});
