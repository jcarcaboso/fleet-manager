<script setup lang="ts">
import { computed } from 'vue';
import { useClipboard } from '@/composables/useClipboard';
import Icon from './Icon.vue';

/**
 * A command block with a copy button (the old `cmdBlock`). Only pass commands built from validated pieces (see `upgradePlan`
 * and the `commands` of an issue): the text is shown and copied exactly as given.
 */
const props = withDefaults(defineProps<{ cmd: string; label?: string }>(), { label: 'Copy' });
const { status, copy } = useClipboard();
const shown = computed(() => (status.value === 'copied' ? 'Copied' : status.value === 'failed' ? 'Press Ctrl+C' : props.label));
</script>

<template>
  <div class="cmd">
    <pre><code>{{ cmd }}</code></pre>
    <button type="button" class="copy" :class="{ 'is-copied': status === 'copied' }" :data-copy="cmd" aria-label="Copy to clipboard" @click="copy(cmd)">
      <Icon name="copy" /><span>{{ shown }}</span>
    </button>
  </div>
</template>
