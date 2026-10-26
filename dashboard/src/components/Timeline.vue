<script setup lang="ts">
import { computed } from 'vue';
import { dayKey, dayLabel, fmtTime } from '@/lib/format';
import type { GlyphKind, GlyphLevel } from '@/lib/status';
import DiagLine from './DiagLine.vue';
import FileList from './FileList.vue';
import Icon from './Icon.vue';
import StatusGlyph from './StatusGlyph.vue';
import StepChip from './StepChip.vue';

/** An event of the Activity timeline. Events must be newest first; they are grouped by UTC day. */
export interface TimelineEvent {
  at: string;
  level: GlyphLevel;
  kind: GlyphKind;
  title: string;
  sub?: string;
  step?: string | null;
  text?: string | null;
  files?: string[];
  /** Keeps expandable parts open across repaints; defaults to the time plus the title. */
  key?: string;
}
const props = defineProps<{ events: TimelineEvent[] }>();
const days = computed(() => {
  const out: Array<{ k: string; label: string; items: TimelineEvent[] }> = [];
  for (const e of props.events) {
    const k = dayKey(e.at);
    let d = out[out.length - 1];
    if (!d || d.k !== k) out.push((d = { k, label: dayLabel(e.at), items: [] }));
    d.items.push(e);
  }
  return out;
});
const keyOf = (e: TimelineEvent): string => e.key || e.at + e.title;
</script>

<template>
  <div v-if="!events.length" class="empty-mini"><Icon name="activity" /><p>Nothing to show here.</p></div>
  <template v-else>
    <div v-for="d in days" :key="d.k" class="tl-day">
      <h3>{{ d.label }}</h3>
      <ol class="tl">
        <li v-for="e in d.items" :key="keyOf(e)" class="tl-item">
          <span class="tl-dot"><StatusGlyph :level="e.level" :kind="e.kind" /></span>
          <div class="tl-card">
            <div class="tl-top"><b>{{ e.title }}</b><time :datetime="e.at">{{ fmtTime(e.at) }}</time></div>
            <p v-if="e.sub || e.step" class="tl-sub"><span v-if="e.sub">{{ e.sub }}</span><StepChip :step="e.step" /></p>
            <DiagLine v-if="e.text" :text="e.text" :open-key="keyOf(e)" cls="tl-text" />
            <FileList v-if="e.files?.length" :files="e.files" :open-key="keyOf(e)" />
          </div>
        </li>
      </ol>
    </div>
  </template>
</template>
