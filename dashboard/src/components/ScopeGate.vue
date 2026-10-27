<script setup lang="ts">
import { useSession } from '@/context';
import type { Scope } from '@/api/types';

/** Renders the default slot only when the session's scope includes `level`; otherwise the `locked` slot (if any). */
defineProps<{ level: Scope }>();
const session = useSession();
</script>

<template>
  <slot v-if="session.can(level)" />
  <slot v-else name="locked" />
</template>
