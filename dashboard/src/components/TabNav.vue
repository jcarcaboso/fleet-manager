<script setup lang="ts">
import { inject, nextTick, ref, watch } from 'vue';
import type { RouteLocationRaw } from 'vue-router';
import { FLEET_KEY } from '@/context';

/**
 * Link tabs (`<nav class="tabs">`), one route per tab. `current` marks the active one with `aria-current="page"`.
 * `count` adds a badge with the tone from `tone` (`critical`, `warning`, … as in `t-<tone>`).
 */
export interface TabItem {
  key: string;
  label: string;
  to: RouteLocationRaw;
  count?: number;
  tone?: string;
}
const props = defineProps<{ items: TabItem[]; current: string; label: string }>();
const nav = ref<HTMLElement | null>(null);
const ctx = inject(FLEET_KEY, null);
/* Switching tabs on the same page keeps this component, so no heading mounts: the active tab takes the focus the navigation asked for. */
watch(() => props.current, async () => {
  await nextTick();
  if (!ctx?.shell.focusPending) return;
  ctx.shell.focusPending = false;
  nav.value?.querySelector<HTMLElement>('a[aria-current]')?.focus({ preventScroll: true });
});
</script>

<template>
  <nav ref="nav" class="tabs" :aria-label="label">
    <RouterLink v-for="item in items" :key="item.key" v-slot="{ href, navigate }" :to="item.to" custom>
      <a :href="href" :aria-current="item.key === current ? 'page' : undefined" @click="navigate">{{ item.label }}<span v-if="item.count" class="tab-cnt" :class="`t-${item.tone ?? 'neutral'}`">{{ item.count }}</span></a>
    </RouterLink>
  </nav>
</template>
