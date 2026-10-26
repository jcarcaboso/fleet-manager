<script setup lang="ts">
import { computed } from 'vue';
import CheckinChart from '@/components/CheckinChart.vue';
import GapList from '@/components/GapList.vue';
import Icon from '@/components/Icon.vue';
import InlineError from '@/components/InlineError.vue';
import RevChip from '@/components/RevChip.vue';
import StateTag from '@/components/StateTag.vue';
import StatusGlyph from '@/components/StatusGlyph.vue';
import { num, rel, shortSha } from '@/lib/format';
import { totalPolls } from '@/lib/charts';
import type { NodeDetailView } from '@/lib/model';
import { targetIcon, targetLabel, targetWhere } from '@/lib/targets';
import DiskPanel from './DiskPanel.vue';
import MachinePanel from './MachinePanel.vue';
import { healthChecks, rowTime, targetContent } from './nodeModel';
import { useNodePage } from './nodePage';

/** Overview: health checks, the Targets, the Disk and Machine panels, the Targets table and the check-in chart. */
const props = defineProps<{ node: NodeDetailView }>();
const page = useNodePage();
const checks = computed(() => healthChecks(props.node));
const buckets = computed(() => page.tab.checkins[page.hours.value]);
const rev = computed(() => props.node.currentRevision);
const RANGES = [[168, '7 days'], [24, '24 hours']] as const;
const same = (t: NodeDetailView['targets'][number]): boolean => !!t.lastSucceededRevision && !!t.desiredRevision && t.lastSucceededRevision === t.desiredRevision.sourceRevision;
</script>

<template>
  <div class="cols">
    <section class="panel">
      <header class="panel-head"><h2>Health checks</h2><p>What Fleet knows about {{ node.alias }} right now.</p></header>
      <ul class="hchecks">
        <li v-for="c in checks" :key="c.title"><StatusGlyph :level="c.level" :kind="c.kind" /><div><b>{{ c.title }}</b><span>{{ c.text }}</span></div></li>
      </ul>
    </section>
    <section class="panel">
      <header class="panel-head">
        <h2>{{ rev ? `Targets at revision ${shortSha(rev)}` : 'Targets' }}</h2>
        <p>{{ rev && node.currentAcceptedAt ? `Newest desired revision for this machine, published ${rel(node.currentAcceptedAt)}.` : 'The current assignment of each Target.' }}</p>
      </header>
      <ul v-if="node.targets.length" class="trows">
        <li v-for="t in node.targets" :key="t.name"><span class="trow-ic"><Icon :name="targetIcon(t)" /></span><span class="trow-name">{{ targetLabel(t) }}</span><StateTag :state="t.state" /><span class="trow-t">{{ rowTime(t) }}</span></li>
      </ul>
      <div v-else class="empty-mini"><Icon name="layers" /><p>Nothing is assigned yet.</p></div>
      <RouterLink class="more" :to="{ name: 'deployments' }">See all deployments<Icon name="arrowR" /></RouterLink>
    </section>
  </div>
  <DiskPanel :node="node" />
  <MachinePanel :node="node" />
  <section class="panel">
    <header class="panel-head"><h2>Targets: last in sync vs desired</h2><p>The revision each Target last applied successfully, next to the revision it should reach.</p></header>
    <div v-if="!node.targets.length" class="empty-mini"><Icon name="layers" /><p>No Targets are assigned to this machine yet.</p></div>
    <div v-else class="tbl-wrap">
      <table class="tbl">
        <thead><tr><th>Target</th><th>Content</th><th>Last in sync</th><th aria-label="changes to"></th><th>Desired</th><th>State</th><th>Updated</th></tr></thead>
        <tbody>
          <tr v-for="t in node.targets" :key="t.name">
            <td><span class="tcell"><Icon :name="targetIcon(t)" /><span><b>{{ targetLabel(t) }}</b><span class="mono muted">{{ targetWhere(t) }}</span></span></span></td>
            <td>{{ targetContent(t) }}</td>
            <td><RevChip :sha="t.lastSucceededRevision" :tip="t.lastSucceededRevision ?? undefined" /></td>
            <td><span v-if="same(t)" class="muted" aria-label="same">=</span><Icon v-else name="arrowR" class="muted" /></td>
            <td><RevChip v-if="t.desiredRevision" :sha="t.desiredRevision.sourceRevision" :tip="`${t.desiredRevision.sourceRevision}|published ${rel(t.desiredRevision.acceptedAt)}`" /><span v-else class="muted">—</span></td>
            <td><StateTag :state="t.state" /></td>
            <td class="muted">{{ rel(t.latestAttempt?.updatedAt || t.assignedAt) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
  <section class="panel">
    <header class="panel-head row">
      <div><h2>Check-ins</h2><p>Authenticated polls received per hour. Times in UTC.</p></div>
      <div class="head-tools">
        <div class="seg-ctl" role="group" aria-label="Range">
          <button v-for="[h, l] in RANGES" :key="h" type="button" :aria-pressed="page.hours.value === h" @click="page.setRange(h)">{{ l }}</button>
        </div>
        <div class="stat"><span class="stat-l">Total</span><b class="stat-v">{{ buckets ? num(totalPolls(buckets)) : '—' }}</b></div>
      </div>
    </header>
    <template v-if="buckets">
      <template v-if="buckets.length"><CheckinChart :buckets="buckets" /><GapList :buckets="buckets" :revoked="node.revoked" /></template>
      <div v-else class="empty-mini"><p>No check-in data yet.</p></div>
    </template>
    <InlineError v-else-if="page.tab.checkinsErr" :error="page.tab.checkinsErr" what="check-ins" />
    <div v-else class="skel skel-block"></div>
  </section>
</template>
