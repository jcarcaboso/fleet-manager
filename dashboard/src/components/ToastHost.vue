<script setup lang="ts">
import { useToasts } from '@/context';
import Icon from './Icon.vue';
import StatusGlyph from './StatusGlyph.vue';

/** The toast area (`role="status"`, polite). Mounted once by `AppShell`; views push toasts through `useToasts()`. */
const toasts = useToasts();
const kind = { good: 'check', info: 'info', critical: 'x', warning: 'bang' } as const;
</script>

<template>
  <div id="toasts" class="toasts" role="status" aria-live="polite">
    <div v-for="t in toasts.items" :key="t.id" class="toast" :class="[`toast--${t.tone}`, { out: t.out }]" :role="t.tone === 'critical' ? 'alert' : 'status'">
      <StatusGlyph :level="t.tone" :kind="kind[t.tone]" />
      <div class="toast-main"><b>{{ t.title }}</b><span v-if="t.text">{{ t.text }}</span></div>
      <button type="button" class="icon-btn" aria-label="Dismiss" @click="toasts.dismiss(t.id)"><Icon name="x" /></button>
    </div>
  </div>
</template>
