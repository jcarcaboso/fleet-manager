<script setup lang="ts">
import type { GlyphKind, GlyphLevel } from '@/lib/status';
import StatusGlyph from './StatusGlyph.vue';

/** A status chip: glyph plus label, always both. */
defineProps<{ level: GlyphLevel; kind?: GlyphKind; label: string }>();
</script>

<template>
  <span class="pill" :class="`t-${level}`">
    <StatusGlyph :level="level" :kind="kind" />
    <span>{{ label }}</span>
  </span>
</template>
