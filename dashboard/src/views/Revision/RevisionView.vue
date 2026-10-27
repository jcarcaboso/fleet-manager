<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { DesiredRevisionDetail, RolloutDetail } from '@/api/types';
import Avatar from '@/components/Avatar.vue';
import ChangeChips from '@/components/ChangeChips.vue';
import ChipsFilter from '@/components/ChipsFilter.vue';
import EmptyState from '@/components/EmptyState.vue';
import ErrorState from '@/components/ErrorState.vue';
import Icon from '@/components/Icon.vue';
import InlineError from '@/components/InlineError.vue';
import Legend from '@/components/Legend.vue';
import LoadingBlock from '@/components/LoadingBlock.vue';
import RevChip from '@/components/RevChip.vue';
import Segbar from '@/components/Segbar.vue';
import StatusGlyph from '@/components/StatusGlyph.vue';
import { useDocumentTitle } from '@/composables/useDocumentTitle';
import { useLoad } from '@/composables/useLoad';
import { useFleet } from '@/context';
import { enc, fmtFull, ms, num, plural, rel, shortSha } from '@/lib/format';
import { nodeRank, revisionDetail, rolloutDetail, type RevisionDetailView, type RolloutDetailView } from '@/lib/model';
import { STATES, countTotal, stateParts, targetLabel, targetShort, tstate } from '@/lib/targets';
import { superseded } from '@/lib/errors';

/**
 * One revision (/deployments/:revisionId). API: GET desired-revisions/{id} (commit, previous revision, what changed), GET rollouts/{id}
 * (per-machine progress), GET errors. The revision is read first, then its rollout; both reads carry the load's signal, so a revision
 * the user has left (or a newer load of the same one) never paints. A rollout that cannot be read shows an error beside the diff; a
 * revision without a rollout says so.
 */
const { api, catalog, shell, summary } = useFleet();
const route = useRoute();
const id = computed(() => String(route.params.revisionId));

type Loaded = { kind: 'revision'; rev: RevisionDetailView; roll: RolloutDetailView | null; rollErr: Error | null } | { kind: 'notFound'; error: Error };

const { data, error, loading, reload } = useLoad<Loaded>(async token => {
  let raw: DesiredRevisionDetail;
  try {
    [raw] = await Promise.all([api.get<DesiredRevisionDetail>(`desired-revisions/${enc(id.value)}`, undefined, { signal: token.signal }), catalog.load()]);
  } catch (e) {
    token.check();
    if ((e as { code?: string } | null)?.code === 'revision_not_found') return { kind: 'notFound', error: e as Error };
    throw e;
  }
  token.check();
  const rev = revisionDetail(raw);
  let roll: RolloutDetailView | null = null;
  let rollErr: Error | null = null;
  if (rev.rolloutId) {
    try {
      roll = rolloutDetail(await api.get<RolloutDetail>(`rollouts/${enc(rev.rolloutId)}`, undefined, { signal: token.signal }));
    } catch (e) {
      if (!token.isCurrent() || (e as { silent?: boolean } | null)?.silent) throw superseded();
      rollErr = e as Error;
    }
  }
  token.check();
  void summary.refresh();
  shell.markLoaded();
  return { kind: 'revision', rev, roll, rollErr };
});

const rev = computed(() => (data.value?.kind === 'revision' ? data.value.rev : null));
const roll = computed(() => (data.value?.kind === 'revision' ? data.value.roll : null));
const rollErr = computed(() => (data.value?.kind === 'revision' ? data.value.rollErr : null));
useDocumentTitle(() => (rev.value ? shortSha(rev.value.sourceRevision) : null));

/* The page's <h1> is the revision title; it takes keyboard focus after a navigation, like every page heading. */
const h1 = ref<HTMLElement | null>(null);
watch(h1, el => {
  if (el && shell.focusPending) {
    shell.focusPending = false;
    el.focus({ preventScroll: true });
  }
}, { flush: 'post' });

type Sort = 'state' | 'name' | 'recent';
const filter = ref('all');
const sort = ref<Sort>('state');
const SORTS: Record<Sort, (a: RolloutDetailView['nodes'][number], b: RolloutDetailView['nodes'][number]) => number> = {
  state: (a, b) => nodeRank(a.state) - nodeRank(b.state) || a.name.localeCompare(b.name),
  name: (a, b) => a.name.localeCompare(b.name),
  recent: (a, b) => (ms(b.last) || 0) - (ms(a.last) || 0) || a.name.localeCompare(b.name),
};
const SORT_OPTIONS: ReadonlyArray<readonly [Sort, string]> = [['state', 'Needs attention first'], ['name', 'Name'], ['recent', 'Latest attempt']];

const STATE_OF = new Map<string, { key: string; label: string; level: ReturnType<typeof tstate>['level']; kind: ReturnType<typeof tstate>['kind'] }>(STATES.map(s => [s.key, s]));
const stateOf = (key: string) => STATE_OF.get(key) ?? { key, ...tstate(key) };

const nodes = computed(() => roll.value?.nodes ?? []);
const shown = computed(() => (filter.value === 'all' ? nodes.value : nodes.value.filter(n => n.state === filter.value)).slice().sort(SORTS[sort.value]));
const chips = computed(() => [
  ['all', 'All', nodes.value.length],
  ...STATES.map(s => [s.key, s.label, nodes.value.filter(n => n.state === s.key).length] as [string, string, number]).filter(c => c[2] > 0 || filter.value === c[0]),
] as Array<[string, string, number]>);

const sum = computed(() => roll.value?.summary ?? null);
const parts = computed(() => (sum.value ? stateParts(sum.value) : []));
const work = computed(() => (sum.value ? countTotal(sum.value) : 0));
const active = computed(() => !!sum.value && sum.value.pending + sum.value.applying > 0);
const done = computed(() => nodes.value.filter(n => n.state === 'succeeded' || n.state === 'superseded').length);

const tip = (t: RolloutDetailView['nodes'][number]['targets'][number], label: string): string =>
  `${targetLabel({ name: t.name })}|${label}${t.errorCode ? `\n${catalog.title(t.errorCode)}` : ''}${t.updatedAt ? `\nUpdated ${rel(t.updatedAt)}` : ''}`;
</script>

<template>
  <LoadingBlock v-if="loading" />
  <div v-else class="wrap">
    <ErrorState v-if="error" :error="error" what="Revision" @retry="reload()" />
    <EmptyState v-else-if="data?.kind === 'notFound'" icon="rocket" h="h1" title="We could not find that revision" :text="data.error.message || 'It may have been removed, or the address is wrong.'">
      <RouterLink class="btn btn-secondary" :to="{ name: 'deployments' }">Back to deployments</RouterLink>
    </EmptyState>
    <template v-else-if="rev">
      <nav class="crumbs" aria-label="Breadcrumb"><RouterLink :to="{ name: 'deployments' }"><Icon name="chevL" />All deployments</RouterLink><span aria-hidden="true">/</span><span aria-current="page">{{ shortSha(rev.sourceRevision) }}</span></nav>
      <section class="dep-hero">
        <div class="dep-hero-main">
          <p class="eyebrow" :class="{ live: active }">
            <template v-if="!sum">Revision</template>
            <template v-else-if="active"><span class="live-dot" aria-hidden="true"></span>Rolling out now</template>
            <template v-else>{{ sum.failed ? 'Rollout with failures' : 'Rollout finished' }}</template>
          </p>
          <h1 ref="h1" class="dep-title" tabindex="-1">{{ rev.commit?.subject || `Revision ${shortSha(rev.sourceRevision)}` }}</h1>
          <p class="dep-meta">
            <RevChip :sha="rev.sourceRevision" :tip="rev.sourceRevision" />
            <template v-if="rev.commit?.author"><Avatar :name="rev.commit.author" class="av-xs" /><b>{{ rev.commit.author }}</b></template>
            <span>{{ rev.commit?.subject ? 'committed' : 'Published' }} {{ rel(rev.commit?.committedAt || rev.acceptedAt) }} · published {{ fmtFull(rev.acceptedAt) }} UTC</span>
          </p>
          <h2 class="mini-h">What changed</h2>
          <ChangeChips :detail="rev" />
          <p class="dep-prev small"><Icon name="commit" /><span v-if="rev.previous">Compared with the previous revision <RouterLink :to="{ name: 'revision', params: { revisionId: rev.previous.id } }">{{ shortSha(rev.previous.sourceRevision) }}</RouterLink>.</span><span v-else>This is the first revision, so there is nothing to compare it with.</span></p>
          <dl class="kv kv--grid kv--3">
            <div><dt>Source revision</dt><dd class="mono">{{ rev.sourceRevision }}</dd></div>
            <div><dt>Desired revision</dt><dd class="mono">{{ rev.id }}</dd></div>
            <div><dt>Rollout</dt><dd class="mono">{{ rev.rolloutId || '—' }}</dd></div>
          </dl>
        </div>
        <div class="dep-hero-side">
          <template v-if="sum && roll">
            <p class="stat-l">Assignments succeeded</p>
            <p class="hero-fig">{{ num(sum.succeeded) }}<span> of {{ num(work) }}</span></p>
            <Segbar :parts="parts" :label="`Rollout ${shortSha(rev.sourceRevision)} assignments`" size="lg" />
            <Legend :parts="parts" />
            <p class="muted small"><template v-if="roll.nodes.length">{{ done }} of {{ plural(roll.nodes.length, 'machine') }} {{ done === 1 ? 'has' : 'have' }} nothing left to apply. </template>A rollout is not a transaction: each machine reconciles on its own.</p>
          </template>
          <template v-else-if="rollErr"><p class="stat-l">Rollout</p><p class="muted">The rollout could not be read. See the error below.</p></template>
          <template v-else><p class="stat-l">Rollout</p><p class="muted">{{ rev.rolloutId ? 'Loading…' : 'No rollout was created for this revision.' }}</p></template>
        </div>
      </section>
      <section v-if="!rev.rolloutId" class="panel">
        <header class="panel-head"><h2>Machines</h2></header>
        <div class="empty-mini"><Icon name="rocket" /><p>No rollout was created for this revision, so there is no per-machine progress to show.</p></div>
      </section>
      <section v-else-if="rollErr" class="panel">
        <header class="panel-head"><h2>Machines</h2></header>
        <InlineError :error="rollErr" what="the rollout" />
        <div class="empty-retry"><button type="button" class="btn btn-secondary" data-act="reload" @click="reload()"><Icon name="retry" />Try again</button></div>
      </section>
      <section v-else-if="roll" class="panel">
        <header class="panel-head row">
          <div><h2>Machines <span class="cnt">{{ num(nodes.length) }}</span></h2><p>How each machine is converging on this revision. A machine is as far along as its slowest Target.</p></div>
          <div class="head-tools">
            <ChipsFilter v-model="filter" :items="chips" label="Filter machines by state" />
            <label class="sel"><span>Sort</span><select id="rv-sort" v-model="sort"><option v-for="[k, l] in SORT_OPTIONS" :key="k" :value="k">{{ l }}</option></select><Icon name="chevD" class="sel-chev" /></label>
          </div>
        </header>
        <template v-if="nodes.length">
          <div class="rv-legend" aria-hidden="true"><span>Machine</span><span>State</span><span>Attempts</span><span>Targets</span></div>
          <ul class="rv-list">
            <li v-for="n in shown" :key="n.id" class="rv-row" :class="`rv-row--${n.state}`">
              <RouterLink class="rv-node" :to="{ name: 'node', params: { alias: n.name } }"><b>{{ n.name }}</b></RouterLink>
              <span class="rv-state"><StatusGlyph :level="stateOf(n.state).level" :kind="stateOf(n.state).kind" /><span>{{ stateOf(n.state).label }}</span></span>
              <div class="rv-times">
                <template v-if="n.first || n.last">
                  <span v-if="n.first" class="rv-t" :data-tip="`First attempt|${fmtFull(n.first)} UTC`"><span class="muted">First attempt</span> <time :datetime="n.first">{{ rel(n.first) }}</time></span>
                  <span v-if="n.last" class="rv-t" :data-tip="`Last attempt|${fmtFull(n.last)} UTC`"><span class="muted">Last attempt</span> <time :datetime="n.last">{{ rel(n.last) }}</time></span>
                </template>
                <span v-else class="muted small">No attempt yet</span>
              </div>
              <ul class="rv-targets" :aria-label="`Targets of ${n.name}`">
                <li v-for="t in n.targets" :key="t.name">
                  <RouterLink v-if="t.errorCode" class="tchip tchip--error" :to="{ name: 'node', params: { alias: n.name, tab: 'problems' } }" :data-tip="tip(t, stateOf(t.state).label)">
                    <StatusGlyph :level="stateOf(t.state).level" :kind="stateOf(t.state).kind" /><span class="sr">{{ stateOf(t.state).label }}: </span><span>{{ targetShort({ name: t.name }) }}</span><code>{{ t.errorCode }}</code>
                  </RouterLink>
                  <span v-else class="tchip" :data-tip="tip(t, stateOf(t.state).label)">
                    <StatusGlyph :level="stateOf(t.state).level" :kind="stateOf(t.state).kind" /><span class="sr">{{ stateOf(t.state).label }}: </span><span>{{ targetShort({ name: t.name }) }}</span>
                  </span>
                </li>
              </ul>
            </li>
            <li v-if="!shown.length" class="empty-mini"><Icon name="grid" /><p>No machines in this state.</p></li>
          </ul>
          <p v-if="nodes.length >= 500" class="muted small">Only the first 500 machines are listed.</p>
        </template>
        <div v-else class="empty-mini"><Icon name="grid" /><p>No machine has an Assignment in this rollout.</p></div>
      </section>
    </template>
  </div>
</template>
