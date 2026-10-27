import type { Page } from '@playwright/test';
import { test, expect } from '../support/fixtures';
import { atPath, h1, open } from '../support/app';
import { mockCalls } from '../support/mock';

const history = (page: Page) => page.locator('ol.hist > li');
const machineFilter = (page: Page, name: string) => page.getByRole('group', { name: 'Filter machines by state' }).getByRole('button', { name: new RegExp(`^${name}\\s*\\d+$`) });

test.describe('Deployments', () => {
  test('shows the rollout in progress, where each machine stands, and the revision history', async ({ page }) => {
    await open(page, '/deployments');
    await expect(h1(page)).toHaveText('Deployments');
    await expect(page.getByText('Rolling out now')).toBeVisible();
    await expect(page.getByText('Add postgres-migrations skill; tighten code-review checklist').first()).toBeVisible();
    await expect(page.getByText('31 of 43')).toBeVisible();
    await expect(page.getByText('Source warning: duplicate_skill')).toBeVisible();

    const machines = page.getByRole('group', { name: 'Filter machines' });
    await expect(machines.getByRole('button')).toHaveText([/^All\s*13$/, /^Blocked\s*4$/, /^In progress\s*2$/, /^Waiting\s*4$/, /^Done\s*3$/]);
    await machines.getByRole('button', { name: /^Blocked/ }).click();
    await expect(page.locator('li.dep-row')).toHaveCount(4);
    await expect(page.locator('li.dep-row').first()).toContainText('Target');
    await machines.getByRole('button', { name: /^Done/ }).click();
    await expect(page.locator('li.dep-row .dep-node b')).toHaveText(['build-runner-01', 'homelab-nuc', 'laptop-ana']);

    await expect(history(page)).toHaveCount(5);
    await expect(history(page).first()).toContainText('Newest');
    await expect(history(page).first()).toContainText('a3f9c21');
    await expect(history(page).first()).toContainText('1 warning');
  });

  test('opens a revision to see what changed and how each machine is converging', async ({ page }) => {
    await open(page, '/deployments');
    await page.getByRole('link', { name: 'Open this revision' }).click();
    await expect(page).toHaveURL(url => /^\/deployments\/[0-9a-f-]{36}$/.test(url.pathname));
    await expect(h1(page)).toHaveText('Add postgres-migrations skill; tighten code-review checklist');
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('All deployments');

    // The diff against the previous revision.
    const changed = page.locator('.dep-hero-main');
    await expect(changed.getByRole('heading', { name: 'What changed' })).toBeVisible();
    await expect(changed).toContainText('postgres-migrations');
    await expect(changed).toContainText('code-review');
    await expect(changed).toContainText('Targets: 2 added · 5 changed · 0 removed, on 4 machines');
    await expect(changed.getByRole('link', { name: '9b14e07' })).toBeVisible();

    // Progress of every machine, filtered and sorted.
    await expect(page.getByRole('heading', { level: 2, name: /^Machines\s*13$/ })).toBeVisible();
    await expect(page.locator('li.rv-row')).toHaveCount(13);
    await expect(page.locator('li.rv-row').first()).toContainText('design-imac');
    await expect(page.locator('li.rv-row').first().getByRole('link', { name: /Claude file/ })).toContainText('lock_failed');
    await machineFilter(page, 'Failed').click();
    await expect(page.locator('li.rv-row .rv-node')).toHaveText(['design-imac', 'fedora-ws', 'kitchen-mini', 'studio-mini']);
    await machineFilter(page, 'All').click();
    await page.getByLabel('Sort').selectOption('name');
    const names = await page.locator('li.rv-row .rv-node').allInnerTexts();
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));

    // A failed Target links to the machine's Problems tab.
    await page.locator('li.rv-row', { hasText: 'studio-mini' }).getByRole('link', { name: /ai_client_reconcile_failed/ }).click();
    await expect(page).toHaveURL(atPath('/machines/studio-mini/problems'));
  });

  test('compares with the previous revision and walks back through the history', async ({ page }) => {
    await open(page, '/deployments');
    await page.getByRole('link', { name: 'Open this revision' }).click();
    await page.locator('.dep-prev').getByRole('link', { name: '9b14e07' }).click();
    await expect(h1(page)).toHaveText('Route studio and design nodes through CLIProxy for Claude Code');
    await expect(page.locator('.dep-meta')).toContainText('ana');
  });

  test('loads older revisions on request', async ({ page }) => {
    await open(page, '/deployments', { pagesize: 2 });
    await expect(history(page)).toHaveCount(2);
    await page.getByRole('button', { name: 'Load older revisions' }).click();
    await expect(history(page)).toHaveCount(4);
    await page.getByRole('button', { name: 'Load older revisions' }).click();
    await expect(history(page)).toHaveCount(5);
    await expect(page.getByRole('button', { name: 'Load older revisions' })).toHaveCount(0);
    const pages = (await mockCalls(page)).filter(call => call.path === 'desired-revisions');
    expect(pages.length).toBeGreaterThanOrEqual(3);
  });

  test('shows the attempts of a revision when asked, and sends an old short-SHA address to the list', async ({ page }) => {
    await open(page, '/deployments');
    await history(page).first().locator('summary').click();
    await history(page).first().getByRole('button', { name: 'Show attempts' }).click();
    await expect(history(page).first().getByText(/Attempts in this rollout/)).toBeVisible();
    await expect(history(page).first().getByRole('columnheader', { name: 'Error code' })).toBeVisible();
    await expect(history(page).first().getByText(/^Failed attempts/)).toBeVisible();

    await open(page, '/deployments/9b14e07');
    await expect(page).toHaveURL(atPath('/deployments', { revision: '9b14e07' }));
    await expect(history(page).filter({ hasText: '9b14e07' }).locator('details')).toHaveAttribute('open', '');
  });
});
