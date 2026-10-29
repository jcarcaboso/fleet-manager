/**
 * Agent self-update on the machine page: Update Agent in the Machine panel, its pending state and refusals, the update state with
 * Cancel, the poll that follows the update to its end, a failed update with the catalog's explanation, the Problems tab action, and
 * the admin scope. Polling runs on fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAKE_TIMERS, openNode, type NodeTest } from './helpers';

let t: NodeTest | undefined;
beforeEach(() => { vi.useFakeTimers(FAKE_TIMERS); });
afterEach(() => { t?.unmount(); t = undefined; vi.useRealTimers(); });

const button = () => t!.find('#agent-upgrade [data-act=agent-update]');
const state = () => t!.find('#agent-update');
const msg = () => t!.text('#agent-update-msg');
const updates = () => t!.posts(/\/agent-update$/);
const reads = (alias: string) => t!.gets(new RegExp(`^nodes/(${alias}|${t!.app.mock.nodes.find(n => n.alias === alias)!.id})$`)).length;
const advance = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await t!.app.settle(); };

describe('Update Agent (an Agent that can update itself)', () => {
  it('offers Update Agent instead of manual steps, requests it, then follows the update to the new version', async () => {
    t = await openNode('/machines/fedora-ws', { releaseDelay: 0, updateDelay: 3000 });
    expect(t.text('#agent-upgrade')).toMatch(/Update available: Agent 0\.9\.0-rc\.2 → 0\.9\.0/);
    expect(t.text('#agent-upgrade')).toMatch(/This Agent can update itself\./);
    expect(t.exists('#agent-upgrade .cmd'), 'no manual commands').toBe(false);
    expect(button().text()).toBe('Update Agent');
    expect(t.exists('#agent-update'), 'no update yet').toBe(false);

    await button().trigger('click');
    await t.app.settle();
    expect(updates()).toHaveLength(1);
    expect(updates()[0]!.path).toBe(`nodes/${t.app.mock.nodes.find(n => n.alias === 'fedora-ws')!.id}/agent-update`);
    expect(t.toasts()).toMatch(/Update requested for fedora-ws/);
    expect(t.toasts()).toMatch(/installs 0\.9\.0 after its next check-in/);
    expect(state().attributes('data-state')).toBe('requested');
    expect(t.text('#agent-update .aupd-head')).toBe('Update requested 0.9.0-rc.2 → 0.9.0');
    expect(t.text('#agent-update')).toMatch(/Waiting for the Agent’s next check-in\.Requested by joan just now/);
    expect(t.exists('#agent-upgrade [data-act=agent-update]'), 'no second request while one is active').toBe(false);
    expect(t.find('#agent-update [data-act=agent-update-cancel]').text()).toBe('Cancel update');
    expect(t.text('.hchecks')).toMatch(/Agent is updating/);
    expect(t.text('.nhero')).toMatch(/updating to 0\.9\.0/);

    const before = reads('fedora-ws');
    await advance(5000);
    expect(reads('fedora-ws'), 'read again after 5 s').toBe(before + 1);
    expect(state().attributes('data-state')).toBe('downloading');
    expect(t.text('#agent-update')).toMatch(/downloading the signed release/);
    expect(t.exists('#agent-update [data-act=agent-update-cancel]'), 'no Cancel once the Agent started').toBe(false);
    await advance(5000);
    expect(state().attributes('data-state')).toBe('succeeded');
    await t.app.settle();
    expect(t.text('#agent-update .aupd-head')).toBe('Updated 0.9.0-rc.2 → 0.9.0');
    expect(t.text('#agent-update')).toMatch(/The Agent runs the new version\./);
    expect(t.exists('#agent-upgrade'), 'up to date: no callout').toBe(false);
    expect(t.text('.hchecks')).toMatch(/Agent is up to date/);
    const after = reads('fedora-ws');
    await advance(20_000);
    expect(reads('fedora-ws'), 'the poll stopped').toBe(after);
  });

  it('shows the pending state while the Server mirrors the release', async () => {
    t = await openNode('/machines/fedora-ws', { releaseDelay: 4000 });
    await button().trigger('click');
    await t.app.settle();
    expect(button().text()).toBe('Requesting…');
    expect(button().attributes('disabled')).toBeDefined();
    expect(button().attributes('aria-busy')).toBe('true');
    expect(t.text('#agent-upgrade')).toMatch(/The first request of a release can take a few minutes\./);
    await advance(4000);
    expect(state().attributes('data-state')).toBe('requested');
  });

  it('a release that is not published: the Server\'s message, inline and in a toast; nothing is requested', async () => {
    t = await openNode('/machines/fedora-ws', { releaseDelay: 0, release: 'unavailable' });
    await button().trigger('click');
    await t.app.settle();
    expect(msg()).toMatch(/^Agent release 0\.9\.0 is not published yet/);
    expect(t.find('#agent-update-msg').classes()).toContain('aupd-msg--critical');
    expect(t.toasts()).toMatch(/Agent update was not requested/);
    expect(t.toasts()).toMatch(/not published yet/);
    expect(button().text(), 'can be tried again').toBe('Update Agent');
    expect(t.exists('#agent-update')).toBe(false);
  });

  it('an Agent that was updated meanwhile: 409 agent_update_current, a warning, and the machine is read again', async () => {
    t = await openNode('/machines/fedora-ws', { releaseDelay: 0 });
    t.app.mock.nodes.find(n => n.alias === 'fedora-ws')!._agent!.version = '0.9.0';
    const before = reads('fedora-ws');
    await button().trigger('click');
    await t.app.settle();
    expect(msg()).toBe('The Agent already runs version 0.9.0.');
    expect(t.find('#agent-update-msg').classes()).toContain('aupd-msg--warning');
    expect(reads('fedora-ws')).toBeGreaterThan(before);
    expect(t.exists('#agent-upgrade'), 'the reload shows it is up to date').toBe(false);
  });

  it('a live failure: the smoke test fails, the state says why with the catalog, and Update Agent is offered again', async () => {
    t = await openNode('/machines/fedora-ws', { releaseDelay: 0, updateDelay: 1000, updateFail: ['fedora-ws'] });
    await button().trigger('click');
    await t.app.settle();
    await advance(5000);
    expect(state().attributes('data-state')).toBe('failed');
    expect(t.text('#agent-update .aupd-head')).toBe('Update failed 0.9.0-rc.2 → 0.9.0');
    expect(t.text('#agent-update')).toMatch(/The Agent kept its previous version\.agent_update_smoke_test/);
    expect(t.text('#agent-update .aupd-why')).toMatch(/The new binary did not start on this machine\./);
    expect(button().text()).toBe('Update Agent');
    expect(t.text('.hchecks')).toMatch(/Agent update failed/);
  });

  it('opening a machine whose update is active follows it without a click', async () => {
    t = await openNode('/machines/design-imac', { releaseDelay: 0, updateDelay: 1000 });
    const res = await t.app.mock.fetch('https://mock.fleet.invalid/dashboard/api/nodes/fedora-ws/agent-update', {
      method: 'POST', headers: { 'X-Fleet-CSRF': t.app.mock.state.csrf }, body: '{}',
    });
    expect(res.status).toBe(202);
    await t.go('/machines/fedora-ws');
    await t.ready('fedora-ws');
    expect(state().attributes('data-state')).toBe('requested');
    await advance(5000);
    expect(state().attributes('data-state')).not.toBe('requested');
  });
});

describe('Cancel, an offline machine and a failed update (build-runner-03)', () => {
  it('shows the failed update with the error code and the catalog\'s explanation', async () => {
    t = await openNode('/machines/build-runner-03', { releaseDelay: 0 });
    expect(state().attributes('data-state')).toBe('failed');
    expect(state().classes()).toContain('aupd--critical');
    expect(t.find('#agent-update code').text()).toBe('agent_update_smoke_test');
    expect(t.text('#agent-update .aupd-why')).toBe('agent_update_smoke_test The new binary did not start on this machine. The Agent ran fleet-agent --version with the new binary and it failed, timed out or printed another version. The service keeps running the old version.');
    expect(t.findAll('#agent-update .aupd-why code').map(c => c.text()), 'backticks become code').toEqual(['agent_update_smoke_test', 'fleet-agent --version']);
    expect(t.text('#agent-update')).toMatch(/Requested by ana .* ago · finished .* ago/);
    expect(t.text('.hchecks')).toMatch(/Agent update failed/);
    expect(t.text('.hchecks')).toMatch(/failed with agent_update_smoke_test/);
    expect(button().text(), 'it can be tried again').toBe('Update Agent');
  });

  it('a request for an offline machine waits; Cancel takes it back', async () => {
    t = await openNode('/machines/build-runner-03', { releaseDelay: 0 });
    await button().trigger('click');
    await t.app.settle();
    expect(state().attributes('data-state')).toBe('requested');
    expect(t.text('#agent-update')).toMatch(/build-runner-03 is not checking in\. Its Agent starts the update when it is back\./);
    await t.click('#agent-update [data-act=agent-update-cancel]');
    expect(t.posts(/\/agent-update\/cancel$/)).toHaveLength(1);
    expect(state().attributes('data-state')).toBe('cancelled');
    expect(t.text('#agent-update')).toMatch(/Cancelled before the Agent started it\./);
    expect(t.toasts()).toMatch(/Update cancelled for build-runner-03/);
    expect(button().text(), 'can be requested again').toBe('Update Agent');
    const after = t.gets(/^nodes\/[^/]+$/).length;
    await advance(20_000);
    expect(t.gets(/^nodes\/[^/]+$/).length, 'no poll after a cancel').toBe(after);
  });

  it('a Cancel that comes too late says why and reads the machine again', async () => {
    t = await openNode('/machines/build-runner-03', { releaseDelay: 0 });
    await button().trigger('click');
    await t.app.settle();
    t.app.mock.nodes.find(n => n.alias === 'build-runner-03')!._update!.state = 'downloading';
    await t.click('#agent-update [data-act=agent-update-cancel]');
    expect(msg()).toBe('Only an update the Agent has not started can be cancelled.');
    expect(state().attributes('data-state')).toBe('downloading');
  });
});

describe('Agents that cannot update themselves, scopes and the Problems tab', () => {
  it('an Agent without the capability keeps the manual steps and says it needs fleet-agent service install once', async () => {
    t = await openNode('/machines/laptop-ana', { releaseDelay: 0 });
    expect(t.exists('#agent-upgrade [data-act=agent-update]')).toBe(false);
    expect(t.find('#agent-upgrade').attributes('data-method')).toBe('cargo');
    expect(t.text('#agent-upgrade [data-manual-once]')).toBe('This Agent cannot update itself. After this upgrade, run fleet-agent service install once; later updates can start from here.');
    await t.go('/machines/studio-mini');
    expect(t.exists('#agent-upgrade') || t.exists('#agent-update'), 'up to date: nothing').toBe(false);
  });

  it('a Server before Agent self-update says nothing about it', async () => {
    t = await openNode('/machines/design-imac');
    const node = t.app.mock.nodes.find(n => n.alias === 'fedora-ws')!;
    delete (node._agent as { selfUpdate?: boolean }).selfUpdate;
    await t.go('/machines/fedora-ws');
    await t.ready('fedora-ws');
    expect(t.exists('[data-act=agent-update]') || t.exists('[data-manual-once]')).toBe(false);
    expect(t.find('#agent-upgrade').attributes('data-method')).toBe('binary');
  });

  it('operate: Update Agent is locked, explains itself and sends nothing', async () => {
    t = await openNode('/machines/fedora-ws', { scope: 'operate', releaseDelay: 0 });
    const locked = () => t!.find('#agent-upgrade .btn.is-locked');
    expect(locked().text()).toBe('Update Agent');
    expect(locked().attributes('data-need')).toBe('admin');
    expect(t.text('#agent-upgrade .lock-note')).toBe('Needs the admin scope. Your account has operate access.');
    await locked().trigger('click');
    await t.app.settle();
    expect(updates()).toHaveLength(0);
    expect(t.toasts()).toMatch(/Not available/);
  });

  it('the Problems tab: Update Agent on agent_update_failed and on agent_outdated of an Agent that can update itself, not otherwise', async () => {
    t = await openNode('/machines/build-runner-03/problems', { releaseDelay: 0 });
    const card = () => t!.findAll('article.prob').find(p => /Agent update failed|Agent is outdated/.test(p.find('h3').text()))!;
    expect(card().find('h3').text()).toBe('build-runner-03: Agent update failed');
    expect(card().find('.prob-expl').text()).toMatch(/The new binary did not start|fleet-agent --version/);
    expect(card().findAll('.cmd code').map(c => c.text())).toEqual(['fleet nodes show build-runner-03', 'fleet explain agent_update_smoke_test', 'fleet nodes update build-runner-03']);
    await card().find('[data-act=agent-update]').trigger('click');
    await t.app.settle();
    expect(updates()).toHaveLength(1);
    expect(t.toasts()).toMatch(/Update requested for build-runner-03/);
    await t.go('/machines/laptop-ana/problems');
    expect(card().find('h3').text()).toBe('laptop-ana: Agent is outdated');
    expect(card().find('[data-act=agent-update]').exists()).toBe(false);
    await t.go('/machines/fedora-ws/problems');
    expect(card().find('[data-act=agent-update]').text()).toBe('Update Agent');
  });
});
