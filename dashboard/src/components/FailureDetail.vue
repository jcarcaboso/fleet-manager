<script setup lang="ts">
import { computed } from 'vue';
import { NO_DETAIL, failPath, hasDetail } from '@/lib/targets';
import CopyButton from './CopyButton.vue';
import StepChip from './StepChip.vue';

/**
 * Phase 2 attempt detail: the step, the failing path and the Agent's diagnostic. `src` is `{ diagnostic, path, step }`
 * (an Attempt, an issue); `target` is the Target when known (its base turns `.claude/settings.json` into `~/.claude/settings.json`).
 * Every string from the Server is rendered as text; the diagnostic keeps its line breaks.
 */
const props = defineProps<{
  src: { diagnostic?: string | null; path?: string | null; step?: string | null } | null | undefined;
  target?: { base?: string; path?: string | null } | null;
}>();
const path = computed(() => (props.src?.path ? failPath(props.target, props.src.path) : ''));
const detail = computed(() => hasDetail(props.src));
</script>

<template>
  <p v-if="!detail" class="fdetail-none">{{ NO_DETAIL }}</p>
  <div v-else class="fdetail">
    <div v-if="src?.step || path" class="fdetail-meta">
      <StepChip :step="src?.step" />
      <span v-if="path" class="fdetail-path"><span class="fdetail-k">Failing path</span><code>{{ path }}</code><CopyButton :text="path" aria-label="Copy failing path" /></span>
    </div>
    <div v-if="src?.diagnostic" class="fdetail-diag">
      <p class="kv-label">Diagnostic from the Agent</p>
      <pre class="code code--diag">{{ src.diagnostic }}</pre>
      <CopyButton :text="src.diagnostic" label="Copy" aria-label="Copy diagnostic" />
    </div>
  </div>
</template>
