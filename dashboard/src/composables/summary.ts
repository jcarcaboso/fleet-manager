import { reactive } from 'vue';
import type { ApiClient } from '@/api/client';
import type { CliProxyStatus, Issue, IssuesResponse } from '@/api/types';
import { now } from '@/lib/format';
import { isSilent } from '@/lib/errors';
import { errorCount } from '@/lib/model';

export interface SummaryState {
  /** Open errors (the Problems badge). */
  errors: number;
  /** A model catalog is failing (the Models badge). */
  modelsBad: boolean;
  /** When the summary was last requested, epoch ms. */
  at: number;
  /** The last `GET issues` items, or `null` before the first read. */
  issues: Issue[] | null;
}

export interface NavSummary {
  readonly state: SummaryState;
  /**
   * Reads `GET issues` and `GET cliproxy/status` for the navigation badges. Reads within 20 s of the last one are skipped
   * unless `force`. A failed read keeps the previous value; nothing is thrown.
   */
  refresh(force?: boolean): Promise<SummaryState>;
  reset(): void;
}

export function createNavSummary(api: ApiClient): NavSummary {
  const state = reactive<SummaryState>({ errors: 0, modelsBad: false, at: 0, issues: null });
  let controller = new AbortController();
  return {
    state,
    async refresh(force = false) {
      if (!force && now() - state.at < 20000) return state;
      state.at = now();
      const signal = controller.signal;
      try {
        const [issues, status] = await Promise.all([
          api.get<IssuesResponse>('issues', undefined, { signal }).catch(e => { if (isSilent(e)) throw e; return null; }),
          api.get<CliProxyStatus>('cliproxy/status', undefined, { signal }).catch(e => { if (isSilent(e)) throw e; return null; }),
        ]);
        if (signal.aborted) return state;
        if (issues) {
          state.issues = issues.items || [];
          state.errors = errorCount(state.issues);
        }
        if (status) state.modelsBad = (status.catalogs || []).some(c => c.outcome === 'failed');
      } catch {
        /* signed out or cancelled: the 401 handler already switched to the sign-in page */
      }
      return state;
    },
    reset() {
      controller.abort();
      controller = new AbortController();
      state.errors = 0;
      state.modelsBad = false;
      state.at = 0;
      state.issues = null;
    },
  };
}
