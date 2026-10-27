/**
 * Lazy loading of the check-in strips of the Machines gallery (ported from view-gallery.js).
 *
 * A card's strip is fetched only while the card is rendered and near the viewport, a few requests at a time.
 * Every request has its own AbortController. A card that scrolls out of range, is removed by a search, or is replaced by a new
 * load loses its queued or running request at once and gives its slot to the next card. A cancelled request leaves no trace:
 * nothing is cached or shown and no error appears, so the card asks again when it comes back into range.
 * Every load starts a new epoch (`reset`): the cache is cleared, requests are cancelled, and failures are retried.
 *
 * Cards register their `.strip-slot` element when they mount and unregister when they unmount; the scheduler observes the
 * elements with an `IntersectionObserver` (resolved at use time, so tests can supply a double). Without one, every registered
 * card is wanted at once.
 */
import { reactive } from 'vue';
import type { CheckinBucket } from '@/api/types';
import { now } from '@/lib/format';
import { isSilent } from '@/lib/errors';

export type StripState = { pending: true } | { buckets: CheckinBucket[] } | { error: true; at: number };

export const MAX_PARALLEL = 4;
export const RETRY_AFTER_MS = 10_000;

export interface StripSchedulerOptions {
  /** Loads the buckets of one machine. Must honour the signal. */
  load(id: string, signal: AbortSignal): Promise<CheckinBucket[]>;
  maxParallel?: number;
  retryAfterMs?: number;
}

export interface StripScheduler {
  /** Reactive: node id → state. A missing entry means "not loaded (yet)". */
  readonly states: ReadonlyMap<string, StripState>;
  register(id: string, el: Element): void;
  unregister(id: string, el: Element): void;
  /** Observes every registered card again, so each reports whether it is in range (a repaint of the list, a retry of failures). */
  rescan(): void;
  /** A new load starts: cancels everything, clears the cache and stops asking until `restart`. */
  reset(): void;
  /** The load committed: asks again for the cards that are in range. */
  restart(): void;
  /** The view is gone. */
  dispose(): void;
  /** Requests currently running (for tests and diagnostics). */
  readonly running: number;
}

interface Req {
  ctl: AbortController;
  released: boolean;
  cancelled: boolean;
}

export function createStripScheduler(options: StripSchedulerOptions): StripScheduler {
  const maxParallel = options.maxParallel ?? MAX_PARALLEL;
  const retryAfter = options.retryAfterMs ?? RETRY_AFTER_MS;
  const states = reactive(new Map<string, StripState>()) as Map<string, StripState>;
  const slots = new Map<string, Element>();
  const queue: string[] = [];
  const queued = new Set<string>();
  const active = new Map<string, Req>();
  let running = 0;
  let epoch = 0;
  let enabled = true;
  let io: IntersectionObserver | null = null;

  const wanted = (id: string): boolean => {
    const d = states.get(id);
    return !queued.has(id) && (!d || ('error' in d && now() - d.at > retryAfter));
  };
  /* Gives the request's concurrency slot back, once, whether it finished or was cancelled. */
  const release = (id: string, req: Req): void => {
    if (req.released) return;
    req.released = true;
    running--;
    if (active.get(id) === req) active.delete(id);
  };
  /* Takes the card's queued or running request away. The caller pumps afterwards: when several cards go at once (a search removes
     them, a scroll moves them out of range), the freed slots must not start requests for cards that are about to be cancelled too. */
  const cancel = (id: string): void => {
    if (queued.delete(id)) queue.splice(queue.indexOf(id), 1);
    const req = active.get(id);
    if (!req) return;
    req.cancelled = true;
    req.ctl.abort();
    release(id, req);
    const d = states.get(id);
    if (d && 'pending' in d) states.delete(id);
  };
  function pump(): void {
    while (running < maxParallel && queue.length) {
      const id = queue.shift() as string;
      queued.delete(id);
      if (!slots.has(id)) continue; // no longer shown
      const ep = epoch;
      const req: Req = { ctl: new AbortController(), released: false, cancelled: false };
      states.set(id, { pending: true });
      active.set(id, req);
      running++;
      options.load(id, req.ctl.signal).then(
        buckets => { if (ep === epoch && !req.cancelled) states.set(id, { buckets: buckets || [] }); },
        (e: unknown) => {
          if (ep !== epoch || req.cancelled) return;
          if (isSilent(e)) states.delete(id);
          else states.set(id, { error: true, at: now() });
        },
      ).finally(() => {
        if (ep !== epoch || req.cancelled) return;
        release(id, req);
        pump();
      });
    }
  }
  const want = (id: string, thenPump = true): void => {
    if (!enabled || !slots.has(id) || !wanted(id)) return;
    queue.push(id);
    queued.add(id);
    if (thenPump) pump();
  };
  const idOf = (el: Element): string => (el as HTMLElement).dataset.stripSlot ?? '';

  /* Cards stay observed so that leaving the viewport is seen as well as entering it. */
  const observer = (): IntersectionObserver | null => {
    if (io) return io;
    if (typeof IntersectionObserver !== 'function') return null;
    io = new IntersectionObserver(entries => {
      const known = entries.filter(e => slots.has(idOf(e.target)));
      for (const e of known) if (!e.isIntersecting) cancel(idOf(e.target));
      for (const e of known) if (e.isIntersecting) want(idOf(e.target), false);
      pump();
    }, { rootMargin: '200px 0px' });
    return io;
  };
  const watch = (id: string, el: Element): void => {
    const o = observer();
    if (!o) {
      want(id);
      return;
    }
    o.unobserve(el); // an element that is observed already reports nothing new; this makes it report its state again
    o.observe(el);
  };

  return {
    states,
    get running() { return running; },
    register(id, el) {
      slots.set(id, el);
      if (enabled) watch(id, el);
    },
    unregister(id, el) {
      if (slots.get(id) === el) slots.delete(id);
      io?.unobserve(el);
      cancel(id);
      /* The other cards of the same patch are removed in the same tick; hand the slot on afterwards. */
      queueMicrotask(pump);
    },
    rescan() {
      if (!enabled) return;
      for (const [id, el] of slots) watch(id, el);
    },
    reset() {
      epoch++;
      running = 0;
      for (const req of active.values()) {
        req.cancelled = true;
        req.released = true;
        req.ctl.abort();
      }
      active.clear();
      queue.length = 0;
      queued.clear();
      states.clear();
      enabled = false;
    },
    restart() {
      enabled = true;
      for (const [id, el] of slots) watch(id, el);
    },
    dispose() {
      this.reset();
      io?.disconnect();
      io = null;
      slots.clear();
    },
  };
}
