import type { Page } from '@playwright/test';
import { test, expect } from '../support/fixtures';
import { focusedDescription, open } from '../support/app';

/** Focuses the button by name and presses it with the keyboard, as a keyboard user does. */
async function press(page: Page, name: string, exact = true): Promise<void> {
  const button = page.getByRole('button', { name, exact });
  await button.focus();
  await expect(button).toBeFocused();
  await page.keyboard.press('Enter');
}

/** Focus is never left on <body> once the action is done: it is on the button again, or on the page's heading. */
async function expectFocusKept(page: Page): Promise<void> {
  await expect.poll(() => focusedDescription(page), { message: 'keyboard focus fell to <body>' }).not.toBe('<body>');
}

test.describe('keyboard focus after an action', () => {
  const refreshes: Array<[page: string, path: string, button: string]> = [
    ['Deployments', '/deployments', 'Refresh'],
    ['Audit', '/audit', 'Refresh'],
    ['Problems', '/problems', 'Check again'],
    ['Problems', '/problems', 'Sync repository'],
    ['Repository', '/repository', 'Sync repository'],
    ['Models', '/models', 'Refresh models'],
    ['Machines', '/machines', 'Sync repository'],
  ];
  for (const [name, path, button] of refreshes) {
    test(`${name}: "${button}" keeps the keyboard focus on the page`, async ({ page }) => {
      await open(page, path, { slow: 250 }); // slow answers: the button is disabled for a while, as it is on a real network
      await press(page, button);
      await expectFocusKept(page);
      await expect(page.getByRole('button', { name: button, exact: true })).toBeEnabled(); // back from "Syncing…" / "Refreshing…"
      await expectFocusKept(page);
      // The focus is somewhere the Operator can continue from: pressing Tab moves to a control of the page.
      await page.keyboard.press('Tab');
      expect(await focusedDescription(page)).not.toBe('<body>');
    });
  }

  test('Machine: the disk Refresh button gets the focus back when the Agent has answered', async ({ page }) => {
    await page.clock.install();
    await open(page, '/machines/design-imac', { diskdelay: 1000 });
    await press(page, 'Refresh');
    await expect(page.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
    await page.clock.runFor(6_000);
    await expect(page.locator('#disk-status')).toHaveText(/^Disk usage updated/);
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeFocused();
  });

  test('a page change moves the focus to the new page heading', async ({ page }) => {
    await open(page, '/machines');
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Audit' }).press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: 'Audit' })).toBeFocused();
  });

  test('the skip link moves the focus to the heading of the page', async ({ page }) => {
    await open(page, '/problems');
    await page.getByRole('link', { name: 'Skip to content' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  });
});

test.describe('dialogs', () => {
  test('Escape closes a confirmation dialog and returns the focus to the button that opened it', async ({ page }) => {
    await open(page, '/machines/design-imac/settings');
    const opener = page.getByRole('button', { name: 'Remove…' });
    await opener.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Type design-imac to confirm')).toBeFocused();

    // Tab and Shift+Tab stay inside the dialog.
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate(el => el.contains(document.activeElement)), `Tab ${i + 1} left the dialog`).toBe(true);
    }
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press('Shift+Tab');
      expect(await dialog.evaluate(el => el.contains(document.activeElement)), `Shift+Tab ${i + 1} left the dialog`).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test('Escape closes the Add machine wizard, drops its one-time link and returns the focus', async ({ page }) => {
    await open(page, '/machines');
    const opener = page.getByRole('button', { name: 'Add machine' }).first();
    await opener.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Machine alias')).toBeFocused();
    await dialog.getByLabel('Machine alias').fill('esc-test');
    await page.keyboard.press('Enter');
    await expect(dialog).toContainText('step 2 of 3');
    await expect(dialog.locator('.wz-link .cmd pre')).toContainText('fleet-v1=');

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.locator('body')).not.toContainText('fleet-v1=');
    await expect(opener).toBeFocused();
  });

  test('the close button, the backdrop and Cancel all close a dialog too', async ({ page }) => {
    await open(page, '/machines/design-imac/security');
    const opener = page.getByRole('button', { name: 'Revoke…' });
    for (const close of [
      () => page.getByRole('dialog').getByRole('button', { name: 'Close' }).click(),
      () => page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click(),
      () => page.locator('.modal-back').click({ position: { x: 5, y: 5 } }),
    ]) {
      await opener.click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await close();
      await expect(page.getByRole('dialog')).toBeHidden();
      await expect(opener).toBeFocused();
    }
  });
});
