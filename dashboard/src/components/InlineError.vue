<script setup lang="ts">
import StatusGlyph from './StatusGlyph.vue';

/** A local load failure inside a page that otherwise works (the old `ui.inlineError`). */
defineProps<{ error?: { message?: string } | null; what: string }>();
</script>

<template>
  <div class="callout callout--critical" role="alert">
    <StatusGlyph level="critical" kind="x" />
    <div><b>Could not load {{ what }}</b><p>{{ error?.message || 'Something went wrong.' }}</p></div>
  </div>
</template>
