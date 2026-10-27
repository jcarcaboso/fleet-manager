import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { createFleetApp } from '@/app';
import { createMockServer, MOCK_API_URL } from '@/api/mock';
import ConfigErrorView from '@/views/ConfigError/ConfigErrorView.vue';
import { settle } from '../helpers/app';

describe('createFleetApp', () => {
  let mounted: { unmount(): void } | undefined;
  afterEach(() => mounted?.unmount());

  it('builds an app that mounts, restores the session and renders the shell', async () => {
    const mock = createMockServer();
    const { app, router, ctx } = createFleetApp({ config: { apiUrl: MOCK_API_URL }, fetch: mock.fetch, history: createMemoryHistory() });
    const host = document.createElement('div');
    document.body.append(host);
    await router.push('/problems');
    app.mount(host);
    mounted = { unmount: () => { app.unmount(); mock.dispose(); host.remove(); } };
    await router.isReady();
    await settle(20);
    expect(ctx.config.apiUrl).toBe(MOCK_API_URL);
    expect(host.querySelector('header.topbar')).not.toBeNull();
    expect(host.querySelector('#view h1')?.textContent).toBe('Problems');
  });
});

describe('configuration error page', () => {
  it('shows the message, says where the value comes from, and needs no router or session', () => {
    const w = mount(ConfigErrorView, { props: { message: '"apiUrl" must use https.' } });
    expect(w.find('h1').text()).toBe('Configuration error');
    expect(w.find('[role=alert]').text()).toContain('"apiUrl" must use https.');
    expect(w.text()).toContain('FLEET_API_ORIGIN');
    expect(w.find('#main').exists()).toBe(true);
  });
  it('renders hostile text as text', () => {
    const w = mount(ConfigErrorView, { props: { message: '<img src=x onerror=alert(1)>' } });
    expect(w.find('img').exists()).toBe(false);
  });
});
