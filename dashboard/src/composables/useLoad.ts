import { ref, shallowRef, watch, type Ref, type ShallowRef } from 'vue';
import { isSilent } from '@/lib/errors';
import type { Lane, Token } from '@/lib/lanes';
import { useView, type ViewScope } from './useView';

export interface LoadOptions {
  /** Start loading at once (default `true`). */
  immediate?: boolean;
  /** When this changes the data is loaded again; the load in flight is aborted and can never commit. */
  key?: () => unknown;
  /** Share a `useView()` scope (otherwise the load makes its own). */
  view?: ViewScope;
  /** Keep the previous data while a new load runs for another key (default: data is cleared on a key change). */
  keepData?: boolean;
}

export interface RunOptions {
  /** A refresh in the background: `loading` stays false and the old data stays on screen until the new data commits. */
  quiet?: boolean;
}

export interface LoadState<T> {
  /** The last committed result, or `undefined` before the first one. */
  data: ShallowRef<T | undefined>;
  /** The last committed error (silent errors are never stored). Cleared when a load commits. */
  error: ShallowRef<Error | null>;
  /** `true` from the start of a load until its result commits; stays false for quiet runs. */
  loading: Ref<boolean>;
  /** `true` while a quiet run is in flight. */
  refreshing: Ref<boolean>;
  /** Starts a new load. Never rejects; resolves to the data, or `undefined` when it failed or was superseded. */
  run(options?: RunOptions): Promise<T | undefined>;
  /** Same as `run()`: loads again, aborting the one in flight. */
  reload(options?: RunOptions): Promise<T | undefined>;
  /** The lane behind it, for `lane.current()` and `lane.cancel()`. */
  lane: Lane;
  view: ViewScope;
}

/**
 * The shared pattern for a view's loads: one lane, one `AbortController` per run, and a generation counter, so a response
 * for a load that has since been replaced (or whose view is gone) can never change state.
 *
 *     const { data, error, loading } = useLoad(async token => {
 *       const nodes = await api.all<NodeListItem>('nodes', { maxPages: 5, signal: token.signal });
 *       token.check();               // after awaits that use something other than the API client
 *       return nodes.items.map(fromList);
 *     });
 *
 * Commit rule: a run commits `data`/`error`/`loading` only if its token is still current. A superseded or aborted run
 * changes nothing; whatever replaced it owns the state.
 */
export function useLoad<T>(loader: (token: Token) => Promise<T>, options: LoadOptions = {}): LoadState<T> {
  const view = options.view ?? useView();
  const lane = view.lane();
  const data = shallowRef<T | undefined>();
  const error = shallowRef<Error | null>(null);
  const loading = ref(false);
  const refreshing = ref(false);

  async function run({ quiet = false }: RunOptions = {}): Promise<T | undefined> {
    const token = lane.begin();
    if (quiet) refreshing.value = true;
    else {
      loading.value = true;
      refreshing.value = false;
    }
    try {
      const value = await loader(token);
      if (!token.isCurrent()) return undefined;
      data.value = value;
      error.value = null;
      return value;
    } catch (e) {
      if (!token.isCurrent() || isSilent(e)) return undefined;
      error.value = e instanceof Error ? e : new Error(String(e));
      return undefined;
    } finally {
      if (token.isCurrent()) {
        loading.value = false;
        refreshing.value = false;
      }
    }
  }

  if (options.key) {
    watch(options.key, () => {
      if (!options.keepData) data.value = undefined;
      error.value = null;
      void run();
    }, { flush: 'sync' });
  }
  if (options.immediate !== false) void run();
  return { data, error, loading, refreshing, run, reload: run, lane, view };
}
