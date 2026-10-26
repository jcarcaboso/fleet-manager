<script setup lang="ts">
import { num } from '@/lib/format';
import type { StatePart } from '@/lib/targets';
import StatusGlyph from './StatusGlyph.vue';

/** The legend of a `Segbar`. With `clickable`, every state with a value is a button that emits `pick` with its key (a filter). */
defineProps<{ parts: StatePart[]; clickable?: boolean }>();
const emit = defineEmits<{ pick: [key: StatePart['key']] }>();
</script>

<template>
  <ul class="legend">
    <li v-for="p in parts" :key="p.key">
      <button v-if="clickable && p.value" type="button" class="lg-btn" @click="emit('pick', p.key)">
        <StatusGlyph :level="p.level" :kind="p.kind" /><span>{{ p.label }}</span><b>{{ num(p.value) }}</b>
      </button>
      <span v-else class="lg-item"><StatusGlyph :level="p.level" :kind="p.kind" /><span>{{ p.label }}</span><b>{{ num(p.value) }}</b></span>
    </li>
  </ul>
</template>
