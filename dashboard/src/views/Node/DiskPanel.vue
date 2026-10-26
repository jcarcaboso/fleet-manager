<script setup lang="ts">
import { computed } from 'vue';
import Icon from '@/components/Icon.vue';
import LockNote from '@/components/LockNote.vue';
import ScopeButton from '@/components/ScopeButton.vue';
import StatusGlyph from '@/components/StatusGlyph.vue';
import { bytes, fmtFull, rel } from '@/lib/format';
import { diskLevel, type NodeDetailView } from '@/lib/model';
import type { GlyphKind, GlyphLevel } from '@/lib/status';
import { useNodePage } from './nodePage';

/**
 * Disk usage per volume with the Refresh button and its live status line. The refresh itself lives in the page controller, so it
 * keeps going while the user looks at another tab and ends with the page. Ported from the disk panel of view-node.js.
 */
const props = defineProps<{ node: NodeDetailView }>();
const page = useNodePage();
const VOLUME: Record<string, readonly [string, string]> = {
  home: ['Home folder', 'The volume that holds the user’s home directory'],
  state: ['Agent state', 'The volume that holds the Agent’s state directory'],
};
const volumes = computed(() => (props.node.disk?.volumes ?? []).map(v => {
  const lv = diskLevel(v.usedPercent);
  const [title, sub] = VOLUME[v.label] ?? [v.label, 'Volume reported by the Agent'];
  const pct = v.usedPercent.toFixed(1);
  return { v, lv, title, sub, pct, width: Math.min(100, v.usedPercent).toFixed(1) };
}));
const busy = computed(() => page.diskBusy.value);

interface Status {
  tone: '' | 'info' | 'good' | 'warning' | 'critical';
  level: GlyphLevel;
  kind: GlyphKind;
  spin: boolean;
  text: string;
}
/** The status line under the volumes: what the refresh is doing, or why it failed. */
const status = computed<Status | null>(() => {
  const n = props.node;
  const r = page.disk.value;
  if (!r) {
    return n.disk?.refreshRequestedAt
      ? { tone: 'info', level: 'info', kind: 'info', spin: false, text: `A refresh was requested ${rel(n.disk.refreshRequestedAt)}. The Agent answers on its next check-in.` }
      : null;
  }
  switch (r.phase) {
    case 'requesting': return { tone: 'info', level: 'info', kind: 'sync', spin: true, text: 'Requesting a refresh…' };
    case 'waiting': return { tone: 'info', level: 'info', kind: 'sync', spin: true, text: 'Refresh requested — the Agent answers on its next check-in.' };
    case 'answered': return { tone: 'good', level: 'good', kind: 'check', spin: false, text: `Disk usage updated ${rel(n.disk?.measuredAt)}.` };
    case 'timeout': return { tone: 'warning', level: 'warning', kind: 'bang', spin: false, text: 'No answer yet. Agents before 0.9.0 do not report disk usage.' };
    default: {
      const warn = r.tone === 'warning';
      return { tone: r.tone || 'critical', level: warn ? 'warning' : 'critical', kind: warn ? 'bang' : 'x', spin: false, text: r.message };
    }
  }
});
</script>

<template>
  <section id="disk-panel" class="panel" aria-labelledby="disk-h">
    <header class="panel-head row">
      <div><h2 id="disk-h">Disk</h2><p>Space on the volume that holds {{ node.alias }}’s files. Git worktrees and caches fill it up.</p></div>
      <div id="disk-tools" class="head-tools">
        <ScopeButton
          v-if="!node.revoked" level="operate" cls="btn-secondary btn-sm" data-act="disk-refresh"
          :disabled="busy || undefined" :aria-busy="busy ? 'true' : undefined" @click="page.refreshDisk()"
        ><Icon name="retry" :class="{ spin: busy }" />{{ busy ? 'Refreshing…' : 'Refresh' }}</ScopeButton>
      </div>
    </header>
    <div id="disk-body">
      <div v-if="!node.disk || !node.disk.volumes.length" class="empty-mini">
        <Icon name="server" /><p>{{ node.revoked ? 'This machine is revoked, so it reports no disk usage.' : 'No disk data yet. An Agent reports its disk usage after its first check-in and every 4 hours. Agents before 0.9.0 do not report it.' }}</p>
      </div>
      <template v-else>
        <ul class="dvols">
          <li v-for="d in volumes" :key="d.v.label" class="dvol" :class="`dvol--${d.lv.key}`" :data-volume="d.v.label">
            <div class="dvol-top"><div class="dvol-name"><b>{{ d.title }}</b><span class="muted small">{{ d.sub }}</span></div><div class="dvol-pct">{{ d.pct }}%</div></div>
            <div class="meter" :class="`m-${d.lv.key}`" role="img" :aria-label="`${d.title}: ${d.pct}% used, ${d.lv.label}`"><span :style="{ width: `${d.width}%` }"></span></div>
            <span class="dvol-state" :class="`t-${d.lv.level}`"><StatusGlyph :level="d.lv.level" :kind="d.lv.kind" /><span>{{ d.lv.label }}</span></span>
            <dl class="dvol-nums">
              <div><dt>Used</dt><dd>{{ bytes(d.v.usedBytes) }}</dd></div>
              <div><dt>Available</dt><dd>{{ bytes(d.v.availableBytes) }}</dd></div>
              <div><dt>Total</dt><dd>{{ bytes(d.v.totalBytes) }}</dd></div>
            </dl>
          </li>
        </ul>
        <p class="disk-measured"><template v-if="node.disk.measuredAt">Measured {{ rel(node.disk.measuredAt) }} · {{ fmtFull(node.disk.measuredAt) }} UTC</template></p>
      </template>
    </div>
    <p id="disk-status" class="disk-status" :class="status?.tone ? `disk-status--${status.tone}` : undefined" role="status">
      <template v-if="status"><Icon v-if="status.spin" name="sync" class="spin" /><StatusGlyph v-else :level="status.level" :kind="status.kind" /><span>{{ status.text }}</span></template>
    </p>
    <LockNote v-if="!node.revoked" level="operate" />
  </section>
</template>
