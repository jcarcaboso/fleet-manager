<script setup lang="ts">
import { computed } from 'vue';
import type { Issue } from '@/api/types';
import { fmtFull, rel, until } from '@/lib/format';
import { issueState } from '@/lib/model';
import Icon from './Icon.vue';

/** The line under a problem that is acknowledged or snoozed: who did it, and until when. Nothing for an open problem. */
const props = defineProps<{ issue: Issue }>();
const st = computed(() => issueState(props.issue));
const when = computed(() => (st.value.at ? `, ${rel(st.value.at)}` : ''));
</script>

<template>
  <p v-if="st.key === 'snoozed'" class="prob-state prob-state--snoozed">
    <Icon name="snooze" />
    <span>Snoozed<template v-if="st.by"> by <b>{{ st.by }}</b></template>{{ when }}. Back in Open <template v-if="st.until">at <b>{{ fmtFull(st.until) }} UTC</b> ({{ until(st.until) }})</template><template v-else>later</template>. It stays listed here until then.</span>
  </p>
  <p v-else-if="st.key === 'acknowledged'" class="prob-state prob-state--ack">
    <Icon name="ack" />
    <span>Acknowledged<template v-if="st.by"> by <b>{{ st.by }}</b></template>{{ when }}. It stays listed here and comes back to Open if it starts over.</span>
  </p>
</template>
