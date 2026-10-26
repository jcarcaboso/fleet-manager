import { afterEach, describe, expect, it } from 'vitest';
import { NODE_TABS, nodeRoute, normalizeTab, routeViewKey, safeRedirect } from '@/router';
import { mountApp, textOf, type TestApp } from './helpers/app';

let app: TestApp | undefined;
afterEach(() => app?.unmount());

describe('route table', () => {
  it('has the documented names and paths', async () => {
    app = await mountApp();
    const table = Object.fromEntries(app.router.getRoutes().map(r => [String(r.name), r.path]));
    expect(table).toMatchObject({
      login: '/login', machines: '/machines', node: '/machines/:alias/:tab?', problems: '/problems', deployments: '/deployments', revision: '/deployments/:revisionId',
      repository: '/repository', models: '/models', enrollment: '/enrollment', audit: '/audit', notFound: '/:pathMatch(.*)*',
    });
  });
  it('redirects / to the machines', async () => {
    app = await mountApp({ path: '/' });
    expect(app.router.currentRoute.value.fullPath).toBe('/machines');
  });
  it('shows each placeholder page', async () => {
    app = await mountApp();
    for (const [path, expected] of [['/problems', 'Problems'], ['/deployments', 'Deployments'], ['/repository', 'Repository'], ['/models', 'Models'], ['/enrollment', 'Enrollment'], ['/audit', 'Audit']] as const) {
      await app.go(path);
      expect(textOf(app.wrapper.find('#view').element), path).toContain(`${expected} is not ported yet`);
    }
    await app.go('/deployments/00000000-0000-4000-a000-000000000001');
    expect(app.router.currentRoute.value.name).toBe('revision');
    expect(textOf(app.wrapper.find('#view').element)).toContain('00000000-0000-4000-a000-000000000001');
  });
  it('redirects /deployments/<short SHA> to the list with ?revision=', async () => {
    app = await mountApp();
    await app.go('/deployments/a3f9c21');
    expect(app.router.currentRoute.value.name).toBe('deployments');
    expect(app.router.currentRoute.value.query.revision).toBe('a3f9c21');
    expect(app.wrapper.find('#nav a[aria-current="page"]').text()).toBe('Deployments');
  });
  it('shows the machine page with the tab named in the address, and Overview for an unknown tab', async () => {
    app = await mountApp({ path: '/machines/studio-mini/security' });
    expect(textOf(app.wrapper.find('#tabpanel').element)).toContain('The Security tab is not ported yet');
    expect(app.wrapper.find('.tabs a[aria-current="page"]').text()).toBe('Security');
    await app.go('/machines/studio-mini');
    expect(textOf(app.wrapper.find('#tabpanel').element)).toContain('The Overview tab is not ported yet');
    await app.go('/machines/studio-mini/nonsense');
    expect(app.wrapper.find('.tabs a[aria-current="page"]').text()).toBe('Overview');
  });
  it('moves focus to the active tab when only the tab changes, and to the heading when the machine changes', async () => {
    app = await mountApp({ path: '/machines/studio-mini' });
    expect(document.activeElement?.tagName).toBe('H1');
    await app.go('/machines/studio-mini/activity');
    expect(document.activeElement?.tagName).toBe('A');
    expect(document.activeElement?.textContent).toBe('Activity');
    expect(document.activeElement?.getAttribute('aria-current')).toBe('page');
    await app.go('/machines/design-imac/activity');
    expect(document.activeElement?.tagName).toBe('H1');
    expect(document.activeElement?.textContent).toBe('design-imac');
  });
  it('shows "That page does not exist" for an unknown path', async () => {
    app = await mountApp({ path: '/nowhere/at/all' });
    expect(app.router.currentRoute.value.name).toBe('notFound');
    expect(app.wrapper.find('h1').text()).toBe('That page does not exist');
    expect(app.wrapper.find('#view a.btn').attributes('href')).toBe('/machines');
  });
  it('keys the routed view by machine and revision, not by tab', async () => {
    app = await mountApp();
    const key = (path: string) => routeViewKey(app!.router.resolve(path) as never);
    expect(key('/machines/a/overview')).toBe(key('/machines/a/settings'));
    expect(key('/machines/a')).not.toBe(key('/machines/b'));
    expect(key('/deployments/x')).not.toBe(key('/deployments/y'));
    expect(key('/problems')).not.toBe(key('/audit'));
  });
});

describe('machine addresses', () => {
  it('encodes an alias with a slash, a percent and a space as one path segment', async () => {
    app = await mountApp();
    const resolved = app.router.resolve(nodeRoute('rack/A 100%', 'security'));
    expect(resolved.href).toBe('/machines/rack%2FA%20100%25/security');
    await app.go(resolved.href);
    expect(app.router.currentRoute.value.params.alias).toBe('rack/A 100%');
    expect(app.wrapper.find('h1').text()).toBe('rack/A 100%');
    expect(app.router.resolve(nodeRoute('a%2Fb')).href).toBe('/machines/a%252Fb');
    await app.go('/machines/a%252Fb');
    expect(app.router.currentRoute.value.params.alias).toBe('a%2Fb');
    expect(app.router.resolve(nodeRoute('studio-mini', 'overview')).href).toBe('/machines/studio-mini');
  });
  it('knows the tabs', () => {
    expect(NODE_TABS).toEqual(['overview', 'installed', 'problems', 'activity', 'security', 'settings']);
    expect(normalizeTab('activity')).toBe('activity');
    expect(normalizeTab(undefined)).toBe('overview');
    expect(normalizeTab('x')).toBe('overview');
  });
});

describe('guards', () => {
  it('sends a signed-out visitor to /login and keeps the intended path in ?redirect=', async () => {
    app = await mountApp({ path: '/deployments?x=1', mock: { signedOut: true } });
    const r = app.router.currentRoute.value;
    expect(r.name).toBe('login');
    expect(r.query.redirect).toBe('/deployments?x=1');
    expect(app.wrapper.find('#operator-token').exists()).toBe(true);
  });
  it('does not add a redirect for the default page', async () => {
    app = await mountApp({ path: '/', mock: { signedOut: true } });
    expect(app.router.currentRoute.value.fullPath).toBe('/login');
  });
  it('restores the session on boot with GET session and stays on the page when signed in', async () => {
    app = await mountApp({ path: '/audit' });
    expect(app.router.currentRoute.value.name).toBe('audit');
    expect(app.mock.calls.filter(c => c.path === 'session')).toHaveLength(1);
  });
  it('keeps a signed-in visitor off the login page', async () => {
    app = await mountApp();
    await app.router.push('/login');
    expect(app.router.currentRoute.value.name).toBe('machines');
    await app.router.push('/login?redirect=/audit');
    expect(app.router.currentRoute.value.fullPath).toBe('/audit');
  });
  it('shows "Try again" instead of the login page when the Server cannot be reached on boot', async () => {
    app = await mountApp({ path: '/problems', mock: { offline: true } });
    expect(app.router.currentRoute.value.name).toBe('problems');
    const view = app.wrapper.find('#view');
    expect(view.find('h1').text()).toBe('Could not load the dashboard');
    expect(view.text()).toContain('https://mock.fleet.invalid');
    app.mock.options.offline = false;
    await view.find('.empty-retry button').trigger('click');
    await app.settle();
    expect(app.wrapper.find('#view').text()).toContain('Problems is not ported yet');
  });
  it('sends the visitor to login with the current page when the session ends (401)', async () => {
    app = await mountApp({ path: '/audit' });
    app.mock.state.signedIn = false;
    await expect(app.ctx.api.get('nodes')).rejects.toMatchObject({ status: 401 });
    await app.settle();
    const r = app.router.currentRoute.value;
    expect(r.name).toBe('login');
    expect(r.query.redirect).toBe('/audit');
    expect(app.wrapper.find('#login-msg').text()).toBe('Your session ended. Sign in again.');
    expect(app.wrapper.find('#nav').exists()).toBe(false);
  });
});

describe('safeRedirect', () => {
  it('accepts only paths of this app', () => {
    expect(safeRedirect('/deployments?a=b')).toBe('/deployments?a=b');
    expect(safeRedirect(['/audit'])).toBe('/audit');
    for (const bad of [undefined, null, '', 'audit', 'https://evil.example/', '//evil.example', '/\\evil.example', '/login', '/login?redirect=/x', '/', 5]) {
      expect(safeRedirect(bad), String(bad)).toBeNull();
    }
  });
});
