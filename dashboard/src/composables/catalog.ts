import { reactive, shallowRef } from 'vue';
import type { ApiClient } from '@/api/client';
import type { ErrorCatalogEntry, ErrorsResponse } from '@/api/types';
import { isSilent } from '@/lib/errors';

/** The error catalog (`GET errors`): what each Agent, Server and issue code means and how to fix it. Loaded once and cached. */
export interface ErrorCatalog {
  readonly map: ReadonlyMap<string, ErrorCatalogEntry>;
  readonly loaded: boolean;
  /**
   * Loads the catalog once; every caller shares the same request. A failure other than a silent one resolves with whatever is
   * known (an empty catalog), so pages degrade to showing raw codes. Do not pass a view's signal: the catalog is app-wide.
   */
  load(): Promise<ReadonlyMap<string, ErrorCatalogEntry>>;
  get(code: string | null | undefined): ErrorCatalogEntry | null;
  /** The catalog title of a code, the code itself when unknown, or "Unknown problem" for none. */
  title(code: string | null | undefined): string;
  /** Forgets the catalog (sign-in and sign-out). */
  reset(): void;
}

export function createErrorCatalog(api: ApiClient): ErrorCatalog {
  const state = reactive({ loaded: false });
  const map = shallowRef<ReadonlyMap<string, ErrorCatalogEntry>>(new Map());
  let promise: Promise<ReadonlyMap<string, ErrorCatalogEntry>> | null = null;
  let epoch = 0;
  const catalog: ErrorCatalog = {
    get map() {
      return map.value;
    },
    get loaded() {
      return state.loaded;
    },
    load() {
      if (!promise) {
        const mine = epoch;
        promise = api.get<ErrorsResponse>('errors').then(
          result => {
            if (mine === epoch) {
              map.value = new Map((result?.items ?? []).map(entry => [entry.code, entry]));
              state.loaded = true;
            }
            return map.value;
          },
          (error: unknown) => {
            if (mine === epoch) promise = null;
            if (isSilent(error)) throw error;
            return map.value;
          },
        );
      }
      return promise;
    },
    get: code => (code && map.value.get(code)) || null,
    title: code => catalog.get(code)?.title || code || 'Unknown problem',
    reset() {
      epoch++;
      promise = null;
      map.value = new Map();
      state.loaded = false;
    },
  };
  return catalog;
}
