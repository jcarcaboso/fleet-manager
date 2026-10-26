<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import type { IconName } from '@/lib/icons';
import Icon from './Icon.vue';
import Modal from './Modal.vue';

/**
 * A confirmation dialog (revoke, remove, …). Mount it with `v-if`. The default slot is the body (usually a `ticks` list).
 *
 * - `danger` makes the confirm button red (`btn-danger`), otherwise it is primary.
 * - `confirmPhrase` asks the user to type a phrase (a machine alias) and enables the confirm button only on an exact match.
 * - `busy` disables the buttons and ignores Escape while the request runs; `error` shows the failure inside the dialog.
 */
const props = withDefaults(defineProps<{
  title: string;
  subtitle?: string;
  icon?: IconName;
  tone?: 'info' | 'serious' | 'critical';
  confirmLabel: string;
  confirmIcon?: IconName;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  confirmPhrase?: string;
}>(), { tone: 'serious', cancelLabel: 'Cancel' });
const emit = defineEmits<{ confirm: []; close: [] }>();

const typed = ref('');
const inputId = useId();
const msgId = useId();
watch(() => props.confirmPhrase, () => { typed.value = ''; });
const matches = computed(() => !props.confirmPhrase || typed.value === props.confirmPhrase);
const hint = computed(() => {
  const phrase = props.confirmPhrase ?? '';
  const v = typed.value;
  if (matches.value) return { text: 'Alias matches. This will permanently remove the machine.', cls: 'is-ok' };
  if (v && phrase.startsWith(v)) return { text: 'Keep typing…', cls: '' };
  if (v) return { text: 'That does not match the alias.', cls: 'is-err' };
  return { text: 'The alias must match exactly, including case.', cls: '' };
});
function confirm(): void {
  if (matches.value && !props.busy) emit('confirm');
}
</script>

<template>
  <Modal :title="title" :subtitle="subtitle" :icon="icon" :tone="tone" :persistent="busy" @close="emit('close')">
    <slot />
    <template v-if="confirmPhrase">
      <label class="confirm-label" :for="inputId">Type <b class="mono">{{ confirmPhrase }}</b> to confirm</label>
      <input :id="inputId" v-model="typed" class="input" autocomplete="off" spellcheck="false" data-autofocus :aria-describedby="msgId" @keydown.enter.prevent="confirm">
      <p :id="msgId" class="field-msg" :class="error ? 'is-err' : hint.cls" role="status">{{ error || hint.text }}</p>
    </template>
    <p v-else-if="error" class="field-msg is-err" role="alert">{{ error }}</p>
    <template #footer>
      <button type="button" class="btn btn-secondary" :disabled="busy" :data-autofocus="confirmPhrase ? undefined : ''" @click="emit('close')">{{ cancelLabel }}</button>
      <button type="button" class="btn" :class="danger ? 'btn-danger' : 'btn-primary'" :disabled="busy || !matches" @click="confirm"><Icon v-if="confirmIcon" :name="confirmIcon" />{{ confirmLabel }}</button>
    </template>
  </Modal>
</template>
