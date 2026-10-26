<script setup lang="ts">
import { computed } from 'vue';
import CopyBox from './CopyBox.vue';
import MdText from './MdText.vue';

/** A numbered list of steps. A step is `{ t, cmd?, or? }`; `or` marks an alternative to the step before it ("or"). `t` may contain `code` spans. */
export interface Step {
  t: string;
  cmd?: string;
  or?: boolean;
}
const props = defineProps<{ steps: Step[] }>();
const numbered = computed(() => {
  let k = 0;
  return props.steps.map(s => ({ ...s, n: s.or ? 'or' : String(++k) }));
});
</script>

<template>
  <ol class="steps">
    <li v-for="(s, i) in numbered" :key="i" :class="{ 'is-or': s.or }">
      <span class="sn" aria-hidden="true">{{ s.n }}</span>
      <div class="sbody">
        <p><MdText :text="s.t" /></p>
        <CopyBox v-if="s.cmd" :cmd="s.cmd" />
      </div>
    </li>
  </ol>
</template>
