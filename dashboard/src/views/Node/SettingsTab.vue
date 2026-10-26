<script setup lang="ts">
import type { NodeDetailView } from '@/lib/model';

// Placeholder: the Settings tab is ported onto the foundation (see README.md, "Writing a view").
// `node` is the machine on screen (`fromDetail(GET nodes/{node})`), passed down by NodeView.
defineProps<{ node?: NodeDetailView | null }>();
</script>

<template>
  <section class="panel" data-test="not-ported">
    <p class="muted">The Settings tab is not ported yet.</p>
  </section>
</template>
