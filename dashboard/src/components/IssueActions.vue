<script setup lang="ts">
import { computed } from 'vue';
import { useSession } from '@/context';
import type { Issue } from '@/api/types';
import { SNOOZE, issueState } from '@/lib/model';
import Icon from './Icon.vue';
import ScopeButton from './ScopeButton.vue';

/**
 * Acknowledge and Snooze for an open problem, Reopen for the others. Without the `operate` scope they are locked buttons that
 * explain why. Emits `state` with `{ op, hours? }` and does not call the API itself; `busy` disables them while the request runs.
 */
const props = defineProps<{ issue: Issue; busy?: boolean }>();
const emit = defineEmits<{ state: [change: { id: string; op: 'acknowledge' | 'snooze' | 'reopen'; hours?: number }] }>();
const session = useSession();
const key = computed(() => issueState(props.issue).key);
</script>

<template>
  <template v-if="!session.can('operate')">
    <template v-if="key === 'open'">
      <ScopeButton level="operate" cls="btn-sm btn-secondary"><Icon name="ack" />Acknowledge</ScopeButton>
      <ScopeButton level="operate" cls="btn-sm btn-secondary"><Icon name="snooze" />Snooze</ScopeButton>
    </template>
    <ScopeButton v-else level="operate" cls="btn-sm btn-secondary"><Icon name="retry" />Reopen</ScopeButton>
  </template>
  <button v-else-if="key !== 'open'" type="button" class="btn btn-sm btn-secondary" data-op="reopen" :disabled="busy" @click="emit('state', { id: issue.id, op: 'reopen' })"><Icon name="retry" />Reopen</button>
  <template v-else>
    <button type="button" class="btn btn-sm btn-secondary" data-op="acknowledge" :disabled="busy" @click="emit('state', { id: issue.id, op: 'acknowledge' })"><Icon name="ack" />Acknowledge</button>
    <span class="snooze" role="group" aria-label="Snooze this problem">
      <span class="snooze-l"><Icon name="snooze" />Snooze</span>
      <button v-for="[h, label, long] in SNOOZE" :key="h" type="button" class="btn btn-sm btn-ghost" data-op="snooze" :data-hours="h" :aria-label="`Snooze for ${long}`" :disabled="busy" @click="emit('state', { id: issue.id, op: 'snooze', hours: h })">{{ label }}</button>
    </span>
  </template>
</template>
