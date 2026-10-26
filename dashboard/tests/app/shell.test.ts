import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssuesResponse } from '@/api/types';
import { mountApp, settle, textOf, waitFor, type TestApp } from '../helpers/app';

let app: TestApp | undefined;
afterEach(() => { app?.unmount(); vi.useRealTimers(); });

const navLabels = (a: TestApp): string[] => a.wrapper.findAll('#nav a').map(l => l.text());

describe('shell', () => {
  it('renders the brand, the primary navigation, the user menu, the footer and the mount points', async () => {
    app = await mountApp();
    const w = app.wrapper;
    expect(w.find('a.skip').text()).toBe('Skip to content');
    expect(w.find('a.brand').attributes('href')).toBe('/machines');
    expect(w.find('nav#nav').attributes('aria-label')).toBe('Primary');
    expect(navLabels(app).map(t => t.replace(/\d+$/, '').trim())).toEqual(['Machines', 'Problems', 'Deployments', 'Repository', 'Models', 'Enrollment', 'Audit']);
    expect(w.findAll('#nav a').map(a => a.attributes('href'))).toEqual(['/machines', '/problems', '/deployments', '/repository', '/models', '/enrollment', '/audit']);
    expect(w.find('#me .me-name').text()).toBe('joan');
    expect(w.find('#me .av').text()).toBe('J');
    expect(w.find('#me .scope-chip').text()).toBe('admin');
    expect(w.find('#me .scope-chip').attributes('data-tip')).toBe('Scope: admin|Can change anything.');
    expect(w.find('#me button').text()).toBe('Sign out');
    expect(w.find('main#main').attributes('tabindex')).toBe('-1');
    expect(w.find('footer.foot').text()).toContain('Fleet Manager · All times in UTC');
    expect(w.find('#foot-note').text()).toMatch(/^Loaded \d\d:\d\d UTC$/);
    expect(w.find('#modal-root').attributes('hidden')).toBeDefined();
    expect(w.find('#toasts').attributes('role')).toBe('status');
    expect(w.find('#tip').attributes('role')).toBe('tooltip');
    expect(document.title).toBe('Machines · Fleet Manager');
    expect(w.find('svg.defs').exists()).toBe(true);
  });

  it('marks the page of the route with aria-current, and Deployments for a revision', async () => {
    app = await mountApp({ path: '/problems' });
    expect(app.wrapper.find('#nav a[aria-current="page"]').text()).toMatch(/^Problems/);
    await app.go('/deployments/00000000-0000-4000-a000-000000000001');
    expect(app.wrapper.find('#nav a[aria-current="page"]').text()).toBe('Deployments');
    await app.go('/machines/studio-mini/problems');
    expect(app.wrapper.find('#nav a[aria-current="page"]').text()).toBe('Machines');
    expect(app.wrapper.findAll('#nav a[aria-current]')).toHaveLength(1);
  });

  it('shows the scope chip for read and operate', async () => {
    app = await mountApp({ mock: { scope: 'read' } });
    expect(app.wrapper.find('.scope-chip').text()).toBe('read');
    expect(app.wrapper.find('.scope-chip').attributes('data-tip')).toContain('Cannot change anything');
    expect(app.wrapper.find('.scope-chip svg').exists()).toBe(true);
    app.unmount();
    app = await mountApp({ mock: { scope: 'operate' } });
    expect(app.wrapper.find('.scope-chip').attributes('data-tip')).toContain('Cannot enroll or revoke');
  });

  it('follows a scope change of the session', async () => {
    app = await mountApp();
    app.setScope('read');
    await app.settle();
    expect(app.wrapper.find('.scope-chip').text()).toBe('read');
    expect(app.ctx.session.can('operate')).toBe(false);
    expect(app.mock.state.scope).toBe('read');
  });

  it('hides the navigation and the user menu on the login page', async () => {
    app = await mountApp({ mock: { signedOut: true } });
    expect(app.wrapper.find('#nav').exists()).toBe(false);
    expect(app.wrapper.find('#me').exists()).toBe(false);
    expect(app.wrapper.find('a.brand').exists()).toBe(true);
    expect(document.title).toBe('Sign in · Fleet Manager');
  });

  it('shows the open errors on Problems and a warning glyph on Models while a catalog fails', async () => {
    app = await mountApp();
    const issues = await app.ctx.api.get<IssuesResponse>('issues');
    const errors = issues.items.filter(i => i.severity === 'error').length;
    expect(errors).toBeGreaterThan(0);
    await waitFor(() => app!.wrapper.find('#nav .nav-badge').exists());
    const badge = app.wrapper.find('#nav .nav-badge');
    expect(badge.text()).toBe(String(errors));
    expect(badge.attributes('aria-label')).toBe(`${errors} open errors`);
    expect(textOf(app.wrapper.findAll('#nav a')[1]!.element)).toBe(`Problems ${errors}`);
    const models = app.wrapper.findAll('#nav a')[4]!;
    expect(models.find('.nav-g').attributes('aria-label')).toBe('A catalog is failing');
    expect(models.find('.nav-g svg.g').exists()).toBe(true);
    expect(app.ctx.summary.state.modelsBad).toBe(true);
  });

  it('counts open errors only: acknowledging one lowers the badge, after a forced refresh', async () => {
    app = await mountApp();
    await waitFor(() => app!.ctx.summary.state.errors > 0);
    const before = app.ctx.summary.state.errors;
    const issues = (await app.ctx.api.get<IssuesResponse>('issues')).items;
    const first = issues.find(i => i.severity === 'error')!;
    await app.ctx.api.post('issues/state', { id: first.id, action: 'acknowledge' });
    await app.ctx.summary.refresh(true);
    await app.settle();
    expect(app.ctx.summary.state.errors).toBe(before - 1);
    expect(app.wrapper.find('#nav .nav-badge').text()).toBe(String(before - 1));
  });

  it('has no badges when nothing is wrong', async () => {
    app = await mountApp({ mock: { empty: true, fail: 'cliproxy' } });
    await settle();
    expect(app.ctx.summary.state.at).toBeGreaterThan(0);
    expect(app.wrapper.find('#nav .nav-badge').exists()).toBe(false);
    expect(app.wrapper.find('#nav .nav-g').exists()).toBe(false);
  });

  it('a failing read leaves its badge out and keeps the other', async () => {
    app = await mountApp({ mock: { fail: 'issues' } });
    await waitFor(() => app!.ctx.summary.state.modelsBad);
    expect(app.wrapper.find('#nav .nav-badge').exists()).toBe(false);
    expect(app.wrapper.find('#nav .nav-g').exists()).toBe(true);
    expect(app.ctx.toasts.items).toHaveLength(0);
  });

  it('refreshes the badges on navigation, at most every 20 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    app = await mountApp({ path: '/audit' });
    const reads = () => app!.mock.calls.filter(c => c.path === 'issues').length;
    await settle();
    const first = reads();
    expect(first).toBe(1);
    await app.go('/enrollment');
    await app.go('/audit');
    expect(reads()).toBe(first);
    await vi.advanceTimersByTimeAsync(21_000);
    await app.go('/models');
    expect(reads()).toBe(first + 1);
  });

  it('updates the footer note and moves focus to the new page heading after a navigation', async () => {
    app = await mountApp();
    await app.go('/audit');
    expect(document.activeElement?.tagName).toBe('H1');
    expect(textOf(document.activeElement)).toBe('Audit');
    await app.go('/repository');
    expect(textOf(document.activeElement)).toBe('Repository');
  });

  it('the skip link focuses the page heading', async () => {
    app = await mountApp();
    await app.wrapper.find('a.skip').trigger('click');
    expect(document.activeElement?.tagName).toBe('H1');
  });

  it('shows the tooltip for [data-tip] on hover and focus, as text', async () => {
    app = await mountApp();
    const chip = app.wrapper.find('.scope-chip').element as HTMLElement;
    chip.dispatchEvent(new Event('pointerover', { bubbles: true }));
    await app.settle();
    const tip = app.wrapper.find('#tip');
    expect(tip.attributes('hidden')).toBeUndefined();
    expect(tip.find('b').text()).toBe('Scope: admin');
    expect(tip.find('span').text()).toBe('Can change anything.');
    chip.dispatchEvent(new Event('pointerout', { bubbles: true }));
    await app.settle();
    expect(app.wrapper.find('#tip').attributes('hidden')).toBeDefined();
  });

  it('opens and closes the Add machine wizard from the context', async () => {
    app = await mountApp();
    app.ctx.wizard.show();
    await app.settle();
    expect(document.querySelector('#modal-root .modal h2')?.textContent).toBe('Name your new machine');
    expect(app.wrapper.find('#modal-root').attributes('hidden')).toBeUndefined();
    (document.querySelector('#modal-root .modal button[aria-label="Close"]') as HTMLElement).click();
    await app.settle();
    expect(document.querySelector('#modal-root .modal')).toBeNull();
    expect(app.wrapper.find('#modal-root').attributes('hidden')).toBeDefined();
  });
});

describe('sign out', () => {
  beforeEach(() => undefined);
  it('signs out on the Server, shows the login page with "Signed out." and drops the navigation', async () => {
    app = await mountApp();
    await app.wrapper.find('#me button').trigger('click');
    await app.settle();
    expect(app.mock.state.signedIn).toBe(false);
    expect(app.router.currentRoute.value.name).toBe('login');
    expect(app.wrapper.find('#login-msg').text()).toBe('Signed out.');
    expect(app.wrapper.find('#login-msg').classes()).not.toContain('is-err');
    expect(app.wrapper.find('#nav').exists()).toBe(false);
    expect(app.ctx.summary.state.errors).toBe(0);
    expect(app.ctx.catalog.loaded).toBe(false);
  });
  it('a failed sign-out stays on the page and explains why', async () => {
    app = await mountApp();
    app.mock.options.offline = true;
    await app.wrapper.find('#me button').trigger('click');
    await app.settle();
    expect(app.router.currentRoute.value.name).toBe('machines');
    expect(app.ctx.toasts.items[0]).toMatchObject({ title: 'Could not sign out', tone: 'critical' });
    expect(app.wrapper.find('#toasts .toast--critical').text()).toContain('Could not reach the Server');
  });
});
