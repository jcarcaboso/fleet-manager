<script setup lang="ts" generic="P extends { key: string; label: string; level: GlyphLevel; kind?: GlyphKind; value: number }">
import { num } from '@/lib/format';
import type { GlyphKind, GlyphLevel } from '@/lib/status';
import StatusGlyph from './StatusGlyph.vue';

/** The legend of a `Segbar`. With `clickable`, every state with a value is a button that emits `pick` with its key (a filter). */
defineProps<{ parts: P[]; clickable?: boolean }>();
const emit = defineEmits<{ pick: [key: P['key']] }>();
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
