<script setup lang="ts">
import { computed } from 'vue';
import { glyphSpec, type GlyphKind, type GlyphLevel } from '@/lib/status';

/**
 * A status glyph: a filled shape carries the colour, the inner mark carries the meaning, so colour is never the only signal.
 * Always show it next to a word (`StatusPill`, `StateTag`).
 */
const props = defineProps<{ level: GlyphLevel; kind?: GlyphKind }>();
const spec = computed(() => glyphSpec(props.level, props.kind));
</script>

<template>
  <svg class="g" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path v-if="spec.shape === 'triangle'" d="M8 1.3l7 12.6a1.2 1.2 0 0 1-1.05 1.8H2.05A1.2 1.2 0 0 1 1 13.9z" :fill="spec.color" />
    <circle v-else-if="spec.shape === 'ring'" cx="8" cy="8" r="6.6" fill="#fff" stroke="#a9a397" stroke-width="1.5" />
    <circle v-else cx="8" cy="8" r="7.5" :fill="spec.color" />
    <g v-if="spec.kind === 'ban'" fill="none" :stroke="spec.fg" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <path :d="spec.mark" />
      <circle cx="8" cy="8" r="3.8" />
    </g>
    <g v-else-if="spec.markFilled" fill="none" :stroke="spec.fg" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <path :d="spec.mark" :fill="spec.fg" stroke="none" />
    </g>
    <g v-else fill="none" :stroke="spec.fg" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <path :d="spec.mark" />
    </g>
  </svg>
</template>
