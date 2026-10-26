import { describe, expect, it } from 'vitest';
import { defaultMockOptions, parseMockOptions } from '@/api/mock';
import { startMock } from '@/api/mock/browser';

describe('parseMockOptions', () => {
  it('has the defaults of the old fixture', () => {
    const o = parseMockOptions('');
    expect(o).toMatchObject({ scope: 'admin', signedOut: false, empty: false, fail: null, forbid: false, slow: 0, pageSize: 100, diag: true, xss: false, agent: true, enroll: true, enrollLinkOnly: false, weirdAlias: false, hang: null, diskDelay: 7000, expiry: 0, commit: true, rollout: true, drift: true, states: false, offline: false, cookie: true });
    expect(o.delay).toEqual({});
    expect(o.lag).toEqual({});
    expect(o).toEqual({ ...defaultMockOptions() });
  });
  it('reads every documented switch', () => {
    const o = parseMockOptions('?scope=read&signedout=1&empty=1&fail=nodes/&forbid=1&slow=300&pagesize=2&diag=0&xss=1&agent=0&enroll=link&expiry=8&weirdalias=1&delay=design-imac:2500,rack/A:10&lag=rename:3000,cliproxy/selection:100&hang=enrollment-links/&diskdelay=1000&commit=0&norollout=1&drift=0&states=1&platform=linux&offline=1&cookie=0&origin=https://a.test&dashboardorigin=https://b.test');
    expect(o).toMatchObject({
      scope: 'read', signedOut: true, empty: true, fail: 'nodes/', forbid: true, slow: 300, pageSize: 2, diag: false, xss: true, agent: false, enroll: true, enrollLinkOnly: true,
      expiry: 8, weirdAlias: true, hang: 'enrollment-links/', diskDelay: 1000, commit: false, rollout: false, drift: false, states: true, platform: 'linux', offline: true, cookie: false,
      origin: 'https://a.test', dashboardOrigin: 'https://b.test',
    });
    expect(o.delay).toEqual({ 'design-imac': 2500, 'rack/A': 10 });
    expect(o.lag).toEqual({ rename: 3000, 'cliproxy/selection': 100 });
    expect(parseMockOptions('?enroll=0').enroll).toBe(false);
    expect(parseMockOptions('?scope=nonsense').scope).toBe('admin');
    expect(parseMockOptions('?scope=operate').scope).toBe('operate');
  });
  it('startMock reads the query string and returns a config that needs no config.json', async () => {
    const { config, fetch, server } = startMock('?scope=read&signedout=1');
    expect(config.apiUrl).toBe('https://mock.fleet.invalid');
    expect(server.options.scope).toBe('read');
    expect((await fetch('https://mock.fleet.invalid/dashboard/api/session')).status).toBe(401);
    expect((window as unknown as { __MOCK?: unknown }).__MOCK).toBe(server);
    server.dispose();
  });
});
