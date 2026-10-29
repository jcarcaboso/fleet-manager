/**
 * Problems page. Ports of the Dev/drive.js scenarios issueFlow, issueAllQuiet, issueSince, issueScope, issueForbidden, diskProblems,
 * agentProblems, detailProblems, detailNone (Problems part), detailXss (Problems part), p4Xss (Problems part), syncStale and sync,
 * plus the loading, empty, error, scope and abort states.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Issue, IssuesResponse } from '@/api/types';
import { mountApp, textOf, waitFor, type TestApp } from '../../helpers/app';

let app: TestApp | undefined;
afterEach(() => { app?.unmount(); app = undefined; vi.useRealTimers(); });

const w = () => app!.wrapper;
const tab = (label: string) => w().findAll('.chips-filter[aria-label="Filter problems by state"] button').find(b => b.text().startsWith(label))!;
const count = (label: string) => Number(tab(label).find('span').text());
const rows = () => w().findAll('details.prow');
const rowOf = (t: string) => rows().find(r => r.find('summary b').text().includes(t));
const openAll = async () => { rows().forEach(r => { (r.element as HTMLDetailsElement).open = true; }); await app!.settle(); };
const badge = () => (w().find('#nav .nav-badge').exists() ? Number(w().find('#nav .nav-badge').text()) : 0);
const toasts = () => textOf(w().find('#toasts').element);
const posts = (path = 'issues/state') => app!.mock.calls.filter(c => c.method === 'POST' && c.path === path);
const issueList = async () => (await app!.ctx.api.get<IssuesResponse>('issues')).items;
const click = async (sel: string, root: { find(sel: string): { trigger(event: string): Promise<unknown> } } = w()) => { await root.find(sel).trigger('click'); };

describe('Problems page: acknowledge, snooze and reopen (issueFlow)', () => {
  it.each(['admin', 'operate'] as const)('state tabs with counts, Acknowledge, Snooze, Reopen, badge and audit with the %s scope', async scope => {
    app = await mountApp({ path: '/problems', mock: { scope } });
    const open0 = count('Open');
    const badge0 = badge();
    expect([count('Open'), count('Acknowledged'), count('Snoozed')], 'tabs Open / Acknowledged / Snoozed with counts').toEqual([16, 0, 0]);
    expect(tab('Open').attributes('aria-pressed')).toBe('true');
    expect(badge0, 'the badge counts open errors').toBe(6);
    await openAll();
    const target = 'design-imac: agent-file/claude failed';
    expect(rowOf(target)!.find('[data-op=acknowledge]').exists() && !rowOf(target)!.find('[data-op=reopen]').exists(), 'an open problem offers Acknowledge').toBe(true);
    expect(rowOf(target)!.findAll('[data-op=snooze]').map(b => `${b.text()}:${b.attributes('data-hours')}`)).toEqual(['1 h:1', '4 h:4', '24 h:24', '7 d:168']);
    expect(rowOf(target)!.findAll('[data-op=snooze]').every(b => /^Snooze for /.test(b.attributes('aria-label') ?? ''))).toBe(true);
    expect(rowOf(target)!.find('.snooze').attributes('role')).toBe('group');

    await click('[data-op=acknowledge]', rowOf(target)!);
    await waitFor(() => count('Acknowledged') === 1, { label: 'acknowledged' });
    const p = posts().at(-1)!;
    expect(p.body).toMatchObject({ action: 'acknowledge' });
    expect((p.body as { id: string }).id, 'the issue ID (it contains ":") travels in the body').toMatch(/^assignment_failed:[0-9a-f-]+:agent-file\/claude$/);
    expect('hours' in (p.body as object)).toBe(false);
    expect(p.path, 'and never in the path').toBe('issues/state');
    expect(toasts()).toContain('Problem acknowledged');
    expect(count('Open')).toBe(open0 - 1);
    await waitFor(() => badge() === badge0 - 1, { label: 'badge drops' });
    expect(rowOf(target), 'the problem leaves the Open list').toBeUndefined();

    await tab('Acknowledged').trigger('click');
    await waitFor(() => rowOf(target));
    await openAll();
    const r = rowOf(target)!;
    expect(r.classes()).toContain('is-quiet');
    expect(r.find('.tag--state').text()).toBe('Acknowledged');
    expect(r.find('.prob-state').text()).toMatch(/Acknowledged by joan/);
    expect(r.find('[data-op=reopen]').exists() && !r.find('[data-op=acknowledge]').exists() && !r.find('[data-op=snooze]').exists(), 'only Reopen is offered').toBe(true);
    expect(app.mock.audit[0]).toMatchObject({ action: 'issue.acknowledged', actor: 'joan' });
    expect(app.mock.audit[0]!.subject).toMatch(/^assignment_failed:/);

    await click('[data-op=reopen]', r);
    await waitFor(() => count('Acknowledged') === 0, { label: 'reopened' });
    await waitFor(() => badge() === badge0, { label: 'badge restored' });
    expect(count('Open')).toBe(open0);
    expect(app.mock.issueStates.size).toBe(0);
    expect(app.mock.audit[0]!.action).toBe('issue.reopened');
    expect(w().find('.empty h2').text(), 'an empty tab explains itself').toBe('Nothing acknowledged');

    await tab('Open').trigger('click');
    await waitFor(() => rowOf(target));
    await openAll();
    await click('[data-op=snooze][data-hours="4"]', rowOf(target)!);
    await waitFor(() => count('Snoozed') === 1, { label: 'snoozed' });
    const sp = posts().at(-1)!;
    const st = [...app.mock.issueStates.values()][0]!;
    expect(sp.body).toMatchObject({ action: 'snooze', hours: 4 });
    expect(Math.abs(Date.parse((st as { until: string }).until) - Date.now() - 4 * 3600e3)).toBeLessThan(120e3);
    expect(toasts()).toContain('Snoozed for 4 hours');
    await waitFor(() => badge() === badge0 - 1);
    expect(count('Open')).toBe(open0 - 1);

    await tab('Snoozed').trigger('click');
    await waitFor(() => rowOf(target));
    await openAll();
    const sr = rowOf(target)!;
    expect(sr.find('.tag--state').text()).toBe('Snoozed');
    expect(sr.find('.prob-state').text()).toMatch(/Snoozed by joan/);
    expect(sr.find('.prob-state').text()).toMatch(/Back in Open at/);
    expect(sr.find('.prob-state').text()).toMatch(/in 4 h/);
    expect(app.mock.audit[0]!.action).toBe('issue.snoozed');
    expect(sr.find('[data-op=reopen]').exists()).toBe(true);

    await tab('Open').trigger('click');
    await app.settle();
    expect(rowOf(target), 'it stays out of Open').toBeUndefined();
    expect(count('Snoozed')).toBe(1);

    /* The section filter works within a state. */
    await w().findAll('.chips-filter[aria-label="Filter problems"] button').find(b => b.text().startsWith('Models'))!.trigger('click');
    await app.settle();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.text()).toMatch(/CLIProxy/);
  });

  it('shows Snooze 1 h, 4 h, 24 h and 7 d in the toast wording', async () => {
    app = await mountApp({ path: '/problems' });
    await openAll();
    await click('[data-op=snooze][data-hours="168"]', rows()[0]!);
    await waitFor(() => toasts().includes('Snoozed for 7 days'));
    expect(posts().at(-1)!.body).toMatchObject({ action: 'snooze', hours: 168 });
  });

  it('busy buttons are disabled while the change is in flight, and a second click sends nothing', async () => {
    app = await mountApp({ path: '/problems', mock: { slow: 150 } });
    await waitFor(() => rows().length > 0);
    await openAll();
    const btn = rows()[0]!.find('[data-op=acknowledge]');
    await btn.trigger('click');
    await btn.trigger('click');
    expect(rows()[0]!.find('[data-op=acknowledge]').attributes('disabled')).toBeDefined();
    await waitFor(() => count('Acknowledged') === 1);
    expect(posts()).toHaveLength(1);
  });

  it('an issue that is gone (issue_not_found) is explained and the list is reloaded', async () => {
    app = await mountApp({ path: '/problems' });
    await openAll();
    const row = rowOf('homelab-nuc: disk is 96')!;
    // The machine disappears on the Server while the page is open: its issues go with it.
    const at = app.mock.nodes.findIndex(n => n.alias === 'homelab-nuc');
    app.mock.nodes.splice(at, 1);
    const loads = app.mock.calls.filter(c => c.path === 'issues').length;
    await click('[data-op=acknowledge]', row);
    await waitFor(() => toasts().includes('The problem was not changed'), { label: 'error toast' });
    await waitFor(() => !rowOf('homelab-nuc: disk is 96'), { label: 'the row is gone after the reload' });
    expect(app.mock.calls.filter(c => c.path === 'issues').length).toBeGreaterThan(loads);
    expect(app.mock.issueStates.size).toBe(0);
  });
});

describe('every issue acknowledged or snoozed (issueAllQuiet)', () => {
  it('shows "No open problems", the header says what is left and the badge goes', async () => {
    app = await mountApp({ path: '/problems' });
    const items = await issueList();
    for (const i of items) {
      const snooze = i.code === 'node_not_contacting';
      await app.ctx.api.post('issues/state', { id: i.id, action: snooze ? 'snooze' : 'acknowledge', ...(snooze ? { hours: 24 } : {}) });
    }
    await click('[data-act=reload]');
    await waitFor(() => w().find('.empty h2').exists() && w().find('.empty h2').text() === 'No open problems', { label: 'empty state' });
    expect(w().find('#nav .nav-badge').exists(), 'no badge when nothing open is an error').toBe(false);
    const head = w().find('.page-head p').text();
    expect(head).toMatch(/^No open problems\./);
    expect(head).toMatch(/acknowledged or snoozed/);
    expect([count('Open'), count('Acknowledged') + count('Snoozed'), count('Snoozed')]).toEqual([0, items.length, 3]);
    await tab('Acknowledged').trigger('click');
    await app.settle();
    expect(rows()).toHaveLength(count('Acknowledged'));
    expect(rows().every(r => r.classes().includes('is-quiet'))).toBe(true);
  });
});

describe('a new occurrence reopens an acknowledgement (issueSince)', () => {
  it('a new measurement changes since and the acknowledgement stops applying; a snooze keeps applying', async () => {
    app = await mountApp({ path: '/problems', mock: { diskDelay: 40 } });
    await openAll();
    await click('[data-op=acknowledge]', rowOf('homelab-nuc: disk is 96')!);
    await waitFor(() => count('Acknowledged') === 1);
    const id = [...app.mock.issueStates.keys()][0]!;
    const since0 = (app.mock.issueStates.get(id) as { since: string }).since;
    const homelab = app.mock.nodes.find(n => n.alias === 'homelab-nuc')!;
    await app.ctx.api.post(`nodes/${homelab.id}/disk-usage/refresh`);
    await waitFor(async () => (await issueList()).find(i => i.id === id)!.since !== since0, { label: 'a new measurement', timeout: 5000 });
    const now = (await issueList()).find(i => i.id === id)!;
    expect(now).toMatchObject({ state: 'open', stateBy: null, stateAt: null, snoozedUntil: null });
    await click('[data-act=reload]');
    await waitFor(() => rowOf('homelab-nuc: disk is 96'));
    expect([count('Acknowledged'), count('Open')], 'the problem is back under Open').toEqual([0, 16]);
    await openAll();
    await click('[data-op=snooze][data-hours="24"]', rowOf('homelab-nuc: disk is 96')!);
    await waitFor(() => count('Snoozed') === 1);
    (homelab as unknown as { _disk: { measuredAt: string } })._disk.measuredAt = new Date().toISOString();
    const after = (await issueList()).find(i => i.id === id)!;
    expect(after).toMatchObject({ state: 'snoozed', stateBy: 'joan' });
  });
});

describe('scope and refusal (issueScope, issueForbidden)', () => {
  it('a read token sees locked buttons with the reason and nothing is sent', async () => {
    app = await mountApp({ path: '/problems', mock: { scope: 'read' } });
    await openAll();
    const row = rows().find(r => /design-imac: agent-file\/claude failed/.test(r.text()))!;
    expect(row.find('[data-op]').exists(), 'no working Acknowledge, Snooze or Reopen button').toBe(false);
    const locked = row.findAll('.is-locked[data-need=operate]');
    expect(locked.map(b => b.text())).toEqual(expect.arrayContaining(['Acknowledge', 'Snooze']));
    expect(locked.every(b => b.attributes('aria-disabled') === 'true' && !!b.attributes('data-tip'))).toBe(true);
    expect(locked[0]!.attributes('data-tip')).toContain('Needs the operate scope');
    expect(w().find('.lock-note').text()).toContain('operate scope');
    await locked.find(b => /Acknowledge/.test(b.text()))!.trigger('click');
    await app.settle();
    expect(toasts()).toContain('Not available');
    expect(app.mock.calls.filter(c => c.path === 'issues/state')).toHaveLength(0);
    expect(app.mock.issueStates.size).toBe(0);
    expect(w().findAll('.chips-filter[aria-label="Filter problems by state"] button'), 'the state tabs are readable with any scope').toHaveLength(3);
    // Retry is locked too and the reason is written next to it.
    const retry = row.findAll('button').find(b => b.text() === 'Retry now')!;
    expect(retry.classes()).toContain('is-locked');
    expect(retry.attributes('aria-disabled')).toBe('true');
    expect(row.text()).toContain('Needs the operate scope. Your account has read access.');
    await app.settle();
    expect(app.mock.calls.filter(c => c.method === 'POST' && c.path !== 'login')).toHaveLength(0);
  });

  it('the Server refuses the change (403): it is explained and nothing changes', async () => {
    app = await mountApp({ path: '/problems', mock: { forbid: true } });
    await openAll();
    const open0 = count('Open');
    await click('[data-op=acknowledge]', rows()[0]!);
    await waitFor(() => /did not change|not changed/i.test(toasts()), { label: 'error toast' });
    expect(toasts()).toMatch(/scope does not allow/);
    expect([count('Open'), count('Acknowledged')]).toEqual([open0, 0]);
    expect(app.mock.issueStates.size).toBe(0);
    const btn = rows()[0]!.find('[data-op=acknowledge]');
    expect(btn.exists() && btn.attributes('disabled') === undefined, 'and the button is usable again').toBe(true);
  });
});

describe('catalog text, steps and commands (diskProblems, agentProblems, detailProblems)', () => {
  it('disk issues: error and warning with the catalog explanation, fix steps and commands, no Retry', async () => {
    app = await mountApp({ path: '/problems' });
    await openAll();
    const crit = rows().find(r => /homelab-nuc: disk is 96\.4% full/.test(r.text()))!;
    const low = rows().find(r => /fedora-ws: disk is 88\.7% full/.test(r.text()))!;
    expect(crit && low, 'one issue per machine with a full disk').toBeTruthy();
    expect(crit.classes()).toContain('prow--critical');
    expect(crit.find('summary').text()).toMatch(/Error/);
    expect(low.classes()).toContain('prow--warning');
    expect(low.find('summary').text()).toMatch(/Warning/);
    expect(crit.find('.prob-expl').text()).toMatch(/95% full or more/);
    expect(low.find('.prob-expl').text()).toMatch(/85% full or more/);
    expect(crit.findAll('.fix li').length).toBeGreaterThanOrEqual(3);
    expect(crit.find('.fix').text()).toMatch(/Fleet never deletes files/);
    const cmds = crit.findAll('.cmd code').map(c => c.text());
    expect(cmds).toContain('fleet nodes disk homelab-nuc');
    expect(cmds).toContain('fleet nodes disk homelab-nuc --refresh');
    expect(crit.find('a.btn').attributes('href')).toBe('/machines/homelab-nuc/problems');
    expect(rows().filter(r => /disk is/.test(r.text())).some(r => r.find('[data-act=issue-retry]').exists()), 'a disk issue has no Retry button').toBe(false);
  });

  it('agent_outdated: one warning per outdated, non-revoked machine with the install-method action first', async () => {
    app = await mountApp({ path: '/problems' });
    const list = rows().filter(r => /Agent is outdated/.test(r.find('b').text()));
    expect(list, 'one issue per outdated, non-revoked machine; build-runner-03 has agent_update_failed instead').toHaveLength(3);
    expect(rows().filter(r => /Agent update failed/.test(r.find('b').text()))).toHaveLength(1);
    await openAll();
    const r = list.find(x => /fedora-ws/.test(x.text()))!;
    expect(r.find('summary').text()).toMatch(/Warning/);
    expect(r.find('b').text()).toMatch(/fedora-ws: Agent is outdated/);
    expect(r.find('.prob-expl').text()).toMatch(/lower than the Server/);
    expect(r.find('.prob-expl').text()).toMatch(/runs version 0\.9\.0-rc\.2; the latest version is 0\.9\.0/);
    expect(r.find('.prob-expl strong').exists(), 'the specific detail is emphasised').toBe(true);
    const steps = r.findAll('.fix li').map(l => l.text());
    expect(steps[0], 'an Agent that can update itself is told to').toMatch(/Update Agent in the dashboard/);
    expect(steps).toHaveLength(7);
    expect(r.findAll('.cmd code').map(c => c.text()).join()).toBe('fleet nodes show fedora-ws,fleet nodes update fedora-ws');
    expect(list.find(x => /mba-travel/.test(x.text()))!.find('.fix li').text()).toMatch(/Upgrade with brew upgrade fleet-agent/);
    expect(list.find(x => /laptop-ana/.test(x.text()))!.find('.fix li').text()).toMatch(/--tag v0\.9\.0/);
    expect(w().text()).not.toContain('old-laptop: Agent is outdated');
  });

  it('Update Agent on agent_update_failed and on agent_outdated of an Agent that can update itself; the problems are read again', async () => {
    app = await mountApp({ path: '/problems', mock: { releaseDelay: 0 } });
    await openAll();
    const act = (t: string) => rowOf(t)!.find('[data-act=issue-agent-update]');
    expect(act('build-runner-03: Agent update failed').text()).toBe('Update Agent');
    expect(act('fedora-ws: Agent is outdated').text()).toBe('Update Agent');
    expect(act('laptop-ana: Agent is outdated').exists(), 'cannot update itself').toBe(false);
    expect(act('mba-travel: Agent is outdated').exists()).toBe(false);
    const failed = rowOf('build-runner-03: Agent update failed')!;
    expect(failed.find('.prob-expl').text()).toMatch(/fleet-agent --version/);
    expect(failed.findAll('.facts-row dd').map(d => d.text())).toContain('agent_update_smoke_test');
    const reads = app.mock.calls.filter(c => c.path === 'issues').length;
    await act('build-runner-03: Agent update failed').trigger('click');
    await app.settle();
    expect(posts(`nodes/${app.mock.nodes.find(n => n.alias === 'build-runner-03')!.id}/agent-update`)).toHaveLength(1);
    expect(toasts()).toMatch(/Update requested for build-runner-03/);
    expect(app.mock.calls.filter(c => c.path === 'issues').length).toBeGreaterThan(reads);
    expect(rowOf('build-runner-03: Agent update failed'), 'a requested update is no longer a failed one').toBeUndefined();
    expect(rowOf('build-runner-03: Agent is outdated')).toBeDefined();
  });

  it('Update Agent refused: a toast with the Server\'s message; operate: locked and nothing is sent', async () => {
    app = await mountApp({ path: '/problems', mock: { releaseDelay: 0, release: 'unavailable' } });
    await openAll();
    await rowOf('fedora-ws: Agent is outdated')!.find('[data-act=issue-agent-update]').trigger('click');
    await app.settle();
    expect(toasts()).toMatch(/Agent update was not requested/);
    expect(toasts()).toMatch(/Agent release 0\.9\.0 is not published yet/);
    app.unmount();
    app = await mountApp({ path: '/problems', mock: { scope: 'operate' } });
    await openAll();
    const locked = rowOf('fedora-ws: Agent is outdated')!.findAll('.btn.is-locked').find(b => b.text() === 'Update Agent')!;
    expect(locked.attributes('data-need')).toBe('admin');
    await locked.trigger('click');
    await app.settle();
    expect(app.mock.calls.filter(c => c.method === 'POST' && /agent-update/.test(c.path))).toHaveLength(0);
  });

  it('agent=0 (a Server before phase 3): no agent_outdated issue', async () => {
    app = await mountApp({ path: '/problems', mock: { agent: false } });
    expect(rows().some(r => /Agent is outdated/.test(r.find('b').text()))).toBe(false);
  });

  it('attempt detail: step chip, the failing path as sent, diagnostic with a copy button, quiet line for old Agents', async () => {
    app = await mountApp({ path: '/problems' });
    await openAll();
    const studio = rows().find(c => /studio-mini/.test(c.find('summary').text()) && /claude/.test(c.find('summary').text()))!;
    expect(studio.find('.stepchip').text()).toContain('Configuring');
    expect(studio.find('.fdetail-path code').text(), 'the path is shown as sent (no Target base on this page)').toBe('.claude/settings.json');
    expect(studio.find('pre.code--diag').text()).toMatch(/trailing comma/);
    expect(studio.find('.fdetail-diag > button.copy').exists()).toBe(true);
    const old = rows().find(c => /kitchen-mini/.test(c.find('summary').text()))!;
    expect(old.find('.fdetail-none').text()).toMatch(/^No detail reported\./);
    expect(old.find('.stepchip').exists()).toBe(false);
    expect(studio.find('.prob-expl').text().length).toBeGreaterThan(20);
    expect(studio.find('.fix h4').exists()).toBe(true);
  });

  it('diag=0: only the quiet line is shown', async () => {
    app = await mountApp({ path: '/problems', mock: { diag: false } });
    await openAll();
    expect(w().find('.stepchip, .fdetail, pre.code--diag').exists()).toBe(false);
    expect(w().find('.fdetail-none').exists()).toBe(true);
  });
});

describe('hostile text (detailXss, p4Xss)', () => {
  it('a hostile diagnostic, path and Operator name render as text only', async () => {
    let alerts = 0;
    vi.stubGlobal('alert', () => { alerts++; });
    app = await mountApp({ path: '/problems', mock: { xss: true, states: true } });
    await openAll();
    const bad = () => document.querySelectorAll('#view img, #view script, #view svg[onload], #view [onerror], #view [onclick], #view [onload]').length;
    const text = w().text();
    expect(text).toContain('<img src=x onerror=alert(1)>');
    expect(text).toContain('"><script>');
    expect(bad()).toBe(0);
    const path = w().find('.fdetail-path code').text();
    expect(path).toContain('"><script>alert(3)</script>');
    expect(path).toContain('<img src=x onerror=alert(4)>');
    expect(w().find('.fdetail-diag > button.copy').attributes('data-copy') ?? '').toBeDefined();
    await tab('Acknowledged').trigger('click');
    await app.settle();
    await openAll();
    expect(w().text()).toContain('Acknowledged by "><svg onload=alert(10)>');
    expect(bad()).toBe(0);
    expect(alerts).toBe(0);
  });
});

describe('states=1 (an acknowledged and a snoozed issue exist from the start)', () => {
  it('lists them under their tabs with who and until when', async () => {
    app = await mountApp({ path: '/problems', mock: { states: true } });
    expect([count('Open'), count('Acknowledged'), count('Snoozed')]).toEqual([14, 1, 1]);
    expect(w().find('.page-head p').text()).toMatch(/2 more are acknowledged or snoozed\.$/);
    await tab('Snoozed').trigger('click');
    await app.settle();
    await openAll();
    expect(rows()[0]!.find('.prob-state').text()).toMatch(/Snoozed by joan.*Back in Open at/);
    await tab('Acknowledged').trigger('click');
    await app.settle();
    await openAll();
    expect(rows()[0]!.find('.prob-state').text()).toMatch(/Acknowledged by ana/);
    // The badge counts open errors only, so the quiet ones do not count.
    expect(badge()).toBe(6);
  });
});

describe('retry, sync and check again', () => {
  it('Retry now posts the Target, tells the user and reloads', async () => {
    app = await mountApp({ path: '/problems' });
    await openAll();
    const row = rowOf('design-imac: agent-file/claude failed')!;
    const loads = app.mock.calls.filter(c => c.path === 'issues').length;
    await click('[data-act=issue-retry]', row);
    await waitFor(() => posts('nodes/' + app!.mock.nodes.find(n => n.alias === 'design-imac')!.id + '/retry').length === 1, { label: 'retry' });
    expect(posts('nodes/' + app.mock.nodes.find(n => n.alias === 'design-imac')!.id + '/retry')[0]!.body).toEqual({ target: 'agent-file/claude' });
    await waitFor(() => toasts().includes('Retry requested for design-imac'));
    expect(toasts()).toContain('The Agent applies it on its next poll.');
    await waitFor(() => app!.mock.calls.filter(c => c.path === 'issues').length > loads, { label: 'quiet reload' });
    await waitFor(() => !rowOf('design-imac: agent-file/claude failed') || !rowOf('design-imac: agent-file/claude failed')!.find('[data-act=issue-retry]').exists());
  });

  it('a refused retry is explained', async () => {
    app = await mountApp({ path: '/problems', mock: { forbid: true } });
    await openAll();
    await click('[data-act=issue-retry]', rows()[0]!);
    await waitFor(() => toasts().includes('Retry was not requested'));
  });

  it('Sync repository posts source/rescan, reports the result on a toast and reloads the page quietly', async () => {
    app = await mountApp({ path: '/problems' });
    const loads = app.mock.calls.filter(c => c.path === 'issues').length;
    await click('[data-act=sync]');
    expect(w().find('[data-act=sync]').text()).toBe('Syncing…');
    expect(w().find('[data-act=sync]').attributes('disabled')).toBeDefined();
    await waitFor(() => /up to date/i.test(toasts()), { label: 'sync result' });
    await waitFor(() => w().find('[data-act=sync]').text() === 'Sync repository');
    expect(posts('source/rescan')).toHaveLength(1);
    await waitFor(() => app!.mock.calls.filter(c => c.path === 'issues').length > loads, { label: 'reload' });
    expect(app.ctx.shared.lastSync?.text).toContain('Repository is up to date');
  });

  it('a repository sync that answers after the user left does not reload the page the user is on (syncStale)', async () => {
    app = await mountApp({ path: '/problems', mock: { lag: { rescan: 400 } } });
    await click('[data-act=sync]');
    await new Promise(r => setTimeout(r, 100));
    await app.go('/audit');
    await waitFor(() => w().find('h1').text() === 'Audit' && !w().find('.skel').exists());
    const page = w().find('#view').element.firstElementChild;
    const loads = app.mock.calls.filter(c => c.path === 'audit').length;
    await waitFor(() => /up to date/i.test(toasts()), { label: 'the toast reports it', timeout: 3000 });
    await new Promise(r => setTimeout(r, 100));
    expect(w().find('#view').element.firstElementChild).toBe(page);
    expect(app.mock.calls.filter(c => c.path === 'audit').length).toBe(loads);
  });

  it('Check again loads the page again', async () => {
    app = await mountApp({ path: '/problems' });
    const loads = app.mock.calls.filter(c => c.path === 'issues').length;
    await click('[data-act=reload]');
    await app.settle();
    expect(app.mock.calls.filter(c => c.path === 'issues').length).toBeGreaterThan(loads);
    expect(w().find('h1').text()).toBe('Problems');
  });
});

describe('loading, empty, error and abort', () => {
  it('shows the loading skeleton, then the page', async () => {
    app = await mountApp({ path: '/machines' });
    app.mock.options.slow = 200;
    void app.router.push('/problems');
    await waitFor(() => w().find('[role=status] .skel').exists(), { label: 'skeleton' });
    expect(w().find('.sr').text()).toBe('Loading…');
    await waitFor(() => w().find('h1').exists() && w().find('h1').text() === 'Problems');
  });

  it('with nothing to report: "No problems" and a healthy header', async () => {
    app = await mountApp({ path: '/audit' });
    const real = app.ctx.api.get.bind(app.ctx.api);
    (app.ctx.api as { get: unknown }).get = (path: string, ...rest: unknown[]) =>
      (path === 'issues' ? Promise.resolve({ items: [] }) : (real as (p: string, ...r: unknown[]) => Promise<unknown>)(path, ...rest));
    await app.go('/problems');
    expect(w().find('.empty h2').text()).toBe('No problems');
    expect(w().find('.empty').text()).toContain('No failing Targets, offline machines, repository warnings or model sync failures right now.');
    expect(w().find('.page-head p').text()).toBe('Everything Fleet monitors is healthy right now.');
    expect(w().find('.sumrow').exists()).toBe(false);
    expect(w().find('.toolbar').exists()).toBe(false);
  });

  it('an empty fleet still lists the one model catalog warning, with a link to the models page', async () => {
    app = await mountApp({ path: '/problems', mock: { empty: true } });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.find('summary').text()).toContain('CLIProxy models');
    await openAll();
    expect(rows()[0]!.find('a.btn').attributes('href')).toBe('/models');
    expect(rows()[0]!.find('a.btn').text()).toContain('Open models');
  });

  it('the tabs explain themselves when empty: Snoozed and Acknowledged', async () => {
    app = await mountApp({ path: '/problems' });
    await tab('Snoozed').trigger('click');
    expect(w().find('.empty h2').text()).toBe('Nothing snoozed');
    expect(w().find('.empty p').text()).toMatch(/^Snooze a problem to hide it from Open/);
    await tab('Acknowledged').trigger('click');
    expect(w().find('.empty p').text()).toMatch(/^Acknowledge a problem you know about/);
    await tab('Open').trigger('click');
    await w().findAll('.chips-filter[aria-label="Filter problems"] button').find(b => b.text().startsWith('Models'))!.trigger('click');
    expect(rows()).toHaveLength(1);
  });

  it('a failing read shows the error with Try again, which loads again', async () => {
    app = await mountApp({ path: '/problems', mock: { fail: 'issues' } });
    expect(w().find('h1').text()).toBe('Could not load Problems');
    expect(w().find('.empty--error').attributes('role')).toBe('alert');
    expect(w().find('.empty--error p').text()).not.toBe('');
    app.mock.options.fail = null;
    await w().find('.empty--error button').trigger('click');
    await waitFor(() => w().find('h1').text() === 'Problems');
    expect(rows().length).toBeGreaterThan(0);
  });

  it('a token that cannot read shows "Your account cannot open this" without a retry button', async () => {
    app = await mountApp({ path: '/audit' });
    const real = app.ctx.api.get.bind(app.ctx.api);
    (app.ctx.api as { get: unknown }).get = (path: string, ...rest: unknown[]) =>
      (path === 'issues' ? Promise.reject(Object.assign(new Error('Your Operator scope does not allow this action.'), { status: 403, code: 'insufficient_scope', silent: false })) : (real as (p: string, ...r: unknown[]) => Promise<unknown>)(path, ...rest));
    await app.go('/problems');
    expect(w().find('h1').text()).toBe('Your account cannot open this');
    expect(w().find('.empty--error button').exists()).toBe(false);
  });

  it('leaving the page aborts the read that is in flight, and nothing of it ever paints', async () => {
    app = await mountApp({ path: '/machines' });
    app.mock.options.hang = 'issues';
    await app.go('/problems');
    const open = app.mock.calls.filter(c => c.path === 'issues' && !c.settled);
    expect(open.length).toBeGreaterThan(0);
    app.mock.options.hang = null;
    await app.go('/audit');
    expect(open.every(c => c.aborted)).toBe(true);
    expect(w().find('details.prow').exists()).toBe(false);
  });

  it('a page with no stray undefined, null, NaN or Invalid Date text, an h1 and no horizontal overflow markup (scan)', async () => {
    app = await mountApp({ path: '/problems' });
    await openAll();
    expect(textOf(w().find('#view').element)).not.toMatch(/undefined|\bnull\b|NaN|Invalid Date|\[object/);
    expect(w().find('#view [href*="undefined"], #view [href*="null"]').exists()).toBe(false);
    expect(w().find('h1').text()).toBe('Problems');
    expect(document.title).toBe('Problems · Fleet Manager');
  });

  it('every row has a stable key: opening a row survives a quiet reload', async () => {
    app = await mountApp({ path: '/problems' });
    const second = rows()[1]!;
    (second.element as HTMLDetailsElement).open = true;
    second.element.dispatchEvent(new Event('toggle'));
    const title = second.find('summary b').text();
    await click('[data-act=reload]');
    await waitFor(() => rows().length > 0);
    expect((rows().find(r => r.find('summary b').text() === title)!.element as HTMLDetailsElement).open).toBe(true);
    void ({} as Issue);
  });
});
