import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient } from '@/api/client';
import { createSession } from '@/api/session';
import { jsonResponse, scriptedFetch } from '../helpers/fetch';
import { mockApi } from '../helpers/mock';
import { TOKEN, BAD_TOKEN } from '../helpers/app';

describe('restore', () => {
  it('is signed in when GET session succeeds', async () => {
    const { session } = mockApi({ scope: 'operate' });
    expect(session.state.status).toBe('unknown');
    await expect(session.restore()).resolves.toBe(true);
    expect(session.signedIn).toBe(true);
    expect(session.state).toMatchObject({ actor: 'joan', scope: 'operate', status: 'signedIn' });
  });
  it('is signed out, without a notice, on 401', async () => {
    const { session } = mockApi({ signedOut: true });
    await expect(session.restore()).resolves.toBe(false);
    expect(session.state).toMatchObject({ status: 'signedOut', actor: null, scope: null, notice: null });
  });
  it('rethrows other failures; ensure() records them for the "Try again" page and retryBoot() restores again', async () => {
    const { mock, session } = mockApi({ offline: true });
    await expect(session.restore()).rejects.toMatchObject({ code: 'network_error' });
    await session.ensure();
    expect(session.state.bootError).toMatchObject({ code: 'network_error' });
    expect(session.signedIn).toBe(false);
    expect(session.state.status).toBe('unknown');
    mock.options.offline = false;
    await session.retryBoot();
    expect(session.state.bootError).toBeNull();
    expect(session.signedIn).toBe(true);
  });
  it('ensure() restores only once', async () => {
    const { mock, session } = mockApi();
    await Promise.all([session.ensure(), session.ensure()]);
    await session.ensure();
    expect(mock.calls.filter(c => c.path === 'session')).toHaveLength(1);
  });
  it('treats an unknown scope as admin, like a credential without a scope entry', async () => {
    const s = scriptedFetch(jsonResponse({ actor: 'joan', scope: 'superuser' }));
    const session = createSession(createApiClient({ apiUrl: 'https://x.test', fetch: s.fetch }));
    await session.restore();
    expect(session.state.scope).toBe('admin');
  });
});

describe('scope', () => {
  it('admin includes operate includes read', async () => {
    const levels = async (scope: 'read' | 'operate' | 'admin') => {
      const { session } = mockApi({ scope });
      await session.restore();
      return (['read', 'operate', 'admin'] as const).map(l => session.can(l));
    };
    expect(await levels('read')).toEqual([true, false, false]);
    expect(await levels('operate')).toEqual([true, true, false]);
    expect(await levels('admin')).toEqual([true, true, true]);
  });
  it('signed out counts as read, and explains what is missing', async () => {
    const { session } = mockApi({ signedOut: true });
    expect(session.can('read')).toBe(true);
    expect(session.can('operate')).toBe(false);
    expect(session.scopeLabel()).toBe('read');
    expect(session.scopeTitle()).toBe('Read');
    expect(session.denied('admin')).toBe('Needs the admin scope. Your token has read access.');
  });
});

describe('login and logout', () => {
  it('posts the token once, reads the session and keeps only actor and scope', async () => {
    const { mock, session } = mockApi({ signedOut: true, scope: 'read' });
    const info = await session.login(TOKEN);
    expect(info).toEqual({ actor: 'joan', scope: 'read' });
    expect(session.state).toMatchObject({ actor: 'joan', scope: 'read', status: 'signedIn' });
    expect(Object.keys(session.state).sort()).toEqual(['actor', 'bootError', 'notice', 'scope', 'status']);
    const logins = mock.calls.filter(c => c.path === 'login');
    expect(logins).toHaveLength(1);
    expect(logins[0]!.body).toEqual({ token: TOKEN });
    expect(mock.calls.map(c => c.path)).toEqual(['csrf', 'login', 'session']);
  });
  it('a rejected token is a visible invalid_token error and the session stays signed out', async () => {
    const { session } = mockApi({ signedOut: true });
    const error = await session.login(BAD_TOKEN).then(() => { throw new Error('expected a rejection'); }, (e: ApiError) => e);
    expect(error).toMatchObject({ status: 401, code: 'invalid_token', message: 'That token was not accepted. Check it and try again.', silent: false });
    expect(session.signedIn).toBe(false);
  });
  it('a too short token is also rejected', async () => {
    const { session } = mockApi({ signedOut: true });
    await expect(session.login('short')).rejects.toMatchObject({ code: 'invalid_token' });
  });
  it('says the browser did not send the cookie when GET session is 401 right after a successful login', async () => {
    const { mock, session } = mockApi({ signedOut: true, cookie: false });
    const error = await session.login(TOKEN).then(() => { throw new Error('expected a rejection'); }, (e: ApiError) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: 'session_cookie_not_sent', silent: false });
    expect(error.message).toBe('Your browser did not send the session cookie. The dashboard and the Server must be on the same site.');
    expect(session.signedIn).toBe(false);
    expect(mock.state.signedIn).toBe(true);
  });
  it('an unreachable Server during login is a network error that names the address', async () => {
    const { session } = mockApi({ signedOut: true, offline: true });
    await expect(session.login(TOKEN)).rejects.toMatchObject({ code: 'network_error', message: expect.stringContaining('https://mock.fleet.invalid') });
  });
  it('logout signs out on the Server, clears the session and leaves a notice for the sign-in page', async () => {
    const { mock, session } = mockApi();
    await session.restore();
    await session.logout();
    expect(session.state).toMatchObject({ status: 'signedOut', actor: null, scope: null });
    expect(mock.state.signedIn).toBe(false);
    expect(session.takeNotice()).toEqual({ text: 'Signed out.', err: false });
    expect(session.takeNotice()).toBeNull();
  });
  it('a failed logout keeps the session and rethrows', async () => {
    const { mock, session } = mockApi({ forbid: true });
    await session.restore();
    mock.options.offline = true;
    await expect(session.logout()).rejects.toMatchObject({ code: 'network_error' });
    expect(session.signedIn).toBe(true);
  });
  it('a 401 while signed in ends the session with a notice; while signed out it is ignored', async () => {
    const { mock, api, session } = mockApi();
    await session.restore();
    mock.state.signedIn = false;
    await expect(api.get('nodes')).rejects.toMatchObject({ status: 401, silent: true });
    expect(session.state.status).toBe('signedOut');
    expect(session.takeNotice()).toEqual({ text: 'Your session ended. Sign in again.', err: false });
    await expect(api.get('nodes')).rejects.toMatchObject({ status: 401 });
    expect(session.takeNotice()).toBeNull();
  });
  it('login needs the CSRF handshake: the token is fetched, then sent', async () => {
    const { mock, session } = mockApi({ signedOut: true });
    await session.login(TOKEN);
    expect(mock.calls[1]!.headers['x-fleet-csrf']).toBe(mock.state.csrf);
  });
});
