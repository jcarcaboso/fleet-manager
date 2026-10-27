import type { Page } from '@playwright/test';
import { test, expect } from '../support/fixtures';
import { h1, open } from '../support/app';

const rows = (page: Page) => page.locator('#audit-body tr');

test.describe('Audit', () => {
  test('lists the newest events first, with who did what to which machine', async ({ page }) => {
    await open(page, '/audit');
    await expect(h1(page)).toHaveText('Audit');
    await expect(page.locator('#audit-count')).toHaveText('14 events');
    await expect(rows(page)).toHaveCount(14);
    await expect(rows(page).first()).toContainText('Created an enrollment link');
    await expect(rows(page).first()).toContainText('joan');
    await expect(rows(page).first()).toContainText('Operator');
    await expect(rows(page).filter({ hasText: 'Machine enrolled' })).toContainText('lab-vm-07');
    await expect(rows(page).filter({ hasText: 'Removed a machine' })).toContainText('Removed machine');
    await rows(page).filter({ hasText: 'Renamed a machine' }).getByRole('link', { name: 'studio-mini' }).click();
    await expect(page).toHaveURL(url => /^\/machines\/[0-9a-f-]{36}$/.test(url.pathname)); // linked by Node ID, so it survives a rename
    await expect(h1(page)).toHaveText('studio-mini');
  });

  test('filters by actor, by action and by search text, and combines them', async ({ page }) => {
    await open(page, '/audit');
    await page.getByLabel('Actor').selectOption('ana');
    await expect(page.locator('#audit-count')).toHaveText('4 events');
    await expect(rows(page).locator('.who b')).toHaveText(['ana', 'ana', 'ana', 'ana']);

    await page.getByLabel('Action').selectOption({ label: 'Requested a repository sync' });
    await expect(page.locator('#audit-count')).toHaveText('1 event');
    await expect(rows(page)).toHaveCount(1);

    await page.getByLabel('Actor').selectOption('all');
    await page.getByLabel('Action').selectOption('all');
    await page.getByRole('searchbox', { name: 'Search audit log' }).fill('studio-mini');
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Renamed a machine');

    await page.getByRole('searchbox', { name: 'Search audit log' }).fill('nothing like this');
    await expect(page.getByText('No audit events match these filters.')).toBeVisible();
    await expect(page.locator('#audit-count')).toHaveText('0 events');
  });

  test('loads older events on request and says that filters only cover what is loaded', async ({ page }) => {
    await open(page, '/audit', { pagesize: 5 });
    await expect(rows(page)).toHaveCount(5);
    await expect(page.locator('#audit-more-note')).toContainText('apply to the 5 newest events loaded so far');
    await page.getByRole('button', { name: 'Load older events' }).click();
    await expect(rows(page)).toHaveCount(10);
    await page.getByRole('button', { name: 'Load older events' }).click();
    await expect(rows(page)).toHaveCount(14);
    await expect(page.getByRole('button', { name: 'Load older events' })).toHaveCount(0);
  });

  test('has an empty state when nothing was recorded', async ({ page }) => {
    await open(page, '/audit', { empty: true });
    await expect(page.getByRole('heading', { name: 'No audit events yet' })).toBeVisible();
  });
});
