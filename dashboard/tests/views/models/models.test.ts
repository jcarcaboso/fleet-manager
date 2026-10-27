/**
 * Models page. Ports of the Dev/drive.js scenarios models, modelsStale, modelsRefreshStale and scopeRead (on this page), plus the
 * editor (families, flags, dirty state, reset, tabs), save failures (stale_selection, pinned_model_excluded, catalog_unavailable),
 * refresh outcomes, scope, loading, error and abort states.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogSelection, CliProxyStatus, SaveSelectionResponse, SelectionPolicy } from '@/api/types';
import { mountApp, textOf, waitFor, type TestApp } from '../../helpers/app';
import { changedCount, effective, interval, makeEntry, snapshot } from '../../../src/views/Models/modelsPolicy';

let app: TestApp | undefined;
afterEach(() => { app?.unmount(); app = undefined; vi.useRealTimers(); });

const w = () => app!.wrapper;
const toasts = () => textOf(w().find('#toasts').element);
const box = (id: string) => w().find(`input[data-sel-model="${id}"]`);
const checked = (id: string) => (box(id).element as HTMLInputElement).checked;
const sw = (label: string) => w().find(`button[role=switch][aria-label="${label}"]`);
const bar = () => w().find('.sel-bar');
const saveBtn = () => w().find('[data-act=sel-save]');
const resetBtn = () => w().find('[data-act=sel-reset]');
const posts = (path: string) => app!.mock.calls.filter(c => c.method === 'POST' && c.path === path);
const tabs = () => w().findAll('.seg-ctl button');
const msg = () => w().find('#sel-msg').text();
const selection = async () => (await app!.ctx.api.get<{ catalogs: CatalogSelection[] }>('cliproxy/selection')).catalogs;
const PRIMARY = 'https://proxy.lab.internal/v1';

describe('Models page: catalogs', () => {
  it('shows the key bar, each catalog with its health, and the failing one with its error and a link to Problems', async () => {
    app = await mountApp({ path: '/models' });
    expect(w().find('h1').text()).toBe('Models');
    expect(w().find('.keybar').text()).toContain('Fleet key configured');
    expect(w().find('.keybar').text()).toContain('Refreshes every 1 hour');
    const cards = w().findAll('section.cat');
    expect(cards).toHaveLength(2);
    expect(cards[0]!.find('h2').text()).toBe('proxy.lab.internal');
    expect(cards[0]!.find('.mono.small').text()).toBe(PRIMARY);
    expect(cards[0]!.find('.pill').text()).toBe('Healthy');
    expect(cards[0]!.classes()).not.toContain('cat--err');
    expect(cards[0]!.findAll('dd').map(d => d.text())).toEqual(['8', expect.stringMatching(/ago$/), expect.stringMatching(/^in /)]);
    expect(cards[1]!.classes()).toContain('cat--err');
    expect(cards[1]!.find('.pill').text()).toBe('Refresh failing');
    expect(cards[1]!.find('.callout--critical b').text()).toContain('upstream_http_401');
    expect(cards[1]!.find('.callout--critical p').text()).toMatch(/Agents keep the last valid catalog, .+ old, so AI clients keep working\./);
    expect(cards[1]!.find('a.more').attributes('href')).toBe('/problems');
    expect(cards[1]!.find('a.more').text()).toBe('See Problems');
    expect(w().find('#nav .nav-g').exists(), 'the Models nav shows the failing catalog').toBe(true);
  });

  it('reads the catalog title and explanation of the error code when the catalog has them', async () => {
    app = await mountApp({ path: '/audit' });
    const real = app.ctx.catalog.get.bind(app.ctx.catalog);
    (app.ctx.catalog as { get: unknown }).get = (code: string) => (code === 'upstream_http_401'
      ? { code, source: 'server', title: 'CLIProxy refused the key', explanation: 'The Fleet key was rejected by `CLIProxy`.', fix: [] }
      : real(code));
    await app.go('/models');
    const b = w().findAll('section.cat')[1]!.find('.callout--critical');
    expect(b.find('b').text()).toBe('upstream_http_401: CLIProxy refused the key');
    expect(b.find('p code').text()).toBe('CLIProxy');
  });

  it('says so when the Fleet key is not configured', async () => {
    app = await mountApp({ path: '/audit' });
    const real = app.ctx.api.get.bind(app.ctx.api);
    (app.ctx.api as { get: unknown }).get = async (path: string, ...rest: unknown[]) => {
      const r = await (real as (p: string, ...r: unknown[]) => Promise<unknown>)(path, ...rest);
      return path === 'cliproxy/status' ? { ...(r as CliProxyStatus), enabled: false, catalogs: [] } : r;
    };
    await app.go('/models');
    expect(w().find('.keybar').text()).toContain('No CLIProxy key');
    expect(w().find('.callout--warning b').text()).toBe('Model sync is disabled');
    expect(w().find('.cols').exists()).toBe(false);
  });

  it('with a key but no catalogs, explains how they appear; with no selections, says so', async () => {
    app = await mountApp({ path: '/audit' });
    const real = app.ctx.api.get.bind(app.ctx.api);
    (app.ctx.api as { get: unknown }).get = async (path: string, ...rest: unknown[]) => {
      if (path === 'cliproxy/selection') return { catalogs: [] };
      const r = await (real as (p: string, ...r: unknown[]) => Promise<unknown>)(path, ...rest);
      return path === 'cliproxy/status' ? { ...(r as CliProxyStatus), catalogs: [] } : r;
    };
    await app.go('/models');
    expect(w().find('.empty h2').text()).toBe('No CLIProxy catalogs yet');
    expect(w().find('.panel .empty-mini p').text()).toBe('No model selections are available. Refresh models after assigning CLIProxy to an active machine.');
    expect(w().find('.sel-bar').exists()).toBe(false);
  });

  it('the selection failing to load stays local to the selection panel', async () => {
    app = await mountApp({ path: '/models', mock: { fail: 'cliproxy/selection' } });
    expect(w().find('h1').text()).toBe('Models');
    expect(w().findAll('section.cat')).toHaveLength(2);
    const panel = w().findAll('section.panel').find(p => p.find('h2').text() === 'Model selection')!;
    expect(panel.find('.callout--critical').text()).toContain('Could not load the model selection');
    expect(panel.find('.empty-mini').exists(), 'no second "no selections" message').toBe(false);
  });
});

describe('Models page: the selection editor', () => {
  it('lists families alphabetically with models, reasoning levels, counts and switches', async () => {
    app = await mountApp({ path: '/models' });
    expect(w().findAll('fieldset.fam .fam-name').map(n => n.text())).toEqual(['Claude', 'Gemini', 'GPT 6']);
    expect(w().findAll('fieldset.fam .fam-head .muted').map(n => n.text())).toEqual(['3 of 4 selected', '2 of 2 selected', '1 of 2 selected']);
    expect(w().find('fieldset.fam legend').text()).toBe('Claude models');
    expect(checked('claude-opus-4-1')).toBe(true);
    expect(checked('claude-sonnet-4-20250514')).toBe(false);
    expect(checked('gpt-6-chat-latest')).toBe(false);
    expect([...box('gpt-6-codex').element.closest('li')!.querySelectorAll('.lvl')].map(l => l.textContent)).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(box('gpt-6-codex').element.closest('li')!.querySelector('.levels')!.getAttribute('aria-label')).toBe('Reasoning levels');
    expect(sw('Sync Claude models').attributes('aria-checked')).toBe('true');
    expect(sw('Skip Claude models for other clients').attributes('aria-checked')).toBe('true');
    expect(sw('Enable newly discovered families by default').attributes('aria-checked')).toBe('true');
    expect(bar().text()).toContain('All changes saved');
    expect(bar().attributes('role')).toBe('status');
    expect(resetBtn().attributes('disabled')).toBeDefined();
    expect(saveBtn().attributes('disabled')).toBeDefined();
    expect(w().find('#sel-msg').attributes('role')).toBe('status');
  });

  it('a change makes the bar dirty with a count; Reset puts everything back', async () => {
    app = await mountApp({ path: '/models' });
    await box('claude-sonnet-4-20250514').setValue(true);
    expect(checked('claude-sonnet-4-20250514')).toBe(true);
    expect(bar().classes()).toContain('is-dirty');
    expect(bar().text()).toContain('1 unsaved change for proxy.lab.internal');
    expect(saveBtn().attributes('disabled')).toBeUndefined();
    expect(resetBtn().attributes('disabled')).toBeUndefined();
    expect(w().findAll('fieldset.fam .fam-head .muted')[0]!.text()).toBe('4 of 4 selected');
    await box('gemini-2.5-pro').setValue(false);
    expect(bar().text()).toContain('2 unsaved changes for proxy.lab.internal');
    await resetBtn().trigger('click');
    expect(checked('claude-sonnet-4-20250514')).toBe(false);
    expect(checked('gemini-2.5-pro')).toBe(true);
    expect(bar().text()).toContain('All changes saved');
    expect(saveBtn().attributes('disabled')).toBeDefined();
  });

  it('putting a model back to its saved state is no change', async () => {
    app = await mountApp({ path: '/models' });
    await box('claude-opus-4-1').setValue(false);
    expect(bar().classes()).toContain('is-dirty');
    await box('claude-opus-4-1').setValue(true);
    expect(bar().classes()).not.toContain('is-dirty');
  });

  it('a family switch turns a whole family on or off and drops its model overrides', async () => {
    app = await mountApp({ path: '/models' });
    await sw('Sync GPT 6 models').trigger('click');
    expect(sw('Sync GPT 6 models').attributes('aria-checked')).toBe('false');
    expect(checked('gpt-6-codex') || checked('gpt-6-chat-latest')).toBe(false);
    expect(w().findAll('fieldset.fam .fam-head .muted')[2]!.text()).toBe('0 of 2 selected');
    await sw('Sync GPT 6 models').trigger('click');
    expect(sw('Sync GPT 6 models').attributes('aria-checked')).toBe('true');
    expect(checked('gpt-6-codex') && checked('gpt-6-chat-latest'), 'the override that excluded gpt-6-chat-latest is gone').toBe(true);
    expect(bar().text()).toContain('1 unsaved change');
  });

  it('the two options toggle and count as changes', async () => {
    app = await mountApp({ path: '/models' });
    await sw('Skip Claude models for other clients').trigger('click');
    expect(sw('Skip Claude models for other clients').attributes('aria-checked')).toBe('false');
    await sw('Enable newly discovered families by default').trigger('click');
    expect(sw('Enable newly discovered families by default').attributes('aria-checked')).toBe('false');
    expect(bar().text()).toContain('2 unsaved changes');
    expect(w().findAll('.opt b').map(b => b.text())).toEqual(['Skip Claude models for other clients', 'Enable newly discovered families by default']);
  });

  it('with two catalogs, tabs switch the editor and mark unsaved changes; each keeps its own edits', async () => {
    app = await mountApp({ path: '/models' });
    expect(tabs().map(t => t.text())).toEqual(['proxy.lab.internal', 'proxy-backup.lab.internal']);
    expect(w().find('.seg-ctl').attributes('role')).toBe('group');
    expect(tabs().map(t => t.attributes('aria-pressed'))).toEqual(['true', 'false']);
    await box('gemini-2.5-pro').setValue(false);
    expect(tabs()[0]!.find('.dirty-dot').attributes('aria-label')).toBe('unsaved changes');
    expect(tabs()[1]!.find('.dirty-dot').exists()).toBe(false);
    await tabs()[1]!.trigger('click');
    expect(tabs().map(t => t.attributes('aria-pressed'))).toEqual(['false', 'true']);
    expect(box('claude-opus-4-1').exists() && !checked('claude-opus-4-1')).toBe(true);
    expect(bar().text()).toContain('All changes saved');
    expect(sw('Skip Claude models for other clients').attributes('aria-checked')).toBe('false');
    await tabs()[0]!.trigger('click');
    expect(checked('gemini-2.5-pro')).toBe(false);
    expect(bar().text()).toContain('1 unsaved change for proxy.lab.internal');
  });
});

describe('Models page: saving (models)', () => {
  it('Save posts the base URL, version and policy, then shows the saved state and tells the user', async () => {
    app = await mountApp({ path: '/models' });
    const before = (await selection())[0]!;
    await box('claude-sonnet-4-20250514').setValue(true);
    await saveBtn().trigger('click');
    expect(saveBtn().text()).toBe('Saving…');
    expect(saveBtn().attributes('disabled')).toBeDefined();
    expect(box('claude-opus-4-1').attributes('disabled'), 'the controls are off while saving').toBeDefined();
    expect(msg()).toBe('Saving selection for proxy.lab.internal…');
    await waitFor(() => /Selection saved/.test(toasts()), { label: 'saved toast' });
    expect(toasts()).toContain('proxy.lab.internal. Agents receive it on their next poll.');
    await waitFor(() => /Selection saved for proxy\.lab\.internal\. Agents receive it on their next poll\./.test(msg()));
    const body = posts('cliproxy/selection')[0]!.body as { baseUrl: string; version: number; policy: SelectionPolicy };
    expect(body.baseUrl).toBe(PRIMARY);
    expect(body.version).toBe(before.version);
    expect(body.policy.modelOverrides['claude-sonnet-4-20250514']).toBeUndefined();
    expect(body.policy.modelOverrides['gpt-6-chat-latest']).toBe(false);
    expect(bar().text()).toContain('All changes saved');
    expect(saveBtn().text()).toBe('Save selection');
    expect(checked('claude-sonnet-4-20250514')).toBe(true);
    const after = (await selection())[0]!;
    expect(after.version).toBe(before.version + 1);
    expect(after.models.find(m => m.id === 'claude-sonnet-4-20250514')!.selected).toBe(true);
    // The next save uses the new version.
    await box('gemini-2.5-flash').setValue(false);
    await saveBtn().trigger('click');
    await waitFor(() => posts('cliproxy/selection').length === 2 && /Selection saved for/.test(msg()) && bar().text().includes('All changes saved'), { label: 'second save' });
    expect((posts('cliproxy/selection')[1]!.body as { version: number }).version).toBe(before.version + 1);
  });

  it('freezes the families that are in neither list to the default before switching the default', async () => {
    app = await mountApp({ path: '/models' });
    await sw('Enable newly discovered families by default').trigger('click');
    await saveBtn().trigger('click');
    await waitFor(() => posts('cliproxy/selection').length === 1);
    const policy = (posts('cliproxy/selection')[0]!.body as { policy: SelectionPolicy }).policy;
    expect(policy.includeNew).toBe(false);
    expect([...policy.enabledFamilies].sort()).toEqual(['claude', 'gemini', 'gpt-6']);
    await waitFor(() => /Selection saved/.test(toasts()));
  });

  it('a stale selection (someone saved first): explained, and the page shows what the Server has now', async () => {
    app = await mountApp({ path: '/models' });
    const [primary] = await selection();
    await app.ctx.api.post('cliproxy/selection', { baseUrl: PRIMARY, version: primary!.version, policy: { ...primary!.policy, modelOverrides: { ...primary!.policy.modelOverrides, 'gemini-2.5-flash': false } } });
    await box('claude-sonnet-4-20250514').setValue(true);
    await saveBtn().trigger('click');
    await waitFor(() => toasts().includes('Selection was not saved'), { label: 'error toast' });
    await waitFor(() => msg() === 'Another operator saved this selection. It was reloaded; review it and save again.', { label: 'message' });
    expect(bar().text(), 'the unsaved edit is replaced by the Server\'s selection').toContain('All changes saved');
    expect(checked('gemini-2.5-flash'), 'which includes the other Operator\'s change').toBe(false);
    expect(checked('claude-sonnet-4-20250514')).toBe(false);
    expect(saveBtn().text()).toBe('Save selection');
    expect(w().find('#toasts .toast').exists()).toBe(true);
  });

  it('excluding a pinned model is refused and the pinned models are named', async () => {
    app = await mountApp({ path: '/models' });
    await box('gpt-6-codex').setValue(false);
    await saveBtn().trigger('click');
    await waitFor(() => /Pinned models:/.test(msg()), { label: 'pinned message' });
    expect(msg()).toMatch(/^A pinned default model cannot be excluded\./);
    expect(msg()).toContain('Pinned models: gpt-6-codex.');
    expect(toasts()).toContain('Selection was not saved');
    expect(bar().classes(), 'the edit stays so it can be corrected').toContain('is-dirty');
    expect(saveBtn().attributes('disabled')).toBeUndefined();
    expect(checked('gpt-6-codex')).toBe(false);
  });

  it('a catalog that is no longer available reloads the selections and explains', async () => {
    app = await mountApp({ path: '/models' });
    const real = app.ctx.api.post.bind(app.ctx.api);
    (app.ctx.api as { post: unknown }).post = (path: string, ...rest: unknown[]) =>
      (path === 'cliproxy/selection' ? Promise.reject(Object.assign(new Error('No model catalog is available for that proxy yet.'), { status: 404, code: 'catalog_unavailable', silent: false })) : (real as (p: string, ...r: unknown[]) => Promise<unknown>)(path, ...rest));
    await box('claude-sonnet-4-20250514').setValue(true);
    await saveBtn().trigger('click');
    await waitFor(() => msg() === 'No model catalog is available for that proxy yet.');
    expect(bar().text()).toContain('All changes saved');
    expect(calls('cliproxy/selection').length).toBeGreaterThanOrEqual(2);
  });

  it('a refusal by scope (403) is explained and the edit stays', async () => {
    app = await mountApp({ path: '/models', mock: { forbid: true } });
    await box('claude-sonnet-4-20250514').setValue(true);
    await saveBtn().trigger('click');
    await waitFor(() => /Selection was not saved/.test(toasts()));
    expect(msg()).toMatch(/scope does not allow/);
    expect(bar().classes()).toContain('is-dirty');
    expect(saveBtn().text()).toBe('Save selection');
  });

  it('a save that answers after the user left does not repaint the page the user is on (modelsStale)', async () => {
    app = await mountApp({ path: '/models', mock: { lag: { 'cliproxy/selection': 400 } } });
    await box('claude-sonnet-4-20250514').setValue(true);
    await saveBtn().trigger('click');
    await new Promise(r => setTimeout(r, 100));
    await app.go('/audit');
    await waitFor(() => w().find('h1').text() === 'Audit' && !w().find('.skel').exists());
    const page = w().find('#view').element.firstElementChild;
    const audits = app.mock.calls.filter(c => c.path === 'audit').length;
    await waitFor(() => /Selection saved/.test(toasts()), { label: 'a toast says the selection was saved', timeout: 3000 });
    await new Promise(r => setTimeout(r, 150));
    expect(app.router.currentRoute.value.path).toBe('/audit');
    expect(w().find('#view').element.firstElementChild).toBe(page);
    expect(app.mock.calls.filter(c => c.path === 'audit')).toHaveLength(audits);
    await app.go('/models');
    expect(bar().text(), 'the saved selection is what the page shows afterwards').toContain('All changes saved');
    expect(checked('claude-sonnet-4-20250514')).toBe(true);
  });

  it('a save that answers after the user came back reloads the Models page that is open now', async () => {
    app = await mountApp({ path: '/models' });
    // The Server saves late: the answer is held until the user is back on a fresh Models page that loaded the old state.
    const real = app.ctx.api.post.bind(app.ctx.api);
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    (app.ctx.api as { post: unknown }).post = async (path: string, ...rest: unknown[]) => {
      if (path !== 'cliproxy/selection') return (real as (p: string, ...r: unknown[]) => Promise<unknown>)(path, ...rest);
      await held;
      return (real as (p: string, ...r: unknown[]) => Promise<unknown>)(path, ...rest);
    };
    await box('claude-sonnet-4-20250514').setValue(true);
    await saveBtn().trigger('click');
    await app.go('/audit');
    await app.go('/models');
    expect(checked('claude-sonnet-4-20250514'), 'the new page loaded before the Server saved').toBe(false);
    release();
    await waitFor(() => checked('claude-sonnet-4-20250514'), { label: 'the open page catches up', timeout: 4000 });
    expect(bar().text()).toContain('All changes saved');
    expect(toasts()).toContain('Selection saved');
  });

  it('shows no second save while one runs', async () => {
    app = await mountApp({ path: '/models' });
    app.mock.options.slow = 100;
    await box('claude-sonnet-4-20250514').setValue(true);
    await saveBtn().trigger('click');
    await saveBtn().trigger('click');
    await waitFor(() => /Selection saved for/.test(msg()), { timeout: 3000 });
    expect(posts('cliproxy/selection')).toHaveLength(1);
  });
});

const calls = (path: string) => app!.mock.calls.filter(c => c.path === path);

describe('Models page: Refresh models (modelsRefreshStale)', () => {
  it('posts the refresh, reports a catalog that still fails, and reloads the selections', async () => {
    app = await mountApp({ path: '/models' });
    await box('claude-sonnet-4-20250514').setValue(true);
    await w().find('[data-act=refresh-models]').trigger('click');
    expect(w().find('[data-act=refresh-models]').text()).toBe('Refreshing…');
    expect(w().find('[data-act=refresh-models]').attributes('disabled')).toBeDefined();
    expect(toasts()).toContain('Refreshing model catalogs');
    await waitFor(() => /A catalog is still failing/.test(toasts()), { label: 'refresh result' });
    expect(toasts()).toContain('Refreshed. 1 catalog updated; proxy-backup.lab.internal still fails (upstream_http_401).');
    expect(w().find('p.result[role=status]').text()).toBe('Refreshed. 1 catalog updated; proxy-backup.lab.internal still fails (upstream_http_401).');
    await waitFor(() => w().find('[data-act=refresh-models]').text() === 'Refresh models');
    expect(posts('cliproxy/refresh')).toHaveLength(1);
    expect(checked('claude-sonnet-4-20250514'), 'the selections are read again, so an unsaved edit is replaced by the Server\'s state').toBe(false);
    expect(bar().text()).toContain('All changes saved');
  });

  it('when every catalog refreshes, says so', async () => {
    app = await mountApp({ path: '/models' });
    const real = app.ctx.api.post.bind(app.ctx.api);
    (app.ctx.api as { post: unknown }).post = async (path: string, ...rest: unknown[]) => {
      const r = await (real as (p: string, ...r: unknown[]) => Promise<CliProxyStatus>)(path, ...rest);
      return path === 'cliproxy/refresh' ? { ...r, catalogs: r.catalogs.map(c => ({ ...c, outcome: 'succeeded', errorCode: null })) } : r;
    };
    await w().find('[data-act=refresh-models]').trigger('click');
    await waitFor(() => /Model catalogs refreshed/.test(toasts()));
    expect(w().find('p.result').text()).toBe('Refreshed. All catalogs updated.');
    expect(app.ctx.shared.lastRefresh?.level).toBe('good');
  });

  it('with no catalog in use, says so', async () => {
    app = await mountApp({ path: '/models' });
    const real = app.ctx.api.post.bind(app.ctx.api);
    (app.ctx.api as { post: unknown }).post = async (path: string, ...rest: unknown[]) => {
      const r = await (real as (p: string, ...r: unknown[]) => Promise<CliProxyStatus>)(path, ...rest);
      return path === 'cliproxy/refresh' ? { ...r, catalogs: [] } : r;
    };
    await w().find('[data-act=refresh-models]').trigger('click');
    await waitFor(() => /Refreshed\. No catalogs are in use yet\./.test(toasts()));
  });

  it('a refresh that cannot be confirmed is explained', async () => {
    app = await mountApp({ path: '/models', mock: { forbid: true } });
    await w().find('[data-act=refresh-models]').trigger('click');
    await waitFor(() => /Model refresh could not be confirmed/.test(toasts()));
    expect(w().find('[data-act=refresh-models]').text()).toBe('Refresh models');
    expect(app.ctx.shared.lastRefresh).toBeNull();
  });

  it('a refresh that answers after the user left does not repaint the page the user is on', async () => {
    app = await mountApp({ path: '/models', mock: { lag: { 'cliproxy/refresh': 400 } } });
    await w().find('[data-act=refresh-models]').trigger('click');
    await new Promise(r => setTimeout(r, 100));
    await app.go('/audit');
    await waitFor(() => w().find('h1').text() === 'Audit' && !w().find('.skel').exists());
    const page = w().find('#view').element.firstElementChild;
    await waitFor(() => /catalogs? refreshed|still failing/i.test(toasts()), { label: 'a toast reports the refresh', timeout: 3000 });
    await new Promise(r => setTimeout(r, 150));
    expect(w().find('#view').element.firstElementChild).toBe(page);
    expect(app.ctx.shared.refreshing).toBe(false);
  });

  it('the navigation badge is read again after a refresh', async () => {
    app = await mountApp({ path: '/models' });
    const before = calls('cliproxy/status').length;
    await w().find('[data-act=refresh-models]').trigger('click');
    await waitFor(() => /still failing/.test(toasts()));
    await waitFor(() => calls('cliproxy/status').length > before);
  });
});

describe('Models page: scope (scopeRead)', () => {
  it('a read token sees the selection but cannot change it: locked Save and Refresh with reasons, disabled switches', async () => {
    app = await mountApp({ path: '/models', mock: { scope: 'read' } });
    const locked = w().findAll('.is-locked');
    expect(locked.map(b => b.text())).toEqual(expect.arrayContaining(['Refresh models', 'Save selection']));
    expect(locked.every(b => b.attributes('aria-disabled') === 'true' && !!b.attributes('data-tip'))).toBe(true);
    expect(w().find('.lock-note').text()).toBe('Needs the operate scope. Your token has read access.');
    expect(box('claude-opus-4-1').attributes('disabled')).toBeDefined();
    expect(sw('Sync Claude models').attributes('disabled')).toBeDefined();
    expect(sw('Skip Claude models for other clients').attributes('disabled')).toBeDefined();
    await locked[0]!.trigger('click');
    await app.settle();
    expect(toasts()).toContain('Not available');
    expect(toasts()).toMatch(/Needs the operate scope/);
    expect(app.mock.calls.filter(c => c.method === 'POST' && c.path !== 'login')).toHaveLength(0);
    expect(resetBtn().attributes('disabled')).toBeDefined();
  });

  it('an operate token can save and refresh', async () => {
    app = await mountApp({ path: '/models', mock: { scope: 'operate' } });
    expect(w().find('.is-locked').exists()).toBe(false);
    await box('claude-sonnet-4-20250514').setValue(true);
    await saveBtn().trigger('click');
    await waitFor(() => /Selection saved/.test(toasts()));
  });
});

describe('Models page: loading, errors and aborts', () => {
  it('shows the loading skeleton, then the page', async () => {
    app = await mountApp({ path: '/audit' });
    app.mock.options.slow = 150;
    void app.router.push('/models');
    await waitFor(() => w().find('[role=status] .skel').exists());
    await waitFor(() => w().find('.keybar').exists(), { timeout: 5000 });
  });

  it('a failing status read shows the page error, and Try again recovers', async () => {
    app = await mountApp({ path: '/models', mock: { fail: 'cliproxy/status' } });
    expect(w().find('h1').text()).toBe('Could not load Models');
    app.mock.options.fail = null;
    await w().find('.empty--error button').trigger('click');
    await waitFor(() => w().find('.keybar').exists());
  });

  it('a token that cannot read shows "Your token cannot open this"', async () => {
    app = await mountApp({ path: '/audit' });
    const real = app.ctx.api.get.bind(app.ctx.api);
    (app.ctx.api as { get: unknown }).get = (path: string, ...rest: unknown[]) =>
      (path === 'cliproxy/status' ? Promise.reject(Object.assign(new Error('Your Operator scope does not allow this action.'), { status: 403, silent: false })) : (real as (p: string, ...r: unknown[]) => Promise<unknown>)(path, ...rest));
    await app.go('/models');
    expect(w().find('h1').text()).toBe('Your token cannot open this');
  });

  it('leaving the page aborts the reads in flight', async () => {
    app = await mountApp({ path: '/audit', mock: { hang: 'cliproxy/' } });
    await app.go('/models');
    const hung = app.mock.calls.filter(c => c.path.startsWith('cliproxy/') && !c.settled);
    expect(hung.map(c => c.path)).toEqual(expect.arrayContaining(['cliproxy/status', 'cliproxy/selection']));
    await app.go('/audit');
    expect(hung.filter(c => c.path === 'cliproxy/selection').every(c => c.aborted)).toBe(true);
    expect(hung.some(c => c.path === 'cliproxy/status' && c.aborted), 'the page\'s own status read is aborted (the shell\'s badge read is not the page\'s)').toBe(true);
  });

  it('no stray undefined, null, NaN or Invalid Date text (scan)', async () => {
    app = await mountApp({ path: '/models' });
    expect(textOf(w().find('#view').element)).not.toMatch(/undefined|\bnull\b|NaN|Invalid Date|\[object/);
    expect(document.title).toBe('Models · Fleet Manager');
  });
});

describe('model policy rules', () => {
  const entry = (policy: Partial<SelectionPolicy>) => makeEntry({
    baseUrl: 'https://p/v1', version: 1,
    models: [
      { id: 'a1', reasoningLevels: [], familyKey: 'a', familyLabel: 'A', selected: true },
      { id: 'a2', reasoningLevels: [], familyKey: 'a', familyLabel: 'A', selected: true },
      { id: 'b1', reasoningLevels: [], familyKey: 'b', familyLabel: 'B', selected: false },
      { id: 'x1', reasoningLevels: [], familyKey: '', familyLabel: '', selected: false },
    ],
    policy: { includeNew: false, skipClaudeModelsForOtherClients: true, enabledFamilies: ['a'], disabledFamilies: ['b'], modelOverrides: {}, ...policy },
  });

  it('a model override wins over its family, a family wins over the default', () => {
    const e = entry({ modelOverrides: { a2: false, b1: true } });
    expect(e.models.map(m => effective(e.policy, m))).toEqual([true, false, true, false]);
    const open = entry({ includeNew: true });
    expect(effective(open.policy, open.models[3]!), 'a model without a family is "other" and follows the default').toBe(true);
  });

  it('the snapshot ignores the order of lists and keys; the count is per model and per option', () => {
    expect(snapshot(entry({ modelOverrides: { a2: false, a1: false } }).policy)).toBe(snapshot(entry({ enabledFamilies: ['a'], modelOverrides: { a1: false, a2: false } }).policy));
    const e = entry({});
    e.policy.skipClaudeModelsForOtherClients = false;
    e.policy.modelOverrides = { a1: true };
    expect(changedCount(e)).toBe(1 + 0 + 0);
    e.policy.includeNew = true;
    expect(changedCount(e)).toBe(2 + 1);
  });

  it('formats the refresh interval in the largest exact unit', () => {
    expect([86400, 172800, 7200, 3600, 120, 60, 90, 1].map(interval)).toEqual(['1 day', '2 days', '2 hours', '1 hour', '2 minutes', '1 minute', '90 seconds', '1 second']);
  });

  it('SaveSelectionResponse entries replace the edited one and are clean', () => {
    const saved: SaveSelectionResponse = { catalog: { baseUrl: 'u', version: 2, models: [], policy: { includeNew: true, skipClaudeModelsForOtherClients: false, enabledFamilies: [], disabledFamilies: [], modelOverrides: {} } } };
    const e = makeEntry(saved.catalog);
    expect(e.saved).toBe(JSON.stringify(e.policy));
    expect(changedCount(e)).toBe(0);
  });
});
