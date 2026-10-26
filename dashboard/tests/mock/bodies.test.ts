/**
 * The mock binds request bodies like the Server does: every JSON body is read into a C# record with `UnmappedMemberHandling = Disallow`
 * (`WireJson.Configure`). An extra member, a value of the wrong type, a missing `[JsonRequired]` member or no body is
 * `400 invalid_request` ("The request is malformed or a parameter is invalid.") before the route runs; a member that is not required and
 * missing keeps its default and the route's own checks decide. Also: the antiforgery token is bound to the identity, so it changes at login
 * and logout.
 */
import { describe, expect, it } from 'vitest';
import { bindBody, shapeFor } from '@/api/mock/bind';
import { createMockServer } from '@/api/mock';
import { createApiClient } from '@/api/client';
import { createSession } from '@/api/session';
import { TOKEN } from '../helpers/app';
import { loginClient, mockApi } from '../helpers/mock';
import { allowMalformedBodies, checkMalformed, takeMalformed, watchMock } from '../helpers/strict';

const MALFORMED = 'The request is malformed or a parameter is invalid.';
const NODE_ID = '4965d79a-f516-4f50-a145-74d7f516224b';

function server(options = {}) {
  const mock = watchMock(createMockServer(options));
  const call = async (path: string, body?: unknown, raw?: string): Promise<{ status: number; body: any }> => {
    const r = await mock.fetch('https://mock.fleet.invalid/dashboard/api/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fleet-CSRF': mock.state.csrf },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { mock, call, nodeId: (alias: string) => mock.nodes.find(n => n.alias === alias)!.id };
}
const refused = (r: { status: number; body: any }): void => {
  expect(r.status).toBe(400);
  expect(r.body).toEqual({ code: 'invalid_request', message: MALFORMED });
};

/** Every route that reads a body: a valid body, and the members the record has. */
interface Route {
  name: string;
  path: (id: (alias: string) => string) => string;
  /** A body the route accepts. */
  good: (id: (alias: string) => string) => Record<string, unknown>;
  /** The status the good body gets (it may be refused by the route's own rules, as long as it is not malformed). */
  scope?: 'read' | 'operate' | 'admin';
  /** Removing a member that is not required: what the route answers then (the record's default decides). */
  without?: Array<[member: string, status: number, code: string | null]>;
  /** Members whose absence is a malformed body (`[JsonRequired]`). */
  required?: string[];
}
const ROUTES: Route[] = [
  { name: 'login', path: () => 'login', good: () => ({ token: TOKEN }), without: [['token', 401, 'unauthorized']] },
  { name: 'nodes/rename', path: () => 'nodes/rename', good: () => ({ currentAlias: 'studio-mini', alias: 'studio-renamed' }), without: [['currentAlias', 400, 'invalid_node_alias'], ['alias', 400, 'invalid_node_alias']] },
  { name: 'nodes/{id}/retry', path: id => `nodes/${id('studio-mini')}/retry`, good: () => ({ target: 'ai-client/claude' }), without: [['target', 400, 'invalid_request']] },
  { name: 'nodes/{id}/remove', path: id => `nodes/${id('build-runner-02')}/remove`, good: () => ({ alias: 'build-runner-02' }), without: [['alias', 400, 'invalid_node_alias']] },
  { name: 'issues/state', path: () => 'issues/state', good: id => ({ id: `node_not_contacting:${id('mbp-joan')}`, action: 'acknowledge' }), required: ['id', 'action'] },
  { name: 'enrollment-links', path: () => 'enrollment-links', good: () => ({ alias: 'new-box', expiresInSeconds: 900 }), without: [['alias', 400, 'invalid_alias'], ['expiresInSeconds', 200, null]] },
  {
    name: 'cliproxy/selection', path: () => 'cliproxy/selection', scope: 'operate',
    good: () => ({
      baseUrl: 'https://nowhere/v1', version: 0,
      policy: { includeNew: true, disabledFamilies: [], modelOverrides: {}, enabledFamilies: ['gpt-5'], skipClaudeModelsForOtherClients: true },
    }),
    without: [['baseUrl', 400, 'invalid_selection'], ['policy', 400, 'invalid_selection']],
  },
];

describe.each(ROUTES)('POST $name binds its body like the Server', route => {
  it('a body with an extra member is 400 invalid_request, and nothing changes', async () => {
    const { mock, call, nodeId } = server();
    const audit = mock.audit.length;
    refused(await call(route.path(nodeId), { ...route.good(nodeId), extra: true }));
    expect(mock.audit.length).toBe(audit);
    expect(takeMalformed()).toHaveLength(1);
  });

  it('member names match without regard to case, as with the Server\'s web defaults', async () => {
    const { call, nodeId } = server();
    const body = Object.fromEntries(Object.entries(route.good(nodeId)).map(([k, v]) => [k[0]!.toUpperCase() + k.slice(1), v]));
    const r = await call(route.path(nodeId), body);
    expect(r.body?.message).not.toBe(MALFORMED);
    expect(takeMalformed()).toHaveLength(0);
  });

  it('no body, a body that is not JSON and a body that is not an object are 400 invalid_request', async () => {
    const { call, nodeId } = server();
    refused(await call(route.path(nodeId)));
    refused(await call(route.path(nodeId), undefined, '{not json'));
    refused(await call(route.path(nodeId), undefined, 'null'));
    refused(await call(route.path(nodeId), undefined, '[]'));
    refused(await call(route.path(nodeId), undefined, '"text"'));
    expect(takeMalformed()).toHaveLength(5);
  });

  it('the good body is not refused for its shape', async () => {
    const { call, nodeId } = server();
    const r = await call(route.path(nodeId), route.good(nodeId));
    expect(r.body?.message).not.toBe(MALFORMED);
    expect(takeMalformed()).toHaveLength(0);
  });

  it.each(route.without ?? [])('without %s the route\'s own check answers (the member keeps its default)', async (member, status, code) => {
    const { call, nodeId } = server();
    const { [member]: _gone, ...rest } = route.good(nodeId);
    const r = await call(route.path(nodeId), rest);
    expect(r.status).toBe(status);
    if (code) expect(r.body.code).toBe(code);
    expect(takeMalformed()).toHaveLength(0);
  });

  it.each(route.required ?? [])('without the required member %s the body is 400 invalid_request', async member => {
    const { call, nodeId } = server();
    const { [member]: _gone, ...rest } = route.good(nodeId);
    refused(await call(route.path(nodeId), rest));
    expect(takeMalformed()).toHaveLength(1);
  });
});

describe('types', () => {
  it.each([
    ['login', { token: 5 }],
    ['nodes/rename', { currentAlias: 'a', alias: 5 }],
    ['nodes/rename', { currentAlias: ['a'], alias: 'b' }],
    ['issues/state', { id: 'x', action: 'snooze', hours: 1.5 }],
    ['issues/state', { id: 'x', action: 'snooze', hours: '4' }],
    ['issues/state', { id: 5, action: 'reopen' }],
    ['enrollment-links', { alias: 'a', expiresInSeconds: '900' }],
    ['enrollment-links', { alias: 'a', expiresInSeconds: 900.5 }],
    ['enrollment-links', { alias: 'a', expiresInSeconds: null }],
    ['enrollment-links', { alias: 'a', expiresInSeconds: 1e10 }],
    ['cliproxy/selection', { baseUrl: 'u', version: '1', policy: null }],
    ['cliproxy/selection', { baseUrl: 'u', version: 1.5, policy: null }],
    ['cliproxy/selection', { baseUrl: 'u', version: 1, policy: { includeNew: 'yes' } }],
    ['cliproxy/selection', { baseUrl: 'u', version: 1, policy: { enabledFamilies: [1] } }],
    ['cliproxy/selection', { baseUrl: 'u', version: 1, policy: { modelOverrides: { a: 'on' } } }],
    ['cliproxy/selection', { baseUrl: 'u', version: 1, policy: { includeNew: true, surprise: 1 } }],
  ])('POST %s with %j is refused', async (path, body) => {
    const { call } = server();
    refused(await call(path, body));
    expect(takeMalformed()).toHaveLength(1);
  });

  it('null is a value for the nullable members: the route decides', async () => {
    const { call } = server();
    expect((await call('issues/state', { id: 'x', action: 'acknowledge', hours: null })).body.code).toBe('issue_not_found');
    expect((await call('nodes/rename', { currentAlias: null, alias: null })).body.code).toBe('invalid_node_alias');
    expect((await call('cliproxy/selection', { baseUrl: 'u', version: 0, policy: null })).body.code).toBe('invalid_selection');
    expect(takeMalformed()).toHaveLength(0);
  });
});

describe('the binding happens before the Origin, CSRF and scope checks, and after authentication', () => {
  it('a malformed body is refused for a reader and for a wrong CSRF token alike, but a signed-out caller gets 401 first', async () => {
    const { mock, call } = server({ scope: 'read' });
    refused(await call('nodes/rename', { currentAlias: 'a', alias: 'b', extra: 1 }));
    const wrongToken = await mock.fetch('https://mock.fleet.invalid/dashboard/api/nodes/rename', { method: 'POST', headers: { 'X-Fleet-CSRF': 'wrong' }, body: '{"nope":1}' });
    expect(wrongToken.status).toBe(400);
    expect((await wrongToken.json()).code).toBe('invalid_request');
    expect((await call('nodes/rename', { currentAlias: 'a', alias: 'b' })).body.code).toBe('insufficient_scope');
    takeMalformed();
    const out = server({ signedOut: true });
    expect((await out.call('nodes/rename', { nope: 1 })).status).toBe(401);
  });
});

describe('routes without a body parameter ignore what is posted', () => {
  it.each([
    ['nodes/NODE/revoke'], ['nodes/NODE/disk-usage/refresh'], ['enrollment-links/00000000-0000-4000-8000-000000000000/revoke'], ['source/rescan'], ['cliproxy/refresh'],
  ])('POST %s', async path => {
    const { call, nodeId } = server();
    const r = await call(path.replace('NODE', nodeId('studio-mini')), { anything: 'goes', 'x-y': [1] });
    expect(r.body?.message).not.toBe(MALFORMED);
    expect(r.status).toBeLessThan(500);
    expect((await call(path.replace('NODE', nodeId('studio-mini')))).body?.message).not.toBe(MALFORMED);
    expect(takeMalformed()).toHaveLength(0);
  });
});

describe('shapes', () => {
  it('shapeFor names the routes that read a body and nothing else', () => {
    for (const p of ['login', 'nodes/rename', 'issues/state', 'enrollment-links', 'cliproxy/selection', `nodes/${NODE_ID}/retry`, 'nodes/studio-mini/retry', `nodes/${NODE_ID}/remove`]) expect(shapeFor(p), p).not.toBeNull();
    for (const p of ['logout', 'source/rescan', 'cliproxy/refresh', `nodes/${NODE_ID}/revoke`, 'nodes/x/disk-usage/refresh', 'nodes/studio-mini/remove', 'nodes/%E0%A4%A/remove', 'nodes']) expect(shapeFor(p), p).toBeNull();
  });
  it('bindBody returns the members under their canonical names', () => {
    expect(bindBody(shapeFor('nodes/rename')!, { CURRENTALIAS: 'a', Alias: 'b' })).toEqual({ currentAlias: 'a', alias: 'b' });
    expect(bindBody(shapeFor('issues/state')!, { id: 'x', action: 'snooze', hours: 3 })).toEqual({ id: 'x', action: 'snooze', hours: 3 });
    expect(bindBody(shapeFor('login')!, {})).toEqual({});
  });
});

describe('the antiforgery token is bound to the identity', () => {
  it('it changes at login and at logout, and a request that still carries the old one is 400 invalid_csrf', async () => {
    const { mock, call } = server({ signedOut: true });
    const anonymous = mock.state.csrf;
    expect((await call('login', { token: TOKEN })).status).toBe(200);
    expect(mock.state.csrf).not.toBe(anonymous);
    /* the token from before the login */
    const stale = await mock.fetch('https://mock.fleet.invalid/dashboard/api/source/rescan', { method: 'POST', headers: { 'X-Fleet-CSRF': anonymous }, body: '{}' });
    expect(stale.status).toBe(400);
    expect((await stale.json()).code).toBe('invalid_csrf');
    const signedIn = mock.state.csrf;
    expect((await call('source/rescan', {})).status).toBe(200);
    const out = await mock.fetch('https://mock.fleet.invalid/dashboard/api/logout', { method: 'POST', headers: { 'X-Fleet-CSRF': signedIn }, body: '{}' });
    expect(out.status).toBe(200);
    expect(mock.state.csrf).not.toBe(signedIn);
    expect(mock.state.csrf).not.toBe(anonymous);
  });

  it('a failed login keeps the token', async () => {
    const { mock, call } = server({ signedOut: true });
    const before = mock.state.csrf;
    expect((await call('login', { token: 'bad' + 'x'.repeat(40) })).status).toBe(401);
    expect(mock.state.csrf).toBe(before);
  });

  it('GET csrf hands out the current token', async () => {
    const { mock } = server();
    const r = await mock.fetch('https://mock.fleet.invalid/dashboard/api/csrf');
    expect((await r.json()).token).toBe(mock.state.csrf);
  });
});

describe('the client forgets its CSRF token at login and at logout', () => {
  const statuses = (mock: ReturnType<typeof mockApi>['mock']): Array<number | null> => mock.calls.filter(c => c.method === 'POST').map(c => c.status);

  it('the first mutation after login is not refused for a stale token (it needs no second attempt)', async () => {
    const { mock, api, session } = mockApi({ signedOut: true });
    await session.login(TOKEN);
    await api.post('source/rescan', {});
    expect(statuses(mock)).toEqual([200, 200]);
    expect(mock.calls.filter(c => c.path === 'csrf')).toHaveLength(2); // one before the login, one after
    expect(mock.calls.some(c => c.status === 400)).toBe(false);
  });

  it('and the client would have needed a second attempt if it kept the token (this is what the check above catches)', async () => {
    const { mock, api } = mockApi({ signedOut: true });
    await loginClient(api); // does not call clearCsrf(), unlike session.login()
    await api.post('source/rescan', {}); // the old token is refused once, then the client asks again by itself
    expect(statuses(mock)).toEqual([200, 400, 200]);
  });

  it('the first mutation after sign-out and sign-in again is not refused either', async () => {
    const { mock, api, session } = mockApi();
    await session.restore();
    await api.post('source/rescan', {});
    await session.logout();
    await session.login(TOKEN);
    await api.post('source/rescan', {});
    expect(mock.calls.some(c => c.status === 400)).toBe(false);
  });

  it('a client wired by hand behaves the same', async () => {
    const mock = watchMock(createMockServer({ signedOut: true }));
    const api = createApiClient({ apiUrl: 'https://mock.fleet.invalid', fetch: mock.fetch });
    const session = createSession(api);
    await session.login(TOKEN);
    await api.post('cliproxy/refresh', {});
    expect(mock.calls.some(c => c.status === 400)).toBe(false);
  });
});

describe('the guard that fails a test whose views send a refused body', () => {
  it('lists the refused requests of the watched mocks, and an opt-out silences it', async () => {
    const { api } = mockApi();
    await expect(api.post('nodes/rename', { currentAlias: 'studio-mini', alias: 'x', extra: 1 })).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
    const found = checkMalformed();
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('POST nodes/rename');
    expect(found[0]).toContain('"extra":1');
    const again = mockApi();
    await expect(again.api.post('nodes/rename', { nope: 1 })).rejects.toMatchObject({ code: 'invalid_request' });
    allowMalformedBodies();
    expect(checkMalformed()).toEqual([]);
  });
});
