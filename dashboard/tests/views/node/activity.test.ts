/**
 * The Activity tab: attempts, audit events, drift repairs and the enrollment merged newest first, filters, paging, and errors.
 * Ports of the Dev/drive.js scenarios detailActivity, driftActivity, driftOld, driftNone, p4Xss (the drift part), detailNone/detailXss
 * (Activity), and the activity/audit paging of the machine page.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAKE_TIMERS, openNode, type NodeTest } from './helpers';

let t: NodeTest | undefined;
afterEach(() => { t?.unmount(); t = undefined; vi.useRealTimers(); });

const items = () => t!.findAll('.tl-item');
const titles = () => items().map(i => i.find('.tl-top b').text());
const filterBtn = (label: string) => t!.findAll('.chips-filter[aria-label="Filter activity"] button').find(b => b.text().startsWith(label))!;
const filterCount = (label: string) => Number(filterBtn(label).find('span').text());
const ready = async () => { await t!.until(() => t!.exists('.tl-item'), 'activity'); };
/** More audit events for a machine, so that its audit log has several pages. */
function addAudit(alias: string, count: number): void {
  const node = t!.app.mock.nodes.find(n => n.alias === alias)!;
  for (let i = 0; i < count; i++) t!.app.mock.audit.push({ recordedAt: new Date(Date.now() - (i + 1) * 3600e3).toISOString(), action: 'assignment.retry_requested', actor: 'joan', subject: alias, nodeId: node.id, credentialId: null });
}
/** Opens Activity of a machine whose audit log was filled before the page read it. */
async function openPaged(alias: string, mock: Record<string, unknown> = {}): Promise<void> {
  t = await openNode(`/machines/${alias}`, { pageSize: 2, ...mock });
  addAudit(alias, 4);
  await t.go(`/machines/${alias}/activity`);
  await ready();
}

describe('the timeline (detailActivity)', () => {
  it('shows attempts with their step and an expandable one-line diagnostic', async () => {
    t = await openNode('/machines/studio-mini/activity');
    await ready();
    const item = items().find(i => i.find('.stepchip').exists())!;
    expect(item.find('.stepchip').text(), 'the attempt row shows its step').toMatch(/Configuring/);
    const line = item.find('details.diag-line');
    expect(line.exists() && !(line.element as HTMLDetailsElement).open, 'the diagnostic is one line that can expand').toBe(true);
    expect(line.find('.diag-text').exists()).toBe(true);
    expect(line.find('summary svg.sumchev').exists()).toBe(true);
    (line.element as HTMLDetailsElement).open = true;
    await line.trigger('toggle');
    expect(t.app.ctx.openState.get(line.attributes('data-open-key')!), 'expanding is remembered').toBe(true);
    expect(t.exists('.tl-item .fdetail-none'), 'no "No detail reported" line in Activity').toBe(false);
    expect(item.find('time').attributes('datetime')).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(item.find('.tl-top b').text()).toMatch(/connection failed$/);
    expect(item.find('.tl-sub').text()).toMatch(/^[0-9a-f]{7} · .* · [a-z_]+\s*Step/);
  });

  it('groups by UTC day (Today, Yesterday, a weekday) and puts the newest first', async () => {
    t = await openNode('/machines/studio-mini/activity');
    await ready();
    const days = t.findAll('.tl-day h3').map(h => h.text());
    expect(days[0]).toBe('Today');
    expect(days.length).toBeGreaterThan(1);
    const times = items().map(i => Date.parse(i.find('time').attributes('datetime')!));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('has a loading state before the first page arrives, and shows a skeleton, not "Nothing to show here"', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    t = await openNode('/machines/studio-mini');
    t.app.mock.options.slow = 400;
    await t.app.router.push('/machines/studio-mini/activity');
    await vi.advanceTimersByTimeAsync(50);
    await t.app.settle();
    expect(t.exists('#tabpanel .skel')).toBe(true);
    expect(t.text('#tabpanel')).not.toContain('Nothing to show here');
    await vi.advanceTimersByTimeAsync(1500);
    await t.app.settle();
    expect(t.exists('#tabpanel .skel')).toBe(false);
    expect(items().length).toBeGreaterThan(0);
  });

  it('a Target is named by its label, and the enrollment is the oldest entry when nothing older is left', async () => {
    t = await openNode('/machines/studio-mini/activity');
    await ready();
    expect(titles().some(x => /^Claude Code connection /.test(x))).toBe(true);
    expect(titles().at(-1)).toBe('Enrolled as studio-mini');
    expect(items().at(-1)!.find('.tl-sub').text()).toBe('macOS machine');
    expect(t.text('#tabpanel .panel-head p')).toBe('Attempts, repaired local changes and changes for studio-mini, newest first. Times in UTC.');
  });

  it('with no phase 2 detail anywhere there is no chip and no diagnostic line (detailNone)', async () => {
    t = await openNode('/machines/studio-mini/activity', { diag: false });
    await ready();
    expect(t.exists('.stepchip') || t.exists('.diag-line')).toBe(false);
  });

  it('hostile diagnostics, files and Operator names are text (detailXss, p4Xss)', async () => {
    let alerts = 0;
    vi.stubGlobal('alert', () => { alerts++; });
    t = await openNode('/machines/studio-mini/activity', { xss: true });
    await ready();
    t.findAll('details.diag-line').forEach(d => { (d.element as HTMLDetailsElement).open = true; });
    await t.app.settle();
    const bad = () => t!.findAll('#root img, #root script, #root [onerror], #root [onclick], #root [onload]').length;
    expect(t.text()).toContain('<img src=x onerror=alert(1)>');
    expect(bad()).toBe(0);
    await t.go('/machines/homelab-nuc/activity');
    await t.until(() => t!.exists('.tl-files'));
    t.findAll('.tl-files').forEach(d => { (d.element as HTMLDetailsElement).open = true; });
    await t.app.settle();
    expect(t.text(), 'a hostile drift path is text').toContain('"><script>alert(12)</script>/<img src=x onerror=alert(13)>.md');
    expect(bad()).toBe(0);
    expect(alerts).toBe(0);
  });
});

describe('local changes repaired by the Agent (driftActivity, driftOld, driftNone)', () => {
  it('both drift events are in the timeline, newest first, merged by time, with a collapsed file list', async () => {
    t = await openNode('/machines/homelab-nuc/activity');
    await ready();
    const drift = items().filter(i => /Repaired local changes/.test(i.text()));
    expect(drift, 'both drift events are in the timeline').toHaveLength(2);
    expect(drift.map(i => i.find('.tl-top b').text()), 'titles name the Target and the file count, newest first').toEqual([
      'Repaired local changes in skills: 1 file', 'Repaired local changes in skills: 2 files',
    ]);
    expect(drift[0]!.find('.tl-sub').text()).toBe('Files changed outside Fleet were restored from the verified cache');
    const all = items();
    const pos = (x: typeof all[number]) => all.findIndex(a => a.element === x.element);
    const attempt = all.find(i => /applied/.test(i.find('.tl-top b').text()))!;
    const cert = all.find(i => /Certificate renewed/.test(i.text()))!;
    expect(pos(drift[0]!) > pos(attempt) && pos(drift[0]!) < pos(cert), 'merged by time with attempts and audit events').toBe(true);
    const two = drift[1]!.find('details.tl-files');
    expect(two.exists() && !(two.element as HTMLDetailsElement).open && /2 files/.test(two.text()), 'the file list starts collapsed').toBe(true);
    (two.element as HTMLDetailsElement).open = true;
    await two.trigger('toggle');
    expect(two.findAll('li code').map(c => c.text()).join(), 'it expands to the file paths').toBe('.agents/skills/incident-runbook/SKILL.md,.agents/skills/homelab-ops/compose.md');
    expect(drift[0]!.find('time').attributes('datetime')).toBeTruthy();
  });

  it('has a filter for local changes with a count, which keeps only drift, and an expanded list stays open across repaints', async () => {
    t = await openNode('/machines/homelab-nuc/activity');
    await ready();
    const two = () => t!.findAll('details.tl-files')[1]!;
    (two().element as HTMLDetailsElement).open = true;
    await two().trigger('toggle');
    expect(filterCount('Local changes'), 'a filter for local changes, with a count').toBe(2);
    expect(filterBtn('Everything').attributes('aria-pressed')).toBe('true');
    await filterBtn('Local changes').trigger('click');
    expect(filterBtn('Local changes').attributes('aria-pressed')).toBe('true');
    expect(items().length === 2 && items().every(i => /Repaired local changes/.test(i.text())), 'filtering keeps only drift').toBe(true);
    expect((two().element as HTMLDetailsElement).open, 'an expanded list stays open across repaints').toBe(true);
    await filterBtn('Everything').trigger('click');
    expect(items().length).toBeGreaterThan(2);
  });

  it('Overview mentions drift from the last 24 hours only; a machine without drift has no such check', async () => {
    t = await openNode('/machines/homelab-nuc');
    const check = t.findAll('.hchecks li').find(l => /Local changes were repaired/.test(l.text()))!;
    expect(check.text(), 'the 30 h old one is left out').toMatch(/Once in the last 24 hours/);
    expect(check.text()).toMatch(/skills, 1 file/);
    expect(check.find('svg.g').exists(), 'as an info check with an icon').toBe(true);
    await t.go('/machines/mbp-joan');
    await t.ready('mbp-joan');
    expect(t.text('.hchecks')).not.toMatch(/Local changes were repaired/);
    await t.go('/machines/mbp-joan/activity');
    await ready();
    expect(filterCount('Local changes')).toBe(0);
    expect(t.text('#tabpanel')).not.toMatch(/Repaired local changes/);
  });

  it('driftOld: an event older than a day leaves Overview and stays in Activity', async () => {
    t = await openNode('/machines/studio-mini');
    expect(t.findAll('.hchecks li').find(l => /Local changes were repaired/.test(l.text()))?.text(), 'a drift event from 6 h ago is on Overview').toMatch(/Once/);
    const node = t.app.mock.nodes.find(n => n.alias === 'studio-mini')!;
    node._drift[0]!.detectedAt = new Date(Date.now() - 30 * 3600e3).toISOString();
    await t.go('/machines/design-imac');
    await t.go('/machines/studio-mini');
    await t.ready('studio-mini');
    expect(t.findAll('.hchecks li').some(l => /Local changes were repaired/.test(l.text())), 'at 30 h it is gone from Overview').toBe(false);
    await t.go('/machines/studio-mini/activity');
    await ready();
    expect(items().some(i => /Repaired local changes in skills: 1 file/.test(i.text())), 'but it is still in Activity').toBe(true);
  });

  it('driftNone: a Server before phase 4 sends no drift property and the page shows none', async () => {
    t = await openNode('/machines/homelab-nuc/activity', { drift: false });
    await ready();
    expect(t.text('#tabpanel')).not.toMatch(/Repaired local changes/);
    expect(filterCount('Local changes')).toBe(0);
    await t.go('/machines/homelab-nuc');
    expect(t.text('.hchecks')).not.toMatch(/Local changes/);
  });
});

describe('filters', () => {
  it('Attempts, Changes and Certificates split the events and show their counts; an empty filter says nothing is there', async () => {
    t = await openNode('/machines/homelab-nuc/activity');
    await ready();
    const total = items().length;
    const counts = ['Attempts', 'Local changes', 'Changes', 'Certificates'].map(filterCount);
    expect(filterCount('Everything')).toBe(total);
    expect(counts.reduce((a, b) => a + b, 0), 'every event is in exactly one category').toBe(total);
    await filterBtn('Certificates').trigger('click');
    expect(items().every(i => /Certificate|credential/i.test(i.text()))).toBe(true);
    expect(items()).toHaveLength(filterCount('Certificates'));
    await t.go('/machines/mbp-joan/activity');
    await ready();
    await filterBtn('Local changes').trigger('click');
    expect(t.text('#tabpanel .empty-mini')).toBe('Nothing to show here.');
    expect(filterBtn('Local changes').attributes('aria-pressed')).toBe('true');
  });

  it('the filter has a labelled group, and the choice survives a tab change', async () => {
    t = await openNode('/machines/homelab-nuc/activity');
    await ready();
    expect(t.find('.chips-filter').attributes('role')).toBe('group');
    expect(t.find('.chips-filter').attributes('aria-label')).toBe('Filter activity');
    await filterBtn('Attempts').trigger('click');
    await t.go('/machines/homelab-nuc/security');
    await t.go('/machines/homelab-nuc/activity');
    await ready();
    expect(filterBtn('Attempts').attributes('aria-pressed')).toBe('true');
  });
});

describe('paging (pagesize)', () => {
  it('loads a page of attempts and of audit events and offers "Load older activity" until both are exhausted', async () => {
    await openPaged('studio-mini');
    const first = items().length;
    const attemptCalls = () => t!.gets(/\/attempts$/);
    expect(attemptCalls()[0]!.query.limit, 'a page of 25 is asked for').toBe('25');
    expect(t!.gets(/^audit$/)[0]!.query).toMatchObject({ order: 'newest', limit: '25' });
    expect(t!.gets(/^audit$/)[0]!.query.node).toMatch(/^[0-9a-f-]{36}$/);
    const more = () => t!.find('.load-more button');
    expect(more().exists()).toBe(true);
    expect(more().text()).toBe('Load older activity');
    expect(titles(), 'while older audit events exist the enrollment is not claimed').not.toContain('Enrolled as studio-mini');
    await more().trigger('click');
    await t!.app.settle();
    expect(items().length).toBeGreaterThan(first);
    const second = attemptCalls().at(-1)!;
    expect(second.query.after, 'the cursor of the first page').toBeTruthy();
    expect(t!.gets(/^audit$/).at(-1)!.query.after).toBeTruthy();
    for (let i = 0; i < 12 && t!.exists('.load-more'); i++) { await more().trigger('click'); await t!.app.settle(); }
    expect(t!.exists('.load-more'), 'exhausted').toBe(false);
    expect(titles().at(-1), 'once nothing older is left the enrollment closes the list').toBe('Enrolled as studio-mini');
    expect(items().filter(i => /Requested a retry/.test(i.text())).length).toBeGreaterThanOrEqual(4);
  });

  it('the button is disabled while older activity loads, and a second click sends nothing more', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    await openPaged('studio-mini');
    t!.app.mock.options.slow = 500;
    const more = () => t!.find('.load-more button');
    const before = t!.gets(/\/attempts$/).length;
    await more().trigger('click');
    await t!.app.settle();
    expect(more().attributes('disabled')).toBeDefined();
    await more().trigger('click');
    await vi.advanceTimersByTimeAsync(1000);
    await t!.app.settle();
    expect(t!.gets(/\/attempts$/).length).toBe(before + 1);
    expect(more().attributes('disabled')).toBeUndefined();
  });

  it('a failure while loading older activity is reported and keeps what arrived', async () => {
    await openPaged('studio-mini');
    const before = items().length;
    t!.app.mock.options.fail = 'audit';
    await t!.click('.load-more button');
    await t!.until(() => /Could not load older activity/.test(t!.toasts()), 'toast');
    expect(items().length, 'the attempts page still arrived').toBeGreaterThan(before);
    expect(t!.exists('.load-more button')).toBe(true);
  });

  it('older activity that arrives after the user left changes nothing', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    await openPaged('studio-mini');
    t!.app.mock.options.slow = 800;
    await t!.click('.load-more button');
    await t!.app.router.push('/machines/design-imac/activity');
    await vi.advanceTimersByTimeAsync(3000);
    await t!.app.settle();
    expect(t!.find('.nhero h1').text()).toBe('design-imac');
    expect(t!.exists('.toast')).toBe(false);
  });

  it('a reload of the first page while older activity loads drops the older page instead of appending it', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    await openPaged('studio-mini');
    const first = items().length;
    t!.app.mock.options.slow = 800;
    await t!.click('.load-more button');
    await t!.go('/machines/studio-mini/security');
    await t!.go('/machines/studio-mini/activity');
    await vi.advanceTimersByTimeAsync(3000);
    await t!.app.settle();
    expect(items().length, 'the first page only').toBe(first);
  });
});

describe('errors', () => {
  it('a failing attempts read and a failing audit read are reported where they happen, and the rest still shows', async () => {
    t = await openNode('/machines/studio-mini');
    t.app.mock.options.fail = 'audit';
    await t.go('/machines/studio-mini/activity');
    await ready();
    expect(t.text('#tabpanel [role=alert]')).toContain('Could not load the audit log');
    expect(t.text('#tabpanel [role=alert]')).toContain('The Server had a problem (500). Try again in a moment.');
    expect(items().length, 'attempts still show').toBeGreaterThan(0);
    t.app.mock.options.fail = 'nodes/';
    await t.go('/machines/studio-mini/security');
    await t.go('/machines/studio-mini/activity');
    await t.until(() => t!.text('#tabpanel [role=alert] b') === 'Could not load attempts', 'attempts error');
    expect(t.text('#tabpanel [role=alert]')).toContain('The Server had a problem (500). Try again in a moment.');
    expect(titles(), 'the audit events and the enrollment still show').toContain('Enrolled as studio-mini');
    t.app.mock.options.fail = null;
    await t.go('/machines/studio-mini/security');
    await t.go('/machines/studio-mini/activity');
    await ready();
    expect(t.exists('#tabpanel [role=alert]'), 'the error goes away with the next successful read').toBe(false);
  });

  it('a revoked machine shows its revocation in the timeline', async () => {
    t = await openNode('/machines/old-laptop/activity');
    await ready();
    expect(titles().some(x => /Revoked a machine|Revoked a credential/.test(x))).toBe(true);
  });
});
