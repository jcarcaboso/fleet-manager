import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../support/fixtures';
import { h1, open } from '../support/app';
import { mockWrites } from '../support/mock';

const scopeChip = (page: Page) => page.locator('#me .scope-chip');
const toast = (page: Page) => page.locator('#toasts');

/**
 * Controls the Operator's scope does not allow are locked: they are `aria-disabled`, say why, and a click sends nothing.
 * The read scope can only look, operate can retry/sync/refresh/acknowledge, and admin can also enroll, rename, revoke and remove.
 */
test.describe('scope gating', () => {
  test('read: every control that changes something is locked and a click sends no request', async ({ page }) => {
    /** Clicks a locked button: it says why in a toast and sends nothing. */
    async function clickLocked(target: string | Locator, scope = 'admin'): Promise<void> {
      const button = typeof target === 'string' ? page.getByRole('button', { name: target, exact: true }).first() : target;
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await expect(button).toHaveAttribute('data-need', scope);
      await button.click({ force: true }); // a locked button is aria-disabled, which Playwright does not click without force
      await expect(toast(page)).toContainText('Not available');
      await expect(toast(page)).toContainText(scope);
    }
    await open(page, '/machines', { scope: 'read' });
    await expect(scopeChip(page)).toHaveText('read');
    await clickLocked('Sync repository', 'operate');
    await clickLocked('Add machine');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await open(page, '/machines/design-imac', { scope: 'read' });
    await clickLocked('Refresh', 'operate');
    await expect(page.locator('#disk-status')).toHaveText('');

    await open(page, '/machines/design-imac/problems', { scope: 'read' });
    await clickLocked('Retry now', 'operate');

    await open(page, '/machines/design-imac/settings', { scope: 'read' });
    await expect(page.getByLabel('Alias', { exact: true })).toBeDisabled();
    await clickLocked('Save alias');
    await clickLocked('Remove…');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await open(page, '/machines/design-imac/security', { scope: 'read' });
    await clickLocked('Revoke…');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await open(page, '/models', { scope: 'read' });
    await clickLocked('Refresh models', 'operate');
    await clickLocked('Save selection', 'operate');

    await open(page, '/enrollment', { scope: 'read' });
    await expect(page.locator('#en-alias')).toBeDisabled();
    await clickLocked('Create link');
    await clickLocked('Add machine');
    await clickLocked(page.locator('li.link-row', { hasText: 'lab-vm-08' }).getByRole('button', { name: 'Revoke' }));
    await expect(page.locator('li.link-row', { hasText: 'lab-vm-08' })).toContainText('Active');

    await open(page, '/problems', { scope: 'read' });
    await clickLocked('Acknowledge', 'operate');
    await expect(page.getByRole('button', { name: 'Reopen' })).toHaveCount(0);

    expect(await mockWrites(page)).toEqual([]);
  });

  test('read: the locks explain themselves', async ({ page }) => {
    await open(page, '/enrollment', { scope: 'read' });
    await expect(page.locator('main')).toContainText(/needs? (the )?admin scope|admin/i);
    await open(page, '/problems', { scope: 'read' });
    await expect(page.locator('main')).toContainText(/operate/i);
  });

  test('operate: can act on problems, models and disks, but not enroll, rename, revoke or remove', async ({ page }) => {
    await open(page, '/problems', { scope: 'operate' });
    await expect(scopeChip(page)).toHaveText('operate');
    const first = page.locator('details.prow[open]').first();
    await expect(first.getByRole('button', { name: 'Acknowledge' })).toBeEnabled();
    await expect(first.getByRole('button', { name: 'Acknowledge' })).not.toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByRole('button', { name: 'Sync repository' })).not.toHaveAttribute('aria-disabled', 'true');
    await first.getByRole('button', { name: 'Acknowledge' }).click();
    await expect(page.getByRole('group', { name: 'Filter problems by state' }).getByRole('button', { name: /^Acknowledged\s*1$/ })).toBeVisible();

    await open(page, '/machines', { scope: 'operate' });
    await expect(page.getByRole('button', { name: 'Sync repository' })).not.toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByRole('button', { name: 'Add machine' }).first()).toHaveAttribute('aria-disabled', 'true');

    await open(page, '/machines/design-imac', { scope: 'operate' });
    await expect(page.getByRole('button', { name: 'Refresh' })).not.toHaveAttribute('aria-disabled', 'true');

    await open(page, '/machines/design-imac/settings', { scope: 'operate' });
    await expect(page.getByLabel('Alias', { exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Remove…' }).click({ force: true });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(toast(page)).toContainText('Not available');

    await open(page, '/machines/design-imac/security', { scope: 'operate' });
    await page.getByRole('button', { name: 'Revoke…' }).click({ force: true });
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await open(page, '/enrollment', { scope: 'operate' });
    await expect(page.getByRole('button', { name: 'Create link' })).toHaveAttribute('aria-disabled', 'true');
    await page.locator('li.link-row', { hasText: 'lab-vm-08' }).getByRole('button', { name: 'Revoke' }).click({ force: true });
    await expect(page.locator('li.link-row', { hasText: 'lab-vm-08' })).toContainText('Active');
    expect(await mockWrites(page)).toEqual([]);
  });

  test('admin: nothing is locked', async ({ page }) => {
    await open(page, '/machines/design-imac/settings');
    await expect(scopeChip(page)).toHaveText('admin');
    await expect(page.getByLabel('Alias', { exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Remove…' })).not.toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('[aria-disabled=true]')).toHaveCount(0);
    await expect(h1(page)).toHaveText('design-imac');
  });

  test('a Server that refuses a change with 403 is explained and the page stays usable', async ({ page }) => {
    await open(page, '/problems', { forbid: true });
    await page.locator('details.prow[open]').first().getByRole('button', { name: 'Acknowledge' }).click();
    await expect(page.locator('#toasts')).toContainText(/not (changed|allowed)|scope|permission/i);
    await expect(page.locator('details.prow')).not.toHaveCount(0);
  });
});
