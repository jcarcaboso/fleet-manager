<script setup lang="ts">
/** A row of toggle buttons that filter a list (`aria-pressed`). Emits `update:modelValue` with the chosen key. Each item is `[key, label, count?]`. */
defineProps<{ modelValue: string; items: ReadonlyArray<readonly [string, string, number?]>; label: string }>();
const emit = defineEmits<{ 'update:modelValue': [key: string] }>();
</script>

<template>
  <div class="chips-filter" role="group" :aria-label="label">
    <button v-for="[k, l, c] in items" :key="k" type="button" :aria-pressed="modelValue === k" @click="emit('update:modelValue', k)">
      {{ l }}<span v-if="c !== undefined">{{ c }}</span>
    </button>
  </div>
</template>
