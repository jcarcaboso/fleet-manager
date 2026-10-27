<script setup lang="ts">
import { computed } from 'vue';
import type { CheckinBucket } from '@/api/types';
import { gapLines } from '@/lib/charts';
import StatusGlyph from './StatusGlyph.vue';

/** The sentences under the chart that name each gap of two hours or more without a check-in. */
const props = defineProps<{ buckets: CheckinBucket[]; revoked?: boolean }>();
const lines = computed(() => gapLines(props.buckets, { revoked: props.revoked }));
</script>

<template>
  <template v-if="buckets.length">
    <p v-if="!lines.length" class="gaps-none">No gaps longer than an hour.</p>
    <ul v-else class="gaps">
      <li v-for="(g, i) in lines" :key="i"><StatusGlyph :level="g.open ? 'serious' : 'pending'" :kind="g.open ? 'moon' : 'clock'" /><span>{{ g.text }}</span></li>
    </ul>
  </template>
</template>
