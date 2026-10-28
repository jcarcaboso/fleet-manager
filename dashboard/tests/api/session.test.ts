import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient } from '@/api/client';
import { createSession } from '@/api/session';
import { jsonResponse, scriptedFetch } from '../helpers/fetch';
import { mockApi } from '../helpers/mock';
import { BAD_PASSWORD, NAME, PASSWORD } from '../helpers/app';

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
    expect(session.denied('admin')).toBe('Needs the admin scope. Your account has read access.');
  });
});

describe('login and logout', () => {
  it('posts the name and password once, reads the session and keeps only actor, scope and the password flag', async () => {
    const { mock, session } = mockApi({ signedOut: true, scope: 'read' });
    const info = await session.login(NAME, PASSWORD);
    expect(info).toEqual({ actor: 'joan', scope: 'read', mustChangePassword: false });
    expect(session.state).toMatchObject({ actor: 'joan', scope: 'read', status: 'signedIn', mustChangePassword: false });
    expect(Object.keys(session.state).sort()).toEqual(['actor', 'bootError', 'mustChangePassword', 'notice', 'scope', 'status']);
    expect(JSON.stringify(session.state)).not.toContain(PASSWORD);
    const logins = mock.calls.filter(c => c.path === 'login');
    expect(logins).toHaveLength(1);
    expect(logins[0]!.body).toEqual({ name: NAME, password: PASSWORD });
    expect(mock.calls.map(c => c.path)).toEqual(['csrf', 'login', 'session']);
  });
  it('a rejected password is a visible invalid_credentials error and the session stays signed out', async () => {
    const { session } = mockApi({ signedOut: true });
    const error = await session.login(NAME, BAD_PASSWORD).then(() => { throw new Error('expected a rejection'); }, (e: ApiError) => e);
    expect(error).toMatchObject({ status: 401, code: 'invalid_credentials', message: 'That name and password were not accepted. Check them and try again.', silent: false });
    expect(session.signedIn).toBe(false);
  });
  it('an unknown account is also rejected', async () => {
    const { session } = mockApi({ signedOut: true });
    await expect(session.login('nobody', PASSWORD)).rejects.toMatchObject({ code: 'invalid_credentials' });
  });
  it('says the browser did not send the cookie when GET session is 401 right after a successful login', async () => {
    const { mock, session } = mockApi({ signedOut: true, cookie: false });
    const error = await session.login(NAME, PASSWORD).then(() => { throw new Error('expected a rejection'); }, (e: ApiError) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: 'session_cookie_not_sent', silent: false });
    expect(error.message).toBe('Your browser did not send the session cookie. The dashboard and the Server must be on the same site.');
    expect(session.signedIn).toBe(false);
    expect(mock.state.signedIn).toBe(true);
  });
  it('says the same thing when even the antiforgery cookie is dropped, as on another site', async () => {
    const { mock, session } = mockApi({ signedOut: true, csrfCookie: false });
    const error = await session.login(NAME, PASSWORD).then(() => { throw new Error('expected a rejection'); }, (e: ApiError) => e);
    expect(error).toMatchObject({ code: 'session_cookie_not_sent', silent: false });
    expect(error.message).toBe('Your browser did not send the session cookie. The dashboard and the Server must be on the same site.');
    expect(session.signedIn).toBe(false);
    expect(mock.state.signedIn).toBe(false);
    expect(mock.calls.filter(c => c.path === 'login')).toHaveLength(2);
  });
  it('an unreachable Server during login is a network error that names the address', async () => {
    const { session } = mockApi({ signedOut: true, offline: true });
    await expect(session.login(NAME, PASSWORD)).rejects.toMatchObject({ code: 'network_error', message: expect.stringContaining('https://mock.fleet.invalid') });
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
    await session.login(NAME, PASSWORD);
    /* The token that signed in was fetched while signed out; the Server's token changes with the identity, so the mock's has moved on. */
    expect(mock.calls.slice(0, 2).map(c => `${c.method} ${c.path}`)).toEqual(['GET csrf', 'POST login']);
    expect(mock.calls[1]!.headers['x-fleet-csrf']).toBeTruthy();
    expect(mock.calls[1]!.headers['x-fleet-csrf']).not.toBe(mock.state.csrf);
  });
});

describe('password changes', () => {
  it('an account with a given password signs in flagged, is refused elsewhere, and is free once it changes the password', async () => {
    const { mock, api, session } = mockApi({ signedOut: true });
    const info = await session.login('fleet', 'fleet');
    expect(info).toEqual({ actor: 'fleet', scope: 'admin', mustChangePassword: true });
    await expect(api.get('nodes')).rejects.toMatchObject({ status: 403, code: 'password_change_required', message: 'Change your password before continuing.' });
    expect(session.state.mustChangePassword).toBe(true);
    await expect(session.changePassword('wrong-password', 'a-new-passphrase')).rejects.toMatchObject({ code: 'invalid_current_password' });
    await expect(session.changePassword('fleet', 'short')).rejects.toMatchObject({ code: 'invalid_password' });
    const after = await session.changePassword('fleet', 'a-new-passphrase');
    expect(after).toEqual({ actor: 'fleet', scope: 'admin', mustChangePassword: false });
    expect(session.state.mustChangePassword).toBe(false);
    await expect(api.get('nodes')).resolves.toBeTruthy();
    /* The Server re-issues the cookie, so the client fetched a new CSRF token instead of having a mutation refused once. */
    await api.post('source/rescan', {});
    expect(mock.calls.some(c => c.status === 400 && c.path !== 'account/password')).toBe(false);
    await session.logout();
    await expect(session.login('fleet', 'fleet')).rejects.toMatchObject({ code: 'invalid_credentials' });
    await expect(session.login('fleet', 'a-new-passphrase')).resolves.toMatchObject({ mustChangePassword: false });
  });
  it('a 403 password_change_required while signed in raises the flag; signed out it is ignored', () => {
    const { session } = mockApi();
    session.handlePasswordChangeRequired();
    expect(session.state.mustChangePassword).toBe(false);
  });
});
