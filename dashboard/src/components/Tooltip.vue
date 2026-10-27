<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { tooltip } from '@/composables/tooltip';

/** The tooltip bubble. Mounted once by `AppShell`; it follows `tooltip` (see `composables/tooltip.ts`). */
const el = ref<HTMLElement | null>(null);
const pos = ref({ left: 0, top: 0 });
watch(() => [tooltip.visible, tooltip.x, tooltip.y, tooltip.head, tooltip.label, tooltip.rows.length], async () => {
  if (!tooltip.visible) return;
  await nextTick();
  const w = el.value?.offsetWidth ?? 0;
  const h = el.value?.offsetHeight ?? 0;
  let top = tooltip.y - h - 10;
  if (top < 8) top = tooltip.y + 22;
  pos.value = { left: Math.max(8, Math.min(window.innerWidth - w - 8, tooltip.x - w / 2)), top };
}, { flush: 'post' });
</script>

<template>
  <div id="tip" ref="el" class="tip" role="tooltip" :hidden="!tooltip.visible" :style="{ left: pos.left + 'px', top: pos.top + 'px' }">
    <b>{{ tooltip.head }}</b><span v-if="tooltip.label">{{ tooltip.label }}</span>
    <span v-for="(r, i) in tooltip.rows" :key="i" class="tip-row">{{ r }}</span>
  </div>
</template>
