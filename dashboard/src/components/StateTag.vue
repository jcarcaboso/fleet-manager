<script setup lang="ts">
import { computed } from 'vue';
import { tstate } from '@/lib/targets';
import StatusGlyph from './StatusGlyph.vue';

/** An Assignment or Attempt state (`succeeded`, `failed`, …) as glyph plus word. */
const props = defineProps<{ state: string }>();
const meta = computed(() => tstate(props.state));
</script>

<template>
  <span class="stag">
    <StatusGlyph :level="meta.level" :kind="meta.kind" />
    <span>{{ meta.label }}</span>
  </span>
</template>
