<script setup lang="ts">
import { computed } from 'vue';
import type { GlyphKind, GlyphLevel } from '@/lib/status';

/**
 * A segmented bar of Assignment states. `parts` come from `stateParts(counts)`. Segment widths are `flex-grow` values set
 * through the DOM (never a style attribute), so the Content-Security-Policy allows them.
 */
export interface SegPart {
  key: string;
  label: string;
  level: GlyphLevel;
  kind?: GlyphKind;
  value: number;
  unit?: string;
  /** Extra tooltip row (for example the names behind the segment). */
  tip?: string;
}
const props = defineProps<{ parts: SegPart[]; label: string; size?: 'sm' | 'lg' }>();
const shown = computed(() => props.parts.filter(p => p.value > 0));
const aria = computed(() => `${props.label}: ${shown.value.length ? shown.value.map(p => `${p.value} ${p.label}`).join(', ') : 'none'}`);
const tip = (p: SegPart): string => `${p.value} ${p.unit || ''}|${p.label}${p.tip ? '\n' + p.tip : ''}`;
</script>

<template>
  <div class="segbar" :class="size ? `segbar--${size}` : ''" role="img" :aria-label="aria">
    <span v-for="p in shown" :key="p.key" class="seg" :class="`s-${p.level}`" :style="{ flexGrow: p.value }" :data-tip="tip(p)"></span>
  </div>
</template>
