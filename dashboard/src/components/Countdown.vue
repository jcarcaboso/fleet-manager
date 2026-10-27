<script setup lang="ts">
import { computed } from 'vue';
import { useNow } from '@/composables/useNow';
import { countdownText } from '@/lib/format';

/** A live countdown to an ISO time: "in 5 min", "in 40 s", "expired", or `fmt="clock"` for "m:ss". Ticks every second. */
const props = withDefaults(defineProps<{ to: string | null | undefined; fmt?: 'words' | 'clock' }>(), { fmt: 'words' });
const now = useNow();
const text = computed(() => countdownText(props.to, props.fmt, now.value));
</script>

<template>
  <span>{{ text }}</span>
</template>
