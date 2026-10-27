<script setup lang="ts">
/** The loading placeholder (the old `ui.skeleton`): a page skeleton, or `kind="cards"` for the gallery grid. */
withDefaults(defineProps<{ kind?: 'page' | 'cards' }>(), { kind: 'page' });
</script>

<template>
  <div v-if="kind === 'cards'" class="grid" aria-hidden="true">
    <div v-for="n in 6" :key="n" class="card skel-card">
      <div class="skel skel-stage"></div>
      <div class="skel skel-line"></div>
      <div class="skel skel-line skel-short"></div>
    </div>
  </div>
  <div v-else class="wrap" role="status" aria-live="polite">
    <span class="sr">Loading…</span>
    <div aria-hidden="true">
      <div class="skel skel-title"></div>
      <div class="skel skel-line skel-short"></div>
      <div class="skel skel-block"></div>
      <div class="skel skel-block"></div>
    </div>
  </div>
</template>
