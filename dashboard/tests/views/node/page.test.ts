/**
 * The machine page: loading, error and not-found states, routing (alias as one encoded segment, tabs), the header, the tab bar, and the
 * overlapping-load scenarios of Dev/drive.js: raceNode, raceBack, weirdAlias, scan. Revoked machines and keyboard focus.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAKE_TIMERS, currentTab, focused, nodeTest, openNode, sleep, stray, type NodeTest } from './helpers';
import { ApiError } from '@/api/client';
import { mountApp, textOf, waitFor } from '../../helpers/app';
import NodeView from '@/views/Node/NodeView.vue';
import { NODE_PAGE, type NodePage } from '@/views/Node/nodePage';

let t: NodeTest | undefined;
afterEach(() => { t?.unmount(); t = undefined; vi.useRealTimers(); });

describe('loading, errors and not found', () => {
  it('shows the loading skeleton while the machine loads, then the page', async () => {
    t = await openNode('/machines/studio-mini', { slow: 150 }, { wait: false });
    expect(t.exists('.skel'), 'skeleton').toBe(true);
    expect(t.find('#view [role=status]').text()).toContain('Loading');
    expect(t.exists('.nhero')).toBe(false);
    await t.ready('studio-mini');
    expect(t.exists('.skel-title')).toBe(false);
    expect(t.exists('.nhero')).toBe(true);
  });

  it('a machine that does not exist reads "We could not find …" with a way back (404)', async () => {
    t = await openNode('/machines/nobody', {}, { wait: false });
    await t.until(() => t!.exists('.empty h1'), 'not found');
    expect(t.text('.empty h1')).toBe('We could not find “nobody”');
    expect(t.text('.empty')).toContain('It may have been renamed or removed. Removed machines free their alias.');
    const back = t.find('.empty a.btn');
    expect(back.text()).toBe('Back to all machines');
    expect(back.attributes('href')).toBe('/machines');
    expect(document.title).toBe('nobody · Fleet Manager');
    expect(t.exists('.nhero') || t.exists('nav.tabs')).toBe(false);
    expect(t.exists('[role=alert]'), 'not an error page').toBe(false);
  });

  it('a name that needs encoding is shown as text in the not-found page', async () => {
    t = await openNode('/machines/%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E', {}, { wait: false });
    await t.until(() => t!.exists('.empty h1'));
    expect(t.text('.empty h1')).toBe('We could not find “<img src=x onerror=alert(1)>”');
    expect(t.exists('#view img')).toBe(false);
  });

  it('a failing read shows the error with Try again, and the retry loads the page', async () => {
    t = await openNode('/machines/studio-mini', { fail: 'nodes/studio-mini' }, { wait: false });
    await t.until(() => t!.exists('.empty--error'), 'error state');
    expect(t.text('.empty--error h1')).toBe('Could not load studio-mini');
    expect(t.text('.empty--error')).toContain('The Server had a problem (500). Try again in a moment.');
    expect(t.exists('.nhero')).toBe(false);
    t.app.mock.options.fail = null;
    await t.click('.empty--error button');
    await t.ready('studio-mini');
    expect(t.exists('.empty--error')).toBe(false);
  });

  it('a token that cannot read the machine says so and offers no retry (403)', async () => {
    t = await openNode('/machines/nobody', {}, { wait: false });
    await t.until(() => t!.exists('.empty h1'));
    const real = t.app.ctx.api.get.bind(t.app.ctx.api) as typeof t.app.ctx.api.get;
    vi.spyOn(t.app.ctx.api, 'get').mockImplementation(((path: string, ...rest: unknown[]) => /^nodes\/studio-mini$/.test(path)
      ? Promise.reject(new ApiError('The Operator credential does not have the scope this action needs.', 403, 'insufficient_scope'))
      : (real as (...a: unknown[]) => Promise<unknown>)(path, ...rest)) as typeof t.app.ctx.api.get);
    await t.go('/machines/studio-mini');
    await t.until(() => t!.exists('.empty--error'));
    expect(t.text('.empty--error h1')).toBe('Your token cannot open this');
    expect(t.text('.empty--error')).toContain('does not have the scope');
    expect(t.exists('.empty--error button'), 'no Try again for a 403').toBe(false);
  });

  it('degrades when GET issues fails: the page loads from the machine record and the Problems tab says the details are unavailable', async () => {
    t = await openNode('/machines/studio-mini/problems', { fail: 'issues' });
    expect(t.panel()).toContain('Issue details are unavailable');
    expect(t.panel()).toContain('Failed Targets are shown from the machine record, without CLI commands or other issues.');
    expect(t.findAll('article.prob'), 'the failed Target is still listed').toHaveLength(1);
    expect(t.exists('.nhero')).toBe(true);
  });

  it('a failing catalog degrades to raw error codes instead of failing the page', async () => {
    t = await openNode('/machines/studio-mini', { fail: 'errors' });
    expect(t.exists('.empty--error')).toBe(false);
    expect(t.hero()).toMatch(/Action needed/);
  });

  it('the Server being unreachable (offline) shows the error state', async () => {
    t = await openNode('/machines/studio-mini', {}, { wait: false });
    await t.ready('studio-mini');
    t.app.mock.options.offline = true;
    await t.go('/machines/design-imac');
    await t.until(() => t!.exists('.empty--error'));
    expect(t.text('.empty--error h1')).toBe('Could not load design-imac');
    expect(t.text('.empty--error')).toMatch(/Could not reach the Server/);
  });
});

describe('routing', () => {
  it('opens Overview by default and for an unknown tab, and every tab by its address', async () => {
    t = await openNode('/machines/studio-mini');
    expect(currentTab(t)).toBe('Overview');
    expect(t.tabs().map(a => a.text().replace(/\d+$/, '').trim())).toEqual(['Overview', 'Installed', 'Problems', 'Activity', 'Security', 'Settings']);
    await t.go('/machines/studio-mini/bogus');
    expect(currentTab(t), 'an unknown tab means Overview').toBe('Overview');
    for (const [key, label] of [['installed', 'Installed'], ['problems', 'Problems'], ['activity', 'Activity'], ['security', 'Security'], ['settings', 'Settings'], ['overview', 'Overview']] as const) {
      await t.go(`/machines/studio-mini/${key}`);
      expect(currentTab(t)).toBe(label);
      expect(t.find('nav.tabs a[aria-current]').attributes('aria-current')).toBe('page');
    }
  });

  it('the tab bar is a labelled navigation whose links point at the machine and its tab', async () => {
    t = await openNode('/machines/studio-mini');
    expect(t.find('nav.tabs').attributes('aria-label')).toBe('studio-mini sections');
    expect(t.tabs().map(a => a.attributes('href'))).toEqual(['/machines/studio-mini', '/machines/studio-mini/installed', '/machines/studio-mini/problems', '/machines/studio-mini/activity', '/machines/studio-mini/security', '/machines/studio-mini/settings']);
    expect(t.find('nav.crumbs').attributes('aria-label')).toBe('Breadcrumb');
    expect(t.find('nav.crumbs a').attributes('href')).toBe('/machines');
    expect(t.find('nav.crumbs [aria-current=page]').text()).toBe('studio-mini');
  });

  it('switching tabs within 15 seconds of the last read keeps the page and does not read the machine again', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    t = await openNode('/machines/studio-mini');
    const reads = () => t!.gets(/^nodes\/studio-mini$/).length;
    expect(reads()).toBe(1);
    const h1 = t.find('.nhero h1').element;
    await sleep(14_000);
    await t.tabs()[2]!.trigger('click');
    await t.app.settle();
    expect(t.app.router.currentRoute.value.fullPath).toBe('/machines/studio-mini/problems');
    expect(currentTab(t)).toBe('Problems');
    expect(t.find('.nhero h1').element, 'the same page element').toBe(h1);
    await t.tabs()[3]!.trigger('click');
    await t.app.settle();
    expect(reads(), 'under 15 seconds: no new read').toBe(1);
    expect(t.panel()).toContain('Activity');
  });

  it('switching tabs more than 15 seconds after the last read reads the machine and the issues again, quietly', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    t = await openNode('/machines/build-runner-01');
    const reads = () => t!.gets(/^nodes\/build-runner-01$/).length;
    expect(reads()).toBe(1);
    expect(t.hero(), 'a healthy machine to begin with').not.toMatch(/Action needed/);
    const h1 = t.find('.nhero h1').element;
    /* While the visitor stays on Overview a Target fails on the Server. */
    const mock = t.app.mock.nodes.find(n => n.alias === 'build-runner-01')!;
    mock.targets[0]!.state = 'failed';
    mock.targets[0]!.failure = { code: 'ownership_conflict', firstSeenAt: new Date().toISOString(), retries: 1 } as never;
    await sleep(16_000);
    await t.tabs()[2]!.trigger('click'); // Problems
    expect(t.exists('.skel'), 'the page keeps its content while it reads').toBe(false);
    await t.app.settle();
    await t.until(() => reads() === 2, 'the machine is read again');
    expect(t.find('.nhero h1').element, 'the same page element').toBe(h1);
    await t.until(() => t!.findAll('article.prob').length === 1, 'the failed Target, from the issues read again');
    expect(t.panel()).not.toContain('Nothing to fix');
    expect(t.hero(), 'and the header, from the machine read again').toMatch(/Action needed/);
    expect(t.tabText('Problems')).toMatch(/\d/);
    expect(t.exists('.skel')).toBe(false);
    /* The read is fresh again: another tab change reads nothing. */
    await sleep(2000);
    await t.tabs()[3]!.trigger('click');
    await t.app.settle();
    expect(reads()).toBe(2);
  });

  it('exactly 15 seconds is still fresh; just over is not', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    t = await openNode('/machines/studio-mini');
    await sleep(15_000);
    await t.tabs()[1]!.trigger('click');
    await t.app.settle();
    expect(t.gets(/^nodes\/studio-mini$/)).toHaveLength(1);
    await sleep(1);
    await t.tabs()[2]!.trigger('click');
    await t.app.settle();
    await t.until(() => t!.gets(/^nodes\/studio-mini$/).length === 2, 'read again');
  });

  it('the newest tab change owns the reading: an older machine read is aborted and the tab on screen shows its own data', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    t = await openNode('/machines/studio-mini', { delay: { 'studio-mini': 400 } });
    await sleep(20_000);
    await t.tabs()[2]!.trigger('click'); // Problems: reads the machine again (400 ms)
    await sleep(100);
    await t.tabs()[3]!.trigger('click'); // Activity before the answer
    await sleep(2000);
    await t.app.settle();
    const reads = t.gets(/^nodes\/studio-mini$/);
    expect(reads).toHaveLength(3);
    expect(reads[1]!.aborted, 'the first of the two re-reads was superseded').toBe(true);
    expect(currentTab(t)).toBe('Activity');
    expect(t.panel()).toContain('Activity');
    expect(t.gets(/\/attempts$/).filter(c => !c.query.target).length, 'Activity was read once, for the newest tab change').toBe(1);
    expect(t.findAll('article.prob'), 'no Problems cards on the Activity tab').toHaveLength(0);
  });

  it('a quiet reload that replaces the machine record does not start the tab\'s reads again by itself', async () => {
    t = await openNode('/machines/studio-mini/problems');
    const attempts = () => t!.gets(/\/attempts$/).filter(c => c.query.target).length;
    expect(attempts(), 'one failed Target, read once when the tab opened').toBe(1);
    const page = (t.w().findComponent(NodeView).vm as any).$.provides[NODE_PAGE as symbol] as NodePage;
    const before = page.node.value;
    for (let i = 0; i < 3; i++) await page.core.run({ quiet: true });
    await t.app.settle();
    expect(page.node.value, 'the record was replaced').not.toBe(before);
    expect(t.gets(/^nodes\/studio-mini$/)).toHaveLength(4);
    expect(attempts(), 'but the tab was not read again').toBe(1);
    /* On Activity: the first page of attempts and of audit events once, however often the machine is read. */
    await t.tabs()[3]!.trigger('click');
    await t.app.settle();
    const activity = () => t!.gets(/\/attempts$/).filter(c => !c.query.target).length;
    expect(activity()).toBe(1);
    for (let i = 0; i < 3; i++) await page.core.run({ quiet: true });
    await t.app.settle();
    expect(activity()).toBe(1);
    expect(t.app.mock.calls.filter(c => c.path === 'audit' && c.query.node).length).toBe(1);
  });

  it('sets the page title to the alias', async () => {
    t = await openNode('/machines/studio-mini');
    expect(document.title).toBe('studio-mini · Fleet Manager');
    await t.go('/audit');
    expect(document.title).toBe('Audit · Fleet Manager');
  });

  it('the first heading takes focus after opening the machine, and a tab change moves it to the active tab', async () => {
    t = await openNode('/machines/studio-mini');
    expect(focused()).toBe('h1');
    expect(document.activeElement?.textContent).toBe('studio-mini');
    await t.tabs()[1]!.trigger('click');
    await t.app.settle();
    await waitFor(() => document.activeElement === t!.find('nav.tabs a[aria-current]').element);
    expect(document.activeElement?.textContent).toContain('Installed');
  });

  it('keeps its tab bar labelled with the alias when it is opened by Node ID', async () => {
    const probe = await mountApp({ path: '/machines' });
    const id = probe.mock.nodes.find(n => n.alias === 'studio-mini')!.id;
    probe.unmount();
    t = await openNode(`/machines/${id}/problems`);
    expect(t.find('.nhero h1').text()).toBe('studio-mini');
    expect(t.gets(new RegExp(`^nodes/${id}$`))).toHaveLength(1);
  });
});

describe('weirdAlias: an alias with a slash, a space and a percent sign', () => {
  it('opens as one encoded path segment and keeps the encoding in every link', async () => {
    t = await openNode('/machines/rack%2FA%20100%25', { weirdAlias: true });
    expect(t.find('.nhero h1').text()).toBe('rack/A 100%');
    const first = t.app.mock.calls.find(c => /^nodes\/[^/]+$/.test(c.path))!;
    expect(first.path, 'alias is sent as one percent-encoded segment').toBe('nodes/rack%2FA%20100%25');
    for (const a of t.tabs()) expect(a.attributes('href')).toMatch(/^\/machines\/rack%2FA%20100%25(\/|$)/);
    expect(t.find('.nhero a.btn-secondary').attributes('href')).toBe('/machines/rack%2FA%20100%25/settings');
    expect(document.title).toBe('rack/A 100% · Fleet Manager');
    await t.go('/machines/rack%2FA%20100%25/activity');
    expect(t.gets(/\/attempts$/)[0]!.path, 'the machine ID, not the alias, is used for sub-resources').toMatch(/^nodes\/[0-9a-f-]{36}\/attempts$/);
  });
});

describe('raceNode and raceBack: overlapping loads', () => {
  it('a late answer for the first machine does not change the page, and actions target the machine on screen', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    t = await openNode('/machines/design-imac', { delay: { 'design-imac': 2500 } }, { wait: false });
    await vi.advanceTimersByTimeAsync(250);
    const target = t.app.mock.nodes.find(n => n.alias === 'studio-mini')!;
    await t.app.router.push('/machines/studio-mini/problems');
    await t.ready('studio-mini');
    await vi.advanceTimersByTimeAsync(3500); // the delayed design-imac answer arrives now
    await t.app.settle();
    expect(t.find('.nhero h1').text(), 'late response for the first machine does not change the page').toBe('studio-mini');
    expect(t.tabs().every(a => a.attributes('href')!.startsWith('/machines/studio-mini')), 'tabs still point at studio-mini').toBe(true);
    const first = t.app.mock.calls.find(c => c.path === 'nodes/design-imac')!;
    expect(first.aborted, 'the request of the page the user left was aborted').toBe(true);

    await t.click('[data-act=retry]');
    await t.until(() => t!.posts(/\/retry$/).length > 0, 'retry request');
    expect(t.posts(/\/retry$/).at(-1)!.path, 'Retry targets studio-mini').toBe(`nodes/${target.id}/retry`);
    await t.until(() => /Retry requested/.test(t!.toasts()), 'retry toast');
    expect(t.toasts()).toContain('studio-mini');
    await t.click('[data-act=revoke-node]');
    await t.until(() => t!.exists('.modal'), 'revoke dialog');
    expect(t.text('.modal h2')).toContain('studio-mini');
  });

  it('returning to the first machine while the second is still loading: the machine opened last stays on screen', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    t = await openNode('/machines/studio-mini', { delay: { 'studio-mini': 2500 } }, { wait: false });
    await vi.advanceTimersByTimeAsync(250);
    await t.app.router.push('/machines/studio-mini');
    await vi.advanceTimersByTimeAsync(100);
    await t.app.router.push('/machines/design-imac/settings');
    await t.ready('design-imac');
    await vi.advanceTimersByTimeAsync(1500);
    await t.app.settle();
    expect(t.find('.nhero h1').text(), 'the machine opened last stays on screen').toBe('design-imac');
    expect((t.find('#rename-alias').element as HTMLInputElement).value, 'settings form belongs to design-imac').toBe('design-imac');
    await vi.advanceTimersByTimeAsync(3000);
    await t.app.settle();
    expect((t.find('#rename-alias').element as HTMLInputElement).value).toBe('design-imac');
  });
});

describe('revoked machines', () => {
  it('shows a retired machine: hero, checks, no problems, no disk, no upgrade, locked-down actions', async () => {
    t = await openNode('/machines/old-laptop');
    expect(t.exists('.nhero--retired')).toBe(true);
    expect(t.text('.nhero-top .pill')).toBe('Retired');
    expect(t.hero()).toContain('Revoked');
    expect(t.hero()).toContain('Its alias stays reserved.');
    expect(t.exists('[data-act=revoke-node]'), 'no Revoke on a revoked machine').toBe(false);
    expect(t.exists('.nhero-actions [data-act=remove-node]'), 'Remove stays available').toBe(true);
    expect(t.exists('.nhero-actions .btn-primary'), 'nothing to fix').toBe(false);
    expect(t.panel()).toContain('Access revoked');
    expect(t.panel()).toContain('Targets frozen');
    expect(t.panel()).toContain('This machine is revoked, so it reports no disk usage.');
    expect(t.exists('#disk-panel [data-act=disk-refresh]') || t.exists('#disk-panel .lock-note'), 'no refresh for a revoked machine').toBe(false);
    expect(t.exists('#agent-upgrade') || t.exists('#machine-panel .chip--update'), 'no upgrade for a revoked machine').toBe(false);
    expect(t.hero()).toContain('revoked');
  });

  it('Problems says the machine is retired; Security shows the revocation and points at Settings; Settings cannot rename', async () => {
    t = await openNode('/machines/old-laptop/problems');
    expect(t.text('#tabpanel h2')).toBe('old-laptop is retired');
    expect(t.panel()).toContain('Revoked machines get no new assignments, so Fleet no longer tracks problems for them.');
    expect(t.exists('article.prob')).toBe(false);
    expect(t.tabText('Problems')).toBe('Problems');
    await t.go('/machines/old-laptop/security');
    expect(t.panel()).toMatch(/Revoked .* ago by .*\. Every certificate for this machine is blocked\./);
    expect(t.exists('.validity'), 'no validity bar once revoked').toBe(false);
    expect(t.text('.panel--danger')).toContain('This machine is already revoked. To free its alias, remove it on the Settings tab.');
    expect(t.find('.panel--danger a').attributes('href')).toBe('/machines/old-laptop/settings');
    await t.go('/machines/old-laptop/settings');
    expect(t.text('#rename-msg')).toBe('Revoked machines cannot be renamed.');
    expect((t.find('#rename-alias').element as HTMLInputElement).disabled).toBe(true);
    expect(t.find('form[data-form=rename] button[type=submit]').attributes('disabled')).toBeDefined();
  });
});

describe('scan: no stray values on any tab', () => {
  it.each(['studio-mini', 'homelab-nuc', 'kitchen-mini', 'lab-vm-07', 'old-laptop', 'fedora-ws', 'build-runner-02'])('%s: no undefined, null, NaN or [object] text and no horizontal overflow markers', async alias => {
    t = await openNode(`/machines/${alias}`);
    for (const tab of ['overview', 'installed', 'problems', 'activity', 'security', 'settings']) {
      await t.go(`/machines/${alias}/${tab}`);
      await sleep(0);
      await t.app.settle();
      expect(stray(textOf(t.find('#view').element)), `${alias}/${tab}`).toEqual([]);
      const bad = t.findAll('#view [href],#view [data-v],#view [data-id]').filter(e => /undefined|null/.test((e.attributes('href') ?? '') + (e.attributes('data-v') ?? '')));
      expect(bad, `${alias}/${tab} links`).toHaveLength(0);
      expect(t.exists('#view h1'), `${alias}/${tab} has an h1`).toBe(true);
    }
  });
});
