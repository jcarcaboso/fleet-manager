import { afterEach, describe, expect, it, vi } from 'vitest';
import { BAD_PASSWORD, NAME, PASSWORD, mountApp, waitFor, type TestApp } from '../helpers/app';

let app: TestApp | undefined;
afterEach(() => { app?.unmount(); vi.restoreAllMocks(); });

async function submit(a: TestApp, password: string, name = NAME): Promise<void> {
  a.wrapper.find<HTMLInputElement>('#login-name').element.value = name;
  a.wrapper.find<HTMLInputElement>('#login-password').element.value = password;
  await a.wrapper.find('form').trigger('submit');
  await a.settle();
}

describe('login page', () => {
  it('renders the form with a labelled name field and a masked password field, and focuses the name', async () => {
    app = await mountApp({ mock: { signedOut: true } });
    const w = app.wrapper;
    expect(w.find('h1#login-title').text()).toBe('Sign in');
    expect(w.find('section.login-card').attributes('aria-labelledby')).toBe('login-title');
    expect(w.find('label[for="login-name"]').text()).toBe('Name');
    expect(w.find('label[for="login-password"]').text()).toBe('Password');
    const name = w.find('#login-name');
    expect(name.attributes('autocomplete')).toBe('username');
    expect(name.attributes('maxlength')).toBe('64');
    const input = w.find('#login-password');
    expect(input.attributes('type')).toBe('password');
    expect(input.attributes('autocomplete')).toBe('current-password');
    expect(input.attributes('spellcheck')).toBe('false');
    expect(input.attributes('maxlength')).toBe('256');
    expect(input.attributes('aria-describedby')).toBe('login-msg');
    expect(w.find('#login-msg').attributes('role')).toBe('alert');
    expect(w.find('form button[type="submit"]').text()).toBe('Sign in');
    expect(w.text()).toContain('The password is sent once to start a session. It is never stored in this browser.');
    expect(w.text()).not.toContain('Operator token');
    expect(document.activeElement).toBe(name.element);
  });

  it('signs in with a valid name and password and lands on the machines, with the navigation and the session in place', async () => {
    app = await mountApp({ mock: { signedOut: true, scope: 'operate' } });
    await submit(app, PASSWORD);
    await waitFor(() => app!.router.currentRoute.value.name === 'machines');
    await app.settle();
    expect(app.ctx.session.state).toMatchObject({ actor: 'joan', scope: 'operate', status: 'signedIn', mustChangePassword: false });
    expect(app.wrapper.find('#me .scope-chip').text()).toBe('operate');
    expect(app.wrapper.find('#nav').exists()).toBe(true);
    expect(app.wrapper.find('#login-password').exists()).toBe(false);
  });

  it('returns to the page the visitor asked for', async () => {
    app = await mountApp({ path: '/audit?x=1', mock: { signedOut: true } });
    expect(app.router.currentRoute.value.query.redirect).toBe('/audit?x=1');
    await submit(app, PASSWORD);
    await waitFor(() => app!.router.currentRoute.value.fullPath === '/audit?x=1');
  });

  it('ignores a redirect to another origin', async () => {
    app = await mountApp({ mock: { signedOut: true } });
    await app.router.push('/login?redirect=https://evil.example/');
    await submit(app, PASSWORD);
    await waitFor(() => app!.router.currentRoute.value.name === 'machines');
  });

  it('clears the password field at once and never keeps the password in the page', async () => {
    app = await mountApp({ mock: { signedOut: true } });
    app.wrapper.find<HTMLInputElement>('#login-name').element.value = NAME;
    const input = app.wrapper.find<HTMLInputElement>('#login-password');
    const TOKEN = PASSWORD;
    input.element.value = TOKEN;
    await app.wrapper.find('form').trigger('submit');
    expect(input.element.value).toBe('');
    await app.settle();
    expect(app.wrapper.html()).not.toContain(TOKEN);
    expect(JSON.stringify(app.router.currentRoute.value)).not.toContain(TOKEN);
    expect(JSON.stringify(app.ctx.session.state)).not.toContain(TOKEN);
    expect(window.location.href).not.toContain(TOKEN);
    expect(window.sessionStorage.length).toBe(0);
    for (let i = 0; i < window.localStorage.length; i++) expect(window.localStorage.getItem(window.localStorage.key(i)!)).not.toContain(TOKEN);
  });

  it('asks for the name and then the password when they are empty, without a request', async () => {
    app = await mountApp({ mock: { signedOut: true } });
    const before = app.mock.calls.length;
    await submit(app, PASSWORD, '  ');
    expect(app.wrapper.find('#login-msg').text()).toBe('Enter your account name.');
    expect(app.wrapper.find('#login-msg').classes()).toContain('is-err');
    expect(document.activeElement).toBe(app.wrapper.find('#login-name').element);
    await submit(app, '');
    expect(app.wrapper.find('#login-msg').text()).toBe('Enter your password.');
    expect(document.activeElement).toBe(app.wrapper.find('#login-password').element);
    expect(app.mock.calls.length).toBe(before);
  });

  it('explains a rejected password, re-enables the button and refocuses the password field', async () => {
    app = await mountApp({ mock: { signedOut: true } });
    await submit(app, BAD_PASSWORD);
    expect(app.wrapper.find('#login-msg').text()).toBe('That name and password were not accepted. Check them and try again.');
    expect(app.wrapper.find('#login-msg').classes()).toContain('is-err');
    expect(app.wrapper.find('form button').attributes('disabled')).toBeUndefined();
    expect(app.router.currentRoute.value.name).toBe('login');
    expect(document.activeElement).toBe(app.wrapper.find('#login-password').element);
    await submit(app, PASSWORD, 'nobody');
    expect(app.router.currentRoute.value.name).toBe('login');
    await submit(app, PASSWORD);
    await waitFor(() => app!.router.currentRoute.value.name === 'machines');
  });

  it('says the cookie was not sent when the session is not there right after a successful login', async () => {
    app = await mountApp({ mock: { signedOut: true, cookie: false } });
    await submit(app, PASSWORD);
    expect(app.wrapper.find('#login-msg').text()).toBe('Your browser did not send the session cookie. The dashboard and the Server must be on the same site.');
    expect(app.router.currentRoute.value.name).toBe('login');
    expect(app.ctx.session.signedIn).toBe(false);
  });

  it('shows the same-site explanation, not a refresh hint, when the antiforgery cookie is dropped', async () => {
    app = await mountApp({ mock: { signedOut: true, csrfCookie: false } });
    await submit(app, PASSWORD);
    expect(app.wrapper.find('#login-msg').text()).toBe('Your browser did not send the session cookie. The dashboard and the Server must be on the same site.');
    expect(app.wrapper.find('#login-msg').text()).not.toContain('Refresh');
    expect(app.router.currentRoute.value.name).toBe('login');
  });

  it('names the Server address when it cannot be reached', async () => {
    app = await mountApp({ mock: { signedOut: true } });
    app.mock.options.offline = true;
    await submit(app, PASSWORD);
    expect(app.wrapper.find('#login-msg').text()).toContain('Could not reach the Server at https://mock.fleet.invalid');
  });

  it('shows a Server refusal of the origin as a readable message', async () => {
    app = await mountApp({ mock: { signedOut: true, origin: 'https://evil.example', dashboardOrigin: 'https://dashboard.home.arpa' } });
    await submit(app, PASSWORD);
    expect(app.wrapper.find('#login-msg').text()).toBe('This page was not opened from the dashboard address the Server allows. Open the dashboard from that address and try again.');
  });

  it('disables the button while signing in and says so', async () => {
    app = await mountApp({ mock: { signedOut: true, slow: 50 } });
    app.wrapper.find<HTMLInputElement>('#login-name').element.value = NAME;
    app.wrapper.find<HTMLInputElement>('#login-password').element.value = PASSWORD;
    await app.wrapper.find('form').trigger('submit');
    expect(app.wrapper.find('#login-msg').text()).toBe('Signing in…');
    expect(app.wrapper.find('form button').attributes('disabled')).toBeDefined();
    await app.settle();
  });

  it('clears the password field when the page is hidden', async () => {
    app = await mountApp({ mock: { signedOut: true } });
    const input = app.wrapper.find<HTMLInputElement>('#login-password');
    input.element.value = 'half typed';
    window.dispatchEvent(new Event('pagehide'));
    expect(input.element.value).toBe('');
  });

  it('an account that still has its given password is sent to the password page, with no navigation', async () => {
    app = await mountApp({ path: '/audit', mock: { signedOut: true, mustChangePassword: true } });
    await submit(app, 'fleet', 'fleet');
    await waitFor(() => app!.router.currentRoute.value.name === 'account');
    expect(app.router.currentRoute.value.query.redirect).toBe('/audit');
    expect(app.ctx.session.state.mustChangePassword).toBe(true);
    expect(app.wrapper.find('#nav').exists()).toBe(false);
    expect(app.wrapper.find('#password-required').exists()).toBe(true);
  });
});
