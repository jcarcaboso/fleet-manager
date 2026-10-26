<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import PageHead from '@/components/PageHead.vue';
import TabNav, { type TabItem } from '@/components/TabNav.vue';
import { NODE_TABS, nodeRoute, normalizeTab, type NodeTab } from '@/router';
import ActivityTab from './ActivityTab.vue';
import InstalledTab from './InstalledTab.vue';
import OverviewTab from './OverviewTab.vue';
import ProblemsTab from './ProblemsTab.vue';
import SecurityTab from './SecurityTab.vue';
import SettingsTab from './SettingsTab.vue';

// Placeholder: the machine page is ported onto the foundation (see README.md, "Writing a view").
// The router keys this component by alias (`routeViewKey`), so a new machine is a new component; switching tabs keeps it.
const route = useRoute();
const alias = computed(() => String(route.params.alias));
const tab = computed(() => normalizeTab(route.params.tab));
const LABELS: Record<NodeTab, string> = { overview: 'Overview', installed: 'Installed', problems: 'Problems', activity: 'Activity', security: 'Security', settings: 'Settings' };
const tabs = computed<TabItem[]>(() => NODE_TABS.map(key => ({ key, label: LABELS[key], to: nodeRoute(alias.value, key) })));
const panels = { overview: OverviewTab, installed: InstalledTab, problems: ProblemsTab, activity: ActivityTab, security: SecurityTab, settings: SettingsTab } as const;
</script>

<template>
  <div class="wrap">
    <PageHead :title="alias" sub="Machine details." />
    <p class="muted" data-test="not-ported">The machine page is not ported yet.</p>
    <TabNav :items="tabs" :current="tab" :label="`${alias} sections`" />
    <div id="tabpanel" class="tabpanel"><component :is="panels[tab]" /></div>
  </div>
</template>
