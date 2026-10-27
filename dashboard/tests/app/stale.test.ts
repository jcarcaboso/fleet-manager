/**
 * The shared protection against stale responses, polling and abandoned requests, exercised through the real app: a probe
 * view replaces the machine page and loads `GET nodes/{alias}` the way a ported view will.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { useRoute } from 'vue-router';
import type { NodeDetail } from '@/api/types';
import { useFleet } from '@/context';
import { useDocumentTitle } from '@/composables/useDocumentTitle';
import { useLoad } from '@/composables/useLoad';
import { useView } from '@/composables/useView';
import { mountApp, waitFor, type TestApp } from '../helpers/app';

let app: TestApp | undefined;
let polls: { ticks: number; stopped: string | null; active: () => boolean } | undefined;
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
afterEach(() => { app?.unmount(); vi.useRealTimers(); polls = undefined; });

const Probe = defineComponent({
  setup() {
    const { api } = useFleet();
    const route = useRoute();
    const view = useView();
    const { data, error, loading } = useLoad(async token => api.get<NodeDetail>(`nodes/${encodeURIComponent(String(route.params.alias))}`, undefined, { signal: token.signal }));
    useDocumentTitle(() => data.value?.name);
    const stats = { ticks: 0, stopped: null as string | null };
    const poll = view.poll(async token => { stats.ticks++; return api.get('nodes/' + encodeURIComponent(String(route.params.alias)) + '/checkins', { hours: 1 }, { signal: token.signal }); }, {
      intervalMs: 5000, timeoutMs: 20_000, onStop: reason => { stats.stopped = reason; },
    });
    polls = { get ticks() { return stats.ticks; }, get stopped() { return stats.stopped; }, active: () => poll.active };
    return () => h('div', { id: 'probe' }, loading.value ? 'loading' : error.value ? `error: ${error.value.message}` : `loaded ${data.value?.name}`);
  },
});

async function mountProbe(mock = {}): Promise<TestApp> {
  const a = await mountApp({ mock, path: '/audit' });
  a.router.addRoute({ name: 'node', path: '/machines/:alias/:tab?', component: Probe, meta: { nav: 'machines' } });
  return a;
}
const probeText = (a: TestApp): string => a.wrapper.find('#probe').text();

describe('stale responses', () => {
  it('the slow answer for the machine the user left never replaces the one they are on', async () => {
    app = await mountProbe({ delay: { 'studio-mini': 500, 'design-imac': 50 } });
    void app.router.push('/machines/studio-mini');
    await vi.advanceTimersByTimeAsync(20);
    await app.router.push('/machines/design-imac');
    await vi.advanceTimersByTimeAsync(100);
    await waitFor(() => probeText(app!) === 'loaded design-imac');
    await vi.advanceTimersByTimeAsync(1000);
    expect(probeText(app)).toBe('loaded design-imac');
    const studio = app.mock.calls.find(c => c.path === 'nodes/studio-mini')!;
    expect(studio.aborted).toBe(true);
    expect(studio.settled).toBe(true);
  });

  it('leaving the page aborts what is in flight, and nothing of it ever commits', async () => {
    app = await mountProbe({ hang: 'nodes/' });
    await app.go('/machines/studio-mini');
    const open = app.mock.calls.filter(c => !c.settled);
    expect(open.length).toBeGreaterThan(0);
    await app.go('/audit');
    expect(app.mock.calls.filter(c => c.path.startsWith('nodes/')).every(c => c.aborted || c.settled)).toBe(true);
    expect(app.wrapper.find('#probe').exists()).toBe(false);
  });

  it('a view sets the page title while it is open, and the route title comes back after', async () => {
    app = await mountProbe();
    await app.go('/machines/studio-mini');
    await waitFor(() => document.title === 'studio-mini · Fleet Manager');
    await app.go('/audit');
    expect(document.title).toBe('Audit · Fleet Manager');
  });

  it('a failure shows the Server message', async () => {
    app = await mountProbe();
    await app.go('/machines/nobody');
    await waitFor(() => probeText(app!).startsWith('error'));
    expect(probeText(app)).toBe('error: That machine no longer exists. It may have been renamed or removed.');
  });

  it('a machine alias with a slash, percent sign and space loads through the router and the client', async () => {
    app = await mountProbe({ weirdAlias: true });
    await app.router.push('/machines/rack%2FA%20100%25');
    await waitFor(() => probeText(app!) === 'loaded rack/A 100%');
  });
});

describe('bounded polling', () => {
  it('ticks every 5 s while the page is open and stops at its deadline, aborting a read that hangs', async () => {
    app = await mountProbe({ hang: 'nodes/studio-mini/checkins' });
    await app.go('/machines/studio-mini');
    await vi.advanceTimersByTimeAsync(1);
    expect(polls!.ticks).toBe(1);
    await vi.advanceTimersByTimeAsync(19_000);
    expect(polls!.ticks).toBe(1); // the first read hangs; the next tick waits for it
    await vi.advanceTimersByTimeAsync(1000);
    expect(polls!.active()).toBe(false);
    expect(polls!.stopped).toBe('timeout');
    const hung = app.mock.calls.find(c => c.path.endsWith('checkins'))!;
    expect(hung.aborted).toBe(true);
  });

  it('keeps reading while the page is open and stops the moment the user navigates away', async () => {
    app = await mountProbe();
    await app.go('/machines/studio-mini');
    await vi.advanceTimersByTimeAsync(11_000);
    const reads = () => app!.mock.calls.filter(c => c.path.endsWith('checkins')).length;
    expect(reads()).toBeGreaterThanOrEqual(3);
    await app.go('/audit');
    const after = reads();
    expect(polls!.active()).toBe(false);
    expect(polls!.stopped).toBe('stopped');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads()).toBe(after);
  });

  it('moving to another machine stops the old page\'s poll too (the route key remounts the view)', async () => {
    app = await mountProbe();
    await app.go('/machines/studio-mini');
    await vi.advanceTimersByTimeAsync(6000);
    await app.go('/machines/design-imac');
    await vi.advanceTimersByTimeAsync(11_000);
    const byMachine = (alias: string) => app!.mock.calls.filter(c => c.path === `nodes/${alias}/checkins`).length;
    const studio = byMachine('studio-mini');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(byMachine('studio-mini')).toBe(studio);
    expect(byMachine('design-imac')).toBeGreaterThan(0);
  });
});
