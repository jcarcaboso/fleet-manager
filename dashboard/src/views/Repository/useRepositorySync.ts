import type { RescanResponse } from '@/api/types';
import { useView } from '@/composables/useView';
import { useFleet, type ActionResult } from '@/context';
import type { ToastTone } from '@/composables/toasts';
import type { GlyphKind, GlyphLevel } from '@/lib/status';
import { plural } from '@/lib/format';

interface SyncOutcome {
  level: GlyphLevel;
  kind: GlyphKind;
  title: string;
  text: string;
}

/** What each answer of `POST source/rescan` says (ported from view-repository.js). */
export function syncOutcome(r: Partial<RescanResponse> | null | undefined): SyncOutcome {
  switch (r?.outcome) {
    case 'accepted':
      return { level: 'good', kind: 'check', title: 'Repository synced', text: `Published ${plural((r as { changedAssignmentCount?: number }).changedAssignmentCount ?? 0, 'changed assignment')}. Running Agents fetch them on their next poll.` };
    case 'unchanged':
      return { level: 'good', kind: 'check', title: 'Repository is up to date', text: 'No new assignments were needed. Agents continue syncing their current assignments.' };
    case 'invalid':
      return { level: 'warning', kind: 'bang', title: 'Repository sync was rejected', text: 'The manifest did not validate. Current assignments remain active. See Recent scans for the reason.' };
    case 'failed':
      return { level: 'critical', kind: 'x', title: 'Repository sync failed', text: 'Check the Server’s Git access. Current assignments remain active.' };
    default: {
      const other = (r as { outcome?: string } | null | undefined)?.outcome;
      if (other === 'disabled') return { level: 'info', kind: 'info', title: 'No repository configured', text: 'No source repository is configured on this Server.' };
      if (other === 'already_running') return { level: 'info', kind: 'info', title: 'A sync is already running', text: 'Try again shortly to check for changes.' };
      return { level: 'warning', kind: 'bang', title: 'Unknown sync result', text: 'The Server returned an unknown result. Check Recent scans before retrying.' };
    }
  }
}

const TONE: Record<string, ToastTone> = { critical: 'critical', warning: 'warning', info: 'info' };

/**
 * The "Sync repository" button (Repository, Problems and the empty Deployments page). The request is not tied to the view: it
 * completes and reports in a toast even when the user has moved on, and `shared.syncing` / `shared.lastSync` belong to the
 * whole app. `onDone` runs only while the view that started the sync is still the page on screen, so a late answer never
 * reloads the page the user is on now.
 */
export function useRepositorySync(onDone?: () => unknown): { sync(): Promise<void> } {
  const { api, shared, toasts } = useFleet();
  const view = useView();
  async function sync(): Promise<void> {
    if (shared.syncing) return;
    const visit = view.visit();
    shared.syncing = true;
    toasts.push('Repository sync started', { tone: 'info', text: 'Fetching and validating repository changes…' });
    try {
      const r = await api.post<RescanResponse>('source/rescan', {});
      const f = syncOutcome(r);
      const result: ActionResult = { level: f.level, kind: f.kind, label: f.title, text: `${f.title}. ${f.text}` };
      shared.lastSync = result;
      toasts.push(f.title, { tone: TONE[f.level] ?? 'good', text: f.text });
    } catch (e) {
      toasts.fail(e, 'Repository sync could not be confirmed');
    }
    shared.syncing = false;
    if (visit.isCurrent() && onDone) await onDone();
  }
  return { sync };
}
