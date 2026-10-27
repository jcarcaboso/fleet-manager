<script setup lang="ts">
import { computed } from 'vue';
import { num, plural } from '@/lib/format';
import type { RevisionDetailView } from '@/lib/model';

/** Skills added (+), changed (~) and removed (−) as chips, and the Target counts. The sign is part of the chip, so colour is never the only signal. */
const props = defineProps<{ detail: Pick<RevisionDetailView, 'skills' | 'targets'> }>();
const chips = computed(() => [
  ...props.detail.skills.added.map(name => ({ cls: 'add', sign: '+', label: 'added', name })),
  ...props.detail.skills.changed.map(name => ({ cls: 'mod', sign: '~', label: 'changed', name })),
  ...props.detail.skills.removed.map(name => ({ cls: 'rm', sign: '−', label: 'removed', name })),
]);
const any = computed(() => props.detail.targets.added + props.detail.targets.changed + props.detail.targets.removed > 0);
</script>

<template>
  <div class="changes-block">
    <div v-if="chips.length" class="changes">
      <span v-for="(c, i) in chips" :key="i" class="chg" :class="`chg--${c.cls}`"><span class="chg-s" :aria-label="c.label">{{ c.sign }}</span>{{ c.name }}</span>
    </div>
    <p v-else class="muted small">No Skill changes.</p>
    <p class="chg-targets small">
      <template v-if="any"><span class="muted">Targets:</span> <b>{{ num(detail.targets.added) }}</b> added · <b>{{ num(detail.targets.changed) }}</b> changed · <b>{{ num(detail.targets.removed) }}</b> removed, on {{ plural(detail.targets.nodes, 'machine') }}</template>
      <span v-else class="muted">No Target changes.</span>
    </p>
  </div>
</template>
