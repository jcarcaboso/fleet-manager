<script setup lang="ts">
import { useSession } from '@/context';
import type { Scope } from '@/api/types';
import Icon from './Icon.vue';

/** "Needs the admin scope. Your account has read access." Shown under controls the session may not use; renders nothing when allowed. */
defineProps<{ level: Scope }>();
const session = useSession();
</script>

<template>
  <p v-if="!session.can(level)" class="lock-note"><Icon name="lock" /><span>{{ session.denied(level) }}</span></p>
</template>
