import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { useLoad } from '@/composables/useLoad';
import { useView } from '@/composables/useView';
import { superseded } from '@/lib/errors';
import { settle } from '../helpers/app';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A load whose result the test releases by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness<T>(loader: (n: number, signal: AbortSignal) => Promise<T>, extra: { key?: () => unknown; immediate?: boolean } = {}) {
  let calls = 0;
  let state!: ReturnType<typeof useLoad<T>>;
  const wrapper = mount(defineComponent({
    setup() {
      state = useLoad(token => loader(++calls, token.signal), extra);
      return () => h('div', String(state.data.value ?? ''));
    },
  }));
  return { wrapper, state, calls: () => calls };
}

describe('useLoad', () => {
  it('commits data, clears loading and keeps the error empty', async () => {
    const { state } = harness(async () => 'ok');
    expect(state.loading.value).toBe(true);
    await settle();
    expect(state.data.value).toBe('ok');
    expect(state.loading.value).toBe(false);
    expect(state.error.value).toBeNull();
  });

  it('a superseded response never commits: the older load answers last and is dropped', async () => {
    const d = [deferred<string>(), deferred<string>()];
    const { state } = harness((n) => d[n - 1]!.promise);
    const second = state.reload();
    d[1]!.resolve('new');
    await settle();
    expect(state.data.value).toBe('new');
    d[0]!.resolve('OLD');
    await settle();
    expect(state.data.value).toBe('new');
    expect(await second).toBe('new');
    expect(state.loading.value).toBe(false);
  });

  it('a superseded failure never shows an error either', async () => {
    const d = [deferred<string>(), deferred<string>()];
    const { state } = harness(n => d[n - 1]!.promise);
    void state.reload();
    d[0]!.reject(new Error('old failure'));
    await settle();
    expect(state.error.value).toBeNull();
    expect(state.loading.value).toBe(true);
    d[1]!.resolve('fine');
    await settle();
    expect(state.data.value).toBe('fine');
    expect(state.error.value).toBeNull();
  });

  it('aborts the previous request when a new one starts', async () => {
    const signals: AbortSignal[] = [];
    const { state } = harness((_n, signal) => { signals.push(signal); return new Promise<string>(() => {}); });
    void state.reload();
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
  });

  it('aborts in-flight requests on unmount and never commits afterwards', async () => {
    const d = deferred<string>();
    let signal!: AbortSignal;
    const { wrapper, state } = harness((_n, s) => { signal = s; return d.promise; });
    wrapper.unmount();
    expect(signal.aborted).toBe(true);
    d.resolve('after unmount');
    await settle();
    expect(state.data.value).toBeUndefined();
  });

  it('stores a real failure and clears it on the next success', async () => {
    let fail = true;
    const { state } = harness(async () => { if (fail) throw new Error('nope'); return 'ok'; });
    await settle();
    expect(state.error.value?.message).toBe('nope');
    expect(state.loading.value).toBe(false);
    fail = false;
    await state.run();
    expect(state.error.value).toBeNull();
    expect(state.data.value).toBe('ok');
  });

  it('does not store silent errors', async () => {
    const { state } = harness(async () => { throw superseded(); });
    await settle();
    expect(state.error.value).toBeNull();
  });

  it('a quiet run keeps the data on screen and does not set loading', async () => {
    const d = deferred<string>();
    let first = true;
    const { state } = harness(() => { if (first) { first = false; return Promise.resolve('one'); } return d.promise; });
    await settle();
    const p = state.run({ quiet: true });
    expect(state.loading.value).toBe(false);
    expect(state.refreshing.value).toBe(true);
    expect(state.data.value).toBe('one');
    d.resolve('two');
    await p;
    expect(state.data.value).toBe('two');
    expect(state.refreshing.value).toBe(false);
  });

  it('reloads when the key changes and drops the response of the old key', async () => {
    const key = ref('a');
    const d: Record<string, ReturnType<typeof deferred<string>>> = { a: deferred<string>(), b: deferred<string>() };
    const { state } = harness(() => d[key.value]!.promise, { key: () => key.value });
    key.value = 'b';
    await nextTick();
    expect(state.data.value).toBeUndefined();
    d.a!.resolve('answer for a');
    d.b!.resolve('answer for b');
    await settle();
    expect(state.data.value).toBe('answer for b');
  });

  it('does not start when immediate is false', async () => {
    const { state, calls } = harness(async () => 1, { immediate: false });
    await settle();
    expect(calls()).toBe(0);
    await state.run();
    expect(calls()).toBe(1);
  });
});

describe('useView', () => {
  it('ties a lane, a visit token and polls to the component scope', async () => {
    let view!: ReturnType<typeof useView>;
    const tick = vi.fn(async () => 1);
    const wrapper = mount(defineComponent({ setup() { view = useView(); return () => h('div'); } }));
    const stay = view.visit();
    const token = view.lane().begin();
    const poll = view.poll(tick, { intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(250);
    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(view.alive).toBe(true);
    wrapper.unmount();
    expect(view.alive).toBe(false);
    expect(stay.isCurrent()).toBe(false);
    expect(token.signal.aborted).toBe(true);
    expect(poll.active).toBe(false);
    const calls = tick.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick.mock.calls.length).toBe(calls);
  });

  it('a key change starts a new stay and stops polls of the old one', async () => {
    const key = ref(1);
    let view!: ReturnType<typeof useView>;
    mount(defineComponent({ setup() { view = useView({ key: () => key.value }); return () => h('div'); } }));
    const stay = view.visit();
    const poll = view.poll(async () => 1, { intervalMs: 50 });
    key.value = 2;
    await nextTick();
    expect(stay.isCurrent()).toBe(false);
    expect(poll.active).toBe(false);
    expect(view.visit().isCurrent()).toBe(true);
    expect(view.signal.aborted).toBe(false);
  });
});
