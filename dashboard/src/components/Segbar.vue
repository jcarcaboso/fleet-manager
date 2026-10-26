<script setup lang="ts">
import { computed } from 'vue';
import type { StatePart } from '@/lib/targets';

/**
 * A segmented bar of Assignment states. `parts` come from `stateParts(counts)`. Segment widths are `flex-grow` values set
 * through the DOM (never a style attribute), so the Content-Security-Policy allows them.
 */
const props = defineProps<{ parts: StatePart[]; label: string; size?: 'sm' | 'lg' }>();
const shown = computed(() => props.parts.filter(p => p.value > 0));
const aria = computed(() => `${props.label}: ${shown.value.length ? shown.value.map(p => `${p.value} ${p.label}`).join(', ') : 'none'}`);
const tip = (p: StatePart): string => `${p.value} ${p.unit || ''}|${p.label}`;
</script>

<template>
  <div class="segbar" :class="size ? `segbar--${size}` : ''" role="img" :aria-label="aria">
    <span v-for="p in shown" :key="p.key" class="seg" :class="`s-${p.level}`" :style="{ flexGrow: p.value }" :data-tip="tip(p)"></span>
  </div>
</template>
