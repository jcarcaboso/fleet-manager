<script setup lang="ts">
import { shortSha } from '@/lib/format';
import Icon from './Icon.vue';

/** A revision chip with the short SHA; the full SHA is the tooltip. Without a SHA it reads "Nothing yet". */
defineProps<{ sha?: string | null; tip?: string }>();
</script>

<template>
  <span v-if="sha" class="rev" :data-tip="tip"><Icon name="commit" />{{ shortSha(sha) }}</span>
  <span v-else class="muted">Nothing yet</span>
</template>
