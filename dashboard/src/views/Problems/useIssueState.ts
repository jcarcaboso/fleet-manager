import { reactive } from 'vue';
import type { Issue, IssueStateRequest } from '@/api/types';
import { useView } from '@/composables/useView';
import { useFleet } from '@/context';
import { errorCount, patchIssue, SNOOZE } from '@/lib/model';

export interface IssueChange {
  id: string;
  op: IssueStateRequest['action'];
  hours?: number;
}

/** The toast of each change (ported from view-problems.js). */
const DONE: Record<IssueChange['op'], (hours?: number) => [string, string]> = {
  acknowledge: () => ['Problem acknowledged', 'It stays listed under Acknowledged and returns to Open if it starts over.'],
  snooze: h => [`Snoozed for ${(SNOOZE.find(x => x[0] === h) ?? [0, `${h} h`, `${h} hours`])[2]}`, 'It returns to Open by itself when the time is up.'],
  reopen: () => ['Problem reopened', 'It is back under Open.'],
};

/**
 * Acknowledge, snooze and reopen. The issue ID contains ":" and can contain URLs, so it travels in the JSON body, never in the
 * path; the Server answers with the updated issue. The request is not tied to the view (a change the user made is applied even if
 * they have moved on), but `onUpdated` and `onGone` run only while the view that started it is still on screen. The navigation
 * badge (`summary`) is patched and re-read either way.
 */
export function useIssueState(handlers: { onUpdated(item: Issue): void; onGone(): unknown }): { busy: Set<string>; change(c: IssueChange): Promise<void> } {
  const { api, summary, toasts } = useFleet();
  const view = useView();
  const busy = reactive(new Set<string>());
  async function change({ id, op, hours }: IssueChange): Promise<void> {
    if (!id || !DONE[op] || busy.has(id)) return;
    const visit = view.visit();
    busy.add(id);
    let item: Issue | null = null;
    let gone = false;
    try {
      item = await api.post<Issue>('issues/state', { id, action: op, ...(op === 'snooze' ? { hours } : {}) });
    } catch (e) {
      gone = (e as { code?: string } | null)?.code === 'issue_not_found';
      toasts.fail(e, 'The problem was not changed');
    }
    busy.delete(id);
    if (item?.id) {
      const [title, text] = DONE[op](hours);
      toasts.push(title, { text });
      if (visit.isCurrent()) handlers.onUpdated(item);
      if (summary.state.issues) {
        summary.state.issues = patchIssue(summary.state.issues, item);
        summary.state.errors = errorCount(summary.state.issues);
      }
      void summary.refresh(true);
    }
    if (visit.isCurrent() && gone) await handlers.onGone();
  }
  return { busy, change };
}
