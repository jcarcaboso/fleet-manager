<script setup lang="ts">
import { useHeadingFocus } from '@/composables/useHeadingFocus';
import type { IconName } from '@/lib/icons';
import Icon from './Icon.vue';
import StatusGlyph from './StatusGlyph.vue';

/** An empty block: icon (or a check glyph when `good`), a heading, text, and an `action` slot. `h="h1"` when it is the page's only heading. */
const props = withDefaults(defineProps<{ icon?: IconName; title: string; text?: string; good?: boolean; h?: 'h1' | 'h2' }>(), { icon: 'search', h: 'h2' });
const heading = useHeadingFocus(() => props.h === 'h1');
</script>

<template>
  <div class="empty" :class="{ 'empty--good': good }">
    <div class="empty-art" :class="{ good }">
      <StatusGlyph v-if="good" level="good" kind="check" />
      <Icon v-else :name="icon" />
    </div>
    <component :is="h" ref="heading" tabindex="-1">{{ title }}</component>
    <p v-if="text">{{ text }}</p>
    <slot />
  </div>
</template>
