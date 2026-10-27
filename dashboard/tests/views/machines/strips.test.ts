/**
 * The lazy check-in strips of the gallery cards. Ports of the old drive.js scenarios strips, stripsScroll, stripsDrop, stripsRetry,
 * stripsCancel and stripsAway. The IntersectionObserver is a test double whose "viewport" is a range of card positions.
 */
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountApp, waitFor, type TestApp } from '../../helpers/app';
import { FakeIntersectionObserver, inRange, installIntersectionObserver } from './ioDouble';

let app: TestApp | undefined;
afterEach(() => { app?.unmount(); app = undefined; vi.useRealTimers(); });

const $$ = (sel: string): Element[] => [...document.querySelectorAll(sel)];
const strips = (): TestApp['mock']['calls'] => app!.mock.calls.filter(c => /\/checkins$/.test(c.path));
const drawn = (): number => document.querySelectorAll('svg.strip').length;
const slotIds = (): string[] => $$('[data-strip-slot]').map(e => (e as HTMLElement).dataset.stripSlot!);
const idOf = (c: { path: string }): string => c.path.split('/')[1]!;
const LIVE = 13;
const search = async (text: string): Promise<void> => { await app!.wrapper.find('#q').setValue(text); await flushPromises(); };

/** Opens the gallery with nothing in range, then switches to fake timers (the mock's `slow` needs them). */
async function open(visible: (el: Element) => boolean, { slow = 0, fail = null }: { slow?: number; fail?: string | null } = {}): Promise<void> {
  installIntersectionObserver(() => false);
  app = await mountApp({ path: '/machines' });
  await waitFor(() => app!.wrapper.find('.card').exists());
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  app.mock.options.slow = slow;
  app.mock.options.fail = fail;
  FakeIntersectionObserver.visible = visible;
  FakeIntersectionObserver.recheck();
  await flushPromises();
}
const advance = async (ms: number): Promise<void> => { await vi.advanceTimersByTimeAsync(ms); await flushPromises(); };

describe('strips load only for cards near the viewport', () => {
  it('fetches the cards in range, draws exactly those, ignores a search that finds nothing, and loads the cards a search brings in (strips)', async () => {
    await open(inRange(0, 6));
    await advance(100);
    expect(strips()).toHaveLength(6);
    const inView = slotIds().slice(0, 6);
    expect(strips().every(c => inView.includes(idOf(c)))).toBe(true);
    expect(drawn()).toBe(6);
    expect(new Set(slotIds()).size).toBe(LIVE);
    const before = strips().length;
    await search('zzzz');
    await advance(600);
    expect(strips()).toHaveLength(before);
    await search('linux');
    await advance(900);
    const linux = app!.mock.nodes.filter(n => n.platform === 'linux' && !n.revokedAt).map(n => `nodes/${n.id}/checkins`);
    expect(linux.filter(p => strips().some(c => c.path === p)).length).toBeGreaterThan(0);
    for (const c of strips()) expect(strips().filter(x => x.path === c.path)).toHaveLength(1); // no strip is requested twice while cached
  });

  it('shows the total of the strip next to the title, "…" before it arrived', async () => {
    await open(() => false);
    expect(document.querySelector('[data-strip-total]')!.textContent).toBe('…');
    expect(document.querySelector('.strip-pending')).not.toBeNull();
    FakeIntersectionObserver.visible = inRange(0, 1);
    FakeIntersectionObserver.recheck();
    await advance(100);
    const first = document.querySelector('[data-strip-slot]')!;
    const total = first.closest('.vital')!.querySelector('[data-strip-total]')!.textContent!;
    expect(total).toMatch(/^[\d,]+$/);
    expect(first.querySelector('svg.strip')).not.toBeNull();
  });

  it('scrolling loads the rest once each, a search that hides and restores cards refetches nothing, returning to the page fetches again (stripsScroll)', async () => {
    await open(inRange(0, 4));
    await advance(200);
    const first = strips().length;
    expect(first).toBe(4);
    await search('zzzz');
    await advance(300);
    await search('');
    await advance(600);
    expect(strips()).toHaveLength(first);
    FakeIntersectionObserver.visible = () => true; // the user scrolls to the end
    FakeIntersectionObserver.recheck();
    await advance(1500);
    expect(new Set(strips().map(c => c.path)).size).toBe(LIVE);
    expect(drawn()).toBe(LIVE);
    expect(strips()).toHaveLength(LIVE);
    const total = strips().length;
    await app!.go('/audit');
    await app!.go('/machines');
    await waitFor(() => document.querySelector('.card'));
    await advance(1500);
    expect(strips().length).toBeGreaterThan(total);
  });
});

describe('strips run four at a time and follow their cards', () => {
  const running = (): number => strips().filter(c => !c.settled).length;

  it('never runs more than four requests, and drops the queued ones of cards a search removed (stripsDrop)', async () => {
    await open(() => true, { slow: 1500 });
    await advance(300);
    expect(strips()).toHaveLength(4);
    expect(running()).toBe(4);
    await search('zzzz');
    await advance(6000);
    expect(strips()).toHaveLength(4);
  });

  it('a search that hides cards cancels their running requests, the cards that remain load four at a time, and cancelled requests are never errors (stripsCancel)', async () => {
    await open(() => true, { slow: 1500 });
    await advance(300);
    expect(strips()).toHaveLength(4);
    expect(strips().every(c => !c.settled)).toBe(true);
    await search('zzzz');
    await advance(200);
    expect(strips().every(c => c.aborted)).toBe(true);
    await search('linux');
    let most = 0;
    for (let t = 0; t < 8000; t += 50) {
      await advance(50);
      most = Math.max(most, running());
    }
    expect(most).toBeGreaterThanOrEqual(1);
    expect(most).toBeLessThanOrEqual(4);
    const linuxLive = app!.mock.nodes.filter(n => n.platform === 'linux' && !n.revokedAt).length;
    expect(drawn()).toBe(linuxLive);
    expect(document.querySelector('#gallery-body')!.textContent).not.toContain('Unavailable');
    expect(document.querySelector('.toast--critical')).toBeNull();
  });

  it('requests of cards scrolled out of view are cancelled at once, the freed slots go to the cards now in view, and the cancelled cards load when they come back (stripsAway)', async () => {
    await open(inRange(0, 6), { slow: 1500 });
    await advance(500);
    const first = strips().filter(c => !c.settled);
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThanOrEqual(4);
    const t0 = Date.now();
    FakeIntersectionObserver.visible = inRange(9, 13); // scrolled to the end
    FakeIntersectionObserver.recheck();
    await advance(500);
    expect(first.every(c => c.aborted)).toBe(true);
    const fresh = strips().filter(c => c.at >= t0);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every(c => c.at - t0 < 900)).toBe(true); // without waiting for the slow Server
    expect(running()).toBeLessThanOrEqual(4);
    await advance(3000);
    expect(document.querySelector('#gallery-body')!.textContent).not.toContain('Unavailable');
    expect(document.querySelector('.toast--critical')).toBeNull();
    FakeIntersectionObserver.visible = inRange(0, 6); // back to the top
    FakeIntersectionObserver.recheck();
    await advance(6000);
    const top = $$('[data-strip-slot]').slice(0, 6);
    expect(top.every(e => !!e.querySelector('svg.strip'))).toBe(true);
  });

  it('leaving the page aborts the strips in flight', async () => {
    await open(() => true, { slow: 1500 });
    await advance(300);
    const open4 = strips().filter(c => !c.settled);
    expect(open4).toHaveLength(4);
    await app!.go('/audit');
    expect(open4.every(c => c.aborted)).toBe(true);
    const n = strips().length;
    await advance(10_000);
    expect(strips()).toHaveLength(n);
  });
});

describe('failed strips', () => {
  it('show Unavailable, are not retried before ten seconds, and are retried and drawn when the list repaints later (stripsRetry)', async () => {
    await open(() => true, { fail: 'nodes/' });
    await advance(1500);
    expect(document.querySelectorAll('.strip-slot .muted').length).toBeGreaterThan(0);
    expect(document.querySelector('#gallery-body')!.textContent).toContain('Unavailable');
    expect(drawn()).toBe(0);
    app!.mock.options.fail = null;
    await search('a');
    await search('');
    await advance(500);
    expect(drawn()).toBe(0); // too early: the failure is younger than ten seconds
    await advance(11_000);
    await search('a');
    await search('');
    await advance(1500);
    expect(drawn()).toBeGreaterThan(0);
  });
});

describe('without IntersectionObserver', () => {
  it('every card asks for its strip, still four at a time', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    app = await mountApp({ path: '/machines' });
    await waitFor(() => drawn() === LIVE);
    expect(strips()).toHaveLength(LIVE);
  });
});
