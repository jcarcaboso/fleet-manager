import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../support/fixtures';
import { h1, open, primaryNav } from '../support/app';
import { mockWrites } from '../support/mock';

const stateTabs = (page: Page) => page.getByRole('group', { name: 'Filter problems by state' });
const stateTab = (page: Page, name: string) => stateTabs(page).getByRole('button', { name: new RegExp(`^${name}\\s*\\d+$`) });
const areaTabs = (page: Page) => page.getByRole('group', { name: 'Filter problems', exact: true });
const badge = (page: Page) => primaryNav(page).getByLabel(/open errors$/);
const row = (page: Page, key: string) => page.locator(`details.prow[data-open-key^="${key}"]`);
const count = async (tab: Locator) => Number((await tab.innerText()).replace(/\D+/g, ''));

/** Opens the row (rows start collapsed except the first) and returns it. */
async function expanded(page: Page, key: string): Promise<Locator> {
  const r = row(page, key);
  await expect(r).toHaveCount(1);
  if ((await r.getAttribute('open')) === null) await r.locator('summary').click();
  await expect(r).toHaveAttribute('open', '');
  return r;
}

test.describe('Problems', () => {
  test('groups problems by severity, with the counts the header and the navigation show', async ({ page }) => {
    await open(page, '/problems');
    await expect(h1(page)).toHaveText('Problems');
    await expect(page.locator('.sumrow .sumtile')).toHaveText([/6\s*Errors/, /3\s*Offline machines/, /7\s*Warnings/, /0\s*Notices/]);
    await expect(page.locator('section.pgroup h2')).toHaveText([/^Errors\s*6$/, /^Offline machines\s*3$/, /^Warnings\s*7$/]);
    await expect(stateTab(page, 'Open')).toHaveAttribute('aria-pressed', 'true');
    await expect(badge(page)).toHaveText('6');
    await expect(row(page, 'disk_space_critical')).toContainText('homelab-nuc: disk is 96.4% full');
    await expect(row(page, 'disk_space_critical')).toContainText('Error');
  });

  test('narrows the list to machines or models', async ({ page }) => {
    await open(page, '/problems');
    const everything = await count(areaTabs(page).getByRole('button', { name: /^Everything/ }));
    await areaTabs(page).getByRole('button', { name: /^Models/ }).click();
    await expect(page.locator('details.prow')).toHaveCount(1);
    await expect(page.locator('details.prow')).toContainText('CLIProxy model refresh failed');
    await areaTabs(page).getByRole('button', { name: /^Machines/ }).click();
    await expect(page.locator('details.prow')).toHaveCount(everything - 1);
    await areaTabs(page).getByRole('button', { name: /^Everything/ }).click();
    await expect(page.locator('details.prow')).toHaveCount(everything);
  });

  test('acknowledging moves a problem out of Open, lowers the badge and survives a switch of tab', async ({ page }) => {
    await open(page, '/problems');
    const open0 = await count(stateTab(page, 'Open'));
    const r = await expanded(page, 'disk_space_critical');
    await r.getByRole('button', { name: 'Acknowledge' }).click();

    await expect(row(page, 'disk_space_critical')).toHaveCount(0);
    expect(await count(stateTab(page, 'Open'))).toBe(open0 - 1);
    await expect(stateTab(page, 'Acknowledged')).toHaveText(/1$/);
    await expect(badge(page)).toHaveText('5');

    await stateTab(page, 'Acknowledged').click();
    await expect(stateTab(page, 'Acknowledged')).toHaveAttribute('aria-pressed', 'true');
    await expect(row(page, 'disk_space_critical')).toHaveClass(/is-quiet/);
    await expect(row(page, 'disk_space_critical').locator('summary .tag--state')).toHaveText('Acknowledged');

    const writes = await mockWrites(page);
    expect(writes.map(call => call.path)).toEqual(['issues/state']);
    expect(writes[0].body).toMatchObject({ action: 'acknowledge', id: expect.stringMatching(/^disk_space_critical:/) });
  });

  test('snoozing for four hours files the problem under Snoozed', async ({ page }) => {
    await open(page, '/problems');
    const r = await expanded(page, 'agent_outdated:dc4a357b');
    await r.getByRole('button', { name: 'Snooze for 4 hours' }).click();
    await expect(row(page, 'agent_outdated:dc4a357b')).toHaveCount(0);
    await expect(stateTab(page, 'Snoozed')).toHaveText(/1$/);

    await stateTab(page, 'Snoozed').click();
    await expect(row(page, 'agent_outdated:dc4a357b').locator('summary .tag--state')).toHaveText('Snoozed');
    const body = (await mockWrites(page))[0].body;
    expect(body).toMatchObject({ action: 'snooze', hours: 4 });
  });

  test('reopening brings an acknowledged problem back to Open', async ({ page }) => {
    await open(page, '/problems', { states: true });
    await expect(stateTab(page, 'Acknowledged')).toHaveText(/1$/);
    await expect(stateTab(page, 'Snoozed')).toHaveText(/1$/);
    const open0 = await count(stateTab(page, 'Open'));

    await stateTab(page, 'Acknowledged').click();
    const rows = page.locator('details.prow');
    await expect(rows).toHaveCount(1);
    const key = (await rows.first().getAttribute('data-open-key')) ?? '';
    const r = await expanded(page, key);
    await r.getByRole('button', { name: 'Reopen' }).click();

    await expect(page.locator('details.prow')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Nothing acknowledged' })).toBeVisible();
    await expect(stateTab(page, 'Acknowledged')).toHaveText(/0$/);
    expect(await count(stateTab(page, 'Open'))).toBe(open0 + 1);
    expect((await mockWrites(page))[0].body).toMatchObject({ action: 'reopen' });

    await stateTab(page, 'Snoozed').click();
    await expect(page.locator('details.prow')).toHaveCount(1);
    await expect(page.locator('details.prow summary .tag--state')).toHaveText('Snoozed');
  });

  test('shows the explanation, the fix steps and the commands of a problem, and retries it', async ({ page }) => {
    await open(page, '/problems');
    const r = await expanded(page, 'assignment_failed:609585ff-b4d9-4932-a063-f39ed6a970e3:agent-file/claude');
    await expect(r.getByRole('heading', { name: 'How to fix' })).toBeVisible();
    await expect(r.getByRole('heading', { name: 'Run in a terminal' })).toBeVisible();
    await expect(r).toContainText('fleet retry design-imac agent-file/claude');
    await expect(r.getByRole('link', { name: 'Open design-imac' })).toHaveAttribute('href', '/machines/design-imac/problems');

    await r.getByRole('button', { name: 'Retry now' }).click();
    await expect(page.locator('#toasts')).toContainText('Retry requested');
    const writes = await mockWrites(page);
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toEqual({ target: 'agent-file/claude' });
  });
});
