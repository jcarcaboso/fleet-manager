<script setup lang="ts">
import { computed } from 'vue';
import ChipsFilter from '@/components/ChipsFilter.vue';
import InlineError from '@/components/InlineError.vue';
import Timeline from '@/components/Timeline.vue';
import type { NodeDetailView } from '@/lib/model';
import { ACTIVITY_FILTERS } from './nodeModel';
import { useNodePage } from './nodePage';

/** Activity: Attempts, repaired local changes (drift), audit events and the enrollment, merged and newest first, with a filter and "Load older activity". */
const props = defineProps<{ node: NodeDetailView }>();
const page = useNodePage();
const all = computed(() => page.activity.value);
const filter = computed({ get: () => page.tab.actFilter, set: v => { page.tab.actFilter = v; } });
const shown = computed(() => (filter.value === 'all' ? all.value : all.value.filter(e => e.cat === filter.value)));
const chips = computed(() => ACTIVITY_FILTERS.map(([k, l]) => [k, l, k === 'all' ? all.value.length : all.value.filter(e => e.cat === k).length] as const));
</script>

<template>
  <section class="panel">
    <header class="panel-head row">
      <div><h2>Activity</h2><p>Attempts, repaired local changes and changes for {{ props.node.alias }}, newest first. Times in UTC.</p></div>
      <ChipsFilter v-model="filter" :items="chips" label="Filter activity" />
    </header>
    <InlineError v-if="page.tab.attemptsErr" :error="page.tab.attemptsErr" what="attempts" />
    <InlineError v-if="page.tab.auditErr" :error="page.tab.auditErr" what="the audit log" />
    <div v-if="!page.tab.activityReady" class="skel skel-block" role="status"><span class="sr">Loading…</span></div>
    <Timeline v-else :events="shown" />
    <div v-if="page.tab.attemptsNext || page.tab.auditNext" class="load-more">
      <button type="button" class="btn btn-secondary" data-act="more-activity" :disabled="page.tab.loadingMore" @click="page.loadMoreActivity()">Load older activity</button>
    </div>
  </section>
</template>
