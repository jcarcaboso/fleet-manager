import { test, expect } from '../support/fixtures';
import { BAD_PASSWORD, GOOD_PASSWORD, atPath, h1, open, primaryNav, signIn } from '../support/app';
import { mockCalls } from '../support/mock';

test.describe('signing in and out', () => {
  test('signing in with a valid account lands on Machines and keeps the password out of the browser', async ({ page }) => {
    await open(page, '/machines', { signedout: true });
    await expect(page).toHaveURL(atPath('/login'));
    await expect(h1(page)).toHaveText('Sign in');
    await expect(page.getByLabel('Name', { exact: true })).toBeFocused();
    await expect(primaryNav(page)).toBeHidden();

    await signIn(page);
    await expect(page).toHaveURL(atPath('/machines'));
    await expect(primaryNav(page)).toBeVisible();
    await expect(page.locator('#me')).toContainText('joan');
    await expect(page.locator('#me .scope-chip')).toHaveText('admin');

    // The password was posted once, and is nowhere the page can leak it from.
    expect(page.url()).not.toContain(GOOD_PASSWORD);
    const stored = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookie: document.cookie, html: document.documentElement.outerHTML }));
    expect(stored.local + stored.session).toBe(0);
    expect(stored.cookie).toBe('');
    expect(stored.html).not.toContain(GOOD_PASSWORD);
    const logins = (await mockCalls(page)).filter(call => call.path === 'login');
    expect(logins).toHaveLength(1);
  });

  test('a wrong password shows the Server\'s message, clears the field and stays on the sign-in page', async ({ page }) => {
    await open(page, '/login', { signedout: true });
    await signIn(page, BAD_PASSWORD);
    const message = page.locator('#login-msg');
    await expect(message).toHaveText(/invalid|not accepted|sign-in/i);
    await expect(message).toHaveClass(/is-err/);
    await expect(page).toHaveURL(atPath('/login'));
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
    await expect(primaryNav(page)).toBeHidden();
  });

  test('submitting an empty form asks for the name without calling the Server', async ({ page }) => {
    await open(page, '/login', { signedout: true });
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('#login-msg')).toHaveText('Enter your account name.');
    expect((await mockCalls(page)).filter(call => call.method === 'POST')).toHaveLength(0);
  });

  test('the first sign-in as fleet must choose a new password before anything else opens', async ({ page }) => {
    await open(page, '/login', { signedout: true });
    await signIn(page, 'fleet', 'fleet');
    await expect(page).toHaveURL(atPath('/account'));
    await expect(h1(page)).toHaveText('Your account');
    await expect(page.locator('#password-required')).toBeVisible();
    await expect(primaryNav(page)).toBeHidden();
    await page.getByLabel('Current password').fill('fleet');
    await page.getByLabel('New password', { exact: true }).fill('a-long-new-passphrase');
    await page.getByLabel('Repeat the new password').fill('a-long-new-passphrase');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page).toHaveURL(atPath('/machines'));
    await expect(primaryNav(page)).toBeVisible();
    await expect(page.locator('#me')).toContainText('fleet');
  });

  test('the theme is dark by default and the choice is kept across reloads', async ({ page, allow }) => {
    await open(page, '/machines');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.locator('#me .me-link').click();
    await expect(h1(page)).toHaveText('Your account');
    await page.getByRole('button', { name: 'Light', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    /* The pre-paint script applies it before the application's module runs, so the first paint is already light. */
    const appScripts = (url: URL): boolean => url.pathname.startsWith('/assets/') && url.pathname.endsWith('.js');
    allow.request(/GET \S+\/assets\/\S+\.js net::ERR_FAILED$/);
    allow.console(/Failed to load resource: net::ERR_FAILED/);
    await page.route(appScripts, route => route.abort());
    await page.reload();
    await expect(page.locator('#root .noscript-note')).toBeAttached();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.unroute(appScripts);
    await page.reload();
    await expect(h1(page)).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('signing out returns to the sign-in page and ends the session', async ({ page }) => {
    await open(page, '/machines');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(atPath('/login'));
    await expect(h1(page)).toHaveText('Sign in');
    await expect(primaryNav(page)).toBeHidden();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeHidden();
    const state = await page.evaluate(() => (window as unknown as { __MOCK: { state: { signedIn: boolean } } }).__MOCK.state.signedIn);
    expect(state).toBe(false);
    expect((await mockCalls(page)).some(call => call.path === 'logout' && call.status === 200)).toBe(true);
  });
});

test.describe('a session that ends or is missing', () => {
  test('a 401 while a page is open goes to sign-in with a notice, and signing in returns to that page', async ({ page }) => {
    await open(page, '/problems');
    await page.evaluate(() => { (window as unknown as { __MOCK: { state: { signedIn: boolean } } }).__MOCK.state.signedIn = false; });
    await page.getByRole('button', { name: 'Check again' }).click();

    await expect(page).toHaveURL(atPath('/login', { redirect: /^\/problems(\?|$)/ }));
    await expect(page.locator('#login-msg')).toHaveText('Your session ended. Sign in again.');
    await signIn(page);
    await expect(page).toHaveURL(atPath('/problems'));
    await expect(h1(page)).toHaveText('Problems');
  });

  test('opening a page while signed out returns to it after signing in', async ({ page }) => {
    await open(page, '/deployments', { signedout: true });
    await expect(page).toHaveURL(atPath('/login', { redirect: /^\/deployments(\?|$)/ }));
    await signIn(page);
    await expect(page).toHaveURL(atPath('/deployments'));
    await expect(h1(page)).toHaveText('Deployments');
  });

  test('a sign-in address that points outside the app is ignored after signing in', async ({ page }) => {
    await open(page, '/login', { signedout: true, redirect: 'https://evil.example/steal' });
    await signIn(page);
    await expect(page).toHaveURL(atPath('/machines'));
  });

  test('a browser that drops the session cookie is told the dashboard and Server must share a site', async ({ page }) => {
    await open(page, '/login', { signedout: true, cookie: 0 });
    await signIn(page);
    await expect(page.locator('#login-msg')).toContainText('did not send the session cookie');
    await expect(page.locator('#login-msg')).toContainText('same site');
    await expect(page).toHaveURL(atPath('/login'));
  });

  test('a Server that cannot be reached is explained, with a way to try again', async ({ page }) => {
    await page.goto('/machines?offline=1');
    await expect(page.getByRole('heading', { name: /Could not load the dashboard/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});
