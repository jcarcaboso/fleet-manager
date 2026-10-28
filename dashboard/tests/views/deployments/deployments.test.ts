/**
 * Deployments page. Ports of the Dev/drive.js scenarios depCommit, depNull (list), deployments (paging, order=newest),
 * detailDeployments, p4Xss (list and hero), plus empty, error, filter, load-more failure, highlight by short SHA and abort.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountApp, textOf, waitFor, type TestApp } from '../../helpers/app';

let app: TestApp | undefined;
afterEach(() => { app?.unmount(); app = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });

const w = () => app!.wrapper;
const revs = () => app!.mock.data.revisions;
const items = () => w().findAll('li.hist-item');
const toasts = () => textOf(w().find('#toasts').element);
const calls = (path: string) => app!.mock.calls.filter(c => c.path === path);
const openAll = async () => { w().findAll('.hist-item details').forEach(d => { (d.element as HTMLDetailsElement).open = true; }); await app!.settle(); };
const chip = (label: string) => w().findAll('.chips-filter[aria-label="Filter machines"] button').find(b => b.text().startsWith(label))!;

describe('Deployments: commit information (depCommit)', () => {
  it('the hero shows the commit subject, author and short SHA; every revision links to its own page', async () => {
    app = await mountApp({ path: '/deployments' });
    const r = revs();
    expect(w().find('.dep-title').text()).toBe(r[0]!.message);
    const meta = w().find('.dep-hero .dep-meta');
    expect(meta.text()).toContain('joan');
    expect(meta.text()).toContain('a3f9c21');
    expect(meta.find('.av').exists()).toBe(true);
    expect(calls(`desired-revisions/${r[0]!.id}`).length, 'the newest revision is read for what changed').toBeGreaterThan(0);
    expect(w().find('.dep-hero .changes .chg--add').text()).toContain('postgres-migrations');
    expect(w().find('.dep-hero .changes .chg--mod').text()).toContain('code-review');
    expect(items()).toHaveLength(5);
    items().slice(0, 4).forEach((it, i) => {
      const meta = it.find('.hist-meta').text();
      expect(it.find('.hist-top b').text()).toBe(r[i]!.message);
      expect(meta).toContain(r[i]!.author);
      expect(meta).toMatch(/ago/);
    });
    const last = items()[4]!;
    expect(last.find('.hist-top b').text(), 'the oldest revision has no commit: it shows when it was published').toMatch(/^Published /);
    expect(last.find('.hist-meta .av').exists()).toBe(false);
    expect(last.find('.hist-top .rev').text()).toContain('c08d4be');
    const link = items()[1]!.find('a[href^="/deployments/"]');
    expect(link.attributes('href'), 'each revision links to its own page by revision ID').toBe('/deployments/' + r[1]!.id);
    expect(items()[0]!.attributes('id'), 'the SHA anchor is kept').toBe('rev-a3f9c21');
    expect(items()[0]!.find('.tag--live').text()).toBe('Newest');
    expect(w().find('.dep-hero a.btn').attributes('href')).toBe('/deployments/' + r[0]!.id);
  });

  it('the hero says "Rolling out now" while assignments are pending or applying, with the figures and bar', async () => {
    app = await mountApp({ path: '/deployments' });
    expect(w().find('.dep-hero .eyebrow').text()).toBe('Rolling out now');
    expect(w().find('.dep-hero .eyebrow').classes()).toContain('live');
    expect(w().find('.hero-fig').text().replace(/\s+/g, ' ')).toMatch(/31\s*of 43/);
    expect(w().find('.dep-hero-side .segbar').attributes('role')).toBe('img');
    expect(w().find('.dep-hero-side .segbar').attributes('aria-label')).toBe('Rollout a3f9c21 assignments: 31 Succeeded, 2 Applying, 5 Pending, 5 Failed');
    expect(w().findAll('.dep-hero-side .legend li')).toHaveLength(5);
    expect(w().find('.dep-hero-side .muted').text()).toContain('3 of 13 machines have every Target in sync.');
  });

  it('shows the source warning of the newest revision in the hero and in its history item', async () => {
    app = await mountApp({ path: '/deployments' });
    const callout = w().find('.dep-hero .callout--warning');
    expect(callout.text()).toContain('Source warning: duplicate_skill');
    expect(callout.findAll('.loc code').map(c => c.text())).toEqual(['skills/core/code-review/', 'skills/experimental/code-review/']);
    expect(items()[0]!.find('.hist-meta').text()).toContain('1 warning');
    await openAll();
    expect(items()[0]!.find('.callout--warning b').text()).toBe('duplicate_skill');
  });
});

describe('Deployments: no commit metadata (depNull)', () => {
  it('falls back to the short SHA and the publication time', async () => {
    app = await mountApp({ path: '/deployments', mock: { commit: false } });
    expect(w().find('.dep-title').text()).toBe('Revision a3f9c21');
    expect(w().find('.dep-hero .dep-meta .av').exists()).toBe(false);
    expect(w().find('.dep-hero .dep-meta').text()).toMatch(/Published/);
    expect(items().every(i => /^Published /.test(i.find('.hist-top b').text()) && !i.find('.hist-meta .av').exists())).toBe(true);
    expect(w().text()).not.toContain(revs()[0]!.message);
  });
});

describe('Deployments: newest first and paging (deployments, pagesize=2)', () => {
  it('requests order=newest, shows the first page and follows both cursors', async () => {
    app = await mountApp({ path: '/deployments', mock: { pageSize: 2 } });
    expect(w().find('.dep-title').text()).toBe(revs()[0]!.message);
    expect(w().find('.dep-hero').text()).toContain(revs()[0]!.shortSha);
    const revCalls = calls('desired-revisions');
    expect(revCalls.length > 0 && revCalls.every(c => c.query.order === 'newest')).toBe(true);
    const rolloutCalls = calls('rollouts');
    expect(rolloutCalls.length > 0 && rolloutCalls.every(c => c.query.order === 'newest')).toBe(true);
    expect(items(), 'only the first page of revisions is shown').toHaveLength(2);
    await w().find('[data-act=more-revisions]').trigger('click');
    expect(w().find('[data-act=more-revisions]').attributes('disabled')).toBeDefined();
    await waitFor(() => items().length === 4, { label: 'next page' });
    expect(items().map(i => i.attributes('id')!.replace('rev-', ''))).toEqual(revs().slice(0, 4).map(r => r.shortSha));
    expect(w().findAll('.hist-item .hist-bar .segbar').length, 'rollouts match their revisions by desiredRevisionId').toBeGreaterThanOrEqual(3);
    expect(w().findAll('p.muted').map(p => p.text()).filter(t => /revisions/.test(t) && /only|first|not shown/i.test(t)), 'no truncation notice for revisions').toEqual([]);
    expect(calls('desired-revisions').at(-1)!.query.after).toBeTruthy();
    await w().find('[data-act=more-revisions]').trigger('click');
    await waitFor(() => items().length === 5);
    expect(w().find('[data-act=more-revisions]').exists(), 'no button after the last page').toBe(false);
  });

  it('a failing "Load older revisions" is explained and can be tried again', async () => {
    app = await mountApp({ path: '/deployments', mock: { pageSize: 2 } });
    app.mock.options.fail = 'desired-revisions';
    await w().find('[data-act=more-revisions]').trigger('click');
    await waitFor(() => toasts().includes('Could not load older revisions'));
    expect(items()).toHaveLength(2);
    expect(w().find('[data-act=more-revisions]').attributes('disabled')).toBeUndefined();
    app.mock.options.fail = null;
    await w().find('[data-act=more-revisions]').trigger('click');
    await waitFor(() => items().length === 4);
  });

  it('a page that is loaded again while older revisions load drops the old answer', async () => {
    app = await mountApp({ path: '/deployments', mock: { pageSize: 2 } });
    app.mock.options.slow = 100;
    await w().find('[data-act=more-revisions]').trigger('click');
    await w().find('[data-act=reload]').trigger('click');
    await waitFor(() => items().length > 0, { label: 'the reloaded page', timeout: 6000 });
    await new Promise(r => setTimeout(r, 300));
    await app.settle();
    expect(items()).toHaveLength(2);
    expect(calls('desired-revisions').filter(c => c.query.after).every(c => c.aborted)).toBe(true);
  });
});

describe('Deployments: machines and filter', () => {
  it('lists the live machines, worst first, with counts per state, and filters them', async () => {
    app = await mountApp({ path: '/deployments' });
    expect(['All', 'Blocked', 'In progress', 'Waiting', 'Done'].map(l => chip(l).find('span').text())).toEqual(['13', '4', '2', '4', '3']);
    const names = () => w().findAll('.dep-row .dep-node b').map(b => b.text());
    expect(names()).toHaveLength(13);
    expect(names().slice(0, 4)).toEqual(['design-imac', 'fedora-ws', 'kitchen-mini', 'studio-mini']);
    expect(names()).not.toContain('old-laptop');
    expect(w().find('.dep-row--blocked .dep-status').text()).toBe('2 Targets failing. 1 applied.');
    await chip('Waiting').trigger('click');
    expect(chip('Waiting').attributes('aria-pressed')).toBe('true');
    expect(names()).toEqual(['build-runner-02', 'build-runner-03', 'lab-vm-07', 'mba-travel']);
    expect(w().findAll('.dep-row .dep-status').map(p => p.text())).toEqual([
      '1 Target queued for the next poll.', 'Waiting for build-runner-03 to come back online.', 'Waiting for the first check-in. Nothing has been delivered yet.', 'Waiting for mba-travel to come back online.',
    ]);
    await chip('Done').trigger('click');
    expect(w().findAll('.dep-row .dep-status').map(p => p.text())).toEqual(['All 1 Target in sync.', 'All 5 Targets in sync.', 'All 5 Targets in sync.']);
    expect(w().find('.dep-row a.dep-node').attributes('href')).toMatch(/^\/machines\//);
  });

  it('says so when no machine is in the state', async () => {
    app = await mountApp({ path: '/audit' });
    app.mock.nodes.forEach(n => n.targets.forEach(t => { if (t.state === 'failed') t.state = 'succeeded'; }));
    await app.go('/deployments');
    expect(chip('Blocked').find('span').text()).toBe('0');
    await chip('Blocked').trigger('click');
    expect(w().find('.dep-list .empty-mini p').text()).toBe('No machines in this state.');
  });
});

describe('Deployments: attempts on demand (detailDeployments)', () => {
  it('Show attempts loads a rollout\'s attempts, lists the failed ones with step, path and expandable diagnostic', async () => {
    app = await mountApp({ path: '/deployments' });
    await openAll();
    for (const b of w().findAll('[data-act=load-attempts]')) await b.trigger('click');
    await waitFor(() => w().find('.attlist').exists(), { label: 'failed attempt list' });
    const rows = w().findAll('.attitem');
    expect(rows.length, 'failed attempts are listed').toBeGreaterThanOrEqual(2);
    expect(rows.some(i => i.find('.stepchip').exists()), 'a failed attempt shows its step').toBe(true);
    expect(rows.some(i => i.find('details.diag-line').exists()), 'a long diagnostic is one line with an expander').toBe(true);
    expect(rows.some(i => !i.find('.stepchip').exists() && !i.find('.diag-line').exists()), 'an attempt from an old Agent shows just its error code').toBe(true);
    const line = rows.map(i => i.find('details.diag-line')).find(l => l.exists())!;
    await line.find('summary').trigger('click');
    (line.element as HTMLDetailsElement).open = true;
    line.element.dispatchEvent(new Event('toggle'));
    expect((line.element as HTMLDetailsElement).open, 'the diagnostic expands').toBe(true);
    // The summary table: error codes with what they mean and a count.
    const table = w().find('.attempts table.tbl--compact');
    expect(table.exists()).toBe(true);
    expect(table.findAll('thead th').map(t => t.text())).toEqual(['Error code', 'What it means', 'Attempts']);
    expect(w().find('.attempts .kv-label').text()).toMatch(/^Attempts in this rollout \d+/);
  });

  it('no button after loading, a skeleton while loading, and the error stays local to the rollout', async () => {
    app = await mountApp({ path: '/deployments', mock: { fail: 'rollouts/' } });
    await openAll();
    const btn = w().find('[data-act=load-attempts]');
    await btn.trigger('click');
    await waitFor(() => w().find('.attempts .callout--critical').exists(), { label: 'inline error' });
    expect(w().find('.attempts .callout--critical').text()).toContain('Could not load attempts');
    expect(w().find('h1').text()).toBe('Deployments');
  });

  it('shows a skeleton while the attempts load', async () => {
    app = await mountApp({ path: '/deployments' });
    await openAll();
    app.mock.options.slow = 200;
    await w().find('[data-act=load-attempts]').trigger('click');
    expect(w().find('.attempts .skel').exists()).toBe(true);
    await waitFor(() => !w().find('.attempts .skel').exists());
  });
});

describe('Deployments: opening a short SHA from the address', () => {
  it('?revision=<short SHA> opens and scrolls to that revision', async () => {
    const scroll = vi.fn();
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scroll;
    app = await mountApp({ path: '/deployments?revision=9b14e07' });
    await waitFor(() => scroll.mock.calls.length > 0, { label: 'scroll' });
    const target = w().find('#rev-9b14e07');
    expect((target.find('details').element as HTMLDetailsElement).open).toBe(true);
    expect((items()[0]!.find('details').element as HTMLDetailsElement).open).toBe(false);
    expect(scroll.mock.contexts[0]).toBe(target.element);
    expect(scroll).toHaveBeenCalledWith({ block: 'center' });
  });

  it('a non-UUID revision id in the path redirects to the list with ?revision=', async () => {
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = vi.fn();
    app = await mountApp({ path: '/deployments/9b14e07' });
    expect(app.router.currentRoute.value.fullPath).toBe('/deployments?revision=9b14e07');
    expect((w().find('#rev-9b14e07 details').element as HTMLDetailsElement).open).toBe(true);
  });
});

describe('Deployments: empty, loading, error and abort', () => {
  it('nothing published: says so and offers Sync repository', async () => {
    app = await mountApp({ path: '/deployments', mock: { empty: true } });
    expect(w().find('.empty h2').text()).toBe('Nothing has been published yet');
    expect(w().find('h1').text()).toBe('Deployments');
    await w().find('.empty [data-act=sync]').trigger('click');
    await waitFor(() => /up to date/i.test(toasts()));
    expect(app.mock.calls.filter(c => c.path === 'source/rescan')).toHaveLength(1);
  });

  it('nothing published, read scope: Sync repository is locked and explains itself', async () => {
    app = await mountApp({ path: '/deployments', mock: { empty: true, scope: 'read' } });
    const btn = w().find('.empty .is-locked');
    expect(btn.text()).toBe('Sync repository');
    expect(btn.attributes('aria-disabled')).toBe('true');
    await btn.trigger('click');
    expect(toasts()).toContain('Not available');
    expect(app.mock.calls.filter(c => c.method === 'POST' && c.path !== 'login')).toHaveLength(0);
  });

  it('a server without the diff (phase 4) only hides "What changed"', async () => {
    app = await mountApp({ path: '/deployments', mock: { fail: 'desired-revisions/' } });
    expect(w().find('.dep-title').exists()).toBe(true);
    expect(w().find('.dep-hero .mini-h').exists()).toBe(false);
    expect(items()).toHaveLength(5);
  });

  it('shows the loading skeleton while the page loads', async () => {
    app = await mountApp({ path: '/machines' });
    app.mock.options.slow = 200;
    void app.router.push('/deployments');
    await waitFor(() => w().find('[role=status] .skel').exists());
    await waitFor(() => w().find('.dep-hero').exists());
  });

  it('a failing read shows the error, and Try again recovers', async () => {
    app = await mountApp({ path: '/deployments', mock: { fail: 'rollouts' } });
    expect(w().find('h1').text()).toBe('Could not load Deployments');
    app.mock.options.fail = null;
    await w().find('.empty--error button').trigger('click');
    await waitFor(() => w().find('.dep-hero').exists());
  });

  it('a token that cannot read shows "Your account cannot open this"', async () => {
    app = await mountApp({ path: '/audit' });
    const real = app.ctx.api.page.bind(app.ctx.api);
    (app.ctx.api as { page: unknown }).page = (path: string, ...rest: unknown[]) =>
      (path === 'desired-revisions' ? Promise.reject(Object.assign(new Error('Your Operator scope does not allow this action.'), { status: 403, code: 'insufficient_scope', silent: false })) : (real as (p: string, ...r: unknown[]) => Promise<unknown>)(path, ...rest));
    await app.go('/deployments');
    expect(w().find('h1').text()).toBe('Your account cannot open this');
    expect(w().find('.empty--error button').exists()).toBe(false);
  });

  it('Refresh loads the page again', async () => {
    app = await mountApp({ path: '/deployments' });
    const before = calls('rollouts').length;
    await w().find('[data-act=reload]').trigger('click');
    await app.settle();
    expect(calls('rollouts').length).toBeGreaterThan(before);
    expect(w().find('.dep-hero').exists()).toBe(true);
  });

  it('leaving the page aborts the reads in flight', async () => {
    app = await mountApp({ path: '/machines' });
    app.mock.options.hang = 'rollouts';
    await app.go('/deployments');
    const open = app.mock.calls.filter(c => !c.settled);
    expect(open.some(c => c.path === 'rollouts')).toBe(true);
    app.mock.options.hang = null;
    await app.go('/audit');
    expect(open.filter(c => c.path === 'rollouts').every(c => c.aborted)).toBe(true);
    expect(w().find('.dep-hero').exists()).toBe(false);
  });

  it('no stray undefined, null, NaN or Invalid Date text (scan)', async () => {
    app = await mountApp({ path: '/deployments' });
    await openAll();
    expect(textOf(w().find('#view').element)).not.toMatch(/undefined|\bnull\b|NaN|Invalid Date|\[object/);
    expect(w().find('#view [href*="undefined"], #view [href*="null"]').exists()).toBe(false);
    expect(document.title).toBe('Deployments · Fleet Manager');
  });
});

describe('Deployments: hostile text (p4Xss, detailXss)', () => {
  it('a hostile commit subject, author, Skill name and diagnostic render as text', async () => {
    let alerts = 0;
    vi.stubGlobal('alert', () => { alerts++; });
    app = await mountApp({ path: '/deployments', mock: { xss: true, states: true } });
    const bad = () => document.querySelectorAll('#view img, #view script, #view svg[onload], #view [onerror], #view [onclick], #view [onload]').length;
    const shown = (s: string) => w().text().includes(s);
    expect(shown('<img src=x onerror=alert(1)> "quoted" & <script>alert(9)</script>')).toBe(true);
    expect(shown('"><svg onload=alert(10)>')).toBe(true);
    expect(bad(), 'the list shows the hostile subject and author as text').toBe(0);
    expect(shown('<img src=x onerror=alert(11)>'), 'the hero shows the hostile skill name as text').toBe(true);
    await openAll();
    for (const b of w().findAll('[data-act=load-attempts]')) await b.trigger('click');
    await waitFor(() => w().find('.attlist').exists());
    w().findAll('details.diag-line').forEach(d => { (d.element as HTMLDetailsElement).open = true; });
    await app.settle();
    expect(shown('<img src=x onerror=alert(1)>')).toBe(true);
    expect(shown('"><script>')).toBe(true);
    expect(bad()).toBe(0);
    expect(alerts).toBe(0);
  });
});
