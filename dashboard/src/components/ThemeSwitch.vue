<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import type { IconName } from '@/lib/icons';
import { setTheme, theme, type ThemePreference } from '@/theme';

/**
 * Picks the colour theme: Dark (the default), Light, or System (follows the operating system). A group of toggle buttons in the
 * style of the other segmented controls; `compact` shows the icons only, each button keeps its name for assistive technology.
 */
withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });

const OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string; icon: IconName }> = [
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'system', label: 'System', icon: 'monitor' },
];
</script>

<template>
  <div class="theme-switch" :class="{ 'theme-switch--compact': compact }" role="group" aria-label="Theme">
    <button
      v-for="o in OPTIONS"
      :key="o.value"
      type="button"
      :data-theme-option="o.value"
      :aria-pressed="theme.preference === o.value"
      :aria-label="compact ? `${o.label} theme` : undefined"
      :title="compact ? `${o.label} theme` : undefined"
      @click="setTheme(o.value)"
    >
      <Icon :name="o.icon" /><span v-if="!compact">{{ o.label }}</span>
    </button>
  </div>
</template>
