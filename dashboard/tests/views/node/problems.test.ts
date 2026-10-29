/**
 * The machine's Problems tab. Ports of the Dev/drive.js scenarios retry, forbid, detailNode, detailOld, detailLock, detailNone (this tab),
 * detailXss (this tab), issueNode, issueScope (this tab), diskProblems (this tab), agentProblems (this tab), diskXss (this tab),
 * plus the retry rules (idempotent, keyed by node and target), the empty and degraded states.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAKE_TIMERS, openNode, sleep, type NodeTest } from './helpers';
import { textOf, waitFor } from '../../helpers/app';

let t: NodeTest | undefined;
afterEach(() => { t?.unmount(); t = undefined; vi.useRealTimers(); });

const cards = () => t!.findAll('article.prob');
const chip = (label: string) => t!.findAll('.chips-filter[aria-label="Filter problems by state"] button').find(b => b.text().startsWith(label))!;
const chipCount = (label: string) => Number(chip(label).find('span').text());
const tabCount = () => t!.find('nav.tabs a[href$="/problems"] .tab-cnt').exists() ? t!.find('nav.tabs a[href$="/problems"] .tab-cnt').text() : '';

describe('retry (retry, forbid)', () => {
  it('Retry now asks for the retry, toasts, and the Target is no longer failed afterwards', async () => {
    t = await openNode('/machines/studio-mini/problems');
    expect(cards()).toHaveLength(1);
    const btn = t.find('[data-act=retry]');
    expect(btn.text()).toBe('Retry now');
    expect(btn.attributes('data-target')).toBe('ai-client/claude');
    await btn.trigger('click');
    await t.until(() => /Retry requested/.test(t!.toasts()), 'retry toast');
    expect(t.toasts()).toContain('Retry requested for Claude Code connection on studio-mini');
    expect(t.toasts()).toContain('The Agent applies it on its next poll.');
    const post = t.posts(/\/retry$/);
    expect(post).toHaveLength(1);
    expect(post[0]!.path).toBe(`nodes/${t.app.mock.nodes.find(n => n.alias === 'studio-mini')!.id}/retry`);
    expect(post[0]!.body).toEqual({ target: 'ai-client/claude' });
    await t.until(() => !t!.exists('[data-act=retry]'), 'target no longer failed');
    expect(t.panel()).toContain('Nothing to fix on studio-mini');
    expect(t.exists('.nhero-actions .btn-primary'), 'the Fix button is gone too').toBe(false);
    expect(t.gets(/^nodes\/studio-mini$/).length, 'the machine was read again after the retry').toBeGreaterThan(1);
  });

  it('is idempotent: a second click while the request runs sends nothing and the button reads Requesting…', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    t = await openNode('/machines/studio-mini/problems', { lag: { retry: 1000 } });
    const btn = () => t!.find('[data-act=retry]');
    await btn().trigger('click');
    await t.app.settle();
    expect(btn().text()).toBe('Requesting…');
    expect(btn().attributes('disabled')).toBeDefined();
    expect(btn().find('svg').classes()).toContain('spin');
    await btn().trigger('click');
    await vi.advanceTimersByTimeAsync(200);
    await btn().trigger('click');
    expect(t.posts(/\/retry$/), 'one request').toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1500);
    await t.app.settle();
    expect(/Retry requested/.test(t.toasts())).toBe(true);
    expect(t.posts(/\/retry$/)).toHaveLength(1);
  });

  it('is keyed by machine and Target: retrying one Target leaves the other\'s button alone', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    t = await openNode('/machines/design-imac/problems', { lag: { retry: 1000 } });
    const buttons = () => t!.findAll('[data-act=retry]');
    expect(buttons()).toHaveLength(2);
    const names = buttons().map(b => b.attributes('data-target'));
    expect(new Set(names).size).toBe(2);
    await buttons()[0]!.trigger('click');
    await t.app.settle();
    expect(buttons().map(b => b.text())).toEqual(['Requesting…', 'Retry now']);
    expect(buttons().map(b => b.attributes('disabled') !== undefined)).toEqual([true, false]);
    await buttons()[1]!.trigger('click');
    await t.app.settle();
    expect(t.posts(/\/retry$/).map(c => (c.body as { target: string }).target).sort()).toEqual([...names].sort());
    await vi.advanceTimersByTimeAsync(1500);
    await t.app.settle();
    expect(t.toasts()).toContain('Retry requested');
  });

  it('a refused retry (403) explains why and leaves the page as it was', async () => {
    t = await openNode('/machines/studio-mini/problems', { forbid: true });
    await t.click('[data-act=retry]');
    await t.until(() => /cannot do that|scope/i.test(t!.toasts()), '403 toast');
    expect(t.toasts()).toContain('Retry was not requested');
    expect(t.toasts()).toMatch(/scope|cannot do that/i);
    expect(t.find('[data-act=retry]').attributes('disabled'), 'usable again').toBeUndefined();
    expect(t.find('[data-act=retry]').text()).toBe('Retry now');
    expect(cards()).toHaveLength(1);
  });

  it('a read token sees Retry locked, with its reason, and nothing is sent (scope)', async () => {
    t = await openNode('/machines/studio-mini/problems', { scope: 'read' });
    const btn = t.find('article.prob .is-locked[data-need=operate]');
    expect(btn.text()).toBe('Retry now');
    expect(btn.attributes('aria-disabled')).toBe('true');
    expect(btn.attributes('data-tip')).toContain('Needs the operate scope');
    expect(t.exists('[data-act=retry]')).toBe(false);
    expect(t.exists('article.prob .lock-note--inline')).toBe(true);
    await btn.trigger('click');
    expect(t.toasts()).toContain('Not available');
    expect(t.toasts()).toContain('Needs the operate scope');
    expect(t.posts()).toHaveLength(0);
  });
});

describe('failure detail (detailNode, detailOld, detailLock, detailNone)', () => {
  it('shows the step chip, the failing path with the Target base, the preformatted diagnostic with copy buttons, and keeps the catalog text', async () => {
    t = await openNode('/machines/studio-mini/problems');
    const d = t.find('article.prob .fdetail');
    expect(d.find('.stepchip').text(), 'step is a labelled chip with human wording').toContain('Configuring');
    expect(d.find('.fdetail-path code').text(), 'the failing path is shown with the Target base').toBe('~/.claude/settings.json');
    expect(d.find('pre.code--diag').text()).toMatch(/trailing comma/);
    expect(d.text()).not.toMatch(/excerpt|\|\s+\^/);
    expect(t.find('article.prob').text()).not.toContain('No detail reported');
    expect(t.exists('article.prob .fix h4')).toBe(true);
    expect(t.find('.prob-expl').text()).toMatch(/Configuration file|configuration/i);
    const copy = d.find('.fdetail-diag > button.copy');
    expect(copy.attributes('data-copy')).toBe(d.find('pre.code--diag').text());
    expect(copy.attributes('aria-label')).toBe('Copy diagnostic');
    expect(d.find('.fdetail-path button.copy').attributes('data-copy')).toBe('~/.claude/settings.json');
    expect(d.find('.fdetail-path button.copy').attributes('aria-label')).toBe('Copy failing path');
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    await copy.trigger('click');
    await waitFor(() => copy.classes().includes('is-copied'));
    expect(write).toHaveBeenCalledWith(d.find('pre.code--diag').text());
    expect(copy.classes()).toContain('is-copied');
    expect(t.gets(/^nodes\/[^/]+$/).length, 'node detail was requested').toBeGreaterThan(0);
  });

  it('an old Agent gets one quiet line and no chip, and the catalog text and fix steps are still there', async () => {
    t = await openNode('/machines/kitchen-mini/problems');
    expect(cards().length).toBeGreaterThan(0);
    expect(t.exists('article.prob .fdetail') || t.exists('article.prob .stepchip')).toBe(false);
    expect(t.find('article.prob .fdetail-none').text()).toBe('No detail reported. Agents before 0.9.0 send only the error code.');
    expect(t.exists('article.prob .fix h4')).toBe(true);
    expect(t.find('.prob-expl').text().length).toBeGreaterThan(20);
  });

  it('a step without a path (lock failures are outside the Target base)', async () => {
    t = await openNode('/machines/design-imac/problems');
    const cs = cards();
    const withPath = cs.filter(c => c.find('.fdetail-path').exists());
    const without = cs.filter(c => c.find('.stepchip').exists() && !c.find('.fdetail-path').exists());
    expect(cs.length === 2 && withPath.length === 1 && without.length === 1, 'one failure shows a path and a step, the other a step without a path').toBe(true);
    expect(cs.every(c => /Taking the lock/.test(c.find('.stepchip').text()))).toBe(true);
    expect(withPath[0]!.find('.fdetail-path code').text()).toBe('~/.claude/CLAUDE.md');
    expect(t.text()).toMatch(/held by pid 4127/);
  });

  it('with no phase 2 detail anywhere only the quiet line is shown (diag=0)', async () => {
    t = await openNode('/machines/studio-mini/problems', { diag: false });
    expect(t.exists('.stepchip') || t.exists('.fdetail') || t.exists('pre.code--diag')).toBe(false);
    expect(t.exists('.fdetail-none')).toBe(true);
    await t.go('/machines/studio-mini/activity');
    await t.until(() => t!.exists('.tl-item'));
    expect(t.exists('.stepchip') || t.exists('.diag-line'), 'and in Activity').toBe(false);
  });

  it('hostile diagnostic and path are text, with the copy attribute intact (detailXss)', async () => {
    let alerts = 0;
    vi.stubGlobal('alert', () => { alerts++; });
    t = await openNode('/machines/studio-mini/problems', { xss: true });
    const bad = () => t!.findAll('#root img, #root script, #root [onerror], #root [onclick], #root [onload]').length;
    expect(t.text()).toContain('<img src=x onerror=alert(1)>');
    expect(t.text()).toContain('"><script>');
    const path = t.find('.fdetail-path code').text();
    expect(path).toContain('"><script>alert(3)</script>');
    expect(path).toContain('<img src=x onerror=alert(4)>');
    expect(bad()).toBe(0);
    expect(t.find('.fdetail-diag > button.copy').attributes('data-copy')).toContain('"><script>');
    expect(alerts).toBe(0);
  });
});

describe('issues on the machine: acknowledge, snooze, reopen (issueNode)', () => {
  it('Open / Acknowledged / Snoozed with counts, and the full cycle updates the tab, the header, the badge and Activity', async () => {
    t = await openNode('/machines/studio-mini/problems');
    const badge = () => (t!.exists('#nav .nav-badge') ? Number(t!.text('#nav .nav-badge')) : 0);
    const badge0 = badge();
    expect([chipCount('Open'), chipCount('Acknowledged'), chipCount('Snoozed'), tabCount()]).toEqual([1, 0, 0, '1']);
    expect(chip('Open').attributes('aria-pressed')).toBe('true');
    const card = () => t!.find('article.prob');
    expect(card().exists() && card().find('[data-op=acknowledge]').exists() && card().findAll('[data-op=snooze]').length === 4 && card().find('[data-act=retry]').exists(), 'Acknowledge, Snooze and Retry are offered').toBe(true);
    expect(t.find('.nhero-actions a.btn-primary').text()).toContain('Fix 1 problem');

    await card().find('[data-op=acknowledge]').trigger('click');
    await t.until(() => chipCount('Acknowledged') === 1, 'acknowledged');
    expect(chipCount('Open')).toBe(0);
    expect(tabCount(), 'it leaves the count on the tab').toBe('');
    expect(t.exists('.nhero-actions .btn-primary'), 'and the header button').toBe(false);
    await t.until(() => badge() === badge0 - 1, 'badge drops');
    expect(t.toasts()).toContain('Problem acknowledged');
    expect(t.find('#tabpanel .empty h2').text(), 'the Open tab explains').toBe('Nothing open on studio-mini');
    expect(t.text('#tabpanel .empty')).toContain('Everything that needs attention is acknowledged or snoozed.');

    await chip('Acknowledged').trigger('click');
    await t.until(() => card().exists(), 'acknowledged tab');
    expect(card().find('.prob-state').text()).toMatch(/Acknowledged by joan/);
    expect(card().classes()).toContain('is-quiet');
    expect(card().find('[data-op=reopen]').exists() && card().find('[data-act=retry]').exists(), 'Reopen, and Retry stays available').toBe(true);

    await t.go('/machines/studio-mini/activity');
    await t.until(() => t!.exists('.tl-item'));
    expect(t.findAll('.tl-item').some(i => /Acknowledged a problem/.test(i.text())), 'the acknowledgement is in the machine\'s Activity').toBe(true);
    await t.go('/machines/studio-mini/problems');
    await chip('Acknowledged').trigger('click');
    await t.until(() => t!.exists('[data-op=reopen]'));
    await t.click('[data-op=reopen]');
    await t.until(() => chipCount('Open') === 1, 'reopened');
    expect(tabCount()).toBe('1');
    await t.until(() => badge() === badge0);
    expect(t.app.mock.issueStates.size).toBe(0);
    expect(t.toasts()).toContain('Problem reopened');

    await chip('Open').trigger('click');
    await t.until(() => t!.exists('article.prob [data-op=snooze]'));
    await t.click('article.prob [data-op=snooze][data-hours="168"]');
    await t.until(() => chipCount('Snoozed') === 1, 'snoozed');
    expect(chipCount('Open')).toBe(0);
    expect(t.toasts()).toContain('Snoozed for 7 days');
    expect(t.posts(/^issues\/state$/).at(-1)!.body).toMatchObject({ action: 'snooze', hours: 168 });
    await chip('Snoozed').trigger('click');
    expect(card().find('.prob-state').text()).toMatch(/Snoozed by joan/);
    await chip('Open').trigger('click');
    expect(t.text('#tabpanel .empty h2')).toBe('Nothing open on studio-mini');
    await chip('Snoozed').trigger('click');
    await chip('Acknowledged').trigger('click');
    expect(t.text('#tabpanel .empty h2')).toBe('Nothing acknowledged');
    expect(t.text('#tabpanel .empty')).toContain('Acknowledge a problem you know about. It stays listed here.');
  });

  it('an issue that disappeared meanwhile (404) is reported and the page reads the machine again', async () => {
    t = await openNode('/machines/homelab-nuc/problems');
    const diskCard = () => t!.findAll('article.prob').find(p => /Disk|disk/.test(p.find('h3').text()));
    expect(diskCard()).toBeDefined();
    const node = t.app.mock.nodes.find(n => n.alias === 'homelab-nuc')!;
    for (const v of node._disk!.volumes) { v.availableBytes = v.totalBytes; v.usedBytes = 0; } // the disk was cleaned up: the Server no longer has the issue
    const reads = t.gets(/^nodes\/homelab-nuc$/).length;
    await diskCard()!.find('[data-op=acknowledge]').trigger('click');
    await t.until(() => /not changed|did not change/i.test(t!.toasts()), 'error toast');
    await t.until(() => !diskCard(), 'the page was read again and the issue is gone');
    expect(t.gets(/^nodes\/homelab-nuc$/).length).toBeGreaterThan(reads);
    expect(t.toasts()).toContain('The problem was not changed');
    expect(t.app.mock.issueStates.size).toBe(0);
  });

  it('with the read scope Acknowledge and Snooze are locked and explain themselves; nothing is sent (issueScope)', async () => {
    t = await openNode('/machines/studio-mini/problems', { scope: 'read' });
    expect(t.exists('article.prob [data-op]')).toBe(false);
    const locked = t.findAll('article.prob .is-locked[data-need=operate]');
    expect(locked.map(b => b.text())).toEqual(expect.arrayContaining(['Acknowledge', 'Snooze', 'Retry now']));
    expect(locked.length).toBeGreaterThanOrEqual(3);
    expect(locked[0]!.attributes('data-tip')).toContain('Needs the operate scope');
    expect(t.find('.lock-note').text()).toContain('operate scope');
    await locked.find(b => /Acknowledge/.test(b.text()))!.trigger('click');
    expect(t.toasts()).toContain('Not available');
    expect(t.posts(/issues\/state/)).toHaveLength(0);
    expect(t.app.mock.issueStates.size).toBe(0);
    expect(chipCount('Open'), 'the state tabs are readable with any scope').toBe(1);
  });

  it('a refused change (403) is explained and nothing changes', async () => {
    t = await openNode('/machines/studio-mini/problems', { forbid: true });
    await t.click('article.prob [data-op=acknowledge]');
    await t.until(() => /did not change|not changed/i.test(t!.toasts()), 'error toast');
    expect(t.toasts()).toMatch(/scope|cannot do that/);
    expect(chipCount('Open')).toBe(1);
    expect(chipCount('Acknowledged')).toBe(0);
    expect(t.find('article.prob [data-op=acknowledge]').attributes('disabled')).toBeUndefined();
  });

  it('states=1: an acknowledged and a snoozed issue of other machines appear under their own tabs', async () => {
    t = await openNode('/machines/laptop-ana/problems', { states: true });
    expect([chipCount('Open'), chipCount('Acknowledged'), chipCount('Snoozed')]).toEqual([0, 1, 0]);
    expect(t.text('#tabpanel .empty h2')).toBe('Nothing open on laptop-ana');
    expect(tabCount()).toBe('');
    await chip('Acknowledged').trigger('click');
    expect(t.find('article.prob .prob-state').text()).toMatch(/Acknowledged by ana/);
    await t.go('/machines/fedora-ws/problems');
    await chip('Snoozed').trigger('click');
    const card = t.find('article.prob');
    expect(card.find('.prob-state').text()).toMatch(/Snoozed by joan/);
    expect(card.find('.prob-state').text()).toMatch(/at .* UTC \(in 3 h/);
  });
});

describe('hostile Operator names (p4Xss, this tab)', () => {
  it('the name of whoever acknowledged a problem is text, not markup', async () => {
    let alerts = 0;
    vi.stubGlobal('alert', () => { alerts++; });
    t = await openNode('/machines/laptop-ana/problems', { states: true, xss: true });
    await chip('Acknowledged').trigger('click');
    await t.until(() => t!.exists('article.prob .prob-state'));
    expect(t.text('article.prob .prob-state')).toContain('Acknowledged by "><svg onload=alert(10)>');
    expect(t.findAll('#root img, #root script, #root svg[onload], #root [onerror], #root [onclick], #root [onload]')).toHaveLength(0);
    expect(alerts).toBe(0);
  });
});

describe('issues and the catalog (diskProblems, agentProblems)', () => {
  it('a disk issue shows the catalog explanation, fix steps and the fleet commands, with no Retry (diskProblems)', async () => {
    t = await openNode('/machines/homelab-nuc/problems');
    const card = t.findAll('article.prob').find(p => /Disk|disk/.test(p.find('h3').text()))!;
    expect(card.find('.prob-expl').text()).toMatch(/95% full or more/);
    expect(card.findAll('.fix li').length).toBeGreaterThanOrEqual(3);
    expect(card.find('.fix').text()).toContain('Fleet never deletes files');
    const cmds = card.findAll('.cmd code').map(c => c.text());
    expect(cmds).toEqual(expect.arrayContaining(['fleet nodes disk homelab-nuc', 'fleet nodes disk homelab-nuc --refresh']));
    expect(card.find('[data-act=retry]').exists(), 'a disk issue has no Retry button').toBe(false);
    expect(card.classes()).toContain('prob--critical');
    expect(card.find('.pill').text()).toBe('Error');
  });

  it('agent_outdated: the install-method action comes first, then the catalog steps, and the Problems tab counts it (agentProblems)', async () => {
    t = await openNode('/machines/fedora-ws/problems');
    const p = t.findAll('article.prob').find(x => /Agent is outdated/.test(x.find('h3').text()))!;
    expect(p, 'fedora-ws has the issue').toBeDefined();
    expect(p.find('.pill').text()).toBe('Warning');
    expect(p.find('.prob-expl').text()).toMatch(/lower than the Server/);
    expect(p.find('.prob-expl').text()).toMatch(/runs version 0\.9\.0-rc\.2; the latest version is 0\.9\.0/);
    const steps = p.findAll('.fix li');
    expect(steps[0]!.text()).toMatch(/Update Agent in the dashboard/);
    expect(steps).toHaveLength(7);
    expect(p.findAll('.cmd code').map(c => c.text()).join()).toBe('fleet nodes show fedora-ws,fleet nodes update fedora-ws');
    expect(t.find('nav.tabs').text()).toMatch(/Problems\s*\d/);
    const outdated = (): ReturnType<NodeTest['find']> => t!.findAll('article.prob').find(x => /Agent is outdated/.test(x.find('h3').text()))!;
    await t.go('/machines/mba-travel/problems');
    expect(outdated().find('.fix li').text()).toMatch(/Upgrade with brew upgrade fleet-agent/);
    await t.go('/machines/laptop-ana/problems');
    expect(outdated().find('.fix li').text()).toMatch(/--tag v0\.9\.0/);
  });

  it('an unknown error code has no catalog entry and says so; the technical details stay open across repaints', async () => {
    t = await openNode('/machines/studio-mini/problems');
    const details = t.find('details.tech');
    expect(details.attributes('data-open-key')).toMatch(/^tech:/);
    expect((details.element as HTMLDetailsElement).open).toBe(false);
    (details.element as HTMLDetailsElement).open = true;
    await details.trigger('toggle');
    await t.click('nav.tabs a[href$="/installed"]');
    await t.click('nav.tabs a[href$="/problems"]');
    expect((t.find('details.tech').element as HTMLDetailsElement).open, 'open state is remembered').toBe(true);
    const tech = t.find('details.tech').text();
    expect(tech).toContain('Error code');
    expect(tech).toContain('Target path');
    expect(tech).toContain('Assignment');
    expect(tech).toContain('Recent attempts');
    expect(t.findAll('details.tech table tbody tr').length).toBeGreaterThan(0);
  });
});

describe('empty and quiet states', () => {
  it('a machine with nothing to fix says so, with the Target count', async () => {
    t = await openNode('/machines/mbp-joan/problems');
    expect(t.text('#tabpanel h2')).toBe('Nothing to fix on mbp-joan');
    expect(t.panel()).toMatch(/All \d+ Targets are in sync and the Agent is checking in\./);
    expect(t.exists('.chips-filter')).toBe(false);
  });

  it('a machine that never checked in lists the issue, with the Offline badge, the CLI commands and no Retry', async () => {
    t = await openNode('/machines/lab-vm-07/problems');
    const card = t.find('article.prob');
    expect(card.find('h3').text()).toBe('lab-vm-07 is not checking in');
    expect(card.find('.pill').text()).toBe('Offline');
    expect(card.find('.prob-where').text()).toBe('lab-vm-07');
    expect(card.find('.prob-where a').attributes('href')).toBe('/machines/lab-vm-07');
    expect(card.findAll('.cmd code').map(c => c.text())).toEqual(['fleet nodes show lab-vm-07', 'fleet nodes checkins lab-vm-07']);
    expect(card.find('[data-act=retry]').exists()).toBe(false);
    expect(card.find('.facts-row').text()).toContain('Severity');
    expect(card.find('.facts-row').text()).toContain('Warning');
    expect(t.tabText('Problems')).toBe('Problems1');
    expect(t.find('.nhero-actions .btn-primary').text(), 'offline counts as something to fix').toContain('Fix 1 problem');
  });

  it('degrades to the machine record when GET issues fails (a failed Target is still listed, without commands)', async () => {
    t = await openNode('/machines/studio-mini/problems', { fail: 'issues' });
    expect(t.findAll('article.prob')).toHaveLength(1);
    expect(t.exists('article.prob .cmd')).toBe(false);
    await sleep(0);
    expect(textOf(t.find('.callout--warning').element)).toContain('Issue details are unavailable');
  });
});
