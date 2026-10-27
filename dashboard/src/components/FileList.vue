<script setup lang="ts">
import { computed } from 'vue';
import { useFleet } from '@/context';
import { plural } from '@/lib/format';
import Icon from './Icon.vue';

/** A collapsed list of file paths (drift events). Paths come from the Agent and are shown as text only. */
const props = defineProps<{ files: string[]; openKey: string }>();
const { openState } = useFleet();
const key = computed(() => 'files:' + props.openKey);
function onToggle(e: Event): void {
  openState.set(key.value, (e.target as HTMLDetailsElement).open);
}
</script>

<template>
  <details class="tl-files" :data-open-key="key" :open="openState.get(key) === true" @toggle="onToggle">
    <summary><Icon name="file" /><span>{{ plural(files.length, 'file') }}</span><Icon name="chevD" class="sumchev" /></summary>
    <ul class="tl-filelist"><li v-for="f in files" :key="f"><code>{{ f }}</code></li></ul>
  </details>
</template>
