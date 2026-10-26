/**
 * Repository page. Ports of the Dev/drive.js scenarios sync and syncStale (on this page), and the scan-text check, plus the
 * status card, scans, warnings, paging, every sync outcome, scope, empty, error and abort states.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RescanResponse, SourceScan } from '@/api/types';
import { mountApp, textOf, waitFor, type TestApp } from '../../helpers/app';
import { syncOutcome } from '../../../src/views/Repository/useRepositorySync';

let app: TestApp | undefined;
afterEach(() => { app?.unmount(); app = undefined; vi.useRealTimers(); });

const w = () => app!.wrapper;
const toasts = () => textOf(w().find('#toasts').element);
const scans = () => w().findAll('li.scan');
const calls = (path: string) => app!.mock.calls.filter(c => c.path === path);
const kv = (label: string) => w().findAll('.repo-card dt').find(d => d.text() === label)!.element.nextElementSibling!.textContent!.replace(/\s+/g, ' ').trim();

/** Replaces what `POST source/rescan` answers; everything else reaches the mock. */
function stubRescan(a: TestApp, answer: unknown | Error): void {
  const real = a.ctx.api.post.bind(a.ctx.api);
  (a.ctx.api as { post: unknown }).post = (path: string, ...rest: unknown[]) =>
    (path === 'source/rescan' ? (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)) : (real as (p: string, ...r: unknown[]) => Promise<unknown>)(path, ...rest));
}

describe('Repository page', () => {
  it('shows the published revision, the last scan, who asked, and the warning count', async () => {
    app = await mountApp({ path: '/repository' });
    expect(w().find('h1').text()).toBe('Repository');
    expect(kv('Published revision')).toMatch(/^a3f9c21 \d+ min ago$/);
    expect(kv('Last scan')).toMatch(/^No changes \d+ min ago$/);
    expect(kv('Last scan requested by')).toBe('Scheduled scan');
    expect(kv('Source warnings')).toBe('1 warning');
    expect(w().find('.repo-card h2').text()).toBe('Skills repository');
    expect(document.title).toBe('Repository · Fleet Manager');
    expect(w().find('.lock-note').exists()).toBe(false);
  });

  it('lists the current warning with its locations and catalog title', async () => {
    app = await mountApp({ path: '/repository' });
    const panel = w().findAll('section.panel').find(p => p.find('h2').text().startsWith('Source warnings'))!;
    expect(panel.find('h2 .cnt').text()).toBe('1');
    expect(panel.find('.callout--warning b').text()).toBe('duplicate_skill');
    expect(panel.find('.callout--warning p').text()).toMatch(/exists in groups core and experimental/);
    expect(panel.findAll('.loc code').map(c => c.text())).toEqual(['skills/core/code-review/', 'skills/experimental/code-review/']);
    expect(panel.find('details.tech').exists()).toBe(false);
  });

  it('warnings of earlier revisions sit in a collapsed block, at most 20', async () => {
    app = await mountApp({ path: '/audit' });
    const real = app.ctx.api.all.bind(app.ctx.api);
    (app.ctx.api as { all: unknown }).all = async (path: string, ...rest: unknown[]) => {
      const r = await (real as (p: string, ...r: unknown[]) => Promise<{ items: unknown[]; truncated: boolean }>)(path, ...rest);
      if (path !== 'warnings') return r;
      const old = Array.from({ length: 25 }, (_, i) => ({ desiredRevisionId: 'old-' + i, code: 'duplicate_skill', message: 'old ' + i, sourceLocations: [] }));
      return { ...r, items: [...r.items, ...old] };
    };
    await app.go('/repository');
    const tech = w().find('details.tech');
    expect(tech.find('summary').text()).toBe('Warnings on earlier revisions (25)');
    expect(tech.findAll('.callout--warning')).toHaveLength(20);
    expect(w().find('h2 .cnt').text()).toBe('1');
  });

  it('with warnings only on older revisions, the current revision says it has none', async () => {
    app = await mountApp({ path: '/audit' });
    const real = app.ctx.api.all.bind(app.ctx.api);
    (app.ctx.api as { all: unknown }).all = async (path: string, ...rest: unknown[]) => {
      const r = await (real as (p: string, ...r: unknown[]) => Promise<{ items: Array<{ desiredRevisionId: string }>; truncated: boolean }>)(path, ...rest);
      return path === 'warnings' ? { ...r, items: r.items.map(i => ({ ...i, desiredRevisionId: 'older' })) } : r;
    };
    await app.go('/repository');
    expect(kv('Source warnings')).toBe('None');
    expect(w().text()).toContain('The current revision has no warnings.');
  });

  it('a failing optional read (warnings, status) does not fail the page', async () => {
    app = await mountApp({ path: '/repository', mock: { fail: 'warnings' } });
    expect(w().find('h1').text()).toBe('Repository');
    expect(kv('Source warnings')).toBe('None');
    app.unmount();
    app = await mountApp({ path: '/repository', mock: { fail: 'source/status' } });
    expect(w().find('h1').text()).toBe('Repository');
    expect(kv('Last scan')).toMatch(/^No changes/);
  });
});

describe('Repository page: recent scans', () => {
  it('lists every scan newest first with outcome, revision, code and who asked', async () => {
    app = await mountApp({ path: '/repository' });
    expect(scans().map(s => s.find('.scan-top b').text()).slice(0, 5)).toEqual(['No changes', 'Published', 'Rejected', 'No changes', 'Fetch failed']);
    expect(scans()[0]!.classes()).toContain('scan--unchanged');
    expect(scans()[0]!.find('.scan-top').text()).toContain('scheduled scan');
    expect(scans()[1]!.find('.scan-top').text()).toContain('requested by joan');
    expect(scans()[2]!.find('.scan-top code').text()).toBe('manifest_invalid');
    expect(scans()[2]!.find('.scan-top .rev').text()).toBe('f71a0c3');
    expect(scans()[2]!.find('time').attributes('datetime')).toBeTruthy();
    expect(scans()[0]!.find('details').exists(), 'a scan without code or diagnostic has nothing to open').toBe(false);
  });

  it('a rejected scan opens to the catalog text, its steps and the diagnostic as text', async () => {
    app = await mountApp({ path: '/repository' });
    const rejected = scans()[2]!;
    const d = rejected.find('details');
    expect((d.element as HTMLDetailsElement).open, 'only a newest failing scan starts open').toBe(false);
    (d.element as HTMLDetailsElement).open = true;
    d.element.dispatchEvent(new Event('toggle'));
    expect(rejected.find('.diag .facts-row').text()).toContain('manifest_invalid');
    expect(rejected.find('.diag .facts-row').text()).toContain('f71a0c3');
    expect(rejected.find('.diag pre.code--diag').text()).toMatch(/^fleet\.yml:41:9 nodes\.build-runner-02/);
    expect(rejected.find('.diag .kv-label').text()).toBe('Diagnostic');
  });

  it('a scan whose code is in the error catalog shows the title, the explanation with code spans and the fix steps', async () => {
    app = await mountApp({ path: '/audit' });
    const real = app.ctx.catalog.get.bind(app.ctx.catalog);
    (app.ctx.catalog as { get: unknown }).get = (code: string) => (code === 'manifest_invalid'
      ? { code, source: 'server', title: 'Manifest is not valid', explanation: 'The `fleet.yml` file did not validate.', fix: ['Edit `fleet.yml`.', 'Run `fleet validate`.'] }
      : real(code));
    await app.go('/repository');
    const rejected = scans()[2]!;
    (rejected.find('details').element as HTMLDetailsElement).open = true;
    expect(rejected.find('.prob-expl strong').text()).toBe('Manifest is not valid.');
    expect(rejected.find('.prob-expl code').text()).toBe('fleet.yml');
    expect(rejected.findAll('.steps li').map(l => l.text())).toEqual(['1Edit fleet.yml.', '2Run fleet validate.']);
    expect(rejected.find('.mini-h').text()).toBe('How to fix');
  });

  it('the newest scan starts open when it did not publish or leave things unchanged', async () => {
    app = await mountApp({ path: '/audit' });
    const real = app.ctx.api.page.bind(app.ctx.api);
    (app.ctx.api as { page: unknown }).page = async (path: string, ...rest: unknown[]) => {
      const r = await (real as (p: string, ...r: unknown[]) => Promise<{ items: SourceScan[]; nextCursor: string | null }>)(path, ...rest);
      if (path !== 'source/scans') return r;
      return { ...r, items: [{ scanId: 'new', sourceRevision: null, outcome: 'failed', code: 'git_fetch_failed', diagnostic: 'boom', observedAt: new Date().toISOString(), requestedBy: null }, ...r.items] };
    };
    await app.go('/repository');
    expect((scans()[0]!.find('details').element as HTMLDetailsElement).open).toBe(true);
    expect(scans()[0]!.find('.scan-top b').text()).toBe('Fetch failed');
  });

  it('an outcome this dashboard does not know is shown as written', async () => {
    app = await mountApp({ path: '/audit' });
    const real = app.ctx.api.page.bind(app.ctx.api);
    (app.ctx.api as { page: unknown }).page = async (path: string, ...rest: unknown[]) => {
      const r = await (real as (p: string, ...r: unknown[]) => Promise<{ items: SourceScan[]; nextCursor: string | null }>)(path, ...rest);
      return path === 'source/scans' ? { ...r, items: [{ ...r.items[0]!, outcome: 'half_done' as never }, ...r.items.slice(1)] } : r;
    };
    await app.go('/repository');
    expect(scans()[0]!.find('.scan-top b').text()).toBe('half done');
  });

  it('Load older scans follows the cursor', async () => {
    app = await mountApp({ path: '/repository', mock: { pageSize: 3 } });
    expect(scans()).toHaveLength(3);
    await w().find('[data-act=more-scans]').trigger('click');
    expect(w().find('[data-act=more-scans]').attributes('disabled')).toBeDefined();
    await waitFor(() => scans().length > 3);
    expect(calls('source/scans').at(-1)!.query.after).toBeTruthy();
    while (w().find('[data-act=more-scans]').exists()) {
      const n = scans().length;
      await w().find('[data-act=more-scans]').trigger('click');
      await waitFor(() => scans().length > n);
    }
    expect(scans()).toHaveLength(app.mock.data.source.scans.length);
  });

  it('a failing "Load older scans" is explained and can be tried again', async () => {
    app = await mountApp({ path: '/repository', mock: { pageSize: 3 } });
    app.mock.options.fail = 'source/scans';
    await w().find('[data-act=more-scans]').trigger('click');
    await waitFor(() => toasts().includes('Could not load older scans'));
    expect(scans()).toHaveLength(3);
    expect(w().find('[data-act=more-scans]').attributes('disabled')).toBeUndefined();
  });

  it('nothing recorded yet', async () => {
    app = await mountApp({ path: '/repository', mock: { empty: true } });
    expect(kv('Published revision')).toBe('Nothing published yet');
    expect(kv('Last scan')).toBe('No scans recorded yet');
    expect(kv('Last scan requested by')).toBe('—');
    expect(w().find('.panel .empty-mini p').text()).toBe('No scans have been recorded yet.');
  });
});

describe('Repository page: Sync repository (sync, syncStale)', () => {
  it('posts source/rescan, reports on a toast and in the result line, and reloads the page quietly', async () => {
    app = await mountApp({ path: '/repository' });
    const before = calls('source/scans').length;
    await w().find('[data-act=sync]').trigger('click');
    expect(w().find('[data-act=sync]').text()).toBe('Syncing…');
    expect(w().find('[data-act=sync]').attributes('disabled')).toBeDefined();
    expect(toasts()).toContain('Repository sync started');
    await waitFor(() => /up to date/i.test(toasts()), { label: 'sync result' });
    await waitFor(() => w().find('[data-act=sync]').text() === 'Sync repository');
    expect(app.mock.calls.filter(c => c.method === 'POST' && c.path === 'source/rescan')).toHaveLength(1);
    expect(w().find('p.result[role=status]').text()).toBe('Repository is up to date. No new assignments were needed. Agents continue syncing their current assignments.');
    await waitFor(() => calls('source/scans').length > before, { label: 'quiet reload' });
    expect(scans()[0]!.find('.scan-top').text()).toContain('requested by joan');
  });

  it('clicking again while a sync runs sends nothing', async () => {
    app = await mountApp({ path: '/repository' });
    await w().find('[data-act=sync]').trigger('click');
    await w().find('[data-act=sync]').trigger('click');
    await waitFor(() => /up to date/i.test(toasts()));
    expect(app.mock.calls.filter(c => c.method === 'POST' && c.path === 'source/rescan')).toHaveLength(1);
  });

  it.each([
    [{ outcome: 'accepted', changedAssignmentCount: 3 }, 'Repository synced', 'Published 3 changed assignments. Running Agents fetch them on their next poll.', 'good'],
    [{ outcome: 'accepted', changedAssignmentCount: 1 }, 'Repository synced', 'Published 1 changed assignment. Running Agents fetch them on their next poll.', 'good'],
    [{ outcome: 'disabled' }, 'No repository configured', 'No source repository is configured on this Server.', 'info'],
    [{ outcome: 'already_running' }, 'A sync is already running', 'Try again shortly to check for changes.', 'info'],
    [{ outcome: 'invalid' }, 'Repository sync was rejected', 'The manifest did not validate. Current assignments remain active. See Recent scans for the reason.', 'warning'],
    [{ outcome: 'failed' }, 'Repository sync failed', 'Check the Server’s Git access. Current assignments remain active.', 'critical'],
    [{ outcome: 'something_new' }, 'Unknown sync result', 'The Server returned an unknown result. Check Recent scans before retrying.', 'warning'],
  ])('the answer %j is reported as "%s"', async (answer, title, text, tone) => {
    app = await mountApp({ path: '/repository' });
    stubRescan(app, answer);
    await w().find('[data-act=sync]').trigger('click');
    await waitFor(() => toasts().includes(title), { label: 'result toast' });
    expect(toasts()).toContain(text);
    expect(app.ctx.shared.lastSync?.level).toBe(tone === 'info' ? 'info' : tone);
    expect(app.ctx.shared.lastSync?.text).toBe(`${title}. ${text}`);
    await waitFor(() => w().find('p.result').exists());
    expect(w().find('p.result').text()).toContain(title);
  });

  it('syncOutcome maps each outcome to a level', () => {
    expect(syncOutcome({ outcome: 'unchanged' } as RescanResponse).level).toBe('good');
    expect(syncOutcome({ outcome: 'invalid' } as RescanResponse).level).toBe('warning');
    expect(syncOutcome({ outcome: 'failed' } as RescanResponse).level).toBe('critical');
    expect(syncOutcome(null).title).toBe('Unknown sync result');
  });

  it('a sync that cannot be confirmed is explained', async () => {
    app = await mountApp({ path: '/repository', mock: { forbid: true } });
    await w().find('[data-act=sync]').trigger('click');
    await waitFor(() => toasts().includes('Repository sync could not be confirmed'));
    expect(w().find('[data-act=sync]').text()).toBe('Sync repository');
    expect(app.ctx.shared.lastSync).toBeNull();
  });

  it('a sync that answers after the user left does not reload the page the user is on (syncStale)', async () => {
    app = await mountApp({ path: '/repository', mock: { lag: { rescan: 400 } } });
    await w().find('[data-act=sync]').trigger('click');
    await new Promise(r => setTimeout(r, 100));
    await app.go('/audit');
    await waitFor(() => w().find('h1').text() === 'Audit' && !w().find('.skel').exists());
    const page = w().find('#view').element.firstElementChild;
    const loads = calls('audit').length;
    const scanLoads = calls('source/scans').length;
    await waitFor(() => /up to date/i.test(toasts()), { label: 'the toast reports it', timeout: 3000 });
    await new Promise(r => setTimeout(r, 150));
    expect(w().find('#view').element.firstElementChild).toBe(page);
    expect(calls('audit')).toHaveLength(loads);
    expect(calls('source/scans')).toHaveLength(scanLoads);
    expect(app.ctx.shared.syncing).toBe(false);
  });

  it('the result of the last sync is shown on coming back to the page', async () => {
    app = await mountApp({ path: '/repository' });
    await w().find('[data-act=sync]').trigger('click');
    await waitFor(() => w().find('p.result').exists());
    await app.go('/audit');
    await app.go('/repository');
    expect(w().find('p.result').text()).toContain('Repository is up to date.');
  });
});

describe('Repository page: scope, errors and aborts', () => {
  it('a read token sees a locked Sync button with the reason, and nothing is sent', async () => {
    app = await mountApp({ path: '/repository', mock: { scope: 'read' } });
    const btn = w().find('.page-head button.is-locked');
    expect(btn.text()).toBe('Sync repository');
    expect(btn.attributes('aria-disabled')).toBe('true');
    expect(btn.attributes('data-tip')).toContain('Needs the operate scope');
    expect(w().find('.lock-note').text()).toBe('Needs the operate scope. Your token has read access.');
    await btn.trigger('click');
    expect(toasts()).toContain('Not available');
    expect(app.mock.calls.filter(c => c.method === 'POST' && c.path !== 'login')).toHaveLength(0);
  });

  it('shows the loading skeleton, then the page', async () => {
    app = await mountApp({ path: '/audit' });
    app.mock.options.slow = 150;
    void app.router.push('/repository');
    await waitFor(() => w().find('[role=status] .skel').exists());
    await waitFor(() => w().find('.repo-card').exists(), { timeout: 5000 });
  });

  it('a failing read shows the error, and Try again recovers', async () => {
    app = await mountApp({ path: '/repository', mock: { fail: 'source/scans' } });
    expect(w().find('h1').text()).toBe('Could not load Repository');
    app.mock.options.fail = null;
    await w().find('.empty--error button').trigger('click');
    await waitFor(() => w().find('.repo-card').exists());
  });

  it('a token that cannot read shows "Your token cannot open this"', async () => {
    app = await mountApp({ path: '/audit' });
    const real = app.ctx.api.page.bind(app.ctx.api);
    (app.ctx.api as { page: unknown }).page = (path: string, ...rest: unknown[]) =>
      (path === 'source/scans' ? Promise.reject(Object.assign(new Error('Your Operator scope does not allow this action.'), { status: 403, silent: false })) : (real as (p: string, ...r: unknown[]) => Promise<unknown>)(path, ...rest));
    await app.go('/repository');
    expect(w().find('h1').text()).toBe('Your token cannot open this');
  });

  it('leaving the page aborts the reads in flight', async () => {
    app = await mountApp({ path: '/audit', mock: { hang: 'source/' } });
    await app.go('/repository');
    const hung = app.mock.calls.filter(c => c.path.startsWith('source/'));
    expect(hung.length).toBeGreaterThan(0);
    expect(hung.every(c => !c.settled)).toBe(true);
    await app.go('/audit');
    expect(hung.every(c => c.aborted)).toBe(true);
  });

  it('no stray undefined, null, NaN or Invalid Date text (scan)', async () => {
    app = await mountApp({ path: '/repository' });
    w().findAll('li.scan details').forEach(d => { (d.element as HTMLDetailsElement).open = true; });
    expect(textOf(w().find('#view').element)).not.toMatch(/undefined|\bnull\b|NaN|Invalid Date|\[object/);
  });

  it('a hostile diagnostic renders as text', async () => {
    app = await mountApp({ path: '/audit' });
    const real = app.ctx.api.page.bind(app.ctx.api);
    (app.ctx.api as { page: unknown }).page = async (path: string, ...rest: unknown[]) => {
      const r = await (real as (p: string, ...r: unknown[]) => Promise<{ items: SourceScan[]; nextCursor: string | null }>)(path, ...rest);
      return path === 'source/scans' ? { ...r, items: [{ ...r.items[2]!, diagnostic: '<img src=x onerror=alert(1)> "><script>alert(2)</script>', requestedBy: '<b>joan</b>' }, ...r.items] } : r;
    };
    await app.go('/repository');
    expect(w().find('pre.code--diag').text()).toBe('<img src=x onerror=alert(1)> "><script>alert(2)</script>');
    expect(scans()[0]!.text()).toContain('requested by <b>joan</b>');
    expect(document.querySelectorAll('#view img, #view script').length).toBe(0);
  });
});
