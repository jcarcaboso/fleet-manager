<script setup lang="ts">
import { computed } from 'vue';
import { useHeadingFocus } from '@/composables/useHeadingFocus';
import Icon from './Icon.vue';
import StatusGlyph from './StatusGlyph.vue';

/**
 * A whole-page error (the old `ui.errorState`). A 403 reads "Your account cannot open this" and has no retry button;
 * anything else reads "Could not load <what>" with "Try again" (emits `retry`) unless `retry` is false.
 */
const props = withDefaults(defineProps<{ error?: { message?: string; status?: number } | null; what?: string; retry?: boolean }>(), { what: 'this page', retry: true });
const emit = defineEmits<{ retry: [] }>();
const forbidden = computed(() => props.error?.status === 403);
const h1 = useHeadingFocus();
</script>

<template>
  <div class="empty empty--error" role="alert">
    <div class="empty-art"><StatusGlyph :level="forbidden ? 'warning' : 'critical'" :kind="forbidden ? 'bang' : 'x'" /></div>
    <h1 ref="h1" tabindex="-1">{{ forbidden ? 'Your account cannot open this' : `Could not load ${what}` }}</h1>
    <p>{{ error?.message || 'Something went wrong.' }}</p>
    <button v-if="retry && !forbidden" type="button" class="btn btn-secondary" @click="emit('retry')"><Icon name="retry" />Try again</button>
  </div>
</template>
