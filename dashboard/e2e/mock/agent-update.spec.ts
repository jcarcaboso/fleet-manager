import { test, expect } from '../support/fixtures';
import { card, open } from '../support/app';
import { mockWrites } from '../support/mock';

const toast = (page: import('@playwright/test').Page) => page.locator('#toasts');
const dialog = (page: import('@playwright/test').Page) => page.getByRole('dialog');
const state = (page: import('@playwright/test').Page) => page.locator('#agent-update');

test.describe('Agent self-update on the machine page', () => {
  test('updates the Agent: pending while the Server fetches the release, then follows it to the new version', async ({ page }) => {
    await page.clock.install();
    await open(page, '/machines/fedora-ws', { releasedelay: 2000, updatedelay: 1000 });
    const upgrade = page.locator('#agent-upgrade');
    await expect(upgrade).toContainText('Update available: Agent 0.9.0-rc.2 → 0.9.0');
    await expect(upgrade).toContainText('This Agent can update itself.');
    await upgrade.getByRole('button', { name: 'Update Agent' }).click();
    await expect(upgrade.getByRole('button', { name: 'Requesting…' })).toBeDisabled();
    await expect(upgrade).toContainText('The first request of a release can take a few minutes.');

    await page.clock.runFor(2_000); // the mock Server mirrors the release
    await expect(state(page)).toHaveAttribute('data-state', 'requested');
    await expect(state(page)).toContainText('Waiting for the Agent’s next check-in.');
    await expect(toast(page)).toContainText('Update requested for fedora-ws');
    await expect(page.locator('.hchecks')).toContainText('Agent is updating');

    await page.clock.runFor(5_000); // the page reads the machine every 5 s; the Agent moves on every second
    await expect(state(page)).toHaveAttribute('data-state', 'succeeded');
    await expect(state(page)).toContainText('The Agent runs the new version.');
    await expect(upgrade).toHaveCount(0);
    await expect(page.locator('.hchecks')).toContainText('Agent is up to date');

    const writes = await mockWrites(page);
    expect(writes.map(call => call.path.replace(/^nodes\/[^/]+\//, 'nodes/{id}/'))).toEqual(['nodes/{id}/agent-update']);
    expect(writes[0]).toMatchObject({ status: 202 });
  });

  test('cancels a request that an offline machine has not picked up', async ({ page }) => {
    await open(page, '/machines/build-runner-03', { releasedelay: 0 });
    await page.locator('#agent-upgrade').getByRole('button', { name: 'Update Agent' }).click();
    await expect(state(page)).toHaveAttribute('data-state', 'requested');
    await expect(state(page)).toContainText('build-runner-03 is not checking in. Its Agent starts the update when it is back.');

    await state(page).getByRole('button', { name: 'Cancel update' }).click();
    await expect(state(page)).toHaveAttribute('data-state', 'cancelled');
    await expect(state(page)).toContainText('Cancelled before the Agent started it.');
    await expect(toast(page)).toContainText('Update cancelled for build-runner-03');
    await expect(page.locator('#agent-upgrade').getByRole('button', { name: 'Update Agent' })).toBeEnabled();

    const writes = await mockWrites(page);
    expect(writes.map(call => [call.path.replace(/^nodes\/[^/]+\//, 'nodes/{id}/'), call.status])).toEqual([['nodes/{id}/agent-update', 202], ['nodes/{id}/agent-update/cancel', 200]]);
  });

  test('shows a failed update with its error code and explanation, on the machine, its Problems tab and its card', async ({ page }) => {
    await open(page, '/machines/build-runner-03');
    await expect(state(page)).toHaveAttribute('data-state', 'failed');
    await expect(state(page).locator('#agent-update-h')).toHaveText('Update failed');
    await expect(state(page)).toContainText('0.9.0-rc.1 → 0.9.0');
    await expect(state(page).locator('code').first()).toHaveText('agent_update_smoke_test');
    await expect(state(page)).toContainText('The new binary did not start on this machine.');
    await expect(page.locator('.hchecks')).toContainText('Agent update failed');

    await page.getByRole('navigation', { name: /sections$/ }).getByRole('link', { name: /^Problems/ }).click();
    const problem = page.locator('article.prob').filter({ hasText: 'build-runner-03: Agent update failed' });
    await expect(problem).toBeVisible();
    await expect(problem.getByText('fleet nodes update build-runner-03')).toBeVisible();
    await expect(problem.getByRole('button', { name: 'Update Agent' })).toBeEnabled();

    await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'All machines' }).click();
    await expect(card(page, 'build-runner-03').locator('.chip--update-failed')).toHaveText('Update to 0.9.0 failed');
  });

  test('a live failure: the smoke test of the new binary fails and the page says so', async ({ page }) => {
    await page.clock.install();
    await open(page, '/machines/fedora-ws', { releasedelay: 0, updatedelay: 1000, updatefail: 'fedora-ws' });
    await page.locator('#agent-upgrade').getByRole('button', { name: 'Update Agent' }).click();
    await expect(state(page)).toHaveAttribute('data-state', 'requested');
    await page.clock.runFor(5_000);
    await expect(state(page)).toHaveAttribute('data-state', 'failed');
    await expect(state(page)).toContainText('The Agent kept its previous version.');
    await expect(state(page)).toContainText('agent_update_smoke_test');
    await expect(page.locator('#agent-upgrade').getByRole('button', { name: 'Update Agent' })).toBeEnabled();
  });

  test('a release that is not published: the Server says why and nothing is requested', async ({ page }) => {
    await open(page, '/machines/fedora-ws', { releasedelay: 0, release: 'unavailable' });
    await page.locator('#agent-upgrade').getByRole('button', { name: 'Update Agent' }).click();
    await expect(page.locator('#agent-update-msg')).toContainText('Agent release 0.9.0 is not published yet');
    await expect(toast(page)).toContainText('Agent update was not requested');
    await expect(state(page)).toHaveCount(0);
  });

  test('an Agent that cannot update itself keeps the manual steps; operate cannot update', async ({ page }) => {
    await open(page, '/machines/laptop-ana');
    await expect(page.locator('#agent-upgrade')).toContainText('This Agent cannot update itself.');
    await expect(page.locator('#agent-upgrade').getByRole('button', { name: 'Update Agent' })).toHaveCount(0);

    await open(page, '/machines/fedora-ws', { scope: 'operate' });
    const locked = page.locator('#agent-upgrade').getByRole('button', { name: 'Update Agent' });
    await expect(locked).toHaveAttribute('aria-disabled', 'true');
    await locked.click({ force: true }); // a locked button is aria-disabled, which Playwright does not click without force
    await expect(toast(page)).toContainText('Not available');
    expect(await mockWrites(page)).toHaveLength(0);
  });
});

test.describe('updating outdated Agents from the Machines page', () => {
  test('asks first, sends allOutdated, shows a result per machine and the cards follow', async ({ page }) => {
    await open(page, '/machines', { releasedelay: 0 });
    const bar = page.locator('#agent-updates');
    await expect(bar).toContainText('4 Agents older than the Server. 2 can update themselves and 2 need a manual upgrade first.');
    await bar.getByRole('button', { name: 'Update outdated Agents' }).click();

    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByRole('heading', { name: 'Update outdated Agents' })).toBeVisible();
    await expect(dialog(page).getByRole('checkbox')).toHaveCount(2);
    await expect(dialog(page).getByRole('checkbox', { name: /fedora-ws/ })).toBeChecked();
    await expect(dialog(page).locator('li[data-node="laptop-ana"]')).toContainText('Cannot update itself yet.');
    expect(await mockWrites(page)).toHaveLength(0);

    await dialog(page).getByRole('button', { name: 'Update 2 Agents' }).click();
    await expect(dialog(page)).toContainText('Requested for 2 of 4 machines. They install 0.9.0 after their next check-in.');
    await expect(dialog(page).locator('li[data-requested="true"]')).toHaveCount(2);
    await expect(dialog(page).locator('li[data-node="mba-travel"]')).toContainText('agent_update_unsupported');
    const writes = await mockWrites(page);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ path: 'agent-updates', status: 200, body: { allOutdated: true } });

    await dialog(page).getByRole('button', { name: 'Done' }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(card(page, 'fedora-ws').locator('.chip--updating')).toHaveText('Updating to 0.9.0');
    await expect(card(page, 'build-runner-03').locator('.chip--updating')).toHaveText('Updating to 0.9.0');
    await expect(bar.getByRole('button', { name: 'Update outdated Agents' })).toBeDisabled();
  });

  test('unticking a machine sends the Node IDs that are left', async ({ page }) => {
    await open(page, '/machines', { releasedelay: 0 });
    await page.locator('#agent-updates').getByRole('button', { name: 'Update outdated Agents' }).click();
    await dialog(page).getByRole('checkbox', { name: /build-runner-03/ }).uncheck();
    await dialog(page).getByRole('button', { name: 'Update 1 Agent' }).click();
    await expect(dialog(page).locator('li[data-requested="true"]')).toHaveCount(1);
    const [write] = await mockWrites(page);
    expect(write!.body).toEqual({ nodes: [expect.stringMatching(/^[0-9a-f-]{36}$/)] });
    await expect(dialog(page)).toContainText('Requested for 1 of 1 machine.');
  });

  test('read scope: the action is locked and sends nothing', async ({ page }) => {
    await open(page, '/machines', { scope: 'read' });
    const locked = page.locator('#agent-updates').getByRole('button', { name: 'Update outdated Agents' });
    await expect(locked).toHaveAttribute('aria-disabled', 'true');
    await locked.click({ force: true }); // a locked button is aria-disabled, which Playwright does not click without force
    await expect(dialog(page)).toHaveCount(0);
    expect(await mockWrites(page)).toHaveLength(0);
  });
});
