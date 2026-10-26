<script setup lang="ts">
import { computed, ref } from 'vue';
import type { AuditEvent } from '@/api/types';
import Avatar from '@/components/Avatar.vue';
import EmptyState from '@/components/EmptyState.vue';
import ErrorState from '@/components/ErrorState.vue';
import Icon from '@/components/Icon.vue';
import LoadingBlock from '@/components/LoadingBlock.vue';
import PageHead from '@/components/PageHead.vue';
import { useLoad } from '@/composables/useLoad';
import { useView } from '@/composables/useView';
import { useFleet } from '@/context';
import { actorName, actorRole, auditIcon, auditLabel } from '@/lib/audit';
import { dayLabel, fmtFull, fmtTime, isUuid, num, plural, rel, shortId, valid } from '@/lib/format';
import { nodeRoute } from '@/router';

/**
 * Audit log. API: GET audit?order=newest. Items are { recordedAt, action, actor, nodeId, credentialId, nodeName }. Names resolve at
 * read time, so a removed machine shows as removed. The Server returns the newest events first, one page at a time; "Load older
 * events" follows the cursor. Search and filters apply to the events loaded so far.
 */
const { api, summary, shell, toasts } = useFleet();
const PAGE = 50;

const events = ref<AuditEvent[]>([]);
const next = ref<string | null>(null);
const loadingMore = ref(false);
const q = ref('');
const actor = ref('all');
const action = ref('all');

const view = useView();
const more = view.lane();
const { data, error, loading, reload } = useLoad(async token => {
  more.cancel();
  const r = await api.page<AuditEvent>('audit', { order: 'newest', limit: PAGE }, { signal: token.signal });
  token.check();
  events.value = r.items.filter(e => valid(e.recordedAt));
  next.value = r.nextCursor;
  loadingMore.value = false;
  void summary.refresh();
  shell.markLoaded();
  return true;
}, { view });

async function moreEvents(): Promise<void> {
  if (loadingMore.value || !next.value) return;
  const token = more.begin();
  loadingMore.value = true;
  try {
    const r = await api.page<AuditEvent>('audit', { order: 'newest', limit: PAGE, after: next.value }, { signal: token.signal });
    token.check();
    events.value = events.value.concat(r.items.filter(e => valid(e.recordedAt)));
    next.value = r.nextCursor;
  } catch (e) {
    if (!token.isCurrent()) return;
    toasts.fail(e, 'Could not load older events');
  }
  if (token.isCurrent()) loadingMore.value = false;
}

const actors = computed(() => [...new Set(events.value.map(e => e.actor))].sort());
const actions = computed(() => [...new Set(events.value.map(e => e.action))].sort());
const rows = computed(() => {
  const needle = q.value.trim().toLowerCase();
  return events.value.filter(e => (actor.value === 'all' || e.actor === actor.value) && (action.value === 'all' || e.action === action.value)
    && (!needle || `${e.action} ${auditLabel(e.action)} ${actorName(e)} ${e.nodeName || ''}`.toLowerCase().includes(needle)));
});
</script>

<template>
  <LoadingBlock v-if="loading" />
  <div v-else class="wrap">
    <ErrorState v-if="error" :error="error" what="Audit" @retry="reload()" />
    <template v-else-if="data">
      <PageHead title="Audit" sub="Every change made by operators, Agents and enrollment. Audit history survives machine removal.">
        <template #actions><button type="button" class="btn btn-secondary" data-act="reload" @click="reload()"><Icon name="sync" />Refresh</button></template>
      </PageHead>
      <section class="panel">
        <EmptyState v-if="!events.length" icon="list" title="No audit events yet" text="Operator actions, enrollment and certificate renewals are recorded here." />
        <template v-else>
          <div class="toolbar toolbar--plain">
            <label class="search search--sm"><Icon name="search" /><span class="sr">Search audit log</span><input id="audit-q" v-model="q" type="search" placeholder="Search actions, actors and machines" autocomplete="off"></label>
            <label class="sel"><span>Actor</span>
              <select id="audit-actor" v-model="actor"><option value="all">Everyone</option><option v-for="a in actors" :key="a" :value="a">{{ isUuid(a) ? 'Agent ' + shortId(a) : a }}</option></select>
              <Icon name="chevD" class="sel-chev" />
            </label>
            <label class="sel"><span>Action</span>
              <select id="audit-action" v-model="action"><option value="all">All actions</option><option v-for="a in actions" :key="a" :value="a">{{ auditLabel(a) }}</option></select>
              <Icon name="chevD" class="sel-chev" />
            </label>
            <span id="audit-count" class="muted small">{{ plural(rows.length, 'event') }}</span>
          </div>
          <div class="tbl-wrap">
            <table class="tbl tbl--audit">
              <thead><tr><th>When (UTC)</th><th>Who</th><th>What</th><th>Machine</th></tr></thead>
              <tbody id="audit-body">
                <tr v-if="!rows.length"><td colspan="4"><div class="empty-mini"><Icon name="search" /><p>No audit events match these filters.</p></div></td></tr>
                <tr v-for="(e, i) in rows" :key="`${e.recordedAt}|${e.action}|${e.actor}|${e.nodeId}|${e.credentialId}|${i}`">
                  <td><span class="when"><b>{{ dayLabel(e.recordedAt) === 'Today' ? fmtTime(e.recordedAt) : fmtFull(e.recordedAt) }}</b><span class="muted small">{{ rel(e.recordedAt) }}</span></span></td>
                  <td><span class="who"><Avatar :name="actorName(e)" /><span><b>{{ actorName(e) }}</b><span class="muted small">{{ actorRole(e) }}</span></span></span></td>
                  <td><span class="what"><span class="what-ic"><Icon :name="auditIcon(e.action)" /></span><span>{{ auditLabel(e.action) }}<code class="small">{{ e.action }}</code></span></span></td>
                  <td>
                    <RouterLink v-if="e.nodeName" class="subj" :to="nodeRoute(e.nodeId || e.nodeName)">{{ e.nodeName }}</RouterLink>
                    <template v-else-if="e.nodeId"><span class="subj">Removed machine</span> <code class="small" :data-tip="e.nodeId">{{ shortId(e.nodeId) }}</code></template>
                    <code v-else-if="e.credentialId" class="small" :data-tip="e.credentialId">credential {{ shortId(e.credentialId) }}</code>
                    <span v-else class="muted">—</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <template v-if="next">
            <p id="audit-more-note" class="muted small">Search and filters apply to the {{ num(events.length) }} newest events loaded so far.</p>
            <div class="load-more"><button type="button" class="btn btn-secondary" data-act="more-audit" :disabled="loadingMore" @click="moreEvents()">Load older events</button></div>
          </template>
        </template>
      </section>
    </template>
  </div>
</template>
