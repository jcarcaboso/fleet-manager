/**
 * The controller of one machine page. `NodeView` creates it and provides it to the tabs, so what belongs to the machine (the
 * loaded record, tab data, the disk refresh in progress, the rename/revoke/remove flows) survives tab changes and dies with the page.
 *
 * Staleness rules (ported from view-node.js):
 * - The router keys `NodeView` by alias, so a page is exactly one stay on one machine. `view.visit()` taken before a mutation says,
 *   after the `await`, whether the user is still there: only then may the answer repaint, close a dialog or navigate.
 *   Switching tabs keeps the page, so a mutation started on one tab still follows the user on another.
 * - Every load goes through a lane (`useLoad` for the machine, one lane per tab group): only the newest counts and the older request is aborted.
 * - The disk refresh is a POST followed by a bounded poll with an independent deadline. Leaving the page aborts both.
 * - An Agent update is followed the same way: while it is requested, downloading or restarting (after Update Agent, or when the page opens
 *   on one), the machine is read every `UPDATE_POLL_MS` until it finishes and the Agent reports the new version, or `UPDATE_WAIT_MS` passes.
 */
import { computed, inject, reactive, ref, watch, type ComputedRef, type InjectionKey } from 'vue';
import { useRouter } from 'vue-router';
import type { AgentUpdate, AuditEvent, CheckinBucket, CheckinsResponse, DiskRefreshResponse, ErrorBody, Issue, IssuesResponse, IssueStateKey, NodeAttempt, NodeDetail, Page } from '@/api/types';
import { useLoad } from '@/composables/useLoad';
import { useView } from '@/composables/useView';
import { useFleet } from '@/context';
import { isSilent, serverMessage, soft } from '@/lib/errors';
import { enc, ms, now } from '@/lib/format';
import {
  agentUpdateOf, canUpdateAgent, diskDetail, errorCount, fromDetail, health as modelHealth, osText, patchIssue, SNOOZE, updatePending, type DiskView, type Health, type IssueLevel,
  type NodeDetailView,
} from '@/lib/model';
import { targetLabel } from '@/lib/targets';
import { nodeRoute, type NodeTab } from '@/router';
import { activityEvents, failuresOf, problemsOf, type ActivityEvent, type ProblemEntry } from './nodeModel';

export const ACTIVITY_PAGE = 25;
/** The Node detail has no poll interval, so two poll intervals are taken as 2.5 minutes. */
export const DISK_POLL_MS = 5000;
export const DISK_WAIT_MS = 150_000;
/** The deadline allows the last read, due at `DISK_WAIT_MS`, a moment to answer. */
export const DISK_GRACE_MS = 1000;

/** While an Agent update is active the machine is read this often, for at most `UPDATE_WAIT_MS` (the Agent rolls back by itself after 10 minutes without a poll). */
export const UPDATE_POLL_MS = 5000;
export const UPDATE_WAIT_MS = 600_000;

/** How old the loaded machine may be before a tab change reads it again (the old dashboard's `cacheAt` rule). */
export const STALE_MS = 15_000;

export type DiskPhase = 'requesting' | 'waiting' | 'answered' | 'timeout' | 'error';
export interface DiskRun {
  phase: DiskPhase;
  tone: '' | 'warning' | 'critical';
  message: string;
  requestedAt: string | null;
}
export interface FormNote {
  text: string;
  err: boolean;
  /** Neither an error nor a success ("That is already the alias."): no `is-ok` / `is-err` class. */
  neutral?: boolean;
}
/** Update Agent and Cancel: the request in flight, and why the last one was refused. */
export interface UpdateRun {
  busy: 'request' | 'cancel' | null;
  error: { text: string; tone: 'warning' | 'critical' } | null;
}
export interface NodeDialog {
  kind: 'revoke' | 'remove';
  /** The machine the dialog was opened for. */
  id: string;
  alias: string;
  busy: boolean;
  error: string | null;
}
export interface Loaded {
  missing: false;
  node: NodeDetailView;
  issues: Issue[];
  /** `false` when `GET issues` failed: the page degrades to the failed Targets of the machine record. */
  issuesOk: boolean;
}
export interface Missing {
  missing: true;
}

const DONE: Record<'acknowledge' | 'snooze' | 'reopen', (hours?: number) => [string, string]> = {
  acknowledge: () => ['Problem acknowledged', 'It stays listed under Acknowledged and returns to Open if it starts over.'],
  snooze: h => [`Snoozed for ${(SNOOZE.find(x => x[0] === h) ?? [0, `${h} h`, `${h} hours`])[2]}`, 'It returns to Open by itself when the time is up.'],
  reopen: () => ['Problem reopened', 'It is back under Open.'],
};

export function createNodePage(getAlias: () => string, getTab: () => NodeTab) {
  const { api, catalog, summary, toasts, shell, session, renameNotes, gallery } = useFleet();
  const router = useRouter();
  const view = useView();
  const alias = getAlias();

  /* ---------------------------------------------------------------- the machine */
  /** When the machine was last read successfully (`now()`); a tab change reads it again once it is older than `STALE_MS`. */
  let loadedAt = 0;
  const core = useLoad<Loaded | Missing>(async token => {
    let detail: NodeDetail;
    try {
      [detail] = await Promise.all([api.get<NodeDetail>(`nodes/${enc(alias)}`, undefined, { signal: token.signal }), catalog.load()]);
    } catch (e) {
      if ((e as { code?: string } | null)?.code !== 'node_not_found') throw e;
      token.check();
      return { missing: true };
    }
    token.check();
    const issues = await api.get<IssuesResponse>('issues', undefined, { signal: token.signal }).catch(soft);
    token.check();
    void summary.refresh(true);
    shell.markLoaded();
    loadedAt = now();
    return { missing: false, node: fromDetail(detail), issues: issues?.items ?? [], issuesOk: !!issues };
  }, { view });

  const loaded: ComputedRef<Loaded | null> = computed(() => {
    const d = core.data.value;
    return d && !d.missing ? d : null;
  });
  const node: ComputedRef<NodeDetailView | null> = computed(() => loaded.value?.node ?? null);
  const issues = computed(() => loaded.value?.issues ?? []);
  const issuesOk = computed(() => loaded.value?.issuesOk ?? false);
  const missing = computed(() => core.data.value?.missing === true);
  function patchLoaded(fn: (d: Loaded) => Loaded): void {
    const d = loaded.value;
    if (d) core.data.value = fn(d);
  }

  const failures = computed(() => (node.value ? failuresOf(node.value) : []));
  const problems: ComputedRef<ProblemEntry[]> = computed(() => (node.value ? problemsOf(node.value, issues.value, catalog) : []));
  const openProblems = computed(() => problems.value.filter(p => p.st.key === 'open'));
  const health: ComputedRef<Health | null> = computed(() => (node.value ? modelHealth(node.value, failures.value, code => catalog.title(code)) : null));
  const worst: ComputedRef<IssueLevel> = computed(() => openProblems.value[0]?.level ?? 'info');
  const os = computed(() => (node.value ? osText(node.value) : null));

  /* ---------------------------------------------------------------- tab data */
  const hours = ref(168);
  const tab = reactive({
    checkins: {} as Record<number, CheckinBucket[]>,
    checkinsErr: null as Error | null,
    attempts: [] as NodeAttempt[],
    attemptsNext: null as string | null,
    attemptsErr: null as Error | null,
    audit: [] as AuditEvent[],
    auditNext: null as string | null,
    auditErr: null as Error | null,
    /** The first page of Activity has arrived (or failed). */
    activityReady: false,
    loadingMore: false,
    tAttempts: new Map<string, NodeAttempt[]>(),
    actFilter: 'all',
    probState: 'open' as IssueStateKey,
  });
  const lanes = { checkins: view.lane(), activity: view.lane(), problems: view.lane() };
  /** Bumped whenever the first page of Activity is replaced, so a "load older" that started before cannot append to the new list. */
  let activityGen = 0;

  async function loadCheckins(id: string, force = false): Promise<void> {
    const h = hours.value;
    if (!force && tab.checkins[h]) return;
    const token = lanes.checkins.begin();
    tab.checkinsErr = null;
    try {
      const r = await api.get<CheckinsResponse>(`nodes/${enc(id)}/checkins`, { hours: h }, { signal: token.signal });
      if (!token.isCurrent()) return;
      tab.checkins = { ...tab.checkins, [h]: r?.buckets || [] };
    } catch (e) {
      if (!token.isCurrent() || isSilent(e)) return;
      tab.checkinsErr = e as Error;
    }
  }

  async function loadActivity(id: string): Promise<void> {
    const token = lanes.activity.begin();
    const read = <T>(job: Promise<Page<T>>): Promise<{ page: Page<T> | null; error: Error | null }> =>
      job.then(page => ({ page, error: null }), e => {
        if (isSilent(e)) throw e;
        return { page: null, error: e as Error };
      });
    try {
      const [a, b] = await Promise.all([
        read(api.page<NodeAttempt>(`nodes/${enc(id)}/attempts`, { limit: ACTIVITY_PAGE }, { signal: token.signal })),
        read(api.page<AuditEvent>('audit', { node: id, order: 'newest', limit: ACTIVITY_PAGE }, { signal: token.signal })),
      ]);
      if (!token.isCurrent()) return;
      activityGen++;
      tab.attemptsErr = a.error;
      tab.attempts = a.page?.items ?? [];
      tab.attemptsNext = a.page?.nextCursor ?? null;
      tab.auditErr = b.error;
      tab.audit = b.page?.items ?? [];
      tab.auditNext = b.page?.nextCursor ?? null;
      tab.activityReady = true;
    } catch {
      /* cancelled: whatever replaced this load owns the state */
    }
  }

  async function loadProblems(id: string, n: NodeDetailView): Promise<void> {
    const token = lanes.problems.begin();
    const next = new Map(tab.tAttempts);
    try {
      await Promise.all(n.targets.filter(x => x.state === 'failed').slice(0, 5).map(t =>
        api.get<Page<NodeAttempt>>(`nodes/${enc(id)}/attempts`, { target: t.name, limit: 8 }, { signal: token.signal }).then(
          r => { next.set(t.name, r?.items || []); },
          e => {
            if (isSilent(e)) throw e;
            next.delete(t.name);
          },
        )));
    } catch {
      return;
    }
    if (token.isCurrent()) tab.tAttempts = next;
  }

  /** Reads what a tab shows for the machine on screen. Called when the tab (or the machine) changes and after a reload. */
  async function loadTab(which: NodeTab, force = false): Promise<void> {
    const n = node.value;
    if (!n) return;
    if (which === 'overview') await loadCheckins(n.id, force);
    else if (which === 'activity') await loadActivity(n.id);
    else if (which === 'problems') await loadProblems(n.id, n);
  }

  /** Reads the machine and the current tab again without replacing the page (after a retry, a revoke, a disk answer or a vanished issue). */
  async function reload(): Promise<void> {
    await core.run({ quiet: true });
    await loadTab(getTab(), true);
  }

  let tabSeq = 0;
  /**
   * The tab (or the machine) on screen changed: read what the tab shows. When the machine was last read more than `STALE_MS` ago it is read
   * again first, quietly (the page keeps its content, a newer read supersedes this one, as in `reload()`), so a Target that failed while the
   * visitor was on another tab shows up on Problems.
   */
  async function showTab(which: NodeTab): Promise<void> {
    const seq = ++tabSeq;
    if (node.value && now() - loadedAt > STALE_MS) {
      await core.run({ quiet: true });
      if (seq !== tabSeq) return; // another tab change owns the reading now
      await loadTab(which, true);
      return;
    }
    await loadTab(which);
  }

  async function setRange(h: number): Promise<void> {
    hours.value = h;
    const n = node.value;
    if (n) await loadCheckins(n.id);
  }

  async function loadMoreActivity(): Promise<void> {
    const n = node.value;
    if (!n || tab.loadingMore) return;
    const visit = view.visit();
    const gen = activityGen;
    const attemptsAfter = tab.attemptsNext;
    const auditAfter = tab.auditNext;
    tab.loadingMore = true;
    let attempts: Page<NodeAttempt> | null = null;
    let audit: Page<AuditEvent> | null = null;
    let failure: unknown = null;
    await Promise.all([
      attemptsAfter && api.page<NodeAttempt>(`nodes/${enc(n.id)}/attempts`, { limit: ACTIVITY_PAGE, after: attemptsAfter }, { signal: visit.signal }).then(r => { attempts = r; }),
      auditAfter && api.page<AuditEvent>('audit', { node: n.id, order: 'newest', limit: ACTIVITY_PAGE, after: auditAfter }, { signal: visit.signal }).then(r => { audit = r; }),
    ].filter(Boolean).map(job => (job as Promise<void>).catch(e => { failure = failure || e; })));
    tab.loadingMore = false;
    if (!visit.isCurrent() || gen !== activityGen) return;
    if (attempts) { tab.attempts = tab.attempts.concat((attempts as Page<NodeAttempt>).items); tab.attemptsNext = (attempts as Page<NodeAttempt>).nextCursor; }
    if (audit) { tab.audit = tab.audit.concat((audit as Page<AuditEvent>).items); tab.auditNext = (audit as Page<AuditEvent>).nextCursor; }
    if (failure) toasts.fail(failure, 'Could not load older activity');
  }

  const activity: ComputedRef<ActivityEvent[]> = computed(() => (node.value ? activityEvents(node.value, tab.attempts, tab.audit, tab.auditNext, catalog) : []));

  /* ---------------------------------------------------------------- retry */
  const retrying = reactive(new Set<string>());
  async function retry(targetName: string): Promise<void> {
    const n = node.value;
    if (!n) return;
    const key = n.id + ':' + targetName;
    if (retrying.has(key)) return;
    const visit = view.visit();
    const t = n.targets.find(x => x.name === targetName) ?? { name: targetName };
    retrying.add(key);
    try {
      /* Not tied to the page: a retry the user asked for is sent even when they leave at once. */
      await api.post(`nodes/${enc(n.id)}/retry`, { target: targetName });
      toasts.push(`Retry requested for ${targetLabel(t)} on ${n.alias}`, { text: 'The Agent applies it on its next poll.' });
    } catch (e) {
      toasts.fail(e, 'Retry was not requested');
    }
    retrying.delete(key);
    if (visit.isCurrent()) await reload();
  }

  /* ---------------------------------------------------------------- acknowledge, snooze, reopen */
  const issueBusy = reactive(new Set<string>());
  async function changeIssue({ id, op, hours: h }: { id: string; op: 'acknowledge' | 'snooze' | 'reopen'; hours?: number }): Promise<void> {
    if (!id || !DONE[op] || issueBusy.has(id)) return;
    const visit = view.visit();
    issueBusy.add(id);
    let item: Issue | null = null;
    let gone = false;
    try {
      item = await api.post<Issue>('issues/state', { id, action: op, ...(op === 'snooze' ? { hours: h } : {}) });
    } catch (e) {
      gone = (e as { code?: string } | null)?.code === 'issue_not_found';
      toasts.fail(e, 'The problem was not changed');
    }
    issueBusy.delete(id);
    if (item?.id) {
      const [title, text] = DONE[op](h);
      toasts.push(title, { text });
      const updated = item;
      if (visit.isCurrent()) patchLoaded(d => ({ ...d, issues: patchIssue(d.issues, updated) }));
      if (summary.state.issues) {
        summary.state.issues = patchIssue(summary.state.issues, updated);
        summary.state.errors = errorCount(summary.state.issues);
      }
      void summary.refresh(true);
    }
    if (visit.isCurrent() && gone) await reload();
  }

  /* ---------------------------------------------------------------- disk refresh */
  const disk = ref<DiskRun | null>(null);
  const diskBusy = computed(() => disk.value?.phase === 'requesting' || disk.value?.phase === 'waiting');
  let diskPoll: { stop(): void } | null = null;
  const stopDiskPoll = (): void => {
    diskPoll?.stop();
    diskPoll = null;
  };
  const newerDisk = (cur: DiskView | null, next: DiskView): boolean => !cur || !cur.measuredAt || !next.measuredAt || (ms(next.measuredAt) ?? 0) >= (ms(cur.measuredAt) ?? 0);
  function diskFail(run: DiskRun, e: { code?: string | null; status?: number; message?: string }): void {
    run.phase = 'error';
    run.tone = e.status === 403 ? 'warning' : 'critical';
    run.message = e.code === 'node_revoked' || e.status === 409 ? 'This machine has been revoked, so it cannot answer a disk refresh.' : e.message || 'The refresh was not requested.';
  }

  async function refreshDisk(): Promise<void> {
    const n = node.value;
    if (!n || n.revoked || diskBusy.value) return;
    stopDiskPoll();
    const visit = view.visit();
    const run = reactive<DiskRun>({ phase: 'requesting', tone: '', message: '', requestedAt: null });
    disk.value = run;
    let res: DiskRefreshResponse | null;
    try {
      res = await api.post<DiskRefreshResponse>(`nodes/${enc(n.id)}/disk-usage/refresh`, {}, { signal: visit.signal });
    } catch (e) {
      if (!visit.isCurrent() || disk.value !== run) return;
      diskFail(run, e as ApiLikeError);
      const status = (e as { status?: number }).status;
      if (status !== 403 && status !== 409) toasts.fail(e, 'Disk refresh was not requested');
      return;
    }
    if (!visit.isCurrent() || disk.value !== run) return;
    run.requestedAt = res?.refreshRequestedAt || new Date().toISOString();
    run.phase = 'waiting';
    const startedAt = now();
    patchLoaded(d => ({ ...d, node: { ...d.node, disk: { measuredAt: d.node.disk?.measuredAt ?? null, volumes: d.node.disk?.volumes ?? [], refreshRequestedAt: run.requestedAt } } }));
    /* The first read is one interval after the request; the deadline is independent of the reads and aborts one that never answers. */
    diskPoll = view.poll<DiskView | null>(async token => diskDetail((await api.get<NodeDetail>(`nodes/${enc(n.id)}`, undefined, { signal: token.signal })).disk), {
      intervalMs: DISK_POLL_MS, timeoutMs: DISK_WAIT_MS + DISK_GRACE_MS, immediate: false,
      done: d => {
        if (disk.value !== run || run.phase !== 'waiting') return true;
        const current = node.value?.disk ?? null;
        if (d && newerDisk(current, d)) patchLoaded(l => ({ ...l, node: { ...l.node, disk: d } }));
        if (d && d.measuredAt && (ms(d.measuredAt) ?? 0) > (ms(run.requestedAt) ?? 0)) {
          run.phase = 'answered';
          /* Reload quietly so the Problems tab count and the disk issues follow the new measurement. */
          if (visit.isCurrent()) void reload();
          return true;
        }
        if (now() - startedAt >= DISK_WAIT_MS) {
          run.phase = 'timeout';
          return true;
        }
        return false;
      },
      onError: e => {
        if ((e as { code?: string } | null)?.code === 'node_not_found' && disk.value === run && run.phase === 'waiting') {
          diskFail(run, e as ApiLikeError);
          return 'stop';
        }
        return undefined;
      },
      onTimeout: () => {
        if (disk.value === run && run.phase === 'waiting') run.phase = 'timeout';
      },
    });
  }

  /* ---------------------------------------------------------------- Agent update */
  const update = reactive<UpdateRun>({ busy: null, error: null });
  let updatePoll: { stop(): void } | null = null;
  const patchUpdate = (u: AgentUpdate | null): void => patchLoaded(d => ({ ...d, node: { ...d.node, update: agentUpdateOf(u) } }));
  /** The Server's explanation of a refusal (it says why the release is unavailable, for example), or the dashboard's own message. */
  const refusal = (e: unknown): UpdateRun['error'] => {
    const status = (e as ApiLikeError).status;
    return { text: serverMessage(e, 'The update was not requested.'), tone: status === 403 || status === 409 ? 'warning' : 'critical' };
  };

  /**
   * Follows an active update until the Agent finishes it and reports the new version, which comes with telemetry after the success.
   * Started after Update Agent and whenever the loaded machine has a pending update (`updatePending`).
   */
  function followUpdate(): void {
    const n = node.value;
    if (!n || updatePoll || !updatePending(n)) return;
    const id = n.id;
    updatePoll = view.poll<NodeDetail>(token => api.get<NodeDetail>(`nodes/${enc(id)}`, undefined, { signal: token.signal }), {
      intervalMs: UPDATE_POLL_MS, timeoutMs: UPDATE_WAIT_MS, immediate: false,
      done: d => {
        const next = fromDetail(d);
        patchLoaded(l => (l.node.id === id ? { ...l, node: { ...l.node, agent: next.agent, update: next.update, lastContactAt: next.lastContactAt, freshness: next.freshness } } : l));
        if (updatePending(next)) return false;
        /* Finished: read the machine and its issues again, so health, the Problems count and agent_update_failed follow the result. */
        void reload();
        return true;
      },
      onError: e => ((e as { code?: string } | null)?.code === 'node_not_found' ? 'stop' : undefined),
      onStop: () => { updatePoll = null; },
    });
  }
  watch(() => node.value?.update?.state, () => followUpdate());

  async function updateAgent(): Promise<void> {
    const n = node.value;
    if (!n || update.busy || !canUpdateAgent(n)) return;
    const visit = view.visit();
    update.busy = 'request';
    update.error = null;
    let res: AgentUpdate | null = null;
    try {
      /* Not tied to the page: the first request of a release can take minutes while the Server mirrors it, and it is sent either way. */
      res = await api.post<AgentUpdate>(`nodes/${enc(n.id)}/agent-update`);
    } catch (e) {
      update.busy = null;
      if (isSilent(e)) return;
      const why = refusal(e);
      if (visit.isCurrent()) update.error = why;
      if ((e as ApiLikeError).status !== 403) toasts.push('Agent update was not requested', { tone: why!.tone, text: why!.text, sticky: true });
      /* The Agent may have changed meanwhile (updated, started an update, or the machine was revoked). */
      if (visit.isCurrent() && (e as ApiLikeError).status === 409) await reload();
      return;
    }
    update.busy = null;
    toasts.push(`Update requested for ${n.alias}`, { text: `The Agent installs ${res?.targetVersion ?? 'the new version'} after its next check-in.` });
    if (!visit.isCurrent()) return;
    patchUpdate(res);
    followUpdate();
  }

  async function cancelUpdate(): Promise<void> {
    const n = node.value;
    if (!n || update.busy || n.update?.state !== 'requested') return;
    const visit = view.visit();
    update.busy = 'cancel';
    update.error = null;
    let res: AgentUpdate | null = null;
    try {
      res = await api.post<AgentUpdate>(`nodes/${enc(n.id)}/agent-update/cancel`);
    } catch (e) {
      update.busy = null;
      if (isSilent(e)) return;
      const why = refusal(e);
      if (visit.isCurrent()) update.error = why;
      if ((e as ApiLikeError).status !== 403) toasts.push('The update was not cancelled', { tone: why!.tone, text: why!.text, sticky: true });
      if (visit.isCurrent() && (e as ApiLikeError).status === 409) await reload();
      return;
    }
    update.busy = null;
    toasts.push(`Update cancelled for ${n.alias}`, { text: 'The Agent keeps its current version.' });
    if (!visit.isCurrent()) return;
    updatePoll?.stop();
    patchUpdate(res);
  }

  /* ---------------------------------------------------------------- rename, revoke, remove */
  const note = renameNotes.get(alias);
  renameNotes.delete(alias);
  const renameMsg = ref<FormNote | null>(note ? { text: note, err: false } : null);
  const renameInvalid = ref(false);
  const renaming = ref(false);

  async function rename(raw: string): Promise<void> {
    const n = node.value;
    if (!n || renaming.value) return;
    const visit = view.visit();
    const v = raw.trim();
    if (v === n.alias) {
      renameMsg.value = { text: 'That is already the alias.', err: false, neutral: true };
      return;
    }
    if (!v || v.length > 200) {
      renameMsg.value = { text: 'Choose a nonblank alias of at most 200 characters.', err: true };
      renameInvalid.value = true;
      return;
    }
    renameInvalid.value = false;
    renaming.value = true;
    try {
      await api.post('nodes/rename', { currentAlias: n.alias, alias: v });
    } catch (e) {
      renaming.value = false;
      if (visit.isCurrent()) {
        renameMsg.value = { text: errorText(e), err: true };
        renameInvalid.value = true;
      }
      toasts.fail(e, 'Rename failed');
      return;
    }
    renaming.value = false;
    gallery.search = ''; // the old `galleryReset`: the renamed machine must be visible in the gallery
    if (visit.isCurrent()) {
      renameNotes.set(v, `Renamed from ${n.alias}. Update its entry in fleet.yml too.`);
      toasts.push('Alias changed', { text: 'Update its entry in fleet.yml too.' });
      /* The new page takes the note when it is created. A navigation that did not happen (cancelled, or the guard sent the visitor away) must not leave it for a later page. */
      let moved = false;
      try { moved = !(await router.push(nodeRoute(v, 'settings'))); } catch { /* treated as not moved */ }
      if (!moved) renameNotes.delete(v);
    } else {
      toasts.push(`${n.alias} is now ${v}`, { text: 'Update its entry in fleet.yml too.' });
    }
  }

  const dialog = ref<NodeDialog | null>(null);
  function openDialog(kind: 'revoke' | 'remove'): void {
    const n = node.value;
    if (!n || (kind === 'revoke' && n.revoked)) return;
    dialog.value = { kind, id: n.id, alias: n.alias, busy: false, error: null };
  }
  function closeDialog(): void {
    if (dialog.value && !dialog.value.busy) dialog.value = null;
  }
  /** The route changed (Back, Forward, a tab link): the dialog goes, even while it is busy. Its late answer finds `dialog.value !== d` and touches nothing. */
  function dismissDialog(): void {
    dialog.value = null;
  }

  async function confirmRevoke(): Promise<void> {
    const d = dialog.value;
    if (!d || d.kind !== 'revoke' || d.busy) return;
    const visit = view.visit();
    d.busy = true;
    d.error = null;
    try {
      await api.post(`nodes/${enc(d.id)}/revoke`, {});
    } catch (e) {
      d.busy = false;
      d.error = errorText(e);
      toasts.fail(e);
      return;
    }
    if (dialog.value === d) dialog.value = null;
    toasts.push(`${d.alias} revoked`, { text: 'Node access revoked. Stop its Agent on the machine.' });
    if (visit.isCurrent()) await reload();
  }

  async function confirmRemove(): Promise<void> {
    const d = dialog.value;
    if (!d || d.kind !== 'remove' || d.busy) return;
    const visit = view.visit();
    d.busy = true;
    d.error = null;
    try {
      await api.post(`nodes/${enc(d.id)}/remove`, { alias: d.alias });
    } catch (e) {
      d.busy = false;
      d.error = errorText(e);
      toasts.fail(e);
      return;
    }
    /* The machine is gone either way. Only the page it was removed from goes back to the list. */
    gallery.search = ''; // the old `galleryReset`
    const stay = visit.isCurrent();
    if (dialog.value === d) dialog.value = null;
    toasts.push(`${d.alias} removed`, { text: 'Its alias is available for a new enrollment.' });
    if (stay) await router.push({ name: 'machines' });
  }

  return {
    alias, core, loaded, node, issues, issuesOk, missing, failures, problems, openProblems, health, worst, os,
    hours, tab, activity, retrying, issueBusy, disk, diskBusy, update, updateAgent, cancelUpdate,
    renameMsg, renameInvalid, renaming, dialog, canAdmin: computed(() => session.can('admin')),
    loadTab, showTab, reload, setRange, loadMoreActivity, retry, changeIssue, refreshDisk, rename, openDialog, closeDialog, dismissDialog, confirmRevoke, confirmRemove,
  };
}

interface ApiLikeError { code?: string | null; status?: number; message?: string; details?: ErrorBody | null }
const errorText = (e: unknown): string => (e as { message?: string } | null)?.message || 'Something went wrong.';

export type NodePage = ReturnType<typeof createNodePage>;
export const NODE_PAGE: InjectionKey<NodePage> = Symbol('node-page');
export function useNodePage(): NodePage {
  const page = inject(NODE_PAGE, null);
  if (!page) throw new Error('useNodePage() needs a NodeView above it.');
  return page;
}
