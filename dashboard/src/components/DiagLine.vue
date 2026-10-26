<script setup lang="ts">
import { computed } from 'vue';
import { useFleet } from '@/context';
import Icon from './Icon.vue';

/**
 * One line of diagnostic. Short single-line text is plain; anything else is a `<details>` that opens to the full text
 * (the closed state is cut to one line by CSS). `openKey` keeps it open across repaints.
 */
const props = defineProps<{ text: string | null | undefined; openKey: string; cls?: string }>();
const { openState } = useFleet();
const key = computed(() => 'diag:' + props.openKey);
const short = computed(() => !!props.text && props.text.length <= 90 && !props.text.includes('\n'));
function onToggle(e: Event): void {
  openState.set(key.value, (e.target as HTMLDetailsElement).open);
}
</script>

<template>
  <template v-if="text">
    <p v-if="short" class="diag-line diag-line--short" :class="cls">{{ text }}</p>
    <details v-else class="diag-line" :class="cls" :data-open-key="key" :open="openState.get(key) === true" @toggle="onToggle">
      <summary><span class="diag-text">{{ text }}</span><Icon name="chevD" class="sumchev" /></summary>
    </details>
  </template>
</template>
