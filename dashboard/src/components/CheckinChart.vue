<script setup lang="ts">
import { computed, ref } from 'vue';
import type { CheckinBucket } from '@/api/types';
import { hideTip, showTip } from '@/composables/tooltip';
import { CH, bucketTip, chartLabel, chartModel, chartSlot, chartX, chartY } from '@/lib/charts';

/**
 * The full check-in chart of the machine page. Hover or the arrow keys (Left, Right, Home, End) read each hour; the chart is
 * focusable and its accessible name states the total and the gaps. Pure SVG, no style attributes.
 */
const props = defineProps<{ buckets: CheckinBucket[] }>();
const svg = ref<SVGSVGElement | null>(null);
const cur = ref<number | null>(null);
const model = computed(() => chartModel(props.buckets));
const label = computed(() => chartLabel(props.buckets) + ' Use the arrow keys to read each hour.');
const cx = computed(() => (cur.value === null ? 0 : chartX(cur.value, props.buckets.length)));

function select(i: number): void {
  const n = props.buckets.length;
  if (!n) return;
  i = Math.max(0, Math.min(n - 1, i));
  cur.value = i;
  const r = svg.value?.getBoundingClientRect();
  if (!r) return;
  const top = chartY(props.buckets[i]!.polls, model.value.max);
  showTip(bucketTip(props.buckets, i), r.left + (chartX(i, n) / CH.W) * r.width, r.top + (top / CH.H) * r.height);
}
function move(e: PointerEvent): void {
  const r = svg.value?.getBoundingClientRect();
  if (!r || !props.buckets.length) return;
  select(Math.floor((((e.clientX - r.left) / (r.width || 1)) * CH.W - CH.L) / chartSlot(props.buckets.length)));
}
function off(): void {
  cur.value = null;
  hideTip();
}
function key(e: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) || !props.buckets.length) return;
  e.preventDefault();
  const last = props.buckets.length - 1;
  const i = e.key === 'Home' ? 0 : e.key === 'End' ? last : (cur.value ?? last) + (e.key === 'ArrowLeft' ? -1 : 1);
  select(i);
}
function focus(): void {
  if (props.buckets.length) select(cur.value ?? props.buckets.length - 1);
}
</script>

<template>
  <svg
    ref="svg" class="chart" :viewBox="`0 0 ${CH.W} ${CH.H}`" tabindex="0" role="img" :aria-label="label"
    @pointermove="move" @pointerleave="off" @keydown="key" @focus="focus" @blur="off"
  >
    <template v-for="g in model.grid" :key="g.y">
      <line :class="g.axis ? 'axis' : 'gl'" :x1="CH.L" :x2="CH.W - CH.R" :y1="g.y" :y2="g.y" />
      <text class="tick" :x="CH.L - 8" :y="g.y + 3.5" text-anchor="end">{{ g.label }}</text>
    </template>
    <text v-for="t in model.ticks" :key="t.x" class="tick" :x="t.x" :y="CH.B + 20" text-anchor="middle">{{ t.text }}</text>
    <text class="tick" :x="CH.W - CH.R" :y="CH.B + 20" text-anchor="end">Now</text>
    <template v-for="b in model.bars" :key="b.i">
      <path v-if="b.path" class="cb" :class="{ on: cur === b.i }" :data-i="b.i" :d="b.path" />
      <rect v-else-if="b.rect" class="cb0" :class="{ on: cur === b.i }" :data-i="b.i" v-bind="b.rect" />
    </template>
    <line class="xh" :x1="cx" :x2="cx" :y1="CH.T" :y2="CH.B" :visibility="cur === null ? 'hidden' : 'visible'" />
    <rect class="hit" :x="CH.L" :y="CH.T" :width="CH.W - CH.L - CH.R" :height="CH.B - CH.T" />
  </svg>
</template>
