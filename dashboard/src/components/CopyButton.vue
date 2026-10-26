<script setup lang="ts">
import { computed } from 'vue';
import { useClipboard } from '@/composables/useClipboard';
import Icon from './Icon.vue';

/** A copy button for a value (digest, path, command). `label` adds visible text; the button always has an accessible name. */
const props = defineProps<{ text: string; label?: string; ariaLabel?: string }>();
const { status, copy } = useClipboard();
const shown = computed(() => (status.value === 'copied' ? 'Copied' : status.value === 'failed' ? 'Press Ctrl+C' : props.label));
</script>

<template>
  <button type="button" class="copy copy--icon" :class="{ 'is-copied': status === 'copied' }" :data-copy="text" :aria-label="ariaLabel || 'Copy to clipboard'" @click="copy(text)">
    <Icon name="copy" /><span v-if="shown">{{ shown }}</span>
  </button>
</template>
