<script setup lang="ts">
import { computed } from 'vue';
import { avatarClass, initial } from '@/lib/format';

/** A round initial for an Operator, Agent or machine name. Decorative: the name is always written next to it. */
const props = defineProps<{ name: string | null | undefined }>();
const cls = computed(() => avatarClass(props.name));
const letter = computed(() => initial(props.name));
</script>

<template>
  <span class="av" :class="cls" aria-hidden="true">{{ letter }}</span>
</template>
