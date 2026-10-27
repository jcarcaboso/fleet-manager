import type { Page } from '@playwright/test';
import { test, expect } from '../support/fixtures';
import { h1, open } from '../support/app';
import { mockWrites } from '../support/mock';

const toast = (page: Page) => page.locator('#toasts');

test.describe('Repository', () => {
  test('shows the source, the published revision, warnings and recent scans', async ({ page }) => {
    await open(page, '/repository');
    await expect(h1(page)).toHaveText('Repository');
    await expect(page.getByText('Published revision')).toBeVisible();
    await expect(page.getByText('a3f9c21').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Source warnings\s*1$/ })).toBeVisible();
    await expect(page.getByText('duplicate_skill')).toBeVisible();
    const scans = page.locator('section', { has: page.getByRole('heading', { name: 'Recent scans' }) });
    await expect(scans).toContainText('Published');
    await expect(scans).toContainText('Rejected');
    await expect(scans).toContainText('manifest_invalid');
    await expect(scans).toContainText('Fetch failed');
    await expect(scans).toContainText('git_fetch_failed');
  });

  test('syncing publishes a scan and reports it in a toast', async ({ page }) => {
    await open(page, '/repository');
    await page.getByRole('button', { name: 'Sync repository' }).click();
    await expect(toast(page)).toContainText('Repository sync started');
    await expect(toast(page)).toContainText(/Repository (synced|is up to date)/);
    await expect(page.getByRole('button', { name: 'Sync repository' })).toBeEnabled();
    const writes = await mockWrites(page);
    expect(writes.map(call => call.path)).toEqual(['source/rescan']);
  });

  test('loads older scans on request', async ({ page }) => {
    await open(page, '/repository', { pagesize: 2 });
    const scans = page.locator('section', { has: page.getByRole('heading', { name: 'Recent scans' }) }).locator('details, li');
    const before = await scans.count();
    await page.getByRole('button', { name: 'Load older scans' }).click();
    await expect.poll(() => scans.count()).toBeGreaterThan(before);
  });
});

test.describe('Models', () => {
  const sel = (page: Page) => page.locator('section', { has: page.getByRole('heading', { name: 'Model selection' }) });
  const model = (page: Page, id: string) => page.locator(`input[data-sel-model="${id}"]`);
  const family = (page: Page, label: string) => page.getByRole('switch', { name: `Sync ${label} models` });
  const bar = (page: Page) => page.locator('.sel-bar');

  test('shows both catalogs, and why one of them is failing', async ({ page }) => {
    await open(page, '/models');
    await expect(h1(page)).toHaveText('Models');
    await expect(page.getByText('Fleet key configured')).toBeVisible();
    await expect(page.getByText('Healthy')).toBeVisible();
    await expect(page.getByText('Refresh failing')).toBeVisible();
    await expect(page.getByText('upstream_http_401').first()).toBeVisible();
    await expect(page.locator('#nav, header').getByLabel('A catalog is failing')).toBeVisible();
  });

  test('refreshing the catalogs reports the result', async ({ page }) => {
    await open(page, '/models');
    await page.getByRole('button', { name: 'Refresh models' }).click();
    await expect(toast(page)).toContainText('Refreshing model catalogs');
    await expect(toast(page)).toContainText(/A catalog is still failing|Model catalogs refreshed/);
    await expect(page.locator('p.result')).toBeVisible();
    expect((await mockWrites(page)).map(call => call.path)).toEqual(['cliproxy/refresh']);
  });

  test('edits a selection, shows it as unsaved, saves it, and resets another edit', async ({ page }) => {
    await open(page, '/models');
    await expect(bar(page)).toContainText('All changes saved');
    await expect(bar(page).getByRole('button', { name: 'Save selection' })).toBeDisabled();
    await expect(bar(page).getByRole('button', { name: 'Reset' })).toBeDisabled();

    // Models that no machine pins can change: turn one off, one on, and another off.
    await expect(model(page, 'gemini-2.5-flash')).toBeChecked();
    await expect(model(page, 'gpt-6-chat-latest')).not.toBeChecked();
    await model(page, 'gemini-2.5-flash').uncheck();
    await model(page, 'gpt-6-chat-latest').check();
    await model(page, 'claude-sonnet-4-20250514').uncheck();
    await expect(bar(page)).not.toContainText('All changes saved');
    await expect(sel(page).locator('.dirty-dot')).toBeVisible();

    await bar(page).getByRole('button', { name: 'Save selection' }).click();
    await expect(toast(page)).toContainText('Selection saved');
    await expect(bar(page)).toContainText('All changes saved');
    await expect(sel(page).locator('.dirty-dot')).toHaveCount(0);
    const saves = (await mockWrites(page)).filter(call => call.path === 'cliproxy/selection');
    expect(saves).toHaveLength(1);
    // Only the differences from the family defaults are sent: the two exclusions; the model switched on simply follows its family.
    expect(saves[0].body).toMatchObject({ baseUrl: 'https://proxy.lab.internal/v1', policy: { modelOverrides: { 'claude-sonnet-4-20250514': false, 'gemini-2.5-flash': false } } });
    expect(Object.keys((saves[0].body as { policy: { modelOverrides: object } }).policy.modelOverrides).sort()).toEqual(['claude-sonnet-4-20250514', 'gemini-2.5-flash']);
    await expect(model(page, 'gpt-6-chat-latest')).toBeChecked();

    // A second edit is undone by Reset, which restores what was saved.
    await model(page, 'claude-opus-4-1-20250805').uncheck();
    await expect(bar(page)).not.toContainText('All changes saved');
    await bar(page).getByRole('button', { name: 'Reset' }).click();
    await expect(model(page, 'claude-opus-4-1-20250805')).toBeChecked();
    await expect(model(page, 'claude-sonnet-4-20250514')).not.toBeChecked();
    await expect(bar(page)).toContainText('All changes saved');
    expect((await mockWrites(page)).filter(call => call.path === 'cliproxy/selection')).toHaveLength(1);
  });

  test('a family switch selects or clears all of its models until reset', async ({ page }) => {
    await open(page, '/models');
    await expect(family(page, 'GPT 6')).toHaveAttribute('aria-checked', 'true');
    await family(page, 'GPT 6').click();
    await expect(family(page, 'GPT 6')).toHaveAttribute('aria-checked', 'false');
    await expect(model(page, 'gpt-6-codex')).not.toBeChecked();
    await expect(page.locator('fieldset.fam', { hasText: 'GPT 6 models' })).toContainText('0 of 2 selected');
    await expect(bar(page)).not.toContainText('All changes saved');
    await bar(page).getByRole('button', { name: 'Reset' }).click();
    await expect(family(page, 'GPT 6')).toHaveAttribute('aria-checked', 'true');
    await expect(model(page, 'gpt-6-codex')).toBeChecked();
  });

  test('refuses to save a selection that excludes a model pinned in fleet.yml', async ({ page }) => {
    await open(page, '/models');
    await model(page, 'claude-opus-4-1').uncheck();
    await bar(page).getByRole('button', { name: 'Save selection' }).click();
    await expect(toast(page)).toContainText('Selection was not saved');
    await expect(toast(page)).toContainText('A pinned default model cannot be excluded');
    await expect(bar(page)).not.toContainText('All changes saved'); // the edit is kept for the Operator to fix
    await bar(page).getByRole('button', { name: 'Reset' }).click();
    await expect(model(page, 'claude-opus-4-1')).toBeChecked();
  });

  test('each catalog keeps its own unsaved edits when switching between them', async ({ page }) => {
    await open(page, '/models');
    await model(page, 'gemini-2.5-pro').uncheck();
    await page.getByRole('group', { name: 'Catalog' }).getByRole('button', { name: 'proxy-backup.lab.internal' }).click();
    await expect(page.getByRole('group', { name: 'Catalog' }).getByRole('button', { name: /^proxy\.lab\.internal/ }).locator('.dirty-dot')).toBeVisible();
    await expect(bar(page)).toContainText('All changes saved');
    await page.getByRole('group', { name: 'Catalog' }).getByRole('button', { name: /^proxy\.lab\.internal/ }).click();
    await expect(model(page, 'gemini-2.5-pro')).not.toBeChecked();
  });
});
