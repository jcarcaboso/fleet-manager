<script setup lang="ts">
import { computed, provide, watch } from 'vue';
import { useRoute } from 'vue-router';
import EmptyState from '@/components/EmptyState.vue';
import ErrorState from '@/components/ErrorState.vue';
import Icon from '@/components/Icon.vue';
import LoadingBlock from '@/components/LoadingBlock.vue';
import TabNav, { type TabItem } from '@/components/TabNav.vue';
import { useDocumentTitle } from '@/composables/useDocumentTitle';
import { NODE_TABS, nodeRoute, normalizeTab, type NodeTab } from '@/router';
import ActivityTab from './ActivityTab.vue';
import InstalledTab from './InstalledTab.vue';
import NodeDialogs from './NodeDialogs.vue';
import NodeHero from './NodeHero.vue';
import OverviewTab from './OverviewTab.vue';
import ProblemsTab from './ProblemsTab.vue';
import SecurityTab from './SecurityTab.vue';
import SettingsTab from './SettingsTab.vue';
import { NODE_PAGE, createNodePage } from './nodePage';

/**
 * One machine: header, tabs (Overview, Installed, Problems, Activity, Security, Settings) and the dialogs. The router keys this
 * component by alias (`routeViewKey`), so a new machine is a new page with its own state, requests and polls; switching tabs keeps it.
 */
const route = useRoute();
const alias = String(route.params.alias);
let shown: NodeTab = normalizeTab(route.params.tab);
/* While the router replaces this page with another machine the route already names that machine: keep the tab this page was on. */
const tab = computed<NodeTab>(() => {
  if (String(route.params.alias) === alias) shown = normalizeTab(route.params.tab);
  return shown;
});
const page = createNodePage(() => alias, () => tab.value);
provide(NODE_PAGE, page);
useDocumentTitle(() => alias);

/* The data of a tab is read when the machine has loaded and whenever the tab changes. */
watch(() => [tab.value, page.node.value?.id] as const, ([t]) => { void page.loadTab(t); }, { immediate: true });

const LABELS: Record<NodeTab, string> = { overview: 'Overview', installed: 'Installed', problems: 'Problems', activity: 'Activity', security: 'Security', settings: 'Settings' };
const tabs = computed<TabItem[]>(() => NODE_TABS.map(key => ({
  key, label: LABELS[key], to: nodeRoute(alias, key),
  ...(key === 'problems' && page.openProblems.value.length ? { count: page.openProblems.value.length, tone: page.worst.value } : {}),
})));
const panels = { overview: OverviewTab, installed: InstalledTab, problems: ProblemsTab, activity: ActivityTab, security: SecurityTab, settings: SettingsTab } as const;
const { core } = page;
</script>

<template>
  <LoadingBlock v-if="core.loading.value && !core.data.value" />
  <div v-else-if="core.error.value" class="wrap"><ErrorState :error="core.error.value" :what="alias" @retry="core.reload()" /></div>
  <div v-else-if="page.missing.value" class="wrap">
    <EmptyState icon="search" h="h1" :title="`We could not find “${alias}”`" text="It may have been renamed or removed. Removed machines free their alias.">
      <RouterLink class="btn btn-secondary" :to="{ name: 'machines' }">Back to all machines</RouterLink>
    </EmptyState>
  </div>
  <div v-else-if="page.node.value && page.health.value" class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb"><RouterLink :to="{ name: 'machines' }"><Icon name="chevL" />All machines</RouterLink><span aria-hidden="true">/</span><span aria-current="page">{{ page.node.value.alias }}</span></nav>
    <NodeHero />
    <TabNav :items="tabs" :current="tab" :label="`${page.node.value.alias} sections`" />
    <div id="tabpanel" class="tabpanel"><component :is="panels[tab]" :node="page.node.value" /></div>
    <NodeDialogs />
  </div>
</template>
