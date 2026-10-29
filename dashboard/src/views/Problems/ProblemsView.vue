<script setup lang="ts">
import { computed, ref } from 'vue';
import type { AgentUpdate, Issue, IssuesResponse } from '@/api/types';
import ChipsFilter from '@/components/ChipsFilter.vue';
import CopyBox from '@/components/CopyBox.vue';
import EmptyState from '@/components/EmptyState.vue';
import ErrorState from '@/components/ErrorState.vue';
import FailureDetail from '@/components/FailureDetail.vue';
import Icon from '@/components/Icon.vue';
import IssueActions from '@/components/IssueActions.vue';
import IssueBanner from '@/components/IssueBanner.vue';
import LoadingBlock from '@/components/LoadingBlock.vue';
import LockNote from '@/components/LockNote.vue';
import MdText from '@/components/MdText.vue';
import PageHead from '@/components/PageHead.vue';
import ScopeButton from '@/components/ScopeButton.vue';
import StatusGlyph from '@/components/StatusGlyph.vue';
import StatusPill from '@/components/StatusPill.vue';
import StepsList from '@/components/StepsList.vue';
import { useLoad } from '@/composables/useLoad';
import { useFleet } from '@/context';
import { isSilent, serverMessage } from '@/lib/errors';
import { enc, fmtFull, num, plural, rel } from '@/lib/format';
import type { GlyphKind } from '@/lib/status';
import { targetLabel } from '@/lib/targets';
import {
  STATE_LABEL, errorCount, fixSteps, issueBadge, issueKind, issueLevel, issueSection, issueState, patchIssue, sortIssues,
  type IssueLevel, type IssueSection,
} from '@/lib/model';
import { nodeRoute } from '@/router';
import { useRepositorySync } from '../Repository/useRepositorySync';
import { useIssueState } from './useIssueState';

/**
 * Problems: every open, acknowledged or snoozed issue with its catalog explanation, the steps to fix it and the commands to run.
 * API: GET issues, GET errors, POST nodes/{node}/retry, POST nodes/{node}/agent-update, POST source/rescan, POST issues/state. The page
 * shows one state at a time (Open first); the navigation badge counts open errors only.
 */
const { api, catalog, summary, shell, shared, session, toasts, openState } = useFleet();

const items = ref<Issue[]>([]);
const stateTab = ref<string>('open');
const filter = ref<string>('all');
const retrying = ref(new Set<string>());
const updating = ref(new Set<string>());

const load = useLoad(async token => {
  const [issues] = await Promise.all([api.get<IssuesResponse>('issues', undefined, { signal: token.signal }), catalog.load()]);
  token.check();
  items.value = issues?.items ?? [];
  summary.state.issues = items.value;
  summary.state.errors = errorCount(items.value);
  shell.markLoaded();
  return true;
});
const { data, error, loading, reload, run } = load;

const quietReload = (): Promise<unknown> => run({ quiet: true });
const { sync } = useRepositorySync(quietReload);
const { busy, change } = useIssueState({
  onUpdated: item => { items.value = patchIssue(items.value, item); },
  onGone: quietReload,
});

interface Decorated {
  i: Issue;
  level: IssueLevel;
  kind: GlyphKind;
  badge: string;
  section: IssueSection;
  cat: ReturnType<typeof catalog.get>;
  id: string;
  st: ReturnType<typeof issueState>;
}
const decorate = (i: Issue): Decorated => {
  const level = issueLevel(i);
  return { i, level, kind: issueKind(level), badge: issueBadge(level), section: issueSection(i), cat: catalog.get(i.errorCode) || catalog.get(i.code), id: i.id, st: issueState(i) };
};
const whereText = (p: Decorated): string => {
  const i = p.i;
  if (i.nodeName && i.target) return `${targetLabel({ name: i.target })} on ${i.nodeName}`;
  if (i.nodeName) return i.nodeName;
  if (p.section === 'models') return 'CLIProxy models';
  if (p.section === 'repository') return 'Repository';
  return i.section === 'nodes' ? 'Machines' : (i.section || 'Server');
};

const GROUPS: ReadonlyArray<readonly [IssueLevel, string, string, GlyphKind]> = [
  ['critical', 'Errors', 'Something failed and needs a fix.', 'x'],
  ['serious', 'Offline machines', 'Fleet has not heard from these Agents recently.', 'moon'],
  ['warning', 'Warnings', 'Fine for now, but they can become problems if left alone.', 'bang'],
  ['info', 'Notices', 'Good to know. Nothing is broken.', 'info'],
];

const everything = computed(() => sortIssues(items.value).map(decorate));
const inState = (k: string): Decorated[] => everything.value.filter(p => p.st.key === k);
const all = computed(() => inState(stateTab.value));
const open = computed(() => inState('open'));
const list = computed(() => all.value.filter(p => filter.value === 'all' || p.section === filter.value));
const levelCount = (l: IssueLevel): number => all.value.filter(p => p.level === l).length;
const machines = computed(() => new Set(open.value.filter(p => p.level === 'critical' && p.i.nodeId).map(p => p.i.nodeId)).size);
const quietCount = computed(() => everything.value.length - open.value.length);

const stateChips = computed(() => [
  ['open', 'Open', open.value.length], ['acknowledged', 'Acknowledged', inState('acknowledged').length], ['snoozed', 'Snoozed', inState('snoozed').length],
] as Array<[string, string, number]>);
const filterChips = computed(() => ([
  ['all', 'Everything', all.value.length],
  ['machines', 'Machines', all.value.filter(p => p.section === 'machines').length],
  ['repository', 'Repository', all.value.filter(p => p.section === 'repository').length],
  ['models', 'Models', all.value.filter(p => p.section === 'models').length],
  ['other', 'Other', all.value.filter(p => p.section === 'other').length],
] as Array<[string, string, number]>).filter(c => c[0] === 'all' || c[2] > 0 || filter.value === c[0]));

/* The first row on the page is open unless the user chose otherwise; the rows are keyed by issue ID, so a toggle survives repaints. */
const groups = computed(() => {
  let first = true;
  return GROUPS.map(([level, title, sub]) => {
    const rows = list.value.filter(p => p.level === level).map(p => {
      const defaultOpen = first;
      first = false;
      return { p, defaultOpen };
    });
    return { level, title, sub, rows };
  }).filter(g => g.rows.length);
});

const sub = computed(() => {
  const o = open.value;
  const errors = o.filter(p => p.level === 'critical').length;
  const quiet = quietCount.value;
  if (o.length) {
    return `${plural(errors, 'open error')}${machines.value ? ` on ${plural(machines.value, 'machine')}` : ''}, explained with the steps to fix them. Each problem links to its machine.${quiet ? ` ${num(quiet)} more ${quiet === 1 ? 'is' : 'are'} acknowledged or snoozed.` : ''}`;
  }
  return everything.value.length ? `No open problems. ${num(quiet)} ${quiet === 1 ? 'is' : 'are'} acknowledged or snoozed and stays listed under its tab.` : 'Everything Fleet monitors is healthy right now.';
});
const emptyKind = computed<'none' | 'open' | 'quiet' | 'filter' | null>(() => {
  if (!everything.value.length) return 'none';
  if (!all.value.length) return stateTab.value === 'open' ? 'open' : 'quiet';
  return list.value.length ? null : 'filter';
});

const isOpen = (id: string, dflt: boolean): boolean => (openState.has(id) ? openState.get(id) === true : dflt);
const onToggle = (id: string, e: Event): void => { openState.set(id, (e.target as HTMLDetailsElement).open); };

const facts = (i: Issue): Array<{ k: string; v: string; sub: string; mono: boolean }> => [
  { k: 'Since', v: i.since ? `${fmtFull(i.since)} UTC` : '—', sub: i.since ? rel(i.since) : '', mono: false },
  ...(i.errorCode ? [{ k: 'Error code', v: i.errorCode, sub: '', mono: true }] : []),
  ...(i.nodeName ? [{ k: 'Machine', v: i.nodeName, sub: '', mono: false }] : []),
  ...(i.target ? [{ k: 'Target', v: i.target, sub: '', mono: true }] : []),
];
const specific = (p: Decorated): string => (p.cat?.explanation && p.i.detail && p.i.detail !== p.cat.explanation ? p.i.detail : '');
const retryable = (i: Issue): boolean => i.code === 'assignment_failed' && !!i.nodeId && !!i.target;

/**
 * Update Agent: a failed update, or an outdated Agent that can update itself. This page reads no machines, so it goes by what the Server
 * put in the issue: it lists `fleet nodes update` only for an Agent that announced it can update itself.
 */
const updatable = (i: Issue): boolean => !!i.nodeId
  && (i.code === 'agent_update_failed' || (i.code === 'agent_outdated' && (i.commands || []).some(c => c.startsWith('fleet nodes update '))));

async function updateAgent(i: Issue): Promise<void> {
  if (updating.value.has(i.id) || !i.nodeId) return;
  const visit = load.view.visit();
  updating.value = new Set(updating.value).add(i.id);
  try {
    /* The first request of a release can take minutes while the Server fetches it; it is sent even if the user leaves. */
    const u = await api.post<AgentUpdate>(`nodes/${enc(i.nodeId)}/agent-update`);
    toasts.push(`Update requested for ${i.nodeName}`, { text: `The Agent installs ${u?.targetVersion ?? 'the new version'} after its next check-in.` });
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (!isSilent(e)) toasts.push('Agent update was not requested', { tone: status === 403 || status === 409 ? 'warning' : 'critical', text: serverMessage(e), sticky: true });
  }
  const next = new Set(updating.value);
  next.delete(i.id);
  updating.value = next;
  if (visit.isCurrent()) await quietReload();
}

async function retry(i: Issue): Promise<void> {
  if (retrying.value.has(i.id) || !i.nodeId) return;
  const visit = load.view.visit();
  retrying.value = new Set(retrying.value).add(i.id);
  try {
    await api.post(`nodes/${enc(i.nodeId)}/retry`, { target: i.target });
    toasts.push(`Retry requested for ${i.nodeName}`, { text: 'The Agent applies it on its next poll.' });
  } catch (e) {
    toasts.fail(e, 'Retry was not requested');
  }
  const next = new Set(retrying.value);
  next.delete(i.id);
  retrying.value = next;
  if (visit.isCurrent()) await quietReload();
}
</script>

<template>
  <LoadingBlock v-if="loading" />
  <div v-else class="wrap">
    <ErrorState v-if="error" :error="error" what="Problems" @retry="reload()" />
    <template v-else-if="data">
      <PageHead title="Problems" :sub="sub">
        <template #actions>
          <ScopeButton level="operate" cls="btn-secondary" data-act="sync" :disabled="shared.syncing" @click="sync()"><Icon name="sync" :class="{ spin: shared.syncing }" />{{ shared.syncing ? 'Syncing…' : 'Sync repository' }}</ScopeButton>
          <button type="button" class="btn btn-secondary" data-act="reload" @click="reload()"><Icon name="retry" />Check again</button>
        </template>
      </PageHead>
      <div v-if="all.length" class="sumrow">
        <div v-for="[l, label, , k] in GROUPS" :key="l" class="sumtile">
          <span class="sumtile-ic" :class="`t-${l}`"><StatusGlyph :level="l" :kind="k" /></span>
          <span><b>{{ levelCount(l) }}</b><span>{{ label }}</span></span>
        </div>
      </div>
      <div v-if="everything.length" class="toolbar toolbar--plain toolbar--states">
        <ChipsFilter v-model="stateTab" :items="stateChips" label="Filter problems by state" />
        <ChipsFilter v-if="all.length" v-model="filter" :items="filterChips" label="Filter problems" />
      </div>
      <section v-for="g in groups" :key="g.level" class="pgroup" :aria-labelledby="`pg-${g.level}`">
        <header class="gsec-head"><h2 :id="`pg-${g.level}`">{{ g.title }} <span class="cnt">{{ g.rows.length }}</span></h2><p>{{ g.sub }}</p></header>
        <details
          v-for="{ p, defaultOpen } in g.rows"
          :key="p.id"
          class="prow"
          :class="[`prow--${p.level}`, { 'is-quiet': p.st.key !== 'open' }]"
          :data-open-key="p.id"
          :open="isOpen(p.id, defaultOpen)"
          @toggle="onToggle(p.id, $event)"
        >
          <summary>
            <span class="prob-ic" :class="`t-${p.level}`"><StatusGlyph :level="p.level" :kind="p.kind" /></span>
            <span class="prow-main"><b>{{ p.i.title }}</b><span class="prow-where">{{ whereText(p) }}</span></span>
            <span class="prow-meta">{{ p.i.since ? `Since ${rel(p.i.since)}` : '' }}</span>
            <span v-if="p.st.key !== 'open'" class="tag tag--state">{{ STATE_LABEL[p.st.key] }}</span>
            <StatusPill :level="p.level" :kind="p.kind" :label="p.badge" />
            <Icon name="chevD" class="sumchev" />
          </summary>
          <article class="prob" :class="`prob--${p.level}`">
            <div class="prob-body">
              <IssueBanner :issue="p.i" />
              <p v-if="p.cat?.explanation || p.i.detail" class="prob-expl"><MdText :text="p.cat?.explanation || p.i.detail" /><template v-if="specific(p)">{{ ' ' }}<strong><MdText :text="specific(p)" /></strong></template></p>
              <p v-else class="prob-expl muted">The Server has no catalog entry for this problem yet.</p>
              <dl class="facts-row">
                <div v-for="f in facts(p.i)" :key="f.k"><dt>{{ f.k }}</dt><dd :class="{ mono: f.mono }">{{ f.v }}</dd><dd v-if="f.sub" class="sub">{{ f.sub }}</dd></div>
              </dl>
              <FailureDetail v-if="p.i.code === 'assignment_failed'" :src="p.i" />
              <div class="prob-cols">
                <section class="fix" aria-label="How to fix">
                  <h4>How to fix</h4>
                  <StepsList v-if="fixSteps(p.i, p.cat).length" :steps="fixSteps(p.i, p.cat)" />
                  <p v-else class="muted">No fix steps are published for this problem.</p>
                </section>
                <section class="why">
                  <h4>Run in a terminal</h4>
                  <template v-if="(p.i.commands || []).length"><CopyBox v-for="(c, k) in p.i.commands" :key="k" :cmd="c" /></template>
                  <p v-else class="muted small">There is no CLI command for this problem.</p>
                </section>
              </div>
              <footer class="prob-actions">
                <ScopeButton
                  v-if="updatable(p.i)" level="admin" cls="btn-sm btn-primary" data-act="issue-agent-update" :data-id="p.i.id" :disabled="updating.has(p.i.id)"
                  :aria-busy="updating.has(p.i.id) ? 'true' : undefined" @click="updateAgent(p.i)"
                ><Icon name="sync" :class="{ spin: updating.has(p.i.id) }" />{{ updating.has(p.i.id) ? 'Requesting…' : 'Update Agent' }}</ScopeButton>
                <ScopeButton v-if="retryable(p.i)" level="operate" cls="btn-sm btn-primary" data-act="issue-retry" :data-id="p.i.id" :disabled="retrying.has(p.i.id)" @click="retry(p.i)"><Icon name="retry" :class="{ spin: retrying.has(p.i.id) }" />{{ retrying.has(p.i.id) ? 'Requesting…' : 'Retry now' }}</ScopeButton>
                <IssueActions :issue="p.i" :busy="busy.has(p.i.id)" @state="change" />
                <RouterLink v-if="p.i.nodeName" class="btn btn-sm btn-ghost" :to="nodeRoute(p.i.nodeName, 'problems')">Open {{ p.i.nodeName }}<Icon name="chevR" /></RouterLink>
                <RouterLink v-else-if="p.section === 'models'" class="btn btn-sm btn-ghost" :to="{ name: 'models' }">Open models<Icon name="chevR" /></RouterLink>
                <RouterLink v-else-if="p.section === 'repository'" class="btn btn-sm btn-ghost" :to="{ name: 'repository' }">Open repository<Icon name="chevR" /></RouterLink>
                <span v-if="retryable(p.i) && !session.can('operate')" class="muted small">{{ session.denied('operate') }}</span>
              </footer>
            </div>
          </article>
        </details>
      </section>
      <EmptyState v-if="emptyKind === 'none'" good title="No problems" text="No failing Targets, offline machines, repository warnings or model sync failures right now." />
      <EmptyState v-else-if="emptyKind === 'open'" good title="No open problems" text="Everything that needs attention is acknowledged or snoozed. Open the other tabs to review it." />
      <EmptyState v-else-if="emptyKind === 'quiet'" good :title="`Nothing ${stateTab}`" :text="stateTab === 'snoozed' ? 'Snooze a problem to hide it from Open for a while. It returns by itself when the time is up.' : 'Acknowledge a problem you know about. It stays listed here and returns to Open if it starts over.'" />
      <EmptyState v-else-if="emptyKind === 'filter'" good title="Nothing here" text="No problems match this filter." />
      <LockNote level="operate" />
    </template>
  </div>
</template>
