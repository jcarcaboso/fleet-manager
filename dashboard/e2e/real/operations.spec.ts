import { test, expect, signIn } from '../support/real';

test.describe('operating a real Server', () => {
  test('a problem can be acknowledged and reopened', async ({ page, stack, allow }) => {
    await signIn(page, stack, allow);
    await page.goto('/problems');
    // A fresh stack has no Git source, which the Server reports as a problem.
    const row = page.locator('details.prow[data-open-key^="source_not_configured"]');
    await expect(row).toHaveCount(1);
    const states = page.getByRole('group', { name: 'Filter problems by state' });
    const tab = (name: string) => states.getByRole('button', { name: new RegExp(`^${name}\\s*\\d+$`) });
    if ((await row.getAttribute('open')) === null) await row.locator('summary').click();

    await row.getByRole('button', { name: 'Acknowledge' }).click();
    await expect(row).toHaveCount(0);
    await tab('Acknowledged').click();
    await expect(row).toHaveCount(1);
    await expect(row.locator('summary .tag--state')).toHaveText('Acknowledged');

    // It stays acknowledged for the next page load: the Server recorded it.
    await page.reload();
    await tab('Acknowledged').click();
    await expect(row).toHaveCount(1);

    if ((await row.getAttribute('open')) === null) await row.locator('summary').click();
    await row.getByRole('button', { name: 'Reopen' }).click();
    await expect(row).toHaveCount(0);
    await tab('Open').click();
    await expect(row).toHaveCount(1);
  });

  test('Add machine creates a one-time link for the Server, and the link can be revoked', async ({ page, stack, allow }) => {
    await signIn(page, stack, allow);
    await page.goto('/machines');
    await page.getByRole('button', { name: 'Add machine' }).first().click();
    const wizard = page.getByRole('dialog');
    const alias = `e2e-link-${Date.now().toString(36)}`;
    await wizard.getByLabel('Machine alias').fill(alias);
    await wizard.getByRole('button', { name: 'Create link' }).click();
    await expect(wizard).toContainText('step 2 of 3');

    // The Agent parses SERVER_ORIGIN/enroll#fleet-v1=…: the link points at the Server, not at the dashboard.
    const link = (await wizard.locator('.wz-link .cmd pre').innerText()).trim();
    expect(link.startsWith(`${stack.server}/enroll#fleet-v1=`), 'the link starts with the Server\'s /enroll address').toBe(true);
    expect(link.slice(`${stack.server}/enroll#fleet-v1=`.length)).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(link.startsWith(stack.dashboard)).toBe(false);
    const payload = JSON.parse(Buffer.from(link.split('#fleet-v1=')[1], 'base64url').toString('utf8')) as { serverUrl?: string; alias?: string; caPem?: string };
    expect(payload.alias).toBe(alias);
    expect(payload.serverUrl).toBe(stack.server);
    expect(payload.caPem).toContain('BEGIN CERTIFICATE');

    await wizard.getByRole('button', { name: 'Revoke link' }).click();
    await expect(wizard).toBeHidden();
    await page.goto('/enrollment');
    const row = page.locator('li.link-row', { hasText: alias });
    await expect(row).toContainText('Revoked');
    await expect(page.locator('body')).not.toContainText('fleet-v1=');
  });

  test('every page of the dashboard loads from the real Server without an error', async ({ page, stack, allow }) => {
    await signIn(page, stack, allow);
    for (const [path, heading] of [['/machines', /machine/], ['/problems', /^Problems$/], ['/deployments', /^Deployments$/], ['/repository', /^Repository$/], ['/models', /^Models$/], ['/enrollment', /^Enrollment$/], ['/audit', /^Audit$/]] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
      await expect(page.locator('#view .skel')).toHaveCount(0);
      await expect(page.locator('#view .empty--error')).toHaveCount(0);
    }
  });

  test('the audit trail shows what the journeys did', async ({ page, stack, allow }) => {
    await signIn(page, stack, allow);
    await page.goto('/audit');
    await expect(page.locator('#audit-body tr').first()).toBeVisible();
    await expect(page.locator('#audit-body')).toContainText(/Machine enrolled|Created an enrollment link/);
  });
});

test.describe('scopes on a real Server', () => {
  test('a read account can look but every control that changes something is locked', async ({ page, stack, allow }) => {
    test.skip(!stack.read, 'needs FLEET_E2E_READ_NAME and FLEET_E2E_READ_PASSWORD');
    const writes: string[] = [];
    page.on('request', request => { if (request.method() !== 'GET' && !request.url().endsWith('/dashboard/api/login')) writes.push(`${request.method()} ${request.url()}`); });
    await signIn(page, stack, allow, stack.read);
    await expect(page.locator('#me .scope-chip')).toHaveText('read');
    await page.goto('/machines');
    const add = page.getByRole('button', { name: 'Add machine' }).first();
    await expect(add).toHaveAttribute('aria-disabled', 'true');
    await add.click({ force: true });
    await expect(page.locator('#toasts')).toContainText('Not available');
    expect(writes).toEqual([]);
  });

  test('an operate account can act on problems but not enroll', async ({ page, stack, allow }) => {
    test.skip(!stack.operate, 'needs FLEET_E2E_OPERATE_NAME and FLEET_E2E_OPERATE_PASSWORD');
    await signIn(page, stack, allow, stack.operate);
    await expect(page.locator('#me .scope-chip')).toHaveText('operate');
    await page.goto('/machines');
    await expect(page.getByRole('button', { name: 'Sync repository' })).not.toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByRole('button', { name: 'Add machine' }).first()).toHaveAttribute('aria-disabled', 'true');
  });
});
