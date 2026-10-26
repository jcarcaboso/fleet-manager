<script setup lang="ts">
import { computed } from 'vue';
import { ICON_SHAPES, type IconName } from '@/lib/icons';

/** One icon of the set in `lib/icons.ts`. Decorative (`aria-hidden`): the label next to it carries the meaning. Pass `class` to add classes. */
const props = defineProps<{ name: IconName }>();
const shapes = computed(() => ICON_SHAPES[props.name] ?? []);
</script>

<template>
  <svg class="ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <component :is="s.tag" v-for="(s, i) in shapes" :key="i" v-bind="s.attrs" />
  </svg>
</template>
