import { afterEach, describe, expect, it, vi } from 'vitest';
import { BAD_TOKEN, TOKEN, mountApp, waitFor, type TestApp } from '../helpers/app';

let app: TestApp | undefined;
afterEach(() => { app?.unmount(); vi.restoreAllMocks(); });

async function submit(a: TestApp, token: string): Promise<void> {
  const input = a.wrapper.find<HTMLInputElement>('#operator-token');
  input.element.value = token;
  await a.wrapper.find('form').trigger('submit');
  await a.settle();
}

describe('login page', () => {
  it('renders the form with a labelled, masked token field and focuses it', async () => {
    app = await mountApp({ mock: { signedOut: true } });
    const w = app.wrapper;
    expect(w.find('h1#login-title').text()).toBe('Sign in');
    expect(w.find('section.login-card').attributes('aria-labelledby')).toBe('login-title');
    expect(w.find('label[for="operator-token"]').text()).toBe('Operator token');
    const input = w.find('#operator-token');
    expect(input.attributes('type')).toBe('password');
    expect(input.attributes('autocomplete')).toBe('off');
    expect(input.attributes('spellcheck')).toBe('false');
    expect(input.attributes('maxlength')).toBe('1024');
    expect(input.attributes('aria-describedby')).toBe('login-msg');
    expect(w.find('#login-msg').attributes('role')).toBe('alert');
    expect(w.find('form button[type="submit"]').text()).toBe('Sign in');
    expect(w.text()).toContain('The token is sent once to start a session. It is never stored in this browser.');
    expect(document.activeElement).toBe(input.element);
  });

  it('signs in with a valid token and lands on the machines, with the navigation and the session in place', async () => {
    app = await mountApp({ mock: { signedOut: true, scope: 'operate' } });
    await submit(app, TOKEN);
    await waitFor(() => app!.router.currentRoute.value.name === 'machines');
    await app.settle();
    expect(app.ctx.session.state).toMatchObject({ actor: 'joan', scope: 'operate', status: 'signedIn' });
    expect(app.wrapper.find('#me .scope-chip').text()).toBe('operate');
    expect(app.wrapper.find('#nav').exists()).toBe(true);
    expect(app.wrapper.find('#operator-token').exists()).toBe(false);
  });

  it('returns to the page the visitor asked for', async () => {
    app = await mountApp({ path: '/audit?x=1', mock: { signedOut: true } });
    expect(app.router.currentRoute.value.query.redirect).toBe('/audit?x=1');
    await submit(app, TOKEN);
    await waitFor(() => app!.router.currentRoute.value.fullPath === '/audit?x=1');
  });

  it('ignores a redirect to another origin', async () => {
    app = await mountApp({ mock: { signedOut: true } });
    await app.router.push('/login?redirect=https://evil.example/');
    await submit(app, TOKEN);
    await waitFor(() => app!.router.currentRoute.value.name === 'machines');
  });

  it('clears the field at once and never keeps the token in the page', async () => {
    app = await mountApp({ mock: { signedOut: true } });
    const input = app.wrapper.find<HTMLInputElement>('#operator-token');
    input.element.value = TOKEN;
    await app.wrapper.find('form').trigger('submit');
    expect(input.element.value).toBe('');
    await app.settle();
    expect(app.wrapper.html()).not.toContain(TOKEN);
    expect(JSON.stringify(app.router.currentRoute.value)).not.toContain(TOKEN);
    expect(JSON.stringify(app.ctx.session.state)).not.toContain(TOKEN);
    expect(window.location.href).not.toContain(TOKEN);
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
  });

  it('asks for a token when the field is empty, without a request', async () => {
    app = await mountApp({ mock: { signedOut: true } });
    const before = app.mock.calls.length;
    await submit(app, '');
    expect(app.wrapper.find('#login-msg').text()).toBe('Enter your Operator token.');
    expect(app.wrapper.find('#login-msg').classes()).toContain('is-err');
    expect(app.mock.calls.length).toBe(before);
    expect(document.activeElement).toBe(app.wrapper.find('#operator-token').element);
  });

  it('explains a rejected token, re-enables the button and refocuses the field', async () => {
    app = await mountApp({ mock: { signedOut: true } });
    await submit(app, BAD_TOKEN);
    expect(app.wrapper.find('#login-msg').text()).toBe('That token was not accepted. Check it and try again.');
    expect(app.wrapper.find('#login-msg').classes()).toContain('is-err');
    expect(app.wrapper.find('form button').attributes('disabled')).toBeUndefined();
    expect(app.router.currentRoute.value.name).toBe('login');
    expect(document.activeElement).toBe(app.wrapper.find('#operator-token').element);
    await submit(app, TOKEN);
    await waitFor(() => app!.router.currentRoute.value.name === 'machines');
  });

  it('says the cookie was not sent when the session is not there right after a successful login', async () => {
    app = await mountApp({ mock: { signedOut: true, cookie: false } });
    await submit(app, TOKEN);
    expect(app.wrapper.find('#login-msg').text()).toBe('Your browser did not send the session cookie. The dashboard and the Server must be on the same site.');
    expect(app.router.currentRoute.value.name).toBe('login');
    expect(app.ctx.session.signedIn).toBe(false);
  });

  it('names the Server address when it cannot be reached', async () => {
    app = await mountApp({ mock: { signedOut: true } });
    app.mock.options.offline = true;
    await submit(app, TOKEN);
    expect(app.wrapper.find('#login-msg').text()).toContain('Could not reach the Server at https://mock.fleet.invalid');
  });

  it('shows a Server refusal of the origin as a readable message', async () => {
    app = await mountApp({ mock: { signedOut: true, origin: 'https://evil.example', dashboardOrigin: 'https://dashboard.home.arpa' } });
    await submit(app, TOKEN);
    expect(app.wrapper.find('#login-msg').text()).toBe('This page was not opened from the dashboard address the Server allows. Open the dashboard from that address and try again.');
  });

  it('disables the button while signing in and says so', async () => {
    app = await mountApp({ mock: { signedOut: true, slow: 50 } });
    const input = app.wrapper.find<HTMLInputElement>('#operator-token');
    input.element.value = TOKEN;
    await app.wrapper.find('form').trigger('submit');
    expect(app.wrapper.find('#login-msg').text()).toBe('Signing in…');
    expect(app.wrapper.find('form button').attributes('disabled')).toBeDefined();
    await app.settle();
  });

  it('clears the token field when the page is hidden', async () => {
    app = await mountApp({ mock: { signedOut: true } });
    const input = app.wrapper.find<HTMLInputElement>('#operator-token');
    input.element.value = 'half typed';
    window.dispatchEvent(new Event('pagehide'));
    expect(input.element.value).toBe('');
  });
});
