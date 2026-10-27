<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import { isTopModal, modalOpenCount, popModal, pushModal } from '@/composables/modalStack';
import type { IconName } from '@/lib/icons';
import Icon from './Icon.vue';

/**
 * A modal dialog. Mount it with `v-if` (or `:open`) where it is used; it teleports into `#modal-root`.
 *
 * - Focus moves into the dialog on open: to `[data-autofocus]`, else the first input, button (not the close button) or link.
 * - Tab and Shift+Tab stay inside the dialog; Escape and a click on the backdrop emit `close`.
 * - On close the focus returns to the element that was focused before it opened (when it is still on the page).
 * - `role="dialog"`, `aria-modal="true"`, labelled by its title. While open, the page behind it does not scroll.
 *
 * The header (icon, title, subtitle, close button) is built from props; the default slot is the body, `footer` the buttons.
 * `persistent` ignores Escape and the backdrop (use it while a request runs). A custom `head` slot receives `titleId`: put it on the
 * heading so `aria-labelledby` finds it.
 */
const props = withDefaults(defineProps<{
  title: string;
  subtitle?: string;
  icon?: IconName;
  tone?: 'info' | 'serious' | 'critical' | 'good' | 'warning';
  wide?: boolean;
  persistent?: boolean;
  /** The default slot is the whole dialog content after the `head` slot, without the padded `.modal-body` wrapper (the Add machine wizard lays itself out). */
  bare?: boolean;
}>(), { tone: 'info' });
const emit = defineEmits<{ close: [] }>();

const titleId = useId();
const dialog = ref<HTMLElement | null>(null);
const returnTo = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
const id = pushModal();
const target = computed(() => (document.getElementById('modal-root') ? '#modal-root' : 'body'));
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]';

const focusables = (): HTMLElement[] => [...(dialog.value?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(el => !el.hidden && el.getAttribute('aria-hidden') !== 'true');
function focusFirst(): void {
  const el = dialog.value?.querySelector<HTMLElement>('[data-autofocus]')
    ?? dialog.value?.querySelector<HTMLElement>('input:not([disabled]), button:not(.icon-btn):not([disabled]), a[href]')
    ?? dialog.value?.querySelector<HTMLElement>('.icon-btn');
  el?.focus();
}
function close(): void {
  if (!props.persistent) emit('close');
}
function onKeydown(e: KeyboardEvent): void {
  if (!isTopModal(id)) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
    return;
  }
  if (e.key !== 'Tab') return;
  const list = focusables();
  if (!list.length) {
    e.preventDefault();
    return;
  }
  const first = list[0] as HTMLElement;
  const last = list[list.length - 1] as HTMLElement;
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !dialog.value?.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !dialog.value?.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}

onMounted(async () => {
  document.body.classList.add('has-modal');
  document.addEventListener('keydown', onKeydown);
  await nextTick();
  focusFirst();
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
  popModal(id);
  if (modalOpenCount.value === 0) document.body.classList.remove('has-modal');
  if (returnTo && document.contains(returnTo)) returnTo.focus();
});
</script>

<template>
  <Teleport :to="target">
    <div class="modal-back" @click="close"></div>
    <div ref="dialog" class="modal" :class="{ 'modal--wide': wide }" role="dialog" aria-modal="true" :aria-labelledby="titleId">
      <slot name="head" :title-id="titleId">
        <div class="modal-head">
          <span v-if="icon" class="modal-ic" :class="`t-${tone}`"><Icon :name="icon" /></span>
          <div><h2 :id="titleId">{{ title }}</h2><p v-if="subtitle">{{ subtitle }}</p></div>
          <button type="button" class="icon-btn" aria-label="Close" @click="close"><Icon name="x" /></button>
        </div>
      </slot>
      <slot v-if="bare" />
      <div v-else class="modal-body"><slot /></div>
      <div v-if="$slots.footer" class="modal-foot"><slot name="footer" /></div>
    </div>
  </Teleport>
</template>
