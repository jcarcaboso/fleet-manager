<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import PageHead from '@/components/PageHead.vue';

// Placeholder: the revision page is ported onto the foundation (see README.md, "Writing a view").
const route = useRoute();
const id = computed(() => String(route.params.revisionId));
</script>

<template>
  <div class="wrap">
    <PageHead title="Revision" :sub="id" />
    <p class="muted" data-test="not-ported">The revision page is not ported yet.</p>
  </div>
</template>
