import { test, expect } from '../support/fixtures';
import { atPath, h1, open, primaryNav } from '../support/app';
import { appUrl, mockCalls } from '../support/mock';

test.describe('old bookmarks', () => {
  // The Server redirects /dashboard to the dashboard and the browser keeps the fragment: https://DASHBOARD/#/nodes/…
  const bookmarks: Array<[string, string, string]> = [
    ['#/nodes', '/machines', 'machines are up to date'],
    ['#/nodes/studio-mini', '/machines/studio-mini', 'studio-mini'],
    ['#/nodes/studio-mini/problems', '/machines/studio-mini/problems', 'studio-mini'],
    ['#/problems', '/problems', 'Problems'],
    ['#/deployments', '/deployments', 'Deployments'],
    ['#/repository', '/repository', 'Repository'],
    ['#/models', '/models', 'Models'],
    ['#/enrollment', '/enrollment', 'Enrollment'],
    ['#/audit', '/audit', 'Audit'],
  ];
  for (const [hash, path, heading] of bookmarks) {
    test(`${hash} opens ${path}`, async ({ page }) => {
      await page.goto(`/${hash}`);
      await expect(page).toHaveURL(url => url.pathname === path && url.hash === '');
      await expect(h1(page)).toContainText(heading);
    });
  }

  test('an old bookmark of a revision and of the Add machine screen are translated too', async ({ page }) => {
    await page.goto('/#/deployments/a3f9c21');
    await expect(page).toHaveURL(atPath('/deployments', { revision: 'a3f9c21' }));
    await expect(h1(page)).toHaveText('Deployments');

    await page.goto('/#/add');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page).toHaveURL(url => url.pathname === '/machines' && !url.searchParams.has('add'));
  });

  test('a bookmark of a machine whose alias has a slash keeps it encoded', async ({ page }) => {
    await page.goto('/?weirdalias=1#/nodes/rack%2FA%20100%25/settings');
    await expect(page).toHaveURL(url => url.pathname === '/machines/rack%2FA%20100%25/settings');
    await expect(h1(page)).toHaveText('rack/A 100%');
  });

  test('an unknown fragment is left alone and the app opens Machines', async ({ page }) => {
    await page.goto('/#/something-else');
    await expect(page).toHaveURL(url => url.pathname === '/machines');
    await expect(h1(page)).toBeVisible();
  });
});

test.describe('deep links', () => {
  test('a machine whose alias needs encoding opens directly and survives a reload', async ({ page }) => {
    await page.goto(appUrl('/machines/rack%2FA%20100%25/security', { weirdalias: true }));
    await expect(h1(page)).toHaveText('rack/A 100%');
    await expect(page.getByRole('navigation', { name: /sections$/ }).getByRole('link', { name: 'Security' })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#tabpanel')).toContainText('Credential ID');
    // The alias goes to the Server as one path segment, encoded.
    expect((await mockCalls(page)).some(call => call.path === 'nodes/rack%2FA%20100%25' || call.path === 'nodes/rack%2fA%20100%25')).toBe(true);

    await page.reload();
    await expect(page).toHaveURL(url => url.pathname === '/machines/rack%2FA%20100%25/security');
    await expect(h1(page)).toHaveText('rack/A 100%');
    await expect(page.locator('#tabpanel')).toContainText('Credential ID');
  });

  test('the gallery links the same machine with the same encoding', async ({ page }) => {
    await open(page, '/machines', { weirdalias: true });
    await page.getByRole('link', { name: 'rack/A 100%', exact: true }).click();
    await expect(page).toHaveURL(url => url.pathname === '/machines/rack%2FA%20100%25');
    await expect(h1(page)).toHaveText('rack/A 100%');
  });

  for (const alias of ['build.box', 'v1.2.box', '.hidden-box', 'trailing.']) {
    test(`an address with the dotted alias "${alias}" is answered by the app, not by a file server`, async ({ page }) => {
      // The preview serves index.html for the application routes, as nginx does; the app then says it cannot find the machine.
      await page.goto(appUrl(`/machines/${alias}/settings`));
      await expect(h1(page)).toHaveText(`We could not find “${alias}”`);
      await page.reload();
      await expect(h1(page)).toHaveText(`We could not find “${alias}”`);
      await expect(page.getByRole('link', { name: 'Back to all machines' })).toBeVisible();
    });
  }

  test('an unknown page says so, with a way back', async ({ page }) => {
    await page.goto('/no/such/page');
    await expect(h1(page)).toHaveText('That page does not exist');
    await expect(page.getByRole('link', { name: 'Back to all machines' })).toBeVisible();
    await expect(primaryNav(page)).toBeVisible();
    await expect(page).toHaveTitle(/Not found/);
  });

  test('every page sets a title that names it', async ({ page }) => {
    const titles = new Map<string, string>();
    for (const path of ['/machines', '/problems', '/deployments', '/repository', '/models', '/enrollment', '/audit', '/machines/design-imac']) {
      await open(page, path);
      titles.set(path, await page.title());
      expect(titles.get(path)).toMatch(/ · Fleet Manager$/);
    }
    expect(new Set(titles.values()).size).toBe(titles.size);
  });

  test('the Back button returns through tabs and pages', async ({ page }) => {
    await open(page, '/machines');
    await page.getByRole('link', { name: 'design-imac', exact: true }).click();
    await page.getByRole('navigation', { name: /sections$/ }).getByRole('link', { name: 'Security' }).click();
    await expect(page).toHaveURL(atPath('/machines/design-imac/security'));
    await page.goBack();
    await expect(page).toHaveURL(atPath('/machines/design-imac'));
    await expect(page.getByRole('heading', { level: 2, name: 'Health checks' })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(atPath('/machines'));
    await page.goForward();
    await expect(h1(page)).toHaveText('design-imac');
  });
});
