<script setup lang="ts">
import { stepLabel } from '@/lib/targets';

/** The Agent's step in a failed Attempt ("Step: Verifying"). An unknown step from a newer Agent is shown as written. */
defineProps<{ step: string | null | undefined }>();
</script>

<template>
  <span v-if="step" class="stepchip" :data-step="step"><span class="stepchip-k">Step</span>{{ stepLabel(step) }}</span>
</template>
