import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupersededError, isSilent, soft, superseded } from '@/lib/errors';
import { Visit } from '@/lib/lanes';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('superseded errors', () => {
  it('are silent and recognisable', () => {
    const e = superseded();
    expect(e).toBeInstanceOf(SupersededError);
    expect(e).toBeInstanceOf(Error);
    expect(isSilent(e)).toBe(true);
    expect(isSilent(new Error('x'))).toBe(false);
    expect(isSilent(null)).toBe(false);
  });
  it('soft() turns an ordinary failure into null and rethrows silent ones', () => {
    expect(soft(new Error('boom'))).toBeNull();
    expect(() => soft(superseded())).toThrow(SupersededError);
  });
});

describe('Lane and Token', () => {
  it('only the newest token is current, and beginning aborts the previous one', () => {
    const lane = new Visit().lane();
    const a = lane.begin();
    expect(a.isCurrent()).toBe(true);
    expect(a.generation).toBe(1);
    const b = lane.begin();
    expect(a.isCurrent()).toBe(false);
    expect(a.signal.aborted).toBe(true);
    expect(b.isCurrent()).toBe(true);
    expect(b.signal.aborted).toBe(false);
    expect(() => a.check()).toThrow(SupersededError);
    expect(() => b.check()).not.toThrow();
    expect(lane.current()).toBe(b);
  });
  it('guard() resolves the value of a current operation and drops a stale one, even when it rejects', async () => {
    const lane = new Visit().lane();
    const a = lane.begin();
    const slow = new Promise<string>(r => setTimeout(() => r('late'), 10));
    const guarded = a.guard(slow);
    lane.begin();
    vi.advanceTimersByTime(10);
    await expect(guarded).rejects.toBeInstanceOf(SupersededError);
    const c = lane.begin();
    await expect(c.guard(Promise.resolve(5))).resolves.toBe(5);
    const d = lane.begin();
    const failing = d.guard(Promise.reject(new Error('real failure')));
    await expect(failing).rejects.toThrow('real failure');
    const e = lane.begin();
    const stale = e.guard(new Promise((_, rej) => setTimeout(() => rej(new Error('too late')), 5)));
    lane.begin();
    vi.advanceTimersByTime(5);
    await expect(stale).rejects.toBeInstanceOf(SupersededError);
  });
  it('cancel() makes the operation stale without starting another', () => {
    const lane = new Visit().lane();
    const t = lane.begin();
    lane.cancel();
    expect(t.isCurrent()).toBe(false);
    expect(t.signal.aborted).toBe(true);
    expect(lane.current()).toBeNull();
  });
  it('lanes are independent of each other', () => {
    const visit = new Visit();
    const a = visit.lane().begin();
    const b = visit.lane().begin();
    expect(a.isCurrent() && b.isCurrent()).toBe(true);
  });
  it('disposing the visit aborts everything and makes every token stale', () => {
    const visit = new Visit();
    const lane = visit.lane();
    const t = lane.begin();
    const stay = visit.token();
    visit.dispose();
    expect(t.signal.aborted).toBe(true);
    expect(t.isCurrent()).toBe(false);
    expect(stay.isCurrent()).toBe(false);
    expect(visit.alive).toBe(false);
    expect(lane.begin().isCurrent()).toBe(false);
  });
  it('restarting the visit (a new route key) ends the old stay but keeps the lanes usable', () => {
    const visit = new Visit();
    const lane = visit.lane();
    const t = lane.begin();
    const stay = visit.token();
    visit.restart();
    expect(t.isCurrent()).toBe(false);
    expect(stay.isCurrent()).toBe(false);
    expect(visit.token().isCurrent()).toBe(true);
    expect(lane.begin().isCurrent()).toBe(true);
    expect(visit.alive).toBe(true);
  });
});

describe('bounded polling', () => {
  it('ticks at the interval until done returns true', async () => {
    const visit = new Visit();
    let n = 0;
    const onStop = vi.fn();
    const poll = visit.poll(async () => ++n, { intervalMs: 1000, done: r => r === 3, onStop });
    await vi.advanceTimersByTimeAsync(0);
    expect(n).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(n).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(n).toBe(3);
    expect(poll.active).toBe(false);
    expect(onStop).toHaveBeenCalledWith('done');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(n).toBe(3);
  });
  it('stops at the time limit, aborts the tick in flight and calls onTimeout', async () => {
    const visit = new Visit();
    let signal: AbortSignal | undefined;
    const onTimeout = vi.fn();
    const onStop = vi.fn();
    const poll = visit.poll(token => { signal = token.signal; return new Promise<never>(() => {}); }, { intervalMs: 5000, timeoutMs: 150_000, onTimeout, onStop });
    await vi.advanceTimersByTimeAsync(149_999);
    expect(poll.active).toBe(true);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll.active).toBe(false);
    expect(signal?.aborted).toBe(true);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledWith('timeout');
  });
  it('stops after maxTicks', async () => {
    const visit = new Visit();
    const tick = vi.fn(async () => 'x');
    const poll = visit.poll(tick, { intervalMs: 10, maxTicks: 3 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(3);
    expect(poll.active).toBe(false);
    expect(poll.ticks).toBe(3);
  });
  it('keeps going after an error unless onError says stop; silent errors are not reported', async () => {
    const visit = new Visit();
    let n = 0;
    const onError = vi.fn(() => undefined);
    visit.poll(async () => { n++; if (n === 1) throw new Error('flaky'); if (n === 2) throw superseded(); return n; }, { intervalMs: 10, maxTicks: 3, onError });
    await vi.advanceTimersByTimeAsync(100);
    expect(n).toBe(3);
    expect(onError).toHaveBeenCalledTimes(1);
    const stopper = visit.poll(async () => { throw new Error('fatal'); }, { intervalMs: 10, onError: () => 'stop' });
    await vi.advanceTimersByTimeAsync(100);
    expect(stopper.active).toBe(false);
  });
  it('waits for a tick to finish before scheduling the next (no overlap)', async () => {
    const visit = new Visit();
    let running = 0;
    let max = 0;
    visit.poll(async () => { running++; max = Math.max(max, running); await new Promise(r => setTimeout(r, 50)); running--; }, { intervalMs: 10, maxTicks: 4 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(max).toBe(1);
  });
  it('can start after the interval instead of at once', async () => {
    const tick = vi.fn(async () => 1);
    new Visit().poll(tick, { intervalMs: 500, immediate: false, maxTicks: 1 });
    await vi.advanceTimersByTimeAsync(499);
    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(1);
  });
  it('stop() cancels the next tick and aborts the one in flight; a result that arrives after stop is ignored', async () => {
    const visit = new Visit();
    const done = vi.fn();
    let release!: (v: number) => void;
    const poll = visit.poll(() => new Promise<number>(r => { release = r; }), { intervalMs: 10, done });
    await vi.advanceTimersByTimeAsync(0);
    poll.stop();
    poll.stop();
    release(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(done).not.toHaveBeenCalled();
  });
  it('stops when the visit is disposed or restarted', async () => {
    const visit = new Visit();
    const tick = vi.fn(async () => 1);
    const a = visit.poll(tick, { intervalMs: 10 });
    await vi.advanceTimersByTimeAsync(35);
    const calls = tick.mock.calls.length;
    visit.restart();
    expect(a.active).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(tick.mock.calls.length).toBe(calls);
    const b = visit.poll(tick, { intervalMs: 10 });
    visit.dispose();
    expect(b.active).toBe(false);
    const c = visit.poll(tick, { intervalMs: 10 });
    expect(c.active).toBe(false);
  });
});
