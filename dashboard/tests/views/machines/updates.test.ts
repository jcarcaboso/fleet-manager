/**
 * Updating outdated Agents from the Machines page: the bar, the dialog that asks first and lets the Operator untick machines, the
 * per-machine results, the badges while Agents update and the poll that follows them, refusals of the whole request, and the scopes.
 */
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountApp, textOf, waitFor, type TestApp } from '../../helpers/app';
import { FAKE_TIMERS } from '../node/helpers';
import { installIntersectionObserver } from './ioDouble';

let app: TestApp | undefined;
afterEach(() => { app?.unmount(); app = undefined; vi.useRealTimers(); });

const open = async (mock: Record<string, unknown> = {}): Promise<TestApp> => {
  installIntersectionObserver(() => false);
  app = await mountApp({ path: '/machines', mock: { releaseDelay: 0, ...mock } });
  await waitFor(() => app!.wrapper.find('.card').exists());
  return app;
};
const $ = (sel: string): Element | null => document.querySelector(sel);
const $$ = (sel: string): Element[] => [...document.querySelectorAll(sel)];
const text = (sel: string): string => textOf($(sel));
const click = async (el: Element | null): Promise<void> => { (el as HTMLElement).click(); await app!.settle(); };
const dialog = (): Element | null => $('[role=dialog]');
const rows = (): Element[] => $$('[role=dialog] .upd-list li');
const row = (alias: string): Element => rows().find(r => r.getAttribute('data-node') === alias)!;
const confirm = (): HTMLButtonElement => $('[data-act=update-outdated-confirm]') as HTMLButtonElement;
const cardOf = (alias: string): Element => $$('.card').find(c => c.querySelector('h3')?.textContent === alias)!;
const bulk = () => app!.mock.calls.filter(c => c.method === 'POST' && c.path === 'agent-updates');

describe('Update outdated Agents', () => {
  it('the bar counts outdated Agents and what can be done about them', async () => {
    await open();
    expect(text('#agent-updates > span')).toBe('4 Agents older than the Server. 2 can update themselves and 2 need a manual upgrade first.');
    expect($('#agent-updates [data-act=update-outdated]')!.hasAttribute('disabled')).toBe(false);
  });

  it('asks first, lists every outdated machine, sends allOutdated and shows a result per machine', async () => {
    await open();
    await click($('[data-act=update-outdated]'));
    expect(dialog()!.getAttribute('aria-modal')).toBe('true');
    expect(text('[role=dialog] h2, [role=dialog] .modal-head')).toContain('Update outdated Agents');
    expect(rows().map(r => r.getAttribute('data-node'))).toEqual(['build-runner-03', 'fedora-ws', 'laptop-ana', 'mba-travel']);
    expect((row('fedora-ws').querySelector('input') as HTMLInputElement).checked).toBe(true);
    expect((row('build-runner-03').querySelector('input') as HTMLInputElement).checked).toBe(true);
    expect(row('laptop-ana').querySelector('input'), 'cannot be ticked').toBeNull();
    expect(textOf(row('laptop-ana'))).toBe('laptop-ana · Agent 0.9.0-beta.4Cannot update itself yet. Upgrade it by hand once, then run fleet-agent service install.');
    expect(confirm().textContent!.trim()).toBe('Update 2 Agents');
    expect(bulk(), 'nothing is sent before the confirmation').toHaveLength(0);

    await click(confirm());
    await waitFor(() => $('[role=dialog] [data-requested]'));
    expect(bulk()).toHaveLength(1);
    expect(bulk()[0]!.body).toEqual({ allOutdated: true });
    expect(text('[role=dialog] .modal-body > p')).toBe('Requested for 2 of 4 machines. They install 0.9.0 after their next check-in.');
    expect(rows().map(r => [r.getAttribute('data-node'), r.getAttribute('data-requested')])).toEqual([
      ['build-runner-03', 'true'], ['fedora-ws', 'true'], ['laptop-ana', 'false'], ['mba-travel', 'false'],
    ]);
    expect(textOf(row('fedora-ws'))).toBe('fedora-ws · Update requested');
    expect(textOf(row('laptop-ana'))).toMatch(/^laptop-ana · Not requested agent_update_unsupported The Agent on this Node cannot update itself\./);
    expect(row('fedora-ws').querySelector('a')!.getAttribute('href')).toBe('/machines/fedora-ws');
    expect(textOf($('#toasts'))).toMatch(/Update requested for 2 machines/);

    await click($$('[role=dialog] .modal-foot button').find(b => b.textContent?.trim() === 'Done')!);
    expect(dialog()).toBeNull();
    await waitFor(() => cardOf('fedora-ws').querySelector('.chip--updating'));
    expect(textOf(cardOf('fedora-ws').querySelector('.chip--updating'))).toBe('Updating to 0.9.0');
    expect(cardOf('fedora-ws').querySelector('.agent-badge.is-updating')!.getAttribute('data-tip')).toBe('Agent 0.9.0-rc.2|Updating to 0.9.0');
    expect(cardOf('build-runner-03').querySelector('.chip--update-failed'), 'the new request replaces the failure').toBeNull();
    expect(text('#agent-updates > span')).toBe('4 Agents older than the Server. None can be updated now, 2 are updating and 2 need a manual upgrade first.');
    expect($('#agent-updates [data-act=update-outdated]')!.hasAttribute('disabled')).toBe(true);
  });

  it('with a machine unticked it sends the Node IDs that are left', async () => {
    await open();
    await click($('[data-act=update-outdated]'));
    const box = row('fedora-ws').querySelector('input') as HTMLInputElement;
    box.click();
    await flushPromises();
    expect(confirm().textContent!.trim()).toBe('Update 1 Agent');
    await click(confirm());
    await waitFor(() => $('[role=dialog] [data-requested]'));
    expect(bulk()[0]!.body).toEqual({ nodes: [app!.mock.nodes.find(n => n.alias === 'build-runner-03')!.id] });
    expect(rows().map(r => r.getAttribute('data-node'))).toEqual([app!.mock.nodes.find(n => n.alias === 'build-runner-03')!.id]);
  });

  it('nothing ticked: the confirm button is disabled', async () => {
    await open();
    await click($('[data-act=update-outdated]'));
    for (const alias of ['fedora-ws', 'build-runner-03']) (row(alias).querySelector('input') as HTMLInputElement).click();
    await flushPromises();
    expect(confirm().disabled).toBe(true);
  });

  it('a release that cannot be mirrored fails the whole request: the Server\'s message in the dialog, which stays open', async () => {
    await open({ release: 'unavailable' });
    await click($('[data-act=update-outdated]'));
    await click(confirm());
    await waitFor(() => text('[role=dialog] [role=alert]'));
    expect(text('[role=dialog] [role=alert]')).toMatch(/^Agent release 0\.9\.0 is not published yet/);
    expect(rows()).toHaveLength(4);
    expect(confirm().disabled).toBe(false);
  });

  it('follows the updates: the cards change as the Agents report, without reloading the rest of the page', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    await open({ updateDelay: 1000 });
    await click($('[data-act=update-outdated]'));
    await click(confirm());
    await waitFor(() => $('[role=dialog] [data-requested]'));
    await click($$('[role=dialog] .modal-foot button').find(b => b.textContent?.trim() === 'Done')!);
    await waitFor(() => cardOf('fedora-ws').querySelector('.chip--updating'));
    const issuesBefore = app!.mock.calls.filter(c => c.path === 'issues').length;
    await vi.advanceTimersByTimeAsync(10_000);
    await app!.settle();
    expect(cardOf('fedora-ws').querySelector('.chip--updating'), 'the Agent finished').toBeNull();
    expect(textOf(cardOf('fedora-ws').querySelector('.agent-badge'))).toBe('Agent 0.9.0');
    expect(cardOf('build-runner-03').querySelector('.chip--updating'), 'offline: still waiting').not.toBeNull();
    expect(app!.mock.calls.filter(c => c.path === 'issues').length, 'only the machines are read while Agents update').toBe(issuesBefore);
  });
});

describe('scopes and older Servers', () => {
  it('read: the action is locked, explains itself and sends nothing', async () => {
    await open({ scope: 'read' });
    const locked = $('#agent-updates .btn.is-locked') as HTMLElement;
    expect(locked.textContent!.trim()).toBe('Update outdated Agents');
    expect(text('#agent-updates .lock-note')).toBe('Needs the admin scope. Your account has read access.');
    await click(locked);
    expect(dialog()).toBeNull();
    expect(bulk()).toHaveLength(0);
  });

  it('a Server before Agent self-update (no selfUpdate) and one before phase 3 (agent=0) show no bar', async () => {
    await open();
    app!.unmount();
    app = await mountApp({ path: '/machines', mock: { agent: false } });
    await waitFor(() => app!.wrapper.find('.card').exists());
    expect($('#agent-updates')).toBeNull();
    app.unmount();
    installIntersectionObserver(() => false);
    app = await mountApp({ path: '/problems' });
    for (const n of app.mock.nodes) if (n._agent) delete (n._agent as { selfUpdate?: boolean }).selfUpdate;
    await app.go('/machines');
    await waitFor(() => app!.wrapper.find('.card').exists());
    expect($('#agent-updates')).toBeNull();
  });
});
