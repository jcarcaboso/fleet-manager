<script setup lang="ts">
import { useFleet } from '@/context';
import type { Scope } from '@/api/types';

/**
 * A button for an action that needs a scope (the old `ui.gate`). Allowed: a normal button; every attribute and `click`
 * listener you add goes to it. Not allowed: a focusable, `aria-disabled` button that explains itself on hover and focus
 * and, on click, shows a "Not available" toast with the reason. No request is ever made. `cls` takes the variant classes
 * (`btn-primary`, `btn-secondary btn-sm`, …).
 */
defineOptions({ inheritAttrs: false });
defineProps<{ level: Scope; cls?: string; type?: 'button' | 'submit' }>();
const { session, toasts } = useFleet();
const notAvailable = (level: Scope): void => {
  toasts.push('Not available', { tone: 'warning', text: session.denied(level) });
};
</script>

<template>
  <button v-if="session.can(level)" :type="type ?? 'button'" class="btn" :class="cls" v-bind="$attrs"><slot /></button>
  <button
    v-else
    type="button"
    class="btn is-locked"
    :class="[cls, $attrs.class]"
    aria-disabled="true"
    :data-need="level"
    :data-tip="`Not available|${session.denied(level)}`"
    @click="notAvailable(level)"
  ><slot /></button>
</template>
