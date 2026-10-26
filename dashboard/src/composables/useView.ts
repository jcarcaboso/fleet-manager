import { getCurrentScope, onScopeDispose, watch } from 'vue';
import { Visit, type Lane, type Poll, type PollOptions, type Token } from '@/lib/lanes';

export interface ViewScope {
  /** `true` until the component is unmounted. */
  readonly alive: boolean;
  /** Aborted when the view is unmounted or its `key` changes. */
  readonly signal: AbortSignal;
  /**
   * A token for the stay on this view: `visit().isCurrent()` is false after unmount or a `key` change. Take it before
   * a mutation and check it after the `await` to know whether the user is still where they started.
   */
  visit(): Token;
  /** A sequence of operations of which only the newest counts (`lane.begin()` aborts the previous one). */
  lane(): Lane;
  /** Bounded polling that stops by itself and when the view ends. */
  poll<T>(tick: (token: Token) => Promise<T>, options: PollOptions<T>): Poll;
}

export interface ViewOptions {
  /** When this changes, everything in flight is aborted, polls stop and `visit()` returns a new stay (the view was reused for another page). */
  key?: () => unknown;
}

/**
 * Gives a view one `AbortController` tied to its component scope (and optionally to a route key), plus lanes and bounded
 * polls built on it. Call it in `setup`. See `lib/lanes.ts` for the semantics, and `useLoad` for the common case.
 */
export function useView(options: ViewOptions = {}): ViewScope {
  const visit = new Visit();
  if (getCurrentScope()) onScopeDispose(() => visit.dispose());
  if (options.key) watch(options.key, () => visit.restart(), { flush: 'sync' });
  return {
    get alive() {
      return visit.alive;
    },
    get signal() {
      return visit.signal;
    },
    visit: () => visit.token(),
    lane: () => visit.lane(),
    poll: (tick, opts) => visit.poll(tick, opts),
  };
}
