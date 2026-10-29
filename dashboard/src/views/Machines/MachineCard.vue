<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import CheckinStrip from '@/components/CheckinStrip.vue';
import DeviceArt from '@/components/DeviceArt.vue';
import Icon from '@/components/Icon.vue';
import StatusGlyph from '@/components/StatusGlyph.vue';
import { totalPolls } from '@/lib/charts';
import { HOUR, bytes as bytesText, fmtDay, fmtFull, ms, now, num, platformLabel, rel } from '@/lib/format';
import { agentOutdated, certFlag, certText, diskLevel, isAttention, osText, seenText, updateBadge, type Health, type NodeView } from '@/lib/model';
import { tstate } from '@/lib/targets';
import { nodeRoute } from '@/router';
import type { StripScheduler } from './stripScheduler';

/**
 * One machine in the gallery: the picture with its status and Agent badge (outdated, updating, update failed), the name, what the Agent reported, the reason for its
 * health, the disk meter, the check-in strip (loaded lazily by the scheduler) and the Assignment state chips.
 */
const props = defineProps<{ node: NodeView; health: Health; strips: StripScheduler }>();

const slot = ref<HTMLElement | null>(null);
let registered: HTMLElement | null = null;
onMounted(() => {
  if (props.node.revoked || !slot.value) return;
  registered = slot.value;
  props.strips.register(props.node.id, registered);
});
onBeforeUnmount(() => {
  if (registered) props.strips.unregister(props.node.id, registered);
});

const platformIcon = computed(() => (props.node.platform === 'macos' ? 'apple' : props.node.platform === 'linux' ? 'tux' : null));
const agent = computed(() => props.node.agent);
const outdated = computed(() => agentOutdated(props.node));
const update = computed(() => updateBadge(props.node));
const target = computed(() => props.node.update?.targetVersion || 'a newer version');
const updateText = computed(() => (update.value?.key === 'updating' ? `Updating to ${target.value}` : update.value ? `Update to ${target.value} failed` : ''));
const badgeTip = computed(() => `Agent ${agent.value?.version}|${updateText.value || (outdated.value ? 'Update available' : props.node.revoked ? 'Revoked' : 'Up to date')}`);
const sub = computed(() => {
  const a = agent.value;
  if (!a) return `${platformLabel(props.node.platform)} · enrolled ${fmtDay(props.node.enrolledAt)}`;
  return [osText(props.node) || platformLabel(props.node.platform), a.arch].filter(Boolean).join(' · ');
});
const toProblems = computed(() => isAttention(props.health) && props.health.key === 'failing');
const flag = computed(() => certFlag(props.node));

const disk = computed(() => {
  const d = props.node.disk;
  if (!d) return null;
  const lv = diskLevel(d.usedPercent);
  const measured = ms(d.measuredAt);
  const old = measured !== null && now() - measured > 5 * HOUR;
  return {
    lv,
    pct: d.usedPercent.toFixed(1),
    width: Math.min(100, d.usedPercent).toFixed(1),
    free: d.availableBytes,
    total: d.totalBytes,
    tip: measured !== null ? `Measured ${rel(d.measuredAt)}|${fmtFull(d.measuredAt)} UTC` : undefined,
    label: d.label !== 'home' ? d.label : '',
    age: old ? ` · measured ${rel(d.measuredAt)}` : '',
  };
});

const CHIPS: ReadonlyArray<readonly [keyof NodeView['counts'], string]> = [['failed', 'failed'], ['applying', 'applying'], ['pending', 'waiting'], ['succeeded', 'in sync'], ['superseded', 'superseded']];
const chips = computed(() => CHIPS.filter(([k]) => props.node.counts[k] > 0).map(([k, word]) => ({ key: k, meta: tstate(k), count: props.node.counts[k], word })));

const strip = computed(() => props.strips.states.get(props.node.id));
const buckets = computed(() => { const d = strip.value; return d && 'buckets' in d ? d.buckets : null; });
const stripTotal = computed(() => (buckets.value ? num(totalPolls(buckets.value)) : props.node.revoked ? '—' : '…'));
</script>

<template>
  <article class="card" :class="`card--${health.key}`">
    <div class="stage">
      <DeviceArt :node="node" :health="health" />
      <span class="pill on-stage" :class="`t-${health.level}`"><StatusGlyph :level="health.level" :kind="health.kind" /><span>{{ health.label }}</span></span>
      <span v-if="!agent?.version" class="agent-badge"><Icon v-if="platformIcon" :name="platformIcon" />{{ platformLabel(node.platform) }}</span>
      <span v-else class="agent-badge" :class="update ? `is-${update.key}` : { 'is-old': outdated }" :data-tip="badgeTip">
        <StatusGlyph v-if="update" :level="update.level" :kind="update.kind" /><StatusGlyph v-else-if="outdated" level="warning" kind="bang" /><Icon v-else-if="platformIcon" :name="platformIcon" />Agent {{ agent.version }}
      </span>
    </div>
    <div class="card-body">
      <div class="card-title"><h3><RouterLink class="stretch" :to="nodeRoute(node.alias)">{{ node.alias }}</RouterLink></h3><span class="seen">{{ seenText(node) }}</span></div>
      <p class="card-sub">{{ sub }}</p>
      <p v-if="agent" class="card-host"><template v-if="agent.hostname"><span class="mono">{{ agent.hostname }}</span>{{ ' · ' }}</template>enrolled {{ fmtDay(node.enrolledAt) }}</p>
      <RouterLink class="reason z" :class="`reason--${health.level}`" :to="nodeRoute(node.alias, toProblems ? 'problems' : undefined)">
        <StatusGlyph :level="health.level" :kind="health.kind" /><span>{{ health.reason }}<span v-if="health.extra" class="reason-extra">{{ ' · ' + health.extra }}</span></span><Icon name="chevR" class="rchev" />
      </RouterLink>
      <div v-if="flag || outdated || update" class="flags">
        <span v-if="update" class="chip" :class="update.key === 'updating' ? 'chip--updating' : 'chip--update-failed'" data-agent-update><StatusGlyph :level="update.level" :kind="update.kind" />{{ updateText }}</span>
        <span v-else-if="outdated" class="chip chip--update"><StatusGlyph level="warning" kind="bang" />Update available</span>
        <span v-if="flag" class="flag"><StatusGlyph :level="flag.level" :kind="flag.kind" />{{ flag.text }}</span>
      </div>
      <template v-if="!node.revoked">
        <div v-if="!disk" class="diskm diskm--none"><div class="diskm-top"><span class="diskm-k">Disk</span><span class="diskm-state"><StatusGlyph level="neutral" kind="minus" /><span>No disk data</span></span></div></div>
        <div v-else class="diskm" :class="`diskm--${disk.lv.key}`">
          <div class="diskm-top"><span class="diskm-k">Disk <b>{{ disk.pct }}% used</b></span><span class="diskm-state" :class="`t-${disk.lv.level}`"><StatusGlyph :level="disk.lv.level" :kind="disk.lv.kind" /><span>{{ disk.lv.label }}</span></span></div>
          <div class="meter meter--thin" :class="`m-${disk.lv.key}`" role="img" :aria-label="`Disk ${disk.pct}% used, ${disk.lv.label}`"><span :style="{ width: disk.width + '%' }"></span></div>
          <p class="diskm-sub" :data-tip="disk.tip">{{ bytesText(disk.free) }} free of {{ bytesText(disk.total) }}<template v-if="disk.label">{{ ' · ' + disk.label + ' volume' }}</template>{{ disk.age }}</p>
        </div>
      </template>
      <div class="vitals">
        <div class="vital">
          <div class="vital-top"><span>Check-ins, 24 h</span><b :data-strip-total="node.id">{{ stripTotal }}</b></div>
          <div ref="slot" class="strip-slot" :data-strip-slot="node.revoked ? undefined : node.id">
            <span v-if="node.revoked" class="muted small">Revoked</span>
            <CheckinStrip v-else-if="buckets" :buckets="buckets" />
            <span v-else-if="strip && 'error' in strip" class="muted small">Unavailable</span>
            <span v-else class="strip-pending" aria-hidden="true"></span>
          </div>
        </div>
        <div class="vital"><div class="vital-top"><span>Certificate</span><b>{{ certText(node) }}</b></div></div>
      </div>
      <div class="chips">
        <span v-for="c in chips" :key="c.key" class="chip"><StatusGlyph :level="c.meta.level" :kind="c.meta.kind" /><span class="sr">{{ c.meta.label + ': ' }}</span>{{ c.count }} {{ c.word }}</span>
        <span v-if="!chips.length" class="chip chip--empty">No Targets yet</span>
      </div>
    </div>
  </article>
</template>
