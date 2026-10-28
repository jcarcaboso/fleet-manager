/** Bookmarks of the old hash-routed dashboard: `https://DASHBOARD/#/nodes/studio-mini/problems` lands on `/machines/studio-mini/problems`. */
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createFleetApp } from '@/app';
import { createMockServer, MOCK_API_URL } from '@/api/mock';
import { applyLegacyHash, legacyHashPath } from '@/legacyHash';
import { NAME, PASSWORD, settle, waitFor } from './helpers/app';
import { watchMock } from './helpers/strict';

describe('legacyHashPath: the table', () => {
  it.each([
    ['#/nodes', '/machines'],
    ['#/nodes/', '/machines'],
    ['#/nodes/studio-mini', '/machines/studio-mini'],
    ['#/nodes/studio-mini/problems', '/machines/studio-mini/problems'],
    ['#/nodes/studio-mini/overview', '/machines/studio-mini/overview'],
    ['#/nodes/studio-mini/activity/extra/segments', '/machines/studio-mini/activity'],
    ['#/nodes/studio-mini/bogus', '/machines/studio-mini/bogus'], // an unknown tab opens Overview in the router
    ['#/nodes/rack%2FA/settings', '/machines/rack%2FA/settings'],
    ['#/nodes/rack%2FA%20100%25', '/machines/rack%2FA%20100%25'],
    ['#/nodes/%E2%9C%93%20ok', '/machines/%E2%9C%93%20ok'],
    ['#/nodes/4965d79a-f516-4f50-a145-74d7f516224b/installed', '/machines/4965d79a-f516-4f50-a145-74d7f516224b/installed'],
    ['#/nodes/studio-mini/problems?x=1', '/machines/studio-mini/problems'],
    ['#/problems', '/problems'],
    ['#/problems?state=snoozed', '/problems'],
    ['#/deployments', '/deployments'],
    ['#/deployments/a3f9c21', '/deployments/a3f9c21'],
    ['#/deployments/3f2c5f4e-9d9e-4b9b-8a53-1f7f0a1c2d3e', '/deployments/3f2c5f4e-9d9e-4b9b-8a53-1f7f0a1c2d3e'],
    ['#/repository', '/repository'],
    ['#/models', '/models'],
    ['#/enrollment', '/enrollment'],
    ['#/audit', '/audit'],
    ['#/add', '/machines?add=1'],
  ])('%s -> %s', (hash, path) => {
    expect(legacyHashPath(hash)).toBe(path);
  });

  it.each(['', '#', '#/', '#//', '#/login', '#/machines', '#/machines/studio-mini', '#/Nodes', '#/nodes2', '#/unknown', '#/..', '#section', '#/PROBLEMS', '#/audit2'])('%j is not an old route', hash => {
    expect(legacyHashPath(hash)).toBeNull();
  });

  it('never produces anything but a path of this application', () => {
    for (const hash of ['#/nodes//evil.example/x', '#/nodes/\\\\evil.example', '#/deployments/..%2f..%2f', '#/nodes/%2F%2Fevil.example']) {
      const p = legacyHashPath(hash)!;
      expect(p.startsWith('/machines') || p.startsWith('/deployments')).toBe(true);
      expect(p.startsWith('//')).toBe(false);
    }
  });
});

function fakeWindow(pathname: string, hash: string) {
  const calls: Array<{ state: unknown; url: string }> = [];
  const win = {
    location: { pathname, hash },
    history: { state: { k: 1 }, replaceState: (state: unknown, _t: string, url: string) => { calls.push({ state, url }); } },
  };
  return { win: win as unknown as Pick<Window, 'location' | 'history'>, calls };
}

describe('applyLegacyHash', () => {
  it('replaces the address (no new history entry), keeping the state and dropping the fragment', () => {
    const { win, calls } = fakeWindow('/', '#/nodes/studio-mini/problems');
    expect(applyLegacyHash(win)).toBe('/machines/studio-mini/problems');
    expect(calls).toEqual([{ state: { k: 1 }, url: '/machines/studio-mini/problems' }]);
  });
  it('keeps the alias exactly as encoded', () => {
    const { win, calls } = fakeWindow('/', '#/nodes/rack%2FA%20100%25/settings');
    expect(applyLegacyHash(win)).toBe('/machines/rack%2FA%20100%25/settings');
    expect(calls[0]!.url).toBe('/machines/rack%2FA%20100%25/settings');
  });
  it('leaves everything else alone: other fragments, other paths, no hash', () => {
    for (const [pathname, hash] of [['/', ''], ['/', '#'], ['/', '#/'], ['/', '#top'], ['/', '#/whatever'], ['/machines', '#/nodes'], ['/login', '#/problems']] as const) {
      const { win, calls } = fakeWindow(pathname, hash);
      expect(applyLegacyHash(win), `${pathname}${hash}`).toBeNull();
      expect(calls).toHaveLength(0);
    }
  });
  it('works under another base', () => {
    const { win, calls } = fakeWindow('/fleet/', '#/audit');
    expect(applyLegacyHash(win, '/fleet/')).toBe('/fleet/audit');
    expect(calls[0]!.url).toBe('/fleet/audit');
    expect(applyLegacyHash(fakeWindow('/', '#/audit').win, '/fleet/')).toBeNull();
  });
});

describe('at start-up in the browser', () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
    window.history.replaceState(null, '', '/');
  });

  async function start(url: string, mock = {}) {
    window.history.replaceState(null, '', url);
    const server = watchMock(createMockServer(mock));
    const { app, router, ctx } = createFleetApp({ config: { apiUrl: MOCK_API_URL }, fetch: server.fetch });
    const host = document.createElement('div');
    document.body.append(host);
    app.mount(host);
    stop = () => { app.unmount(); server.dispose(); host.remove(); };
    await router.isReady();
    await settle();
    return { router, ctx, server, host };
  }

  it('an old bookmark of a machine tab lands on the new address of the same page', async () => {
    const { router, host } = await start('/#/nodes/studio-mini/problems');
    await waitFor(() => host.querySelector('.nhero h1'));
    expect(router.currentRoute.value.fullPath).toBe('/machines/studio-mini/problems');
    expect(window.location.pathname).toBe('/machines/studio-mini/problems');
    expect(window.location.hash).toBe('');
    expect(host.querySelector('nav.tabs a[aria-current]')?.textContent).toContain('Problems');
  });

  it('an encoded alias survives', async () => {
    const { router, host } = await start('/#/nodes/rack%2FA%20100%25/settings', { weirdAlias: true });
    await waitFor(() => host.querySelector('.nhero h1'));
    expect(router.currentRoute.value.params.alias).toBe('rack/A 100%');
    expect(window.location.pathname).toBe('/machines/rack%2FA%20100%25/settings');
    expect(host.querySelector('.nhero h1')?.textContent).toBe('rack/A 100%');
  });

  it('a signed-out visitor signs in first and then arrives at the translated page', async () => {
    const { router, ctx } = await start('/#/deployments', { signedOut: true });
    expect(router.currentRoute.value.name).toBe('login');
    expect(router.currentRoute.value.query.redirect).toBe('/deployments');
    await ctx.session.login(NAME, PASSWORD);
    await router.replace(String(router.currentRoute.value.query.redirect));
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('deployments');
  });

  it('#/add opens the Add machine wizard over the gallery', async () => {
    const { router, ctx, host } = await start('/#/add');
    await waitFor(() => ctx.wizard.open);
    await waitFor(() => host.ownerDocument.querySelector('.modal'));
    expect(router.currentRoute.value.fullPath).toBe('/machines');
  });

  it('a fragment that is not an old route is left alone', async () => {
    const { router } = await start('/#/nothing-here');
    expect(window.location.hash).toBe('#/nothing-here');
    expect(router.currentRoute.value.name).toBe('machines');
  });
});
