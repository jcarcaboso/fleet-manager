<script setup lang="ts">
import { useHeadingFocus } from '@/composables/useHeadingFocus';

/** The page title block: `<h1>` (focused after navigation), a subtitle, and an action row in the `actions` slot. */
defineProps<{ title: string; sub?: string }>();
const h1 = useHeadingFocus();
</script>

<template>
  <header class="page-head">
    <div>
      <h1 ref="h1" tabindex="-1">{{ title }}</h1>
      <p v-if="sub">{{ sub }}</p>
    </div>
    <div v-if="$slots.actions" class="btn-row"><slot name="actions" /></div>
  </header>
</template>
