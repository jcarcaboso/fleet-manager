import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, signIn } from '../support/real';

test.describe('sign in and out against the real Server', () => {
  test('the Server sends /dashboard to the dashboard', async ({ page, stack, request, allow }) => {
    allow.request(/GET \S+\/dashboard\/api\/session -> 401$/); // the sign-in page asks whether there is a session
    allow.console(/Failed to load resource: the server responded with a status of 401/);
    for (const path of ['/dashboard', '/']) {
      const response = await request.get(stack.server + path, { maxRedirects: 0 });
      expect(response.status(), `${path} is redirected`).toBe(302);
      expect(response.headers()['location']).toBe(stack.dashboard);
    }
    await page.goto(stack.server + '/dashboard');
    await expect(page).toHaveURL(url => url.origin === stack.dashboard);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');
  });

  test('a wrong token is refused and sets no session; the right one signs in', async ({ page, context, stack, allow }) => {
    allow.request(/GET \S+\/dashboard\/api\/session -> 401$/);
    allow.request(/POST \S+\/dashboard\/api\/login -> 401$/);
    allow.console(/Failed to load resource: the server responded with a status of 401/);
    await page.goto('/login');
    await page.getByLabel('Operator token').fill('wrong-token-'.padEnd(48, 'x'));
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('#login-msg')).toHaveClass(/is-err/);
    await expect(page.locator('#login-msg')).not.toHaveText('');
    await expect(page).toHaveURL(url => url.pathname === '/login');
    expect((await context.cookies(stack.server)).map(cookie => cookie.name)).not.toContain('__Host-Fleet-Session');

    await page.getByLabel('Operator token').fill(stack.token);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(url => url.pathname === '/machines');
    expect((await context.cookies(stack.server)).map(cookie => cookie.name)).toContain('__Host-Fleet-Session');
  });

  test('the session cookie is HttpOnly, Secure, SameSite=Strict and host-only; the token is stored nowhere', async ({ page, context, stack, allow }) => {
    const sent: string[] = [];
    page.on('request', request => { sent.push(`${request.method()} ${request.url()} ${request.postData() ?? ''} ${JSON.stringify(request.headers())}`); });
    await signIn(page, stack, allow);

    const session = (await context.cookies(stack.server)).find(cookie => cookie.name === '__Host-Fleet-Session');
    expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });
    expect(session?.domain.startsWith('.'), 'a __Host- cookie has no Domain attribute').toBe(false);
    expect(session?.value).not.toBe(stack.token);
    const cookies = await context.cookies(stack.server);
    for (const cookie of cookies) expect(cookie.secure, `${cookie.name} is Secure`).toBe(true);

    // The page cannot read the session, and holds nothing of the token anywhere it could be recovered from.
    const inPage = await page.evaluate(() => ({
      cookie: document.cookie, local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }),
      href: location.href, html: document.documentElement.outerHTML, history: JSON.stringify(history.state),
    }));
    expect(inPage.cookie).toBe('');
    expect(inPage.local + inPage.session).toBe('{}{}');
    for (const [where, text] of Object.entries(inPage)) expect(text.includes(stack.token), `the token is in the page's ${where}`).toBe(false);
    expect(JSON.stringify(await context.storageState()).includes(stack.token), 'the token is in the browser storage state').toBe(false);

    // On the wire the token travels once, in the body of the sign-in request, never in a URL or a header.
    const carrying = sent.filter(line => line.includes(stack.token));
    expect(carrying).toHaveLength(1);
    expect(carrying[0]).toMatch(/^POST \S+\/dashboard\/api\/login /);
  });

  test('a third origin cannot read the API, with or without credentials, and the Server answers its preflight with 403', async ({ page, stack, request, allow }) => {
    await signIn(page, stack, allow);

    // CORS: only the dashboard's origin is allowed; headers are exact.
    const api = `${stack.server}/dashboard/api/csrf`;
    const fromDashboard = await request.get(api, { headers: { Origin: stack.dashboard } });
    expect(fromDashboard.headers()['access-control-allow-origin']).toBe(stack.dashboard);
    expect(fromDashboard.headers()['access-control-allow-credentials']).toBe('true');
    expect(fromDashboard.headers()['vary']).toContain('Origin');
    for (const other of ['https://other-site.invalid', 'http://127.0.0.1:1', 'null']) {
      const response = await request.get(api, { headers: { Origin: other } });
      expect(response.headers()['access-control-allow-origin'], `ACAO for ${other}`).toBeUndefined();
      expect(response.headers()['access-control-allow-credentials'], `ACAC for ${other}`).toBeUndefined();
      const preflight = await request.fetch(api, { method: 'OPTIONS', headers: { Origin: other, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-fleet-csrf' } });
      expect(preflight.status(), `preflight from ${other}`).toBe(403);
      expect(preflight.headers()['access-control-allow-origin']).toBeUndefined();
    }
    const preflight = await request.fetch(api, { method: 'OPTIONS', headers: { Origin: stack.dashboard, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-fleet-csrf' } });
    expect(preflight.status()).toBe(204);
    expect(preflight.headers()['access-control-allow-methods']).toBe('GET, POST, OPTIONS');
    expect(preflight.headers()['access-control-allow-headers']).toBe('Content-Type, X-Fleet-CSRF');

    // A real browser page on a third origin, signed in in the same browser, cannot read anything.
    let thirdParty: Server | undefined;
    try {
      thirdParty = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><title>third origin</title>'); });
      await new Promise<void>(resolve => thirdParty!.listen(0, '127.0.0.1', resolve));
      const thirdOrigin = `http://127.0.0.1:${(thirdParty.address() as AddressInfo).port}`;
      allow.console(/CORS|Failed to load resource|ERR_FAILED/);
      allow.request(/GET \S+\/dashboard\/api\/session net::ERR_FAILED/);
      const other = await page.context().newPage();
      await other.goto(thirdOrigin);
      const outcome = await other.evaluate(async url => {
        try {
          const response = await fetch(url, { credentials: 'include' });
          return { read: true, status: response.status, body: await response.text() };
        } catch (error) {
          return { read: false, error: String(error) };
        }
      }, `${stack.server}/dashboard/api/session`);
      expect(outcome.read, 'the third origin must not be able to read the response').toBe(false);
      await other.close();
    } finally {
      await new Promise<void>(resolve => (thirdParty ? thirdParty.close(() => resolve()) : resolve()));
    }
  });

  test('signing out ends the session on the Server', async ({ page, stack, allow }) => {
    await signIn(page, stack, allow);
    const session = () => page.request.get(`${stack.server}/dashboard/api/session`, { headers: { Origin: stack.dashboard } }); // shares the browser's cookies
    expect((await session()).status()).toBe(200);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(url => url.pathname === '/login');
    expect((await session()).status()).toBe(401);
  });
});
