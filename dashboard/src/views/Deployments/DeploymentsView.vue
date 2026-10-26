<script setup lang="ts">
import { computed, nextTick, reactive, ref, shallowRef, watch } from 'vue';
import { useRoute } from 'vue-router';
import type {
  DesiredRevisionDetail, DesiredRevisionItem, NodeListItem, RevisionWarning, RolloutAttempt, RolloutItem, StateCounts,
} from '@/api/types';
import Avatar from '@/components/Avatar.vue';
import ChangeChips from '@/components/ChangeChips.vue';
import ChipsFilter from '@/components/ChipsFilter.vue';
import CopyButton from '@/components/CopyButton.vue';
import DeviceArt from '@/components/DeviceArt.vue';
import DiagLine from '@/components/DiagLine.vue';
import EmptyState from '@/components/EmptyState.vue';
import ErrorState from '@/components/ErrorState.vue';
import Icon from '@/components/Icon.vue';
import InlineError from '@/components/InlineError.vue';
import Legend from '@/components/Legend.vue';
import LoadingBlock from '@/components/LoadingBlock.vue';
import PageHead from '@/components/PageHead.vue';
import RevChip from '@/components/RevChip.vue';
import ScopeButton from '@/components/ScopeButton.vue';
import Segbar from '@/components/Segbar.vue';
import StatusGlyph from '@/components/StatusGlyph.vue';
import StepChip from '@/components/StepChip.vue';
import { useLoad } from '@/composables/useLoad';
import { useView } from '@/composables/useView';
import { useFleet } from '@/context';
import { enc, fmtFull, num, plural, platformLabel, rel, shortId, shortSha } from '@/lib/format';
import { soft } from '@/lib/errors';
import { commit, fromList, health, revisionDetail, revTitle, seenText, total, type NodeView, type RevisionDetailView } from '@/lib/model';
import { emptyCounts, stateParts } from '@/lib/targets';
import { nodeRoute } from '@/router';
import { useRepositorySync } from '../Repository/useRepositorySync';

/**
 * Deployments. API: GET desired-revisions?order=newest, GET rollouts?order=newest, GET desired-revisions/{id} (the newest revision, for
 * what changed), GET warnings, GET nodes, GET errors, GET rollouts/{id}/attempts (on demand). The Server returns revisions and rollouts
 * newest first, one page at a time; a rollout belongs to the revision named by its desiredRevisionId. "Load older revisions" follows
 * both cursors. Each revision links to its own page (views/Revision) with the diff and the per-machine progress.
 */
const { api, catalog, summary, shell, toasts, openState } = useFleet();
const route = useRoute();
const PAGE = 10;

const revs = ref<DesiredRevisionItem[]>([]);
const revsNext = ref<string | null>(null);
const rollouts = shallowRef(new Map<string, RolloutItem>());
const rolloutsNext = ref<string | null>(null);
const loadingMore = ref(false);
const warnings = ref<RevisionWarning[]>([]);
const nodes = ref<NodeView[]>([]);
const truncated = ref(false);
const curDetail = ref<RevisionDetailView | null>(null);
const filter = ref('all');
interface AttemptsState { items: RolloutAttempt[]; truncated?: boolean; error?: Error }
const attempts = reactive<Record<string, AttemptsState>>({});
const loadingAttempts = reactive(new Set<string>());
const focus = ref<string | null>(null);
const queryFocus = (): string | null => {
  const q = route.query.revision;
  const v = Array.isArray(q) ? q[0] : q;
  return typeof v === 'string' && v ? v : null;
};

const view = useView();
const more = view.lane();
const load = useLoad(async token => {
  more.cancel();
  const [r, ro, w, n] = await Promise.all([
    api.page<DesiredRevisionItem>('desired-revisions', { order: 'newest', limit: PAGE }, { signal: token.signal }),
    api.page<RolloutItem>('rollouts', { order: 'newest', limit: PAGE }, { signal: token.signal }),
    api.all<RevisionWarning>('warnings', { maxPages: 3, signal: token.signal }).catch(soft),
    api.all<NodeListItem>('nodes', { maxPages: 5, signal: token.signal }),
    catalog.load(),
  ]);
  token.check();
  /* What the newest revision changed: a failure (a Server before phase 4) only hides that block. */
  const newest = r.items[0];
  const detail = newest ? await api.get<DesiredRevisionDetail>(`desired-revisions/${enc(newest.desiredRevisionId)}`, undefined, { signal: token.signal }).catch(soft) : null;
  token.check();
  curDetail.value = detail ? revisionDetail(detail) : null;
  revs.value = r.items;
  revsNext.value = r.nextCursor;
  rollouts.value = new Map(ro.items.map(x => [x.desiredRevisionId, x]));
  rolloutsNext.value = ro.nextCursor;
  warnings.value = w ? w.items : [];
  nodes.value = n.items.map(fromList);
  truncated.value = n.truncated;
  focus.value = queryFocus();
  loadingMore.value = false;
  for (const k of Object.keys(attempts)) delete attempts[k];
  loadingAttempts.clear();
  void summary.refresh();
  shell.markLoaded();
  return true;
}, { view });
const { data, error, loading, reload } = load;
const { sync } = useRepositorySync();

watch(() => data.value, async d => { if (d) await scrollToFocus(); });
watch(() => route.query.revision, async () => {
  if (!data.value) return;
  focus.value = queryFocus();
  await scrollToFocus();
});
async function scrollToFocus(): Promise<void> {
  if (!focus.value) return;
  await nextTick();
  document.getElementById('rev-' + focus.value)?.scrollIntoView?.({ block: 'center' });
}

/* ------------------------------------------------------------------ derived */
const countsOf = (r: RolloutItem | undefined | null): StateCounts => ({ ...emptyCounts(), pending: r?.pending || 0, applying: r?.applying || 0, succeeded: r?.succeeded || 0, failed: r?.failed || 0, superseded: r?.superseded || 0 });
const deployState = (n: NodeView): 'blocked' | 'progress' | 'waiting' | 'done' =>
  n.counts.failed ? 'blocked' : n.counts.applying ? 'progress' : (n.counts.pending || (n.freshness !== 'fresh' && total(n) > n.counts.succeeded + n.counts.superseded)) ? 'waiting' : 'done';
const statusText = (n: NodeView): string => {
  const c = n.counts;
  if (c.failed) return `${plural(c.failed, 'Target')} failing. ${c.succeeded ? `${c.succeeded} applied.` : ''}`;
  if (c.applying) return `Applying ${plural(c.applying, 'Target')} now.`;
  if (c.pending) return n.freshness === 'fresh' ? `${plural(c.pending, 'Target')} queued for the next poll.` : n.freshness === 'never_contacted' ? 'Waiting for the first check-in. Nothing has been delivered yet.' : `Waiting for ${n.alias} to come back online.`;
  if (!total(n)) return 'No Targets assigned.';
  return `All ${plural(c.succeeded, 'Target')} in sync.`;
};
const warningsFor = (rev: DesiredRevisionItem): RevisionWarning[] => warnings.value.filter(w => w.desiredRevisionId === rev.desiredRevisionId);
const partsText = (parts: ReturnType<typeof stateParts>): string => parts.filter(x => x.value).map(x => `${x.value} ${x.label.toLowerCase()}`).join(' · ');

const ORDER = { blocked: 0, progress: 1, waiting: 2, done: 3 } as const;
const rows = computed(() => nodes.value.filter(n => !n.revoked).map(n => ({ n, st: deployState(n) }))
  .sort((a, b) => ORDER[a.st] - ORDER[b.st] || a.n.alias.localeCompare(b.n.alias)));
const countOf = (k: string): number => rows.value.filter(r => r.st === k).length;
const shown = computed(() => (filter.value === 'all' ? rows.value : rows.value.filter(r => r.st === filter.value)));
const depChips = computed(() => [['all', 'All', rows.value.length], ['blocked', 'Blocked', countOf('blocked')], ['progress', 'In progress', countOf('progress')], ['waiting', 'Waiting', countOf('waiting')], ['done', 'Done', countOf('done')]] as Array<[string, string, number]>);

const cur = computed(() => revs.value[0]);
const curRollout = computed(() => (cur.value ? rollouts.value.get(cur.value.desiredRevisionId) : undefined));
const counts = computed(() => countsOf(curRollout.value));
const parts = computed(() => stateParts(counts.value));
const work = computed(() => counts.value.pending + counts.value.applying + counts.value.succeeded + counts.value.failed);
const active = computed(() => counts.value.pending + counts.value.applying > 0);
const curCommit = computed(() => commit(cur.value?.commit));
const curWarns = computed(() => (cur.value ? warningsFor(cur.value) : []));

const isOpen = (key: string, dflt: boolean): boolean => (openState.has(key) ? openState.get(key) === true : dflt);
const onToggle = (key: string, e: Event): void => { openState.set(key, (e.target as HTMLDetailsElement).open); };

/* ------------------------------------------------------------------ actions */
async function moreRevisions(): Promise<void> {
  if (loadingMore.value || !revsNext.value) return;
  const token = more.begin();
  const revsAfter = revsNext.value;
  const rolloutsAfter = rolloutsNext.value;
  loadingMore.value = true;
  try {
    const [r, ro] = await Promise.all([
      api.page<DesiredRevisionItem>('desired-revisions', { order: 'newest', limit: PAGE, after: revsAfter }, { signal: token.signal }),
      rolloutsAfter ? api.page<RolloutItem>('rollouts', { order: 'newest', limit: PAGE, after: rolloutsAfter }, { signal: token.signal }) : Promise.resolve({ items: [] as RolloutItem[], nextCursor: null }),
    ]);
    token.check();
    revs.value = revs.value.concat(r.items);
    revsNext.value = r.nextCursor;
    const next = new Map(rollouts.value);
    for (const x of ro.items) next.set(x.desiredRevisionId, x);
    rollouts.value = next;
    rolloutsNext.value = ro.nextCursor;
  } catch (e) {
    if (!token.isCurrent()) return;
    toasts.fail(e, 'Could not load older revisions');
  }
  if (token.isCurrent()) loadingMore.value = false;
}

async function loadAttempts(id: string): Promise<void> {
  const visit = load.lane.current();
  if (!visit || loadingAttempts.has(id)) return;
  loadingAttempts.add(id);
  try {
    attempts[id] = await api.all<RolloutAttempt>(`rollouts/${enc(id)}/attempts`, { maxPages: 5, signal: visit.signal });
  } catch (e) {
    if (visit.isCurrent() && !(e as { silent?: boolean }).silent) attempts[id] = { error: e as Error, items: [] };
  }
  if (visit.isCurrent()) loadingAttempts.delete(id);
}

/* ------------------------------------------------------------------ attempts of a rollout */
const FAILED_SHOWN = 20;
const attemptCounts = (a: AttemptsState): StateCounts => {
  const c = emptyCounts();
  for (const x of a.items) if (x.state in c) c[x.state]++;
  return c;
};
const failedCodes = (a: AttemptsState): Array<[string, number]> => {
  const m = new Map<string, number>();
  a.items.filter(x => x.state === 'failed' || x.errorCode).forEach(x => { const k = x.errorCode || 'unknown'; m.set(k, (m.get(k) || 0) + 1); });
  return [...m].sort((x, y) => y[1] - x[1]);
};
const failedAttempts = (a: AttemptsState): RolloutAttempt[] => a.items.filter(x => x.state === 'failed');
</script>

<template>
  <LoadingBlock v-if="loading" />
  <div v-else class="wrap">
    <ErrorState v-if="error" :error="error" what="Deployments" @retry="reload()" />
    <template v-else-if="data">
      <template v-if="!revs.length">
        <PageHead title="Deployments" sub="What Fleet is delivering to your machines, and what it delivered before." />
        <EmptyState icon="rocket" title="Nothing has been published yet" text="When the repository is scanned and accepted, each publication appears here with its rollout.">
          <ScopeButton level="operate" cls="btn-primary" data-act="sync" @click="sync()"><Icon name="sync" />Sync repository</ScopeButton>
        </EmptyState>
      </template>
      <template v-else-if="cur">
        <PageHead title="Deployments" sub="What Fleet is delivering to your machines right now, and what it delivered before.">
          <template #actions><button type="button" class="btn btn-secondary" data-act="reload" @click="reload()"><Icon name="sync" />Refresh</button></template>
        </PageHead>
        <section class="dep-hero">
          <div class="dep-hero-main">
            <p class="eyebrow" :class="{ live: active }">
              <template v-if="active"><span class="live-dot" aria-hidden="true"></span>Rolling out now</template>
              <template v-else>{{ counts.failed ? 'Newest revision, with failures' : 'Newest revision' }}</template>
            </p>
            <h2 class="dep-title">{{ revTitle(cur) }}</h2>
            <p class="dep-meta">
              <RevChip :sha="cur.sourceRevision" :tip="cur.sourceRevision" />
              <template v-if="curCommit?.author"><Avatar :name="curCommit.author" class="av-xs" /><span><b>{{ curCommit.author }}</b> · published {{ rel(cur.acceptedAt) }} · {{ fmtFull(cur.acceptedAt) }} UTC</span></template>
              <span v-else>Published <b>{{ rel(cur.acceptedAt) }}</b> · {{ fmtFull(cur.acceptedAt) }} UTC</span>
            </p>
            <template v-if="curDetail"><h3 class="mini-h">What changed</h3><ChangeChips :detail="curDetail" /></template>
            <p class="dep-more"><RouterLink class="btn btn-sm btn-secondary" :to="{ name: 'revision', params: { revisionId: cur.desiredRevisionId } }"><Icon name="list" />Open this revision<Icon name="chevR" /></RouterLink></p>
            <div v-for="(w, k) in curWarns" :key="k" class="callout callout--warning">
              <StatusGlyph level="warning" kind="bang" />
              <div><b>Source warning: {{ w.code }}</b><p>{{ w.message }}</p>
                <div v-if="(w.sourceLocations || []).length" class="loc-chips"><span v-for="(l, j) in w.sourceLocations" :key="j" class="loc"><Icon name="folder" /><code>{{ l }}</code></span></div>
              </div>
            </div>
          </div>
          <div class="dep-hero-side">
            <p class="stat-l">Assignments succeeded</p>
            <p class="hero-fig">{{ num(counts.succeeded) }}<span> of {{ num(work) }}</span></p>
            <Segbar :parts="parts" :label="`Rollout ${shortSha(cur.sourceRevision)} assignments`" size="lg" />
            <Legend :parts="parts" />
            <p class="muted small"><template v-if="curRollout">{{ countOf('done') }} of {{ rows.length }} machines have every Target in sync. </template>A rollout is not a transaction: each machine reconciles on its own.</p>
          </div>
        </section>
        <section class="panel">
          <header class="panel-head row">
            <div><h2>Machines</h2><p>Where each machine stands, from its Target state counts.</p></div>
            <ChipsFilter v-model="filter" :items="depChips" label="Filter machines" />
          </header>
          <div class="dep-legend" aria-hidden="true"><span>Machine</span><span>Current revision</span><span>Targets</span><span>Status</span></div>
          <ul class="dep-list">
            <li v-for="{ n, st } in shown" :key="n.id" class="dep-row" :class="`dep-row--${st}`">
              <RouterLink class="dep-node" :to="nodeRoute(n.alias)">
                <DeviceArt :node="n" :health="health(n)" class="dev-sm" />
                <span><b>{{ n.alias }}</b><span class="muted small">{{ platformLabel(n.platform) }} · {{ seenText(n).toLowerCase() }}</span></span>
              </RouterLink>
              <div class="dep-rev"><RevChip :sha="n.currentRevision" :tip="n.currentRevision ?? undefined" /></div>
              <div class="dep-targets">
                <template v-if="total(n)"><Segbar :parts="stateParts(n.counts, 'Targets')" :label="`${n.alias} Targets`" size="sm" /><span class="hist-sum">{{ partsText(stateParts(n.counts)) }}</span></template>
                <span v-else class="muted small">None</span>
              </div>
              <p class="dep-status">{{ statusText(n) }}</p>
            </li>
            <li v-if="!shown.length" class="empty-mini"><Icon name="grid" /><p>No machines in this state.</p></li>
          </ul>
          <p v-if="truncated" class="muted small">Only the first machines are listed.</p>
        </section>
        <section class="panel">
          <header class="panel-head"><h2>Revision history</h2><p>Each publication creates an immutable desired revision. Its rollout tracks delivery until a newer revision supersedes it.</p></header>
          <ol class="hist">
            <li v-for="(rev, i) in revs" :id="`rev-${shortSha(rev.sourceRevision)}`" :key="rev.desiredRevisionId" class="hist-item">
              <span class="hist-dot">
                <StatusGlyph v-if="i === 0 && counts.pending + counts.applying > 0" level="info" kind="sync" />
                <StatusGlyph v-else-if="i === 0 && counts.failed" level="critical" kind="x" />
                <StatusGlyph v-else level="good" kind="check" />
              </span>
              <details :data-open-key="`rev:${shortSha(rev.sourceRevision)}`" :open="isOpen(`rev:${shortSha(rev.sourceRevision)}`, focus === shortSha(rev.sourceRevision))" @toggle="onToggle(`rev:${shortSha(rev.sourceRevision)}`, $event)">
                <summary>
                  <span class="hist-main">
                    <span class="hist-top"><RevChip :sha="rev.sourceRevision" :tip="rev.sourceRevision" /><span v-if="i === 0" class="tag tag--live">Newest</span><b>{{ commit(rev.commit)?.subject ? commit(rev.commit)?.subject : `Published ${fmtFull(rev.acceptedAt)} UTC` }}</b></span>
                    <span class="hist-meta">
                      <template v-if="commit(rev.commit)?.author"><Avatar :name="commit(rev.commit)?.author" class="av-xs" />{{ commit(rev.commit)?.author }} · </template>
                      <template v-if="commit(rev.commit)?.subject">{{ fmtFull(rev.acceptedAt) }} UTC · </template>{{ rel(rev.acceptedAt) }}
                      <template v-if="warningsFor(rev).length"> · <StatusGlyph level="warning" kind="bang" />{{ plural(warningsFor(rev).length, 'warning') }}</template>
                      <template v-if="!rollouts.get(rev.desiredRevisionId) && !rolloutsNext"> · no rollout recorded</template>
                    </span>
                  </span>
                  <span class="hist-bar">
                    <template v-if="rollouts.get(rev.desiredRevisionId)">
                      <Segbar :parts="stateParts(countsOf(rollouts.get(rev.desiredRevisionId)))" :label="`Rollout ${shortSha(rev.sourceRevision)}`" size="sm" />
                      <span class="hist-sum">{{ partsText(stateParts(countsOf(rollouts.get(rev.desiredRevisionId)))) || 'No assignments' }}</span>
                    </template>
                    <span v-else class="hist-sum"></span>
                  </span>
                  <Icon name="chevD" class="sumchev" />
                </summary>
                <div class="hist-body">
                  <div v-for="(w, k) in warningsFor(rev)" :key="k" class="callout callout--warning">
                    <StatusGlyph level="warning" kind="bang" />
                    <div><b>{{ w.code }}</b><p>{{ w.message }}</p>
                      <div v-if="(w.sourceLocations || []).length" class="loc-chips"><span v-for="(l, j) in w.sourceLocations" :key="j" class="loc"><Icon name="folder" /><code>{{ l }}</code></span></div>
                    </div>
                  </div>
                  <dl class="kv kv--grid kv--3">
                    <div><dt>Source revision</dt><dd class="mono">{{ rev.sourceRevision }}<CopyButton :text="rev.sourceRevision" aria-label="Copy source revision" /></dd></div>
                    <div><dt>Desired revision</dt><dd class="mono">{{ rev.desiredRevisionId }}</dd></div>
                    <div><dt>Rollout</dt><dd class="mono">{{ rollouts.get(rev.desiredRevisionId)?.rolloutId || '—' }}</dd></div>
                  </dl>
                  <p class="hist-open"><RouterLink class="btn btn-sm btn-secondary" :to="{ name: 'revision', params: { revisionId: rev.desiredRevisionId } }"><Icon name="list" />What changed and where it stands<Icon name="chevR" /></RouterLink></p>
                  <template v-if="rollouts.get(rev.desiredRevisionId)">
                    <Legend :parts="stateParts(countsOf(rollouts.get(rev.desiredRevisionId)))" />
                    <div v-for="r in [rollouts.get(rev.desiredRevisionId)!]" :id="`att-${r.rolloutId}`" :key="r.rolloutId" class="attempts">
                      <div v-if="loadingAttempts.has(r.rolloutId)" class="skel skel-block"></div>
                      <button v-else-if="!attempts[r.rolloutId]" type="button" class="btn btn-sm btn-secondary" data-act="load-attempts" :data-id="r.rolloutId" @click="loadAttempts(r.rolloutId)"><Icon name="list" />Show attempts</button>
                      <InlineError v-else-if="attempts[r.rolloutId]!.error" :error="attempts[r.rolloutId]!.error" what="attempts" />
                      <template v-else>
                        <p class="kv-label">Attempts in this rollout <span class="cnt">{{ num(attempts[r.rolloutId]!.items.length) }}</span></p>
                        <Legend :parts="stateParts(attemptCounts(attempts[r.rolloutId]!), 'attempts')" />
                        <div v-if="failedCodes(attempts[r.rolloutId]!).length" class="tbl-wrap">
                          <table class="tbl tbl--compact">
                            <thead><tr><th>Error code</th><th>What it means</th><th class="num">Attempts</th></tr></thead>
                            <tbody><tr v-for="[code, c] in failedCodes(attempts[r.rolloutId]!)" :key="code"><td><code>{{ code }}</code></td><td>{{ catalog.get(code)?.title || 'No catalog entry' }}</td><td class="num">{{ c }}</td></tr></tbody>
                          </table>
                        </div>
                        <p v-else class="muted small">No failed attempts.</p>
                        <template v-if="failedAttempts(attempts[r.rolloutId]!).length">
                          <p class="kv-label">Failed attempts <span class="cnt">{{ num(failedAttempts(attempts[r.rolloutId]!).length) }}</span></p>
                          <ul class="attlist">
                            <li v-for="a in failedAttempts(attempts[r.rolloutId]!).slice(0, FAILED_SHOWN)" :key="a.attemptId" class="attitem">
                              <div class="attitem-top"><span class="mono">{{ shortId(a.attemptId) }}</span><code v-if="a.errorCode">{{ a.errorCode }}</code><StepChip :step="a.step" /><time class="muted small" :datetime="a.updatedAt">{{ fmtFull(a.updatedAt) }} UTC</time></div>
                              <p v-if="a.path" class="attitem-path small"><span class="muted">Path</span> <code>{{ a.path }}</code></p>
                              <DiagLine :text="a.diagnostic" :open-key="a.attemptId" />
                            </li>
                          </ul>
                          <p v-if="failedAttempts(attempts[r.rolloutId]!).length > FAILED_SHOWN" class="muted small">Showing {{ FAILED_SHOWN }} of {{ num(failedAttempts(attempts[r.rolloutId]!).length) }} failed attempts.</p>
                        </template>
                        <p v-if="attempts[r.rolloutId]!.truncated" class="muted small">Showing the first attempts only.</p>
                      </template>
                    </div>
                  </template>
                </div>
              </details>
            </li>
          </ol>
          <div v-if="revsNext" class="load-more"><button type="button" class="btn btn-secondary" data-act="more-revisions" :disabled="loadingMore" @click="moreRevisions()">Load older revisions</button></div>
        </section>
      </template>
    </template>
  </div>
</template>
