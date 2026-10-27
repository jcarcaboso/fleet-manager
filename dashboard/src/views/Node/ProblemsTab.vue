<script setup lang="ts">
import { computed } from 'vue';
import ChipsFilter from '@/components/ChipsFilter.vue';
import StatusGlyph from '@/components/StatusGlyph.vue';
import { plural } from '@/lib/format';
import { total, type NodeDetailView } from '@/lib/model';
import ProblemCard from './ProblemCard.vue';
import { useNodePage } from './nodePage';

/** Problems: the failed Targets and issues of this machine, by state (Open, Acknowledged, Snoozed), each with how to fix it. */
const props = defineProps<{ node: NodeDetailView }>();
const page = useNodePage();
const list = computed(() => page.problems.value);
const count = (key: string): number => list.value.filter(p => p.st.key === key).length;
const shown = computed(() => list.value.filter(p => p.st.key === page.tab.probState));
const filters = computed(() => [['open', 'Open', count('open')], ['acknowledged', 'Acknowledged', count('acknowledged')], ['snoozed', 'Snoozed', count('snoozed')]] as const);
const targets = computed(() => total(props.node));
</script>

<template>
  <div v-if="node.revoked" class="empty empty--good">
    <div class="empty-art good"><StatusGlyph level="neutral" kind="minus" /></div>
    <h2>{{ node.alias }} is retired</h2>
    <p>Revoked machines get no new assignments, so Fleet no longer tracks problems for them.</p>
  </div>
  <template v-else>
    <div v-if="!page.issuesOk.value" class="callout callout--warning">
      <StatusGlyph level="warning" kind="bang" />
      <div><b>Issue details are unavailable</b><p>Failed Targets are shown from the machine record, without CLI commands or other issues.</p></div>
    </div>
    <div v-if="!list.length" class="empty empty--good">
      <div class="empty-art good"><StatusGlyph level="good" kind="check" /></div>
      <h2>Nothing to fix on {{ node.alias }}</h2>
      <p>{{ targets ? `All ${plural(targets, 'Target')} are in sync and the Agent is checking in.` : 'Nothing is assigned to this machine yet.' }}</p>
    </div>
    <template v-else>
      <div class="toolbar toolbar--plain"><ChipsFilter v-model="page.tab.probState" :items="filters" label="Filter problems by state" /></div>
      <template v-if="!shown.length">
        <div v-if="page.tab.probState === 'open'" class="empty empty--good">
          <div class="empty-art good"><StatusGlyph level="good" kind="check" /></div>
          <h2>Nothing open on {{ node.alias }}</h2>
          <p>Everything that needs attention is acknowledged or snoozed. Open the other tabs to review it.</p>
        </div>
        <div v-else class="empty empty--good">
          <div class="empty-art good"><StatusGlyph level="good" kind="check" /></div>
          <h2>Nothing {{ page.tab.probState }}</h2>
          <p>{{ page.tab.probState === 'snoozed' ? 'Snooze a problem to hide it from Open for a while.' : 'Acknowledge a problem you know about. It stays listed here.' }}</p>
        </div>
      </template>
      <template v-else><ProblemCard v-for="p in shown" :key="p.id" :node="node" :problem="p" /></template>
    </template>
  </template>
</template>
