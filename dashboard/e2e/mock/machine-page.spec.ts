import { test, expect } from '../support/fixtures';
import { atPath, card, cardAliases, h1, open, openMachine } from '../support/app';
import { mockWrites } from '../support/mock';

const tabs = (page: import('@playwright/test').Page) => page.getByRole('navigation', { name: /sections$/ });
const toast = (page: import('@playwright/test').Page) => page.locator('#toasts');
const dialog = (page: import('@playwright/test').Page) => page.getByRole('dialog');

test.describe('machine page', () => {
  test('opens from the gallery and walks through all six tabs', async ({ page }) => {
    await openMachine(page, 'design-imac');
    await expect(page).toHaveURL(atPath('/machines/design-imac'));
    await expect(page.locator('.nhero')).toContainText('Action needed');
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('All machines');
    await expect(tabs(page).getByRole('link')).toHaveText([/^Overview$/, /^Installed$/, /^Problems\s*2$/, /^Activity$/, /^Security$/, /^Settings$/]);
    await expect(tabs(page).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { level: 2, name: 'Health checks' })).toBeVisible();
    await expect(page.locator('#disk-panel')).toContainText('Home folder');
    await expect(page.getByRole('heading', { level: 2, name: 'Machine' })).toBeVisible();

    const steps: Array<[string, string, string | RegExp]> = [
      ['Installed', 'installed', 'Skills'],
      ['Problems', 'problems', 'Another Agent process holds the state lock'],
      ['Activity', 'activity', 'Activity'],
      ['Security', 'security', 'Node credential'],
      ['Settings', 'settings', 'Remove from Fleet'],
    ];
    for (const [name, path, heading] of steps) {
      await tabs(page).getByRole('link', { name: new RegExp(`^${name}`) }).click();
      await expect(page).toHaveURL(atPath(`/machines/design-imac/${path}`));
      await expect(tabs(page).getByRole('link', { name: new RegExp(`^${name}`) })).toHaveAttribute('aria-current', 'page');
      await expect(page.locator('#tabpanel').getByRole('heading', { name: heading }).first()).toBeVisible();
      await expect(page.locator('#tabpanel .empty--error')).toHaveCount(0);
    }
    await tabs(page).getByRole('link', { name: 'Overview' }).click();
    await expect(page).toHaveURL(atPath('/machines/design-imac'));
    await expect(page.getByRole('heading', { level: 2, name: 'Health checks' })).toBeVisible();
  });

  test('shows what the Agent installed, its activity with older pages, and the credential', async ({ page }) => {
    await open(page, '/machines/design-imac/installed');
    await expect(page.locator('#tabpanel table').first()).toContainText('code-review');
    await expect(page.locator('#tabpanel')).toContainText('In sync');

    await open(page, '/machines/design-imac/activity', { pagesize: 3 });
    await expect(page.getByRole('button', { name: 'Load older activity' })).toBeVisible();
    const before = await page.locator('#tabpanel li, #tabpanel tr').count();
    await page.getByRole('button', { name: 'Load older activity' }).click();
    await expect.poll(() => page.locator('#tabpanel li, #tabpanel tr').count()).toBeGreaterThan(before);

    await open(page, '/machines/design-imac/security');
    await expect(page.locator('#tabpanel')).toContainText('Credential ID');
    await expect(page.getByRole('img', { name: /Certificate validity/ })).toBeVisible();
  });

  test('retries a failed Target and tells the Operator the Agent applies it on its next poll', async ({ page }) => {
    await open(page, '/machines/design-imac/problems');
    const retry = page.locator('[data-act=retry][data-target="agent-file/claude"]');
    await expect(retry).toBeEnabled();
    await retry.click();
    await expect(toast(page)).toContainText('Retry requested for CLAUDE.md for Claude Code on design-imac');
    await expect(toast(page)).toContainText('The Agent applies it on its next poll.');

    const writes = await mockWrites(page);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: 'POST', status: 200, body: { target: 'agent-file/claude' } });
    expect(writes[0].path).toMatch(/^nodes\/[^/]+\/retry$/);
  });

  test('refreshes the disk and shows the Agent\'s answer when it arrives', async ({ page }) => {
    await page.clock.install();
    await open(page, '/machines/design-imac', { diskdelay: 1000 });
    const before = await page.locator('.disk-measured').innerText();
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
    await expect(page.locator('#disk-status')).toHaveText('Refresh requested — the Agent answers on its next check-in.');

    await page.clock.runFor(6_000); // the Agent answers after 1 s; the page reads the machine again every 5 s
    await expect(page.locator('#disk-status')).toHaveText(/^Disk usage updated /);
    await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    await expect(page.locator('.disk-measured')).not.toHaveText(before);

    const refreshes = (await mockWrites(page)).filter(call => call.path.endsWith('/disk-usage/refresh'));
    expect(refreshes).toHaveLength(1);
  });

  test('gives up on a disk refresh that nothing answers, and says why', async ({ page }) => {
    await page.clock.install();
    await open(page, '/machines/kitchen-mini'); // Agent 0.6.6 does not report disk usage
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.locator('#disk-status')).toContainText('Refresh requested');

    await page.clock.runFor(60_000);
    await expect(page.locator('#disk-status')).toContainText('Refresh requested'); // still waiting after a minute
    await page.clock.runFor(95_000); // past the 150 s limit
    await expect(page.locator('#disk-status')).toHaveText('No answer yet. Agents before 0.9.0 do not report disk usage.');
    await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  });

});

test.describe('renaming, revoking and removing a machine', () => {
  test('rename follows the machine to its new address and the gallery shows it', async ({ page }) => {
    await open(page, '/machines/laptop-ana/settings');
    await page.getByLabel('Alias', { exact: true }).fill('ana-laptop');
    await page.getByRole('button', { name: 'Save alias' }).click();
    await expect(page).toHaveURL(atPath('/machines/ana-laptop/settings'));
    await expect(h1(page)).toHaveText('ana-laptop');
    await expect(toast(page)).toContainText('Alias changed');
    await expect(page.locator('#rename-msg')).toContainText(/ana-laptop|renamed|changed/i);

    const rename = (await mockWrites(page)).find(call => call.path.endsWith('/rename'));
    expect(rename?.body).toMatchObject({ currentAlias: 'laptop-ana', alias: 'ana-laptop' });

    await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'All machines' }).click();
    await expect.poll(() => cardAliases(page)).toContain('ana-laptop');
    expect(await cardAliases(page)).not.toContain('laptop-ana');
  });

  test('rename refuses a blank alias and one that is taken, and says so next to the field', async ({ page }) => {
    await open(page, '/machines/laptop-ana/settings');
    const field = page.getByLabel('Alias', { exact: true });
    await field.fill('   ');
    await page.getByRole('button', { name: 'Save alias' }).click();
    await expect(page.locator('#rename-msg')).toHaveText('Choose a nonblank alias of at most 200 characters.');
    await expect(field).toHaveAttribute('aria-invalid', 'true');

    await field.fill('gpu-box');
    await page.getByRole('button', { name: 'Save alias' }).click();
    await expect(page.locator('#rename-msg')).toHaveClass(/is-err/);
    await expect(page.locator('#rename-msg')).not.toHaveText('');
    await expect(page).toHaveURL(atPath('/machines/laptop-ana/settings'));
  });

  test('revoking asks first, blocks the machine and moves it to Retired', async ({ page }) => {
    await open(page, '/machines/laptop-ana/security');
    await page.getByRole('button', { name: 'Revoke…' }).click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByRole('heading', { name: 'Revoke access for laptop-ana?' })).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog(page)).toBeHidden();
    expect(await mockWrites(page)).toHaveLength(0);

    await page.getByRole('button', { name: 'Revoke…' }).click();
    await dialog(page).getByRole('button', { name: 'Revoke access' }).click();
    await expect(toast(page)).toContainText('laptop-ana revoked');
    await expect(page.locator('#tabpanel')).toContainText('already revoked');
    await expect(page.getByRole('button', { name: 'Revoke…' })).toHaveCount(0);

    await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'All machines' }).click();
    const retired = page.locator('details.retired');
    await expect(retired).toBeVisible();
    await retired.locator('summary').click();
    await expect(card(page, 'laptop-ana')).toBeVisible();
    await expect(card(page, 'laptop-ana')).toContainText('Revoked');
  });

  test('removing needs the alias typed exactly, then frees the alias', async ({ page }) => {
    await open(page, '/machines/old-laptop/settings');
    await page.getByRole('button', { name: 'Remove…' }).click();
    const confirm = dialog(page).getByRole('button', { name: 'Remove machine' });
    const phrase = dialog(page).getByLabel('Type old-laptop to confirm');
    await expect(confirm).toBeDisabled();
    await phrase.fill('old-lapto');
    await expect(confirm).toBeDisabled();
    await phrase.fill('OLD-LAPTOP');
    await expect(confirm).toBeDisabled();
    await phrase.fill('old-laptop');
    await expect(confirm).toBeEnabled();
    expect(await mockWrites(page)).toHaveLength(0);

    await confirm.click();
    await expect(toast(page)).toContainText('old-laptop removed');
    await expect(page).toHaveURL(atPath('/machines'));
    await expect(page.locator('details.retired')).toHaveCount(0);
    expect((await mockWrites(page)).map(call => call.path.replace(/^nodes\/[^/]+\//, 'nodes/{id}/'))).toEqual(['nodes/{id}/remove']);
    expect((await mockWrites(page))[0].body).toEqual({ alias: 'old-laptop' });
  });
});
