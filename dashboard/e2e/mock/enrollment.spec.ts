import type { Page } from '@playwright/test';
import { test, expect } from '../support/fixtures';
import { atPath, h1, open } from '../support/app';
import { mockWrites } from '../support/mock';

const wizard = (page: Page) => page.getByRole('dialog');
const linkRow = (page: Page, alias: string) => page.locator('li.link-row', { hasText: alias });
const linkFilter = (page: Page, name: string) => page.getByRole('group', { name: 'Filter links' }).getByRole('button', { name: new RegExp(`^${name}\\s*\\d+$`) });

/** Fills in step 1 of the wizard and creates the link. */
async function createLink(page: Page, alias: string, platform: 'macOS' | 'Linux' = 'macOS'): Promise<void> {
  await wizard(page).getByLabel('Machine alias').fill(alias);
  await wizard(page).getByRole('radio', { name: platform }).check();
  await wizard(page).getByRole('button', { name: 'Create link' }).click();
}

test.describe('Add machine wizard', () => {
  test('walks from the alias to the first check-in', async ({ page }) => {
    await page.clock.install();
    await open(page, '/machines', { platform: 'linux' });
    await page.getByRole('button', { name: 'Add machine' }).first().click();
    await expect(wizard(page)).toBeVisible();
    await expect(wizard(page)).toContainText('step 1 of 3');
    await expect(wizard(page).getByLabel('Machine alias')).toBeFocused();

    // Step 1 → 2: the link, shown once, in the Server's format.
    await createLink(page, 'office-mini', 'Linux');
    await expect(wizard(page)).toContainText('step 2 of 3');
    const link = wizard(page).locator('.wz-link .cmd pre');
    await expect(link).toHaveText(/^https:\/\/[^/\s]+\/enroll#fleet-v1=[A-Za-z0-9_-]+$/);
    await expect(wizard(page).locator('.wz-link')).toContainText('One-time enrollment link for office-mini');
    await expect(wizard(page).locator('.wz-link .cd')).toContainText(/Expires in \d+:\d\d/);
    await expect(wizard(page).getByRole('tab', { name: 'Linux' })).toHaveAttribute('aria-selected', 'true');
    await expect(wizard(page).getByRole('tabpanel')).toContainText('enroll --link');
    await expect(wizard(page).getByRole('tabpanel')).toContainText('Linux amd64');
    await wizard(page).getByRole('tab', { name: 'macOS' }).click();
    await expect(wizard(page).getByRole('tabpanel')).toContainText('macOS 13 or newer');

    // Step 2 → 3: waiting; the mock's Agent enrolls and checks in a few seconds later.
    await wizard(page).getByRole('button', { name: 'I have run these commands' }).click();
    await expect(wizard(page)).toContainText('step 3 of 3');
    await expect(wizard(page)).toContainText('Fleet is listening for office-mini');
    await page.clock.runFor(15_000);
    await expect(wizard(page).locator('.wz-wait')).toContainText('Checked in');
    await expect(wizard(page).locator('.wz-checks li.done')).toHaveCount(await wizard(page).locator('.wz-checks li').count());

    // The link is gone from the page once the wizard has moved on.
    await expect(page.locator('body')).not.toContainText('fleet-v1=');
    await wizard(page).getByRole('link', { name: 'View office-mini' }).click();
    await expect(page).toHaveURL(atPath('/machines/office-mini'));
    await expect(h1(page)).toHaveText('office-mini');
    await expect(wizard(page)).toBeHidden();

    const created = (await mockWrites(page)).filter(call => call.path === 'enrollment-links');
    expect(created).toHaveLength(1);
    expect(created[0].body).toEqual({ alias: 'office-mini', expiresInSeconds: 900 });
  });

  test('asks for an alias before it creates anything, and the link is bound to the alias it was made for', async ({ page }) => {
    await open(page, '/machines');
    await page.getByRole('button', { name: 'Add machine' }).first().click();
    await wizard(page).getByRole('button', { name: 'Create link' }).click();
    await expect(wizard(page).locator('#wz-alias-msg')).toHaveClass(/is-err/);
    await expect(wizard(page).locator('#wz-alias-msg')).toHaveText('Choose a nonblank alias of at most 200 characters.');
    await expect(wizard(page).getByLabel('Machine alias')).toHaveAttribute('aria-invalid', 'true');
    await expect(wizard(page)).toContainText('step 1 of 3');
    expect(await mockWrites(page)).toHaveLength(0);
  });

  test('revoking the link in step 2 closes the wizard and leaves the link revoked', async ({ page }) => {
    await open(page, '/enrollment');
    await page.getByRole('button', { name: 'Add machine' }).click();
    await createLink(page, 'revoke-me');
    await expect(wizard(page)).toContainText('step 2 of 3');
    await wizard(page).getByRole('button', { name: 'Revoke link' }).click();
    await expect(page.locator('#toasts')).toContainText('Enrollment link revoked');
    await expect(wizard(page)).toBeHidden();
    await expect(linkRow(page, 'revoke-me')).toContainText('Revoked');
    expect((await mockWrites(page)).map(call => call.path.replace(/[0-9a-f-]{36}/, '{id}'))).toEqual(['enrollment-links', 'enrollment-links/{id}/revoke']);
  });

  test('an unused link expires and the wizard offers a new one', async ({ page }) => {
    await page.clock.install();
    await open(page, '/machines', { expiry: 8, enroll: 0 });
    await page.getByRole('button', { name: 'Add machine' }).first().click();
    await createLink(page, 'too-slow');
    await wizard(page).getByRole('button', { name: 'I have run these commands' }).click();
    await expect(wizard(page)).toContainText('Fleet is listening for too-slow');
    await page.clock.runFor(12_000);
    await expect(wizard(page).locator('.wz-wait')).toContainText('The link expired before too-slow used it.');
    await wizard(page).getByRole('button', { name: 'Create a new link' }).click();
    await expect(wizard(page)).toContainText('step 1 of 3');
    await expect(wizard(page).getByLabel('Machine alias')).toHaveValue('too-slow');
  });
});

test.describe('Enrollment page', () => {
  test('lists the links by state and filters them', async ({ page }) => {
    await open(page, '/enrollment');
    await expect(h1(page)).toHaveText('Enrollment');
    await expect(page.getByRole('group', { name: 'Filter links' }).getByRole('button')).toHaveText([/^All\s*4$/, /^Active\s*1$/, /^Used\s*1$/, /^Expired\s*1$/, /^Revoked\s*1$/]);
    await expect(linkRow(page, 'lab-vm-08')).toContainText('Active');
    await expect(linkRow(page, 'lab-vm-08')).toContainText(/Expires in \d+ min/);
    await expect(linkRow(page, 'lab-vm-07')).toContainText('Used');
    await expect(linkRow(page, 'tablet-test')).toContainText('Expired');
    await expect(linkRow(page, 'guest-mbp')).toContainText('Revoked');
    await linkFilter(page, 'Expired').click();
    await expect(page.locator('li.link-row')).toHaveCount(1);
    await linkFilter(page, 'All').click();
    await expect(page.locator('li.link-row')).toHaveCount(4);
    await linkRow(page, 'lab-vm-07').getByRole('link', { name: 'Open machine' }).click();
    await expect(page).toHaveURL(url => /^\/machines\/[0-9a-f-]{36}$/.test(url.pathname)); // a used link points at the Node ID
    await expect(h1(page)).toHaveText('lab-vm-07');
  });

  test('revokes an active link from the list', async ({ page }) => {
    await open(page, '/enrollment');
    await linkRow(page, 'lab-vm-08').getByRole('button', { name: 'Revoke' }).click();
    await expect(linkRow(page, 'lab-vm-08')).toContainText('Revoked');
    await expect(linkRow(page, 'lab-vm-08').getByRole('button', { name: 'Revoke' })).toHaveCount(0);
    await expect(linkFilter(page, 'Active')).toHaveText(/0$/);
    await expect(linkFilter(page, 'Revoked')).toHaveText(/2$/);
  });

  test('creates a link from the form, shows it once and lists it as active', async ({ page }) => {
    await open(page, '/enrollment');
    await page.getByLabel('Machine alias').fill('form-made');
    await page.getByLabel('Link expires after').selectOption('1800');
    await page.getByRole('button', { name: 'Create link' }).click();
    await expect(wizard(page)).toContainText('step 2 of 3');
    await expect(wizard(page).locator('.wz-link .cmd pre')).toContainText('/enroll#fleet-v1=');
    await wizard(page).getByRole('button', { name: 'Close' }).first().click();
    await expect(linkRow(page, 'form-made')).toContainText('Active');
    await expect(page.locator('body')).not.toContainText('fleet-v1=');
    const body = (await mockWrites(page))[0].body;
    expect(body).toEqual({ alias: 'form-made', expiresInSeconds: 1800 });
  });
});
