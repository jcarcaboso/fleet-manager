<script setup lang="ts">
import { computed } from 'vue';
import { mdParts } from '@/lib/format';

/** Catalog text where `backticks` mark code: rendered as text nodes and `<code>` elements, never as markup. */
const props = defineProps<{ text: string | null | undefined }>();
const parts = computed(() => mdParts(props.text));
</script>

<template>
  <template v-for="(p, i) in parts" :key="i"><code v-if="p.code">{{ p.text }}</code><template v-else>{{ p.text }}</template></template>
</template>
