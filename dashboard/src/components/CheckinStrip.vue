<script setup lang="ts">
import { computed, ref } from 'vue';
import type { CheckinBucket } from '@/api/types';
import { hideTip, showTip } from '@/composables/tooltip';
import { STRIP, bucketTip, chartLabel, stripBars } from '@/lib/charts';

/**
 * The small check-in strip of a gallery card: one bar per hour, oldest first. Hovering a bar shows its tooltip.
 * Pure SVG with presentation attributes and CSS classes (no style attributes).
 */
const props = defineProps<{ buckets: CheckinBucket[] }>();
const svg = ref<SVGSVGElement | null>(null);
const active = ref<number | null>(null);
const bars = computed(() => stripBars(props.buckets));
const label = computed(() => chartLabel(props.buckets));

function at(e: PointerEvent): void {
  const el = svg.value;
  const n = props.buckets.length;
  if (!el || !n) return;
  const r = el.getBoundingClientRect();
  const i = Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / (r.width || 1)) * n)));
  const pitch = STRIP.W / n;
  active.value = i;
  showTip(bucketTip(props.buckets, i), r.left + ((i * pitch + pitch / 2) / STRIP.W) * r.width, r.top);
}
function leave(): void {
  active.value = null;
  hideTip();
}
</script>

<template>
  <svg ref="svg" class="strip z" :viewBox="`0 0 ${STRIP.W} ${STRIP.H}`" role="img" :aria-label="label" @pointermove="at" @pointerleave="leave">
    <template v-for="b in bars" :key="b.i">
      <path v-if="b.path" class="sb" :class="{ on: active === b.i }" :data-i="b.i" :d="b.path" />
      <rect v-else-if="b.rect" class="sb0" :class="{ on: active === b.i }" :data-i="b.i" v-bind="b.rect" />
    </template>
    <line class="base" x1="0" :x2="STRIP.W" y1="22.5" y2="22.5" />
  </svg>
</template>
