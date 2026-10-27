<script setup lang="ts">
import { computed } from 'vue';
import { useNow } from '@/composables/useNow';
import { ms } from '@/lib/format';

/** The shrinking meter of a countdown (`wz-meter` span): its width is the share of `totalMs` left until `to`. Set through the DOM, not a style attribute. */
const props = defineProps<{ to: string | null | undefined; totalMs: number }>();
const now = useNow();
const pct = computed(() => Math.max(0, Math.min(100, (((ms(props.to) ?? 0) - now.value) / props.totalMs) * 100)));
</script>

<template>
  <span :style="{ width: pct.toFixed(2) + '%' }"></span>
</template>
