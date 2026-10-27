import { test, expect, runAgentOnce, signIn } from '../support/real';

test.describe('machines the real Agents reported', () => {
  test('the gallery shows each enrolled machine with its OS, Agent version and disk', async ({ page, stack, allow }) => {
    test.skip(!stack.agentAlias || !stack.idleAlias, 'needs FLEET_E2E_AGENT_ALIAS and FLEET_E2E_IDLE_ALIAS (a machine that reported and one that never did)');
    await signIn(page, stack, allow);
    await page.goto('/machines');
    const card = (alias: string) => page.locator('article.card').filter({ has: page.getByRole('heading', { level: 3, name: alias, exact: true }) });

    const reported = card(stack.agentAlias!);
    await expect(reported).toBeVisible();
    await expect(reported.locator('.card-sub')).toHaveText(/\S+ · \S+/); // "<OS> · <architecture>"
    await expect(reported.locator('.agent-badge')).toHaveText(/Agent \d+\.\d+\.\d+/);
    await expect(reported.getByRole('img', { name: /^Disk \d+(\.\d)?% used/ })).toBeVisible();
    await expect(reported.locator('.diskm-sub')).toContainText(/free of/);
    await expect(reported).toContainText(/Seen (just now|\d+ s ago|\d+ min ago)/);

    const idle = card(stack.idleAlias!);
    await expect(idle).toBeVisible();
    await expect(idle).toContainText('No disk data');
    await expect(idle).toContainText(/never|Never|Waiting/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('machine');
  });

  test('a machine page opens with all six tabs, each without an error', async ({ page, stack, allow }) => {
    test.skip(!stack.agentAlias, 'needs FLEET_E2E_AGENT_ALIAS');
    await signIn(page, stack, allow);
    await page.goto('/machines');
    await page.getByRole('link', { name: stack.agentAlias!, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(stack.agentAlias!);
    const tabs = page.getByRole('navigation', { name: /sections$/ });
    await expect(tabs.getByRole('link')).toHaveText([/^Overview$/, /^Installed$/, /^Problems/, /^Activity$/, /^Security$/, /^Settings$/]);
    for (const tab of ['Overview', 'Installed', 'Problems', 'Activity', 'Security', 'Settings']) {
      await tabs.getByRole('link', { name: new RegExp(`^${tab}`) }).click();
      await expect(tabs.getByRole('link', { name: new RegExp(`^${tab}`) })).toHaveAttribute('aria-current', 'page');
      await expect(page.locator('#tabpanel')).not.toBeEmpty();
      await expect(page.locator('#tabpanel .empty--error, #tabpanel .callout--critical')).toHaveCount(0);
    }
    await tabs.getByRole('link', { name: 'Security' }).click();
    await expect(page.locator('#tabpanel')).toContainText('Credential ID');
    await tabs.getByRole('link', { name: 'Overview' }).click();
    await expect(page.locator('#machine-panel, section:has-text("Operating system")').first()).toBeVisible();
  });

  test('a disk refresh is answered when the Agent next runs', async ({ page, stack, allow }) => {
    test.skip(!stack.agentAlias || !stack.agentRun, 'needs FLEET_E2E_AGENT_ALIAS and FLEET_E2E_AGENT_RUN');
    await signIn(page, stack, allow);
    await page.goto(`/machines/${encodeURIComponent(stack.agentAlias!)}`);
    await expect(page.locator('#disk-panel .dvol').first()).toBeVisible();

    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('#disk-status')).toHaveText('Refresh requested — the Agent answers on its next check-in.');
    await runAgentOnce(stack, stack.agentAlias!); // the Agent polls, sees the request and measures its disks
    await expect(page.locator('#disk-status')).toHaveText(/^Disk usage updated/, { timeout: 45_000 }); // the page reads again every 5 s
    await expect(page.locator('.disk-measured')).toContainText('Measured');
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  });
});
