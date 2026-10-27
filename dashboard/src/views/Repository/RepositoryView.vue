<script setup lang="ts">
import { computed, ref } from 'vue';
import type { DesiredRevisionItem, RevisionWarning, SourceScan, SourceStatus } from '@/api/types';
import ErrorState from '@/components/ErrorState.vue';
import Icon from '@/components/Icon.vue';
import LoadingBlock from '@/components/LoadingBlock.vue';
import LockNote from '@/components/LockNote.vue';
import MdText from '@/components/MdText.vue';
import PageHead from '@/components/PageHead.vue';
import RevChip from '@/components/RevChip.vue';
import ScopeButton from '@/components/ScopeButton.vue';
import StatusGlyph from '@/components/StatusGlyph.vue';
import StepsList from '@/components/StepsList.vue';
import { useLoad } from '@/composables/useLoad';
import { useView } from '@/composables/useView';
import { useFleet } from '@/context';
import { soft } from '@/lib/errors';
import { fmtFull, plural, rel, shortSha } from '@/lib/format';
import { scanOutcome } from '@/lib/model';
import { useRepositorySync } from './useRepositorySync';

/**
 * Repository. API: GET source/status, GET source/scans, GET desired-revisions?order=newest&limit=1, GET warnings, GET errors,
 * POST source/rescan. The remote URL, branch and skill library are not in the Operator API, so they are not shown.
 */
const { api, catalog, summary, shell, shared, toasts, openState } = useFleet();

const status = ref<SourceStatus | null>(null);
const scans = ref<SourceScan[]>([]);
const next = ref<string | null>(null);
const rev = ref<DesiredRevisionItem | null>(null);
const warnings = ref<RevisionWarning[]>([]);
const loadingMore = ref(false);

const view = useView();
const more = view.lane();
const load = useLoad(async token => {
  more.cancel();
  const [st, sc, revs, w] = await Promise.all([
    api.get<SourceStatus | null>('source/status', undefined, { signal: token.signal }).catch(soft),
    api.page<SourceScan>('source/scans', { limit: 20 }, { signal: token.signal }),
    api.page<DesiredRevisionItem>('desired-revisions', { order: 'newest', limit: 1 }, { signal: token.signal }),
    api.all<RevisionWarning>('warnings', { maxPages: 3, signal: token.signal }).catch(soft),
    catalog.load(),
  ]);
  token.check();
  status.value = st;
  scans.value = sc.items;
  next.value = sc.nextCursor;
  rev.value = revs.items[0] ?? null;
  warnings.value = w ? w.items : [];
  loadingMore.value = false;
  void summary.refresh();
  shell.markLoaded();
  return true;
}, { view });
const { data, error, loading, reload, run } = load;
const { sync } = useRepositorySync(() => run({ quiet: true }));

const last = computed(() => status.value || scans.value[0] || null);
const o = computed(() => (last.value ? scanOutcome(last.value.outcome) : null));
const curWarns = computed(() => (rev.value ? warnings.value.filter(w => w.desiredRevisionId === rev.value!.desiredRevisionId) : []));
const olderWarns = computed(() => (rev.value ? warnings.value.filter(w => w.desiredRevisionId !== rev.value!.desiredRevisionId) : warnings.value));

const hasBody = (s: SourceScan): boolean => !!(s.diagnostic || (s.code && catalog.get(s.code)));
const scanOpen = (s: SourceScan, i: number): boolean => {
  const key = 'scan:' + s.scanId;
  return openState.has(key) ? openState.get(key) === true : (i === 0 && s.outcome !== 'unchanged' && s.outcome !== 'accepted');
};
const onToggle = (key: string, e: Event): void => { openState.set(key, (e.target as HTMLDetailsElement).open); };

async function moreScans(): Promise<void> {
  if (loadingMore.value || !next.value) return;
  const token = more.begin();
  loadingMore.value = true;
  try {
    const r = await api.page<SourceScan>('source/scans', { limit: 20, after: next.value }, { signal: token.signal });
    token.check();
    scans.value = scans.value.concat(r.items);
    next.value = r.nextCursor;
  } catch (e) {
    if (!token.isCurrent()) return;
    toasts.fail(e, 'Could not load older scans');
  }
  if (token.isCurrent()) loadingMore.value = false;
}
</script>

<template>
  <LoadingBlock v-if="loading" />
  <div v-else class="wrap">
    <ErrorState v-if="error" :error="error" what="Repository" @retry="reload()" />
    <template v-else-if="data">
      <PageHead title="Repository" sub="Fleet publishes Skills, agent files and AI-client settings from your Git repository. A publication only happens when the manifest is valid.">
        <template #actions>
          <ScopeButton level="operate" cls="btn-primary" data-act="sync" :disabled="shared.syncing" @click="sync()"><Icon name="sync" :class="{ spin: shared.syncing }" />{{ shared.syncing ? 'Syncing…' : 'Sync repository' }}</ScopeButton>
        </template>
      </PageHead>
      <LockNote level="operate" />
      <section class="panel repo-card">
        <div class="repo-id"><span class="repo-ic"><Icon name="branch" /></span><div><p class="eyebrow">Source</p><h2>Skills repository</h2><p class="muted small">Scanned automatically on a schedule, and whenever an Operator syncs.</p></div></div>
        <dl class="kv kv--grid kv--3">
          <div><dt>Published revision</dt><dd><template v-if="rev"><RevChip :sha="rev.sourceRevision" :tip="rev.sourceRevision" /> <span class="muted small">{{ rel(rev.acceptedAt) }}</span></template><span v-else class="muted">Nothing published yet</span></dd></div>
          <div><dt>Last scan</dt><dd><template v-if="last && o"><StatusGlyph :level="o.level" :kind="o.kind" /> {{ o.label }} <span class="muted small">{{ rel(last.observedAt) }}</span></template><span v-else class="muted">No scans recorded yet</span></dd></div>
          <div><dt>Last scan requested by</dt><dd>{{ last ? (last.requestedBy || 'Scheduled scan') : '—' }}</dd></div>
          <div><dt>Source warnings</dt><dd><template v-if="curWarns.length"><StatusGlyph level="warning" kind="bang" /> {{ plural(curWarns.length, 'warning') }}</template><template v-else>None</template></dd></div>
        </dl>
        <p v-if="shared.lastSync" class="result" role="status"><StatusGlyph :level="shared.lastSync.level" :kind="shared.lastSync.kind" />{{ shared.lastSync.text }}</p>
      </section>
      <section v-if="curWarns.length || olderWarns.length" class="panel">
        <header class="panel-head"><h2>Source warnings <span class="cnt">{{ curWarns.length }}</span></h2><p>Raised while scanning the current revision. They do not block publication.</p></header>
        <template v-if="curWarns.length">
          <div v-for="(w, k) in curWarns" :key="k" class="callout callout--warning">
            <StatusGlyph level="warning" kind="bang" />
            <div><b>{{ w.code }}</b><span v-if="catalog.get(w.code)" class="muted"> · {{ catalog.get(w.code)?.title }}</span><p>{{ w.message }}</p>
              <div v-if="(w.sourceLocations || []).length" class="loc-chips"><span v-for="(l, j) in w.sourceLocations" :key="j" class="loc"><Icon name="folder" /><code>{{ l }}</code></span></div>
            </div>
          </div>
        </template>
        <p v-else class="muted">The current revision has no warnings.</p>
        <details v-if="olderWarns.length" class="tech">
          <summary><Icon name="list" />Warnings on earlier revisions ({{ olderWarns.length }})<Icon name="chevD" class="sumchev" /></summary>
          <div class="tech-body">
            <div v-for="(w, k) in olderWarns.slice(0, 20)" :key="k" class="callout callout--warning">
              <StatusGlyph level="warning" kind="bang" />
              <div><b>{{ w.code }}</b><span v-if="catalog.get(w.code)" class="muted"> · {{ catalog.get(w.code)?.title }}</span><p>{{ w.message }}</p>
                <div v-if="(w.sourceLocations || []).length" class="loc-chips"><span v-for="(l, j) in w.sourceLocations" :key="j" class="loc"><Icon name="folder" /><code>{{ l }}</code></span></div>
              </div>
            </div>
          </div>
        </details>
      </section>
      <section class="panel">
        <header class="panel-head"><h2>Recent scans</h2><p>Every fetch and validation, newest first. Rejected and failed scans never change what machines receive.</p></header>
        <ol v-if="scans.length" class="scans">
          <li v-for="(s, i) in scans" :key="s.scanId" class="scan" :class="`scan--${s.outcome}`">
            <span class="scan-dot"><StatusGlyph :level="scanOutcome(s.outcome).level" :kind="scanOutcome(s.outcome).kind" /></span>
            <div class="scan-card">
              <details v-if="hasBody(s)" :data-open-key="`scan:${s.scanId}`" :open="scanOpen(s, i)" @toggle="onToggle(`scan:${s.scanId}`, $event)">
                <summary>
                  <span class="scan-top"><b>{{ scanOutcome(s.outcome).label }}</b><RevChip v-if="s.sourceRevision" :sha="shortSha(s.sourceRevision)" :tip="s.sourceRevision" /><code v-if="s.code" class="small">{{ s.code }}</code><span class="muted small">{{ s.requestedBy ? `requested by ${s.requestedBy}` : 'scheduled scan' }}</span></span>
                  <time class="scan-t" :datetime="s.observedAt">{{ fmtFull(s.observedAt) }} · {{ rel(s.observedAt) }}</time>
                  <Icon name="chevD" class="sumchev" />
                </summary>
                <div class="diag">
                  <p v-if="catalog.get(s.code)" class="prob-expl"><strong>{{ catalog.get(s.code)?.title }}.</strong> <MdText :text="catalog.get(s.code)?.explanation" /></p>
                  <dl v-if="s.code" class="facts-row">
                    <div><dt>Code</dt><dd class="mono">{{ s.code }}</dd></div>
                    <div><dt>Scanned</dt><dd>{{ fmtFull(s.observedAt) }} UTC</dd><dd class="sub">{{ rel(s.observedAt) }}</dd></div>
                    <div v-if="s.sourceRevision"><dt>Revision</dt><dd class="mono">{{ shortSha(s.sourceRevision) }}</dd></div>
                  </dl>
                  <template v-if="catalog.get(s.code)?.fix?.length"><h4 class="mini-h">How to fix</h4><StepsList :steps="catalog.get(s.code)!.fix.map(t => ({ t }))" /></template>
                  <template v-if="s.diagnostic"><p class="kv-label">Diagnostic</p><pre class="code code--diag">{{ s.diagnostic }}</pre></template>
                </div>
              </details>
              <div v-else class="scan-sum">
                <span class="scan-top"><b>{{ scanOutcome(s.outcome).label }}</b><RevChip v-if="s.sourceRevision" :sha="shortSha(s.sourceRevision)" :tip="s.sourceRevision" /><code v-if="s.code" class="small">{{ s.code }}</code><span class="muted small">{{ s.requestedBy ? `requested by ${s.requestedBy}` : 'scheduled scan' }}</span></span>
                <time class="scan-t" :datetime="s.observedAt">{{ fmtFull(s.observedAt) }} · {{ rel(s.observedAt) }}</time>
              </div>
            </div>
          </li>
        </ol>
        <div v-else class="empty-mini"><Icon name="branch" /><p>No scans have been recorded yet.</p></div>
        <div v-if="next" class="load-more"><button type="button" class="btn btn-secondary" data-act="more-scans" :disabled="loadingMore" @click="moreScans()">Load older scans</button></div>
      </section>
    </template>
  </div>
</template>
