/**
 * Revision page (/deployments/:revisionId). Ports of the Dev/drive.js scenarios depNull (revision page), depDetail, depRollout,
 * depNoRollout, depMissing, depRolloutFail, depAbort and p4Xss (revision page), plus loading, error and scope states.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockServer } from '@/api/mock';
import { mountApp, textOf, waitFor, type TestApp } from '../../helpers/app';

let app: TestApp | undefined;
afterEach(() => { app?.unmount(); app = undefined; vi.useRealTimers(); });

const w = () => app!.wrapper;
const probe = createMockServer();
const REVS = probe.data.revisions;
probe.dispose();
const revs = () => REVS;
const names = () => w().findAll('.rv-row .rv-node').map(a => a.text());
const chip = (k: string) => w().findAll('.chips-filter[aria-label="Filter machines by state"] button').find(b => b.text().toLowerCase().startsWith(k));
const rowOf = (n: string) => w().findAll('.rv-row').find(r => r.find('.rv-node').text() === n)!;
const calls = (re: RegExp) => app!.mock.calls.filter(c => re.test(c.path));
const open = async (id: string) => { await app!.go('/deployments/' + id); await waitFor(() => w().find('h1.dep-title').exists() || w().find('.empty h1').exists()); };

describe('Revision page: what changed (depDetail)', () => {
  it('title, author, skills with signs, Target counts, previous revision, summary bar and legend', async () => {
    app = await mountApp({ path: '/deployments' });
    await open(revs()[0]!.id);
    await waitFor(() => w().find('.rv-row').exists());
    const r = revs();
    expect(w().find('h1.dep-title').text()).toBe(r[0]!.message);
    expect(calls(new RegExp('^desired-revisions/' + r[0]!.id + '$')).length).toBeGreaterThan(0);
    expect(calls(/^rollouts\/[^/]+$/).length, 'GET desired-revisions/{id}, then GET rollouts/{id}').toBeGreaterThan(0);
    expect(w().findAll('.dep-hero-main .changes .chg').map(c => c.text())).toEqual(['+postgres-migrations', '~code-review']);
    expect(w().find('.chg-targets').text().replace(/\s+/g, ' ')).toContain('2 added · 5 changed · 0 removed, on 4 machines');
    const prev = w().find('.dep-prev a');
    expect(prev.attributes('href'), 'a link to the previous revision').toBe('/deployments/' + r[1]!.id);
    expect(prev.text()).toBe('9b14e07');
    expect(w().find('.dep-hero-main .dep-meta').text()).toContain('joan');
    expect(w().find('.crumbs a').attributes('href'), 'a way back to all deployments').toBe('/deployments');
    expect(w().find('.crumbs [aria-current=page]').text()).toBe('a3f9c21');
    expect(w().find('nav.crumbs').attributes('aria-label')).toBe('Breadcrumb');
    expect(w().find('.dep-hero-side').text()).toMatch(/Assignments succeeded/);
    expect(w().find('.dep-hero-side .hero-fig').text().replace(/\s+/g, ' ')).toMatch(/31\s*of 43/);
    expect(w().find('.dep-hero-side .segbar').exists()).toBe(true);
    expect(w().findAll('.dep-hero-side .legend li')).toHaveLength(5);
    expect(w().find('.dep-hero-side .muted').text()).toContain('3 of 13 machines have nothing left to apply.');
    expect(w().find('.dep-hero-main .eyebrow').text()).toBe('Rolling out now');
    expect(w().findAll('.dep-hero-main dl.kv dd').map(d => d.text())).toEqual([r[0]!.sourceRevision, r[0]!.id, expect.stringMatching(/^[0-9a-f-]{36}$/)]);
    expect(document.title).toBe('a3f9c21 · Fleet Manager');
  });

  it('follows the previous-revision link; a revision without Skill changes says so; the first revision has nothing to compare', async () => {
    app = await mountApp({ path: '/deployments/' + revs()[0]!.id });
    const r = revs();
    await w().find('.dep-prev a').trigger('click');
    await waitFor(() => w().find('h1.dep-title').text() === r[1]!.message, { label: 'previous revision' });
    await waitFor(() => w().find('.rv-row').exists());
    expect(w().find('.dep-hero-main .changes').exists()).toBe(false);
    expect(w().find('.dep-hero-main').text()).toMatch(/No Skill changes/);
    expect(w().find('.chg-targets').text().replace(/\s+/g, ' ')).toMatch(/0 added · 3 changed · 0 removed, on 3 machines/);
    expect(w().find('.dep-prev a').text(), 'its previous revision is the next one down').toBe('51c0d8a');
    await open(r[3]!.id);
    expect(w().findAll('.chg--rm').map(c => c.text())).toEqual(['−jira-triage']);
    expect(w().find('.chg--rm .chg-s').attributes('aria-label')).toBe('removed');
    await open(r[4]!.id);
    expect(w().find('h1.dep-title').text()).toBe('Revision c08d4be');
    expect(w().find('.dep-prev a').exists()).toBe(false);
    expect(w().find('.dep-prev').text()).toMatch(/first revision/);
    expect(w().findAll('.chg--add'), 'and everything it holds is added').toHaveLength(5);
  });

  it('the title is focused after a navigation', async () => {
    app = await mountApp({ path: '/deployments' });
    await app.go('/deployments/' + revs()[0]!.id);
    await waitFor(() => w().find('h1.dep-title').exists());
    await waitFor(() => document.activeElement === w().find('h1.dep-title').element, { label: 'focus' });
    expect(w().find('h1.dep-title').attributes('tabindex')).toBe('-1');
  });
});

describe('Revision page without commit metadata (depNull)', () => {
  it('falls back to the short SHA in the title and the breadcrumb', async () => {
    app = await mountApp({ path: '/deployments', mock: { commit: false } });
    await open(revs()[0]!.id);
    await waitFor(() => w().find('.rv-row').exists());
    expect(w().find('h1.dep-title').text()).toBe('Revision a3f9c21');
    expect(w().find('.dep-hero .dep-meta .av').exists()).toBe(false);
    expect(w().find('.dep-hero .dep-meta').text()).toMatch(/Published/);
    expect(w().find('.crumbs').text()).toContain('a3f9c21');
  });
});

describe('Revision page: per-machine progress (depRollout)', () => {
  it('rows, filter chips with counts, sort, links to the Problems tab', async () => {
    app = await mountApp({ path: '/deployments/' + revs()[0]!.id });
    await waitFor(() => w().find('.rv-row').exists());
    expect(names()).toHaveLength(13);
    expect(w().find('.panel-head h2').text().replace(/\s+/g, ' ')).toMatch(/Machines\s*13/);
    for (const k of ['all', 'succeeded', 'applying', 'pending', 'failed']) expect(chip(k), k).toBeTruthy();
    expect(chip('superseded')).toBeUndefined();
    expect(['all', 'failed', 'applying', 'pending', 'succeeded'].map(k => chip(k)!.find('span').text())).toEqual(['13', '4', '2', '4', '3']);
    expect(names().slice(0, 4)).toEqual(['design-imac', 'fedora-ws', 'kitchen-mini', 'studio-mini']);
    expect(names().at(-1), 'sorted by state, worst first, then name').toBe('laptop-ana');
    const state = (n: string) => rowOf(n).find('.rv-state').text().trim();
    expect([state('fedora-ws'), state('gpu-box'), state('mba-travel'), state('homelab-nuc')], 'each state has a word').toEqual(['Failed', 'Applying', 'Pending', 'Succeeded']);
    expect(rowOf('fedora-ws').find('.rv-state svg.g').exists(), 'and an icon').toBe(true);
    expect(rowOf('fedora-ws').find('.rv-times').text()).toMatch(/First attempt.*ago/);
    expect(rowOf('fedora-ws').find('.rv-times').text()).toMatch(/Last attempt/);
    expect(rowOf('build-runner-02').text()).toMatch(/No attempt yet/);
    const chipsOf = (n: string) => rowOf(n).findAll('.tchip').map(c => [c.find('span:not(.sr)').text(), c.find('code').exists() ? c.find('code').text() : '', c.find('.sr').text().trim()].filter(Boolean).join(' '));
    expect(chipsOf('studio-mini')).toEqual(expect.arrayContaining(['Claude ai_client_reconcile_failed Failed:', 'Skills Succeeded:']));
    const link = rowOf('studio-mini').find('a.tchip--error');
    expect(link.attributes('href'), 'the error code links to the machine\'s Problems tab').toBe('/machines/studio-mini/problems');
    expect(link.attributes('data-tip')).toContain('Failed');
    expect(rowOf('homelab-nuc').find('a.tchip').exists(), 'a Target without an error code is not a link').toBe(false);
    expect(rowOf('studio-mini').find('ul.rv-targets').attributes('aria-label')).toBe('Targets of studio-mini');
    expect(rowOf('fedora-ws').find('.rv-node').attributes('href')).toBe('/machines/fedora-ws');

    await chip('failed')!.trigger('click');
    expect(names()).toEqual(['design-imac', 'fedora-ws', 'kitchen-mini', 'studio-mini']);
    expect(chip('failed')!.attributes('aria-pressed')).toBe('true');
    await chip('pending')!.trigger('click');
    expect(names()).toEqual(['build-runner-02', 'build-runner-03', 'lab-vm-07', 'mba-travel']);
    await chip('all')!.trigger('click');
    expect(names()).toHaveLength(13);

    await w().find('#rv-sort').setValue('name');
    expect(names()).toEqual([...names()].sort((a, b) => a.localeCompare(b)));
    expect(names()[0]).toBe('build-runner-01');
    await w().find('#rv-sort').setValue('recent');
    expect(names()[0], 'sort by latest attempt: newest first').toBe('gpu-box');
    expect(['build-runner-02', 'build-runner-03', 'lab-vm-07', 'mba-travel']).toContain(names().at(-1));
    expect(w().findAll('#rv-sort option').map(o => o.text())).toEqual(['Needs attention first', 'Name', 'Latest attempt']);
    expect(calls(/^rollouts\/[^/]+$/), 'filtering and sorting do not read the rollout again').toHaveLength(1);

    await chip('failed')!.trigger('click');
    await w().find('a.tchip--error[href$="/design-imac/problems"]').trigger('click');
    await waitFor(() => app!.router.currentRoute.value.fullPath === '/machines/design-imac/problems');
  });

  it('an older rollout lists its own machines, with Targets that were superseded', async () => {
    app = await mountApp({ path: '/deployments/' + revs()[1]!.id });
    await waitFor(() => w().find('.rv-row').exists());
    expect(chip('failed')!.find('span').text()).toBe('3');
    expect(chip('succeeded')).toBeUndefined();
    expect(w().findAll('.rv-row')).toHaveLength(3);
    expect(w().findAll('.rv-row .tchip').some(c => /Superseded/.test(c.text()))).toBe(true);
    expect(w().find('.dep-hero-main .eyebrow').text()).toBe('Rollout with failures');
  });

  it('a finished rollout says so', async () => {
    app = await mountApp({ path: '/deployments/' + revs()[2]!.id });
    await waitFor(() => w().find('.rv-row').exists());
    expect(w().find('.dep-hero-main .eyebrow').text()).toBe('Rollout finished');
    expect(w().find('.dep-hero-main .eyebrow').classes()).not.toContain('live');
  });
});

describe('Revision page: no rollout, missing, failing (depNoRollout, depMissing, depRolloutFail)', () => {
  it('a revision without a rollout says so and still shows the diff', async () => {
    app = await mountApp({ path: '/deployments', mock: { rollout: false } });
    await open(revs()[0]!.id);
    expect(w().text()).toMatch(/No rollout was created for this revision/);
    expect(w().find('.rv-row').exists()).toBe(false);
    expect(w().find('.dep-hero-side .segbar').exists()).toBe(false);
    expect(w().find('.chg--add').exists() && w().find('.chg-targets').exists(), 'the diff is still shown').toBe(true);
    expect(w().find('.dep-hero-main .eyebrow').text()).toBe('Revision');
    expect(w().find('.panel .empty-mini p').text()).toContain('no per-machine progress to show');
    expect(calls(/^rollouts\//)).toHaveLength(0);
  });

  it('an unknown revision explains itself and links back; Deployments stays the current section', async () => {
    app = await mountApp({ path: '/deployments/00000000-0000-4000-a000-000000000000' });
    await waitFor(() => w().find('.empty h1').exists());
    expect(w().find('.empty h1').text()).toBe('We could not find that revision');
    expect(w().find('.empty p').text()).toBe('That revision no longer exists.');
    expect(w().find('.empty a[href="/deployments"]').text()).toBe('Back to deployments');
    expect(w().find('#nav a[aria-current=page]').text()).toBe('Deployments');
    expect(w().find('.dep-hero').exists()).toBe(false);
  });

  it('a rollout that cannot be read: the diff stays, the error is local, and Try again reads it', async () => {
    app = await mountApp({ path: '/deployments', mock: { fail: 'rollouts/' } });
    await open(revs()[0]!.id);
    await waitFor(() => w().find('.callout--critical').exists());
    expect(w().find('.callout--critical').text()).toContain('Could not load the rollout');
    expect(w().find('.chg--add').exists()).toBe(true);
    expect(w().find('.rv-row').exists()).toBe(false);
    expect(w().find('.dep-hero-side').text()).toContain('The rollout could not be read. See the error below.');
    expect(w().find('.panel [data-act=reload]').text()).toContain('Try again');
    app.mock.options.fail = null;
    await w().find('.panel [data-act=reload]').trigger('click');
    await waitFor(() => w().find('.rv-row').exists());
    expect(w().find('.callout--critical').exists()).toBe(false);
  });

  it('a failing revision read shows the page error with Try again', async () => {
    app = await mountApp({ path: '/deployments', mock: { fail: 'desired-revisions/' } });
    await app.go('/deployments/' + revs()[0]!.id);
    expect(w().find('h1').text()).toBe('Could not load Revision');
    app.mock.options.fail = null;
    await w().find('.empty--error button').trigger('click');
    await waitFor(() => w().find('h1.dep-title').exists());
  });

  it('a token that cannot read shows "Your account cannot open this"', async () => {
    app = await mountApp({ path: '/audit' });
    const real = app.ctx.api.get.bind(app.ctx.api);
    (app.ctx.api as { get: unknown }).get = (path: string, ...rest: unknown[]) =>
      (path.startsWith('desired-revisions/') ? Promise.reject(Object.assign(new Error('Your Operator scope does not allow this action.'), { status: 403, code: 'insufficient_scope', silent: false })) : (real as (p: string, ...r: unknown[]) => Promise<unknown>)(path, ...rest));
    await app.go('/deployments/' + revs()[0]!.id);
    expect(w().find('h1').text()).toBe('Your account cannot open this');
  });

  it('a machine without an Assignment in the rollout is not listed; an empty rollout says so', async () => {
    app = await mountApp({ path: '/audit' });
    const real = app.ctx.api.get.bind(app.ctx.api);
    (app.ctx.api as { get: unknown }).get = async (path: string, ...rest: unknown[]) => {
      const r = await (real as (p: string, ...r: unknown[]) => Promise<Record<string, unknown>>)(path, ...rest);
      return /^rollouts\/[^/]+$/.test(path) ? { ...r, nodes: [] } : r;
    };
    await app.go('/deployments/' + revs()[0]!.id);
    expect(w().find('.panel .empty-mini p').text()).toBe('No machine has an Assignment in this rollout.');
  });
});

describe('Revision page: stale and abandoned loads (depAbort)', () => {
  it('moving to another revision aborts the first read, and the newer revision is the one on screen', async () => {
    app = await mountApp({ path: '/audit', mock: { slow: 300 } });
    const r = revs();
    void app.router.push('/deployments/' + r[0]!.id);
    await waitFor(() => calls(new RegExp('^desired-revisions/' + r[0]!.id)).length > 0, { label: 'first read started' });
    void app.router.push('/deployments/' + r[1]!.id);
    await waitFor(() => w().find('h1.dep-title').exists() && w().find('h1.dep-title').text() === r[1]!.message && w().find('.rv-row').exists(), { label: 'second revision', timeout: 6000 });
    await new Promise(res => setTimeout(res, 800));
    expect(w().find('h1.dep-title').text()).toBe(r[1]!.message);
    const first = calls(new RegExp('^desired-revisions/' + r[0]!.id + '$'));
    expect(first.length >= 1 && first.every(c => c.settled) && first.some(c => c.aborted), 'the first revision read was aborted when the user moved on').toBe(true);
    app.mock.options.slow = 0;
    await app.go('/machines');
    await new Promise(res => setTimeout(res, 800));
    expect(app.mock.calls.filter(c => !c.settled), 'nothing is left in flight').toHaveLength(0);
    expect(w().find('.rv-row').exists() || w().find('h1.dep-title').exists()).toBe(false);
  });

  it('leaving while the rollout read hangs aborts it', async () => {
    app = await mountApp({ path: '/audit', mock: { hang: 'rollouts/' } });
    await app.go('/deployments/' + revs()[0]!.id);
    const hung = calls(/^rollouts\/[^/]+$/);
    expect(hung.length).toBe(1);
    expect(hung[0]!.settled).toBe(false);
    await app.go('/audit');
    expect(hung[0]!.aborted).toBe(true);
  });
});

describe('Revision page: hostile text (p4Xss)', () => {
  it('a hostile commit subject, author and Skill name render as text', async () => {
    let alerts = 0;
    vi.stubGlobal('alert', () => { alerts++; });
    app = await mountApp({ path: '/deployments', mock: { xss: true } });
    await open(revs()[0]!.id);
    await waitFor(() => w().find('.rv-row').exists());
    const bad = () => document.querySelectorAll('#view img, #view script, #view svg[onload], #view [onerror], #view [onclick], #view [onload]').length;
    expect(w().find('h1.dep-title').text()).toContain('<script>alert(9)</script>');
    expect(w().text()).toContain('<img src=x onerror=alert(11)>');
    expect(w().text()).toContain('"><svg onload=alert(10)>');
    expect(bad()).toBe(0);
    expect(alerts).toBe(0);
  });
});

describe('Revision page: loading and scan', () => {
  it('shows the loading skeleton, then the page; no stray undefined text', async () => {
    app = await mountApp({ path: '/audit' });
    app.mock.options.slow = 150;
    void app.router.push('/deployments/' + revs()[0]!.id);
    await waitFor(() => w().find('[role=status] .skel').exists(), { label: 'skeleton' });
    await waitFor(() => w().find('.rv-row').exists(), { timeout: 5000 });
    expect(textOf(w().find('#view').element)).not.toMatch(/undefined|\bnull\b|NaN|Invalid Date|\[object/);
    expect(w().find('#view [href*="undefined"], #view [href*="null"]').exists()).toBe(false);
  });

  it('a read scope sees the page (nothing here needs more)', async () => {
    app = await mountApp({ path: '/deployments', mock: { scope: 'read' } });
    await open(revs()[0]!.id);
    await waitFor(() => w().find('.rv-row').exists());
    expect(w().find('.is-locked').exists()).toBe(false);
  });
});
