/**
 * The Disk panel of the machine Overview and the refresh flow. Ports of the Dev/drive.js scenarios diskNode, diskRefreshAnswered,
 * diskRefreshUnanswered, diskNavAway, diskRefreshHang, diskNavHang, diskReadScope, diskRefreshForbidden, diskRefreshRevoked,
 * diskXss (machine page) and the node part of issueSince. Polling and deadlines run on fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssuesResponse } from '@/api/types';
import { FAKE_TIMERS, openNode, type NodeTest } from './helpers';

let t: NodeTest | undefined;
beforeEach(() => { vi.useFakeTimers(FAKE_TIMERS); });
afterEach(() => { t?.unmount(); t = undefined; vi.useRealTimers(); });

const status = () => t!.find('#disk-status');
const refresh = () => t!.find('#disk-panel [data-act=disk-refresh]');
const idOf = (alias: string) => t!.app.mock.nodes.find(n => n.alias === alias)!.id;
const reads = (alias: string) => t!.app.mock.calls.filter(c => c.method === 'GET' && c.path === `nodes/${idOf(alias)}`);
const advance = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await t!.app.settle(); };
const NO_ANSWER = 'No answer yet. Agents before 0.9.0 do not report disk usage.';

describe('the Disk panel (diskNode)', () => {
  it('shows each volume with percent, word and icon, a bar of the right width, GiB with one decimal, and when it was measured', async () => {
    t = await openNode('/machines/homelab-nuc');
    const rows = t.findAll('#disk-panel .dvol');
    expect(rows.map(r => r.attributes('data-volume')), 'two volumes, home first then state').toEqual(['home', 'state']);
    const [home, state] = rows as [typeof rows[0], typeof rows[0]];
    expect(home.classes()).toContain('dvol--critical');
    expect(home.text()).toMatch(/96\.4%/);
    expect(home.text()).toMatch(/Nearly full/);
    expect(home.find('.dvol-state svg.g').exists(), 'icon as well as word').toBe(true);
    expect(home.find('.dvol-name b').text()).toBe('Home folder');
    expect(home.find('.dvol-name .muted').text()).toBe('The volume that holds the user’s home directory');
    const meter = home.find('.meter.m-critical');
    expect(meter.attributes('role')).toBe('img');
    expect(meter.attributes('aria-label')).toBe('Home folder: 96.4% used, Nearly full');
    expect((meter.find('span').element as HTMLElement).style.width, 'the bar is 96.4% wide').toBe('96.4%');
    const nums = Object.fromEntries(home.findAll('.dvol-nums > div').map(d => [d.find('dt').text(), d.find('dd').text()]));
    expect(nums.Total).toBe('954.0 GiB');
    expect(nums.Used).toMatch(/^\d+\.\d GiB$/);
    expect(nums.Available).toBe('33.3 GiB');
    expect(state.classes()).toContain('dvol--good');
    expect(state.text()).toMatch(/41\.3%/);
    expect(state.text()).toMatch(/476\.0 GiB/);
    expect(state.find('.dvol-name b').text()).toBe('Agent state');
    expect(t.text('#disk-panel .disk-measured')).toMatch(/^Measured .* ago · [A-Z][a-z]{2} \d+, \d\d:\d\d UTC$/);
    expect(refresh().text()).toBe('Refresh');
    expect(refresh().attributes('disabled')).toBeUndefined();
    expect([...t.findAll('.hchecks b')].some(b => b.text() === 'Disk is nearly full'), 'Health checks mention the disk').toBe(true);
    expect(t.find('.nhero-actions .btn-primary').text(), 'the disk issue counts as a problem to fix').toContain('Fix 1 problem');
    expect(t.gets(/^nodes\/[^/]+$/).length, 'disk comes from GET nodes/{node}').toBeGreaterThan(0);
    expect(t.find('#disk-status').attributes('role')).toBe('status');
  });

  it('warning and good levels read "Filling up" and "Enough space"; a machine that never reported explains why', async () => {
    t = await openNode('/machines/fedora-ws');
    expect(t.find('#disk-panel .dvol').classes()).toContain('dvol--warning');
    expect(t.text('#disk-panel .dvol-state')).toBe('Filling up');
    expect([...t.findAll('.hchecks b')].some(b => b.text() === 'Disk is filling up')).toBe(true);
    await t.go('/machines/mbp-joan');
    expect(t.find('#disk-panel .dvol').classes()).toContain('dvol--good');
    expect(t.text('#disk-panel .dvol-state')).toBe('Enough space');
    expect([...t.findAll('.hchecks b')].some(b => b.text() === 'Disk has room')).toBe(true);
    await t.go('/machines/build-runner-02');
    expect(t.exists('.dvol')).toBe(false);
    expect(t.text('#disk-body')).toBe('No disk data yet. An Agent reports its disk usage after its first check-in and every 4 hours. Agents before 0.9.0 do not report it.');
    expect(t.text('#disk-status'), 'no status without a refresh').toBe('');
  });

  it('a Server without disk data (disk missing) shows the same explanation', async () => {
    t = await openNode('/machines/kitchen-mini');
    expect(t.exists('.dvol')).toBe(false);
    expect(t.text('#disk-body')).toContain('No disk data yet.');
  });
});

describe('refresh answered (diskRefreshAnswered)', () => {
  it('asks the Server, waits with a live status, reads the machine every 5 s, shows the new volume and stops', async () => {
    t = await openNode('/machines/build-runner-02');
    const node = t.app.mock.nodes.find(n => n.alias === 'build-runner-02')!;
    expect(t.text('#disk-body')).toMatch(/No disk data yet/);
    await refresh().trigger('click');
    await t.app.settle();
    expect(t.text('#disk-status'), 'status after the click').toBe('Refresh requested — the Agent answers on its next check-in.');
    expect(status().attributes('role')).toBe('status');
    expect(status().classes()).toContain('disk-status--info');
    expect(refresh().attributes('disabled'), 'the button is disabled while waiting').toBeDefined();
    expect(refresh().attributes('aria-busy')).toBe('true');
    expect(refresh().text()).toBe('Refreshing…');
    const post = t.app.mock.calls.find(c => c.method === 'POST' && c.path === `nodes/${node.id}/disk-usage/refresh`)!;
    expect(post, 'POST nodes/{id}/disk-usage/refresh was sent').toBeDefined();
    expect(post.body).toEqual({});
    const t0 = post.at;
    await advance(4900);
    expect(reads('build-runner-02').filter(c => c.at > t0)).toHaveLength(0);
    await advance(20_000);
    expect(t.text('#disk-status')).toMatch(/^Disk usage updated .*\.$/);
    expect(t.exists('#disk-panel .dvol'), 'the volume appears').toBe(true);
    expect(t.text('#disk-panel .dvol-name b')).toBe('Home folder');
    expect(status().classes()).toContain('disk-status--good');
    expect(refresh().attributes('disabled'), 'the button is enabled again').toBeUndefined();
    expect(refresh().text()).toBe('Refresh');
    const polls = reads('build-runner-02').filter(c => c.at > t0).sort((a, b) => a.at - b.at);
    const gaps = polls.slice(0, 3).map((c, i, a) => (i ? c.at - a[i - 1]!.at : c.at - t0));
    expect(polls.length).toBeGreaterThanOrEqual(2);
    expect(gaps.slice(0, 2), 'GET nodes/{node} every 5 s while waiting').toEqual([5000, 5000]);
    await advance(100);
    const settled = reads('build-runner-02').length;
    await advance(30_000);
    expect(reads('build-runner-02').length, 'polling stops once the Agent answered').toBe(settled);
    expect(t.exists('.disk-status--warning') || t.exists('.disk-status--critical'), 'no error shown').toBe(false);
    expect(t.find('nav.tabs').exists()).toBe(true);
  });

  it('the answer also refreshes the rest of the page (health check, Problems count, header) with one quiet reload', async () => {
    t = await openNode('/machines/build-runner-02', { diskDelay: 1000 });
    expect([...t.findAll('.hchecks b')].some(b => /^Disk /.test(b.text()))).toBe(false);
    expect(t.gets(/^nodes\/build-runner-02$/)).toHaveLength(1);
    const issuesBefore = t.gets(/^issues$/).length;
    await refresh().trigger('click');
    await advance(12_000);
    expect(t.exists('#disk-panel .dvol')).toBe(true);
    expect([...t.findAll('.hchecks b')].some(b => b.text() === 'Disk has room'), 'the health check follows the new measurement').toBe(true);
    expect(reads('build-runner-02'), 'one poll saw the answer').toHaveLength(1);
    expect(t.gets(/^nodes\/build-runner-02$/), 'and the machine was read once more, quietly').toHaveLength(2);
    expect(t.gets(/^issues$/).length, 'the issues are read again with it').toBeGreaterThan(issuesBefore);
    expect(t.exists('.nhero h1'), 'the page stays up during the reload').toBe(true);
  });

  it('a repeated request keeps the first time until the Agent answers, and the audit records one request', async () => {
    t = await openNode('/machines/kitchen-mini');
    await refresh().trigger('click');
    await advance(300_000);
    await refresh().trigger('click');
    await advance(500);
    const posts = t.posts(/disk-usage\/refresh$/);
    expect(posts).toHaveLength(2);
    expect(t.app.mock.audit.filter(e => e.action === 'node.disk_refresh_requested')).toHaveLength(1);
  });
});

describe('refresh never answered (diskRefreshUnanswered)', () => {
  it('stops waiting after 2.5 minutes, says so, enables Refresh again, and the polling is bounded', async () => {
    t = await openNode('/machines/kitchen-mini');
    await refresh().trigger('click');
    await t.app.settle();
    expect(t.text('#disk-status')).toBe('Refresh requested — the Agent answers on its next check-in.');
    const t0 = Date.now();
    await advance(60_000);
    expect(t.text('#disk-status')).toMatch(/Refresh requested/);
    expect(refresh().attributes('disabled'), 'after a minute it is still waiting').toBeDefined();
    await advance(89_000);
    expect(t.text('#disk-status'), 'not before 2.5 minutes').toMatch(/Refresh requested/);
    await advance(2000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150_000);
    expect(t.text('#disk-status'), 'the time-out message').toBe(NO_ANSWER);
    expect(status().classes()).toContain('disk-status--warning');
    expect(refresh().attributes('disabled'), 'the button is enabled again, so the user can try once more').toBeUndefined();
    expect(refresh().attributes('aria-busy')).toBeUndefined();
    const polls = reads('kitchen-mini').filter(c => c.at >= t0).length;
    expect(polls, 'the number of polls is bounded').toBeGreaterThanOrEqual(25);
    expect(polls).toBeLessThanOrEqual(32);
    await advance(30_000);
    expect(reads('kitchen-mini').filter(c => c.at >= t0).length, 'no polling after the time-out').toBe(polls);
    expect(t.exists('.toast') || t.text('#toasts') !== '').toBe(false);
  });

  it('Refresh works again after the time-out', async () => {
    t = await openNode('/machines/kitchen-mini');
    await refresh().trigger('click');
    await advance(155_000);
    expect(t.text('#disk-status')).toBe(NO_ANSWER);
    await refresh().trigger('click');
    await t.app.settle();
    expect(t.text('#disk-status')).toMatch(/Refresh requested/);
    expect(refresh().attributes('disabled')).toBeDefined();
  });
});

describe('leaving the machine (diskNavAway, diskNavHang)', () => {
  it('stops the polling, the other machine does not inherit the waiting state, and coming back does not resume it', async () => {
    t = await openNode('/machines/kitchen-mini');
    await refresh().trigger('click');
    await t.app.settle();
    await advance(12_000);
    const during = reads('kitchen-mini').length;
    expect(during, 'it polls every 5 s while the user stays').toBeGreaterThanOrEqual(2);
    await t.go('/machines/studio-mini');
    await t.ready('studio-mini');
    const atLeave = reads('kitchen-mini').length;
    await advance(20_000);
    expect(reads('kitchen-mini').length, 'no further reads of the first machine after navigating to another one').toBeLessThanOrEqual(atLeave + 1);
    expect(t.text('#disk-status')).not.toMatch(/Refresh requested/);
    expect(refresh().exists() && refresh().attributes('disabled') === undefined, 'the other machine does not inherit the waiting state').toBe(true);
    await t.go('/machines/kitchen-mini');
    await t.ready('kitchen-mini');
    const back = reads('kitchen-mini').length;
    await advance(12_000);
    expect(refresh().attributes('disabled') === undefined && reads('kitchen-mini').length === back, 'coming back does not resume the polling').toBe(true);
    expect(t.text('#disk-status'), 'the pending request from the Server is mentioned').toMatch(/^A refresh was requested .* ago\. The Agent answers on its next check-in\.$/);
    expect(status().classes()).toContain('disk-status--info');
  });

  it('navigating away while a read hangs aborts it, with no error and no further reads', async () => {
    t = await openNode('/machines/kitchen-mini');
    const id = idOf('kitchen-mini');
    const base = reads('kitchen-mini').length;
    await refresh().trigger('click');
    await t.app.settle();
    t.app.mock.options.hang = `nodes/${id}`;
    await advance(5100);
    const hung = reads('kitchen-mini').at(-1)!;
    expect(reads('kitchen-mini').length).toBeGreaterThan(base);
    expect(!hung.settled && !hung.aborted, 'the poll is in flight and does not answer').toBe(true);
    await t.go('/machines/studio-mini');
    await t.ready('studio-mini');
    expect(hung.aborted && hung.settled, 'navigating away aborted the read').toBe(true);
    const atLeave = reads('kitchen-mini').length;
    await advance(30_000);
    expect(reads('kitchen-mini').length, 'no further reads of the first machine').toBe(atLeave);
    expect(t.exists('.toast') || t.exists('.disk-status--critical') || t.exists('.disk-status--warning'), 'the abort is not shown as an error').toBe(false);
    expect(refresh().attributes('disabled'), 'the other machine can refresh').toBeUndefined();
    t.app.mock.options.hang = null;
    await t.go('/machines/kitchen-mini');
    await t.ready('kitchen-mini');
    const back = reads('kitchen-mini').length;
    await advance(12_000);
    expect(reads('kitchen-mini').length === back && refresh().attributes('disabled') === undefined, 'coming back does not resume the polling').toBe(true);
  });

  it('switching tabs does not stop the refresh: it keeps waiting and the panel shows the result when Overview is shown again', async () => {
    t = await openNode('/machines/build-runner-02', { diskDelay: 1000 });
    await refresh().trigger('click');
    await t.app.settle();
    await t.go('/machines/build-runner-02/installed');
    await advance(8000);
    await t.go('/machines/build-runner-02');
    expect(t.exists('#disk-panel .dvol')).toBe(true);
    expect(t.text('#disk-status')).toMatch(/^Disk usage updated /);
  });
});

describe('a read that never answers cannot hold Refresh forever (diskRefreshHang)', () => {
  it('the deadline, 2.5 minutes after the request was accepted, aborts the read and shows the no-answer state', async () => {
    t = await openNode('/machines/kitchen-mini');
    const id = idOf('kitchen-mini');
    const base = reads('kitchen-mini').length;
    await refresh().trigger('click');
    await t.app.settle();
    const t0 = Date.now();
    t.app.mock.options.hang = `nodes/${id}`;
    await advance(5100);
    const hung = reads('kitchen-mini').at(-1)!;
    expect(reads('kitchen-mini').length).toBe(base + 1);
    expect(!hung.settled && !hung.aborted, 'the poll is in flight and does not answer').toBe(true);
    await advance(60_000);
    expect(t.text('#disk-status')).toMatch(/Refresh requested/);
    expect(refresh().attributes('disabled')).toBeDefined();
    expect(reads('kitchen-mini').length === base + 1 && !hung.settled, 'only the one read is out (a new poll does not start before the last one ended)').toBe(true);
    await advance(85_000); // 150.1 s after the request
    expect(t.text('#disk-status'), 'the deadline allows the last read a moment').toMatch(/Refresh requested/);
    await advance(1000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150_000);
    expect(Date.now() - t0).toBeLessThanOrEqual(154_000);
    expect(t.text('#disk-status'), 'the deadline ends the wait without the read answering').toBe(NO_ANSWER);
    expect(hung.aborted && hung.settled, 'the read that hung was aborted').toBe(true);
    expect(refresh().attributes('disabled') === undefined && refresh().attributes('aria-busy') === undefined, 'Refresh is enabled again').toBe(true);
    expect(t.exists('.toast') || t.exists('.disk-status--critical'), 'the abort is not shown as an error').toBe(false);
    const count = t.app.mock.calls.length;
    await advance(30_000);
    expect(t.app.mock.calls.length, 'no request after the deadline').toBe(count);
    t.app.mock.options.hang = null;
    await refresh().trigger('click');
    await t.app.settle();
    expect(t.text('#disk-status'), 'a new refresh waits again').toMatch(/Refresh requested/);
    expect(refresh().attributes('disabled'), 'and the button is busy again').toBeDefined();
  });
});

describe('scope and refusals (diskReadScope, diskRefreshForbidden, diskRefreshRevoked)', () => {
  it('a read token sees Refresh locked and explained, the data still shown, and nothing is sent', async () => {
    t = await openNode('/machines/homelab-nuc', { scope: 'read' });
    expect(t.exists('#disk-panel .dvol'), 'the data is still shown').toBe(true);
    const btn = t.find('#disk-panel .is-locked[data-need=operate]');
    expect(btn.exists()).toBe(true);
    expect(btn.attributes('aria-disabled')).toBe('true');
    expect(btn.attributes('data-tip'), 'a tooltip that names the scope').toMatch(/operate scope/);
    expect(btn.text()).toBe('Refresh');
    expect(t.exists('#disk-panel [data-act=disk-refresh]'), 'there is no live Refresh button').toBe(false);
    expect(t.text('#disk-panel .lock-note'), 'a visible note explains why').toMatch(/operate scope/);
    await btn.trigger('click');
    expect(t.toasts()).toMatch(/Needs the operate scope/);
    expect(t.posts(/disk-usage/)).toHaveLength(0);
  });

  it('403 insufficient_scope is explained inline, the button is usable again, and nothing polls', async () => {
    t = await openNode('/machines/studio-mini', { forbid: true });
    await refresh().trigger('click');
    await t.until(() => t!.exists('.disk-status--warning'), 'the 403 message');
    expect(t.text('#disk-status')).toMatch(/scope does not allow/);
    expect(refresh().attributes('disabled')).toBeUndefined();
    expect(t.exists('.toast'), 'inline, no toast').toBe(false);
    await advance(15_000);
    expect(t.gets(/^nodes\/[^/]+$/).length, 'no polling after a refused request').toBe(1);
  });

  it('409 node_revoked (revoked meanwhile) is explained inline and nothing polls', async () => {
    t = await openNode('/machines/studio-mini');
    const node = t.app.mock.nodes.find(n => n.alias === 'studio-mini')!;
    await t.app.ctx.api.post(`nodes/${node.id}/revoke`, {});
    await refresh().trigger('click');
    await t.until(() => t!.exists('.disk-status--critical'), 'the 409 message');
    expect(t.text('#disk-status')).toBe('This machine has been revoked, so it cannot answer a disk refresh.');
    expect(refresh().attributes('disabled')).toBeUndefined();
    await advance(15_000);
    expect(t.gets(/^nodes\/[^/]+$/).length, 'no polling after a refused request').toBe(1);
  });

  it('a server error answers inline and with a toast', async () => {
    t = await openNode('/machines/studio-mini');
    const real = t.app.ctx.api.post.bind(t.app.ctx.api);
    vi.spyOn(t.app.ctx.api, 'post').mockImplementation(((path: string, ...rest: unknown[]) => /disk-usage/.test(path)
      ? Promise.reject(Object.assign(new Error('The Server had a problem (500). Try again in a moment.'), { status: 500, code: 'mock_error' }))
      : (real as (...a: unknown[]) => Promise<unknown>)(path, ...rest)) as typeof t.app.ctx.api.post);
    await refresh().trigger('click');
    await t.until(() => t!.exists('.disk-status--critical'));
    expect(t.text('#disk-status')).toBe('The Server had a problem (500). Try again in a moment.');
    expect(t.toasts()).toContain('Disk refresh was not requested');
  });
});

describe('diskXss: a hostile volume label', () => {
  it('shows as text in the volume title, with no injected element', async () => {
    let alerts = 0;
    vi.stubGlobal('alert', () => { alerts++; });
    t = await openNode('/machines/homelab-nuc', { xss: true });
    expect(t.text()).toContain('<img src=x onerror=alert(1)>');
    expect([...t.findAll('#disk-panel .dvol-name b')].some(b => b.text().includes('<img src=x onerror=alert(1)>')), 'in the volume title').toBe(true);
    expect(t.findAll('#root img, #root script, #root [onerror], #root [onclick], #root [onload]')).toHaveLength(0);
    await t.go('/machines/homelab-nuc/problems');
    expect(t.findAll('#root img, #root script, #root [onerror]')).toHaveLength(0);
    await advance(300);
    expect(alerts).toBe(0);
  });
});

describe('an acknowledgement applies to one occurrence only (issueSince, machine part)', () => {
  it('a new measurement reopens an acknowledged disk problem, a snooze keeps applying', async () => {
    t = await openNode('/machines/homelab-nuc/problems', { diskDelay: 1000 });
    const chip = (l: string) => Number(t!.findAll('.chips-filter button').find(b => b.text().startsWith(l))!.find('span').text());
    const card = () => t!.findAll('article.prob').find(p => /disk/i.test(p.find('h3').text()));
    await card()!.find('[data-op=acknowledge]').trigger('click');
    await t.until(() => chip('Acknowledged') === 1, 'acknowledged');
    const id = [...t.app.mock.issueStates.keys()][0]!;
    const since0 = t.app.mock.issueStates.get(id)!.since;
    await t.go('/machines/homelab-nuc');
    await refresh().trigger('click');
    await advance(12_000);
    expect(t.text('#disk-status')).toMatch(/Disk usage updated/);
    const now = (await t.app.ctx.api.get<IssuesResponse>('issues')).items.find(i => i.id === id)!;
    expect(now.since !== since0 && now.state === 'open' && now.stateBy === null && now.stateAt === null && now.snoozedUntil === null, 'a new measurement is a new occurrence: since changed, the acknowledgement no longer applies').toBe(true);
    await t.go('/machines/homelab-nuc/problems');
    expect(chip('Acknowledged')).toBe(0);
    expect(chip('Open')).toBe(1);
    expect(card(), 'the problem is back under Open').toBeDefined();
    await card()!.find('[data-op=snooze][data-hours="24"]').trigger('click');
    await t.until(() => chip('Snoozed') === 1, 'snoozed');
    t.app.mock.nodes.find(n => n.alias === 'homelab-nuc')!._disk!.measuredAt = new Date().toISOString();
    const after = (await t.app.ctx.api.get<IssuesResponse>('issues')).items.find(i => i.id === id)!;
    expect(after.state === 'snoozed' && after.stateBy === 'joan', 'a snooze applies until its time passes, whatever since does').toBe(true);
  });
});
