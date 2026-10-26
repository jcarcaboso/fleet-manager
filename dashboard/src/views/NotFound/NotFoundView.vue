<script setup lang="ts">
import EmptyState from '@/components/EmptyState.vue';
</script>

<template>
  <div class="wrap">
    <EmptyState icon="search" h="h1" title="That page does not exist" text="Check the address, or go back to your machines.">
      <RouterLink class="btn btn-secondary" :to="{ name: 'machines' }">Back to all machines</RouterLink>
    </EmptyState>
  </div>
</template>
