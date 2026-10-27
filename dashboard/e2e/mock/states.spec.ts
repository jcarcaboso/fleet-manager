import { test, expect } from '../support/fixtures';
import { h1, open } from '../support/app';
import { mockCalls } from '../support/mock';

test.describe('error and empty states', () => {
  test('a page whose data cannot be loaded says so and offers Try again, which asks again', async ({ page }) => {
    await open(page, '/machines', { fail: 'nodes' }).catch(() => undefined);
    await expect(page.getByRole('heading', { name: 'Could not load Machines' })).toBeVisible();
    await expect(page.locator('main')).toContainText('The Server had a problem (500). Try again in a moment.');
    const before = (await mockCalls(page)).filter(call => call.path === 'nodes').length;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(async () => (await mockCalls(page)).filter(call => call.path === 'nodes').length).toBeGreaterThan(before);
    await expect(page.getByRole('heading', { name: 'Could not load Machines' })).toBeVisible();
  });

  test('a Server with nothing yet explains the next step', async ({ page }) => {
    await open(page, '/machines', { empty: true });
    await expect(h1(page)).toHaveText('No machines yet');
    await expect(page.getByRole('button', { name: 'Add machine' })).toBeVisible();
    await open(page, '/problems', { empty: true });
    await expect(page.locator('.sumrow .sumtile').first()).toContainText('0'); // no machine errors; only the model catalog warning is left
    await expect(page.locator('details.prow')).toHaveCount(1);
    await open(page, '/deployments', { empty: true });
    await expect(page.getByRole('heading', { name: 'Nothing has been published yet' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sync repository' })).toBeVisible();
    await open(page, '/enrollment', { empty: true });
    await expect(page.locator('li.link-row')).toHaveCount(0);
  });

  test('a slow Server shows loading placeholders, not a blank page', async ({ page }) => {
    await page.goto('/machines?slow=700');
    await expect(page.locator('#view .skel').first()).toBeVisible();
    await expect(h1(page)).toBeVisible();
    await expect(page.locator('#view .skel')).toHaveCount(0);
  });
});

test.describe('hostile text from the Server', () => {
  test('is shown as text: nothing runs, no element is created, no dialog opens', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
    for (const path of ['/deployments', '/machines/design-imac', '/machines/design-imac/problems', '/machines/design-imac/activity', '/problems', '/repository', '/audit']) {
      await open(page, path, { xss: true });
      await expect(page.locator('#view .skel')).toHaveCount(0);
      // The payloads never became elements.
      await expect(page.locator('#view img[src="x"], #view svg[onload], #view script')).toHaveCount(0);
      await expect(page.locator('#view [onerror], #view [onload]')).toHaveCount(0);
    }
    await open(page, '/deployments', { xss: true });
    await expect(page.locator('main')).toContainText('<img src=x onerror=alert(1)>'); // the literal text is visible
    expect(dialogs).toEqual([]);
  });
});
