<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { CheckinsResponse, CliProxyStatus, DesiredRevisionItem, EnrollmentLink, Issue, IssuesResponse, NodeListItem, SourceStatus } from '@/api/types';
import EmptyState from '@/components/EmptyState.vue';
import ErrorState from '@/components/ErrorState.vue';
import Icon from '@/components/Icon.vue';
import LoadingBlock from '@/components/LoadingBlock.vue';
import LockNote from '@/components/LockNote.vue';
import ScopeButton from '@/components/ScopeButton.vue';
import { useLoad } from '@/composables/useLoad';
import { useFleet } from '@/context';
import { soft } from '@/lib/errors';
import { enc, num, slug } from '@/lib/format';
import { errorCount, failuresFromIssues, fromList, health, issuesByNode, type Health, type NodeView } from '@/lib/model';
import { useEnrollmentBus } from '../Enrollment/enrollmentBus';
import { useRepositorySync } from '../Repository/useRepositorySync';
import { GROUPS, SORTS, comparator, matches, sections, sortByName, type GroupKey } from './gallery';
import { useGalleryPrefs } from './galleryPrefs';
import MachineCard from './MachineCard.vue';
import MachinesHero from './MachinesHero.vue';
import { createStripScheduler } from './stripScheduler';

/**
 * Machines: the gallery of every enrolled machine, grouped and sorted, with the health summary and the tiles that lead to the other
 * pages (ported from view-gallery.js).
 * API: GET nodes (with disk and agent), GET issues, GET errors, GET source/status, GET desired-revisions?order=newest&limit=1,
 * GET cliproxy/status, GET enrollment-links, and GET nodes/{id}/checkins?hours=24 for the strip of each card that is on screen.
 */
const { api, catalog, summary, shell, shared, wizard } = useFleet();
const bus = useEnrollmentBus();
const prefs = useGalleryPrefs();

const q = ref('');
const searchBox = ref<HTMLInputElement | null>(null);

interface Gallery {
  nodes: NodeView[];
  truncated: boolean;
  issues: Issue[] | null;
  source: SourceStatus | null;
  rev: DesiredRevisionItem | null;
  proxy: CliProxyStatus | null;
  links: EnrollmentLink[] | null;
}

const strips = createStripScheduler({
  load: async (id, signal) => (await api.get<CheckinsResponse>(`nodes/${enc(id)}/checkins`, { hours: 24 }, { signal }))?.buckets ?? [],
});
onBeforeUnmount(() => strips.dispose());

const { data, error, loading, run, reload } = useLoad<Gallery>(async token => {
  strips.reset();
  const [nodes, issues, source, revs, proxy, links] = await Promise.all([
    api.all<NodeListItem>('nodes', { maxPages: 5, signal: token.signal }),
    api.get<IssuesResponse>('issues', undefined, { signal: token.signal }).catch(soft),
    api.get<SourceStatus>('source/status', undefined, { signal: token.signal }).catch(soft),
    api.page<DesiredRevisionItem>('desired-revisions', { order: 'newest', limit: 1 }, { signal: token.signal }).catch(soft),
    api.get<CliProxyStatus>('cliproxy/status', undefined, { signal: token.signal }).catch(soft),
    api.page<EnrollmentLink>('enrollment-links', undefined, { signal: token.signal }).catch(soft),
    catalog.load(),
  ]);
  token.check();
  const items = issues ? issues.items || [] : null;
  summary.state.issues = items;
  if (items) summary.state.errors = errorCount(items);
  shell.markLoaded();
  return {
    nodes: nodes.items.map(fromList), truncated: nodes.truncated, issues: items, source,
    rev: revs ? revs.items[0] || null : null, proxy, links: links ? links.items : null,
  };
});
/* The load committed: the cards that are in range ask for their strips again. */
watch(data, () => strips.restart(), { flush: 'post' });

const quietReload = (): Promise<unknown> => run({ quiet: true });
const { sync } = useRepositorySync(quietReload);
/* A link was created or revoked, or a wizard that made one closed: the gallery and its Enrollment tile are stale. A new machine
   should be visible, so the search is cleared too (the old `galleryReset`). */
watch(() => bus.version, () => { q.value = ''; void quietReload(); });

const byIssues = computed(() => issuesByNode(data.value?.issues ?? []));
const healths = computed(() => {
  const map = new Map<string, Health>();
  for (const n of data.value?.nodes ?? []) map.set(n.id, health(n, failuresFromIssues(byIssues.value.get(n.id)), code => catalog.title(code)));
  return map;
});
const healthOf = (n: NodeView): Health => healths.value.get(n.id) ?? health(n);

const query = computed(() => q.value.trim().toLowerCase());
const live = computed(() => (data.value?.nodes ?? []).filter(n => !n.revoked));
const shownLive = computed(() => live.value.filter(n => matches(n, query.value, healthOf)).sort(comparator(prefs.sort, healthOf)));
const shownRetired = computed(() => (data.value?.nodes ?? []).filter(n => n.revoked && matches(n, query.value, healthOf)).sort(sortByName));
const groups = computed(() => sections(shownLive.value, prefs.groupBy, prefs.sort, healthOf, data.value?.rev ?? null));

/* Searching, grouping and sorting repaint the list: every card reports its position again, which also retries failed strips. */
watch([query, () => prefs.groupBy, () => prefs.sort], () => strips.rescan(), { flush: 'post' });

const setGroup = (g: GroupKey): void => { prefs.groupBy = g; };
const clearSearch = (): void => { q.value = ''; void nextTick(() => searchBox.value?.focus()); };
async function jump(key: string): Promise<void> {
  if (prefs.groupBy !== 'status') {
    prefs.groupBy = 'status';
    await nextTick();
  }
  const id = ({ ok: 'sec-ok', updating: 'sec-updating' } as Record<string, string>)[key] || 'sec-attention';
  document.getElementById(id)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
}
const onRetiredToggle = (e: Event): void => { prefs.retiredOpen = (e.target as HTMLDetailsElement).open; };
</script>

<template>
  <LoadingBlock v-if="loading && !data" />
  <div v-else class="wrap">
    <ErrorState v-if="error" :error="error" what="Machines" @retry="reload()" />
    <template v-else-if="data">
      <template v-if="data.nodes.length">
        <MachinesHero
          :live="live" :health-of="healthOf" :source="data.source" :rev="data.rev" :proxy="data.proxy" :links="data.links"
          :syncing="shared.syncing" @sync="sync()" @add="wizard.show()" @jump="jump"
        />
        <div class="toolbar" role="search">
          <label class="search"><Icon name="search" /><span class="sr">Search machines</span><input id="q" ref="searchBox" v-model="q" type="search" autocomplete="off" placeholder="Search by name, hostname, OS, Agent version or status"></label>
          <div class="seg-ctl" role="group" aria-label="Group by"><span class="seg-lbl">Group by</span><button v-for="[k, l] in GROUPS" :key="k" type="button" data-act="group" :data-v="k" :aria-pressed="prefs.groupBy === k" @click="setGroup(k)">{{ l }}</button></div>
          <label class="sel"><span>Sort</span><select id="sort" v-model="prefs.sort"><option v-for="[k, l] in SORTS" :key="k" :value="k">{{ l }}</option></select><Icon name="chevD" class="sel-chev" /></label>
        </div>
      </template>
      <div id="gallery-body">
        <EmptyState v-if="!data.nodes.length" icon="server" title="No machines yet" text="Create an enrollment link, then run the Agent on a machine to add it to Fleet." h="h1">
          <ScopeButton level="admin" cls="btn-primary" data-act="add" @click="wizard.show()"><Icon name="plus" />Add machine</ScopeButton>
          <LockNote level="admin" />
        </EmptyState>
        <EmptyState v-else-if="!shownLive.length && !shownRetired.length" icon="search" :title="`No machines match “${q}”`" text="Try an alias, a hostname, an OS such as Fedora, an Agent version such as 0.9.0, or a status such as Offline.">
          <button type="button" class="btn btn-secondary" data-act="clear-search" @click="clearSearch">Clear search</button>
        </EmptyState>
        <template v-else>
          <section v-for="s in groups" :id="`sec-${slug(s.key)}`" :key="s.key" class="gsec" :aria-labelledby="`h-${slug(s.key)}`">
            <header class="gsec-head">
              <h2 :id="`h-${slug(s.key)}`"><span v-if="s.icon" class="gsec-ic"><Icon :name="s.icon" /></span>{{ s.title }} <span class="cnt">{{ s.nodes.length }}</span></h2>
              <p>{{ s.sub }}</p>
            </header>
            <div class="grid"><MachineCard v-for="n in s.nodes" :key="n.id" :node="n" :health="healthOf(n)" :strips="strips" /></div>
          </section>
          <details v-if="shownRetired.length" class="retired" data-retired :open="prefs.retiredOpen" @toggle="onRetiredToggle">
            <summary><span class="gsec-ic"><Icon name="ban" /></span><span><b>Retired</b> <span class="cnt">{{ shownRetired.length }}</span><span class="retired-sub">Revoked machines keep their alias reserved. Remove one on its Settings tab to free the alias.</span></span><Icon name="chevD" class="sumchev" /></summary>
            <div class="grid"><MachineCard v-for="n in shownRetired" :key="n.id" :node="n" :health="healthOf(n)" :strips="strips" /></div>
          </details>
          <p v-if="data.truncated" class="note"><Icon name="info" /><span>Showing the first {{ num(data.nodes.length) }} machines. Narrow the list with search to find others.</span></p>
        </template>
      </div>
    </template>
  </div>
</template>
