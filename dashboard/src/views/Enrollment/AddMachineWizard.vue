<script setup lang="ts">
import Modal from '@/components/Modal.vue';

// Placeholder: the Add machine wizard is ported onto the foundation (see README.md, "Writing a view").
// AppShell mounts it while `useFleet().wizard.open` is true; any page opens it with `wizard.show()`.
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <Modal title="Add a machine" icon="plus" @close="emit('close')">
    <p class="muted" data-test="not-ported">The Add machine wizard is not ported yet.</p>
    <template #footer><button type="button" class="btn btn-secondary" @click="emit('close')">Close</button></template>
  </Modal>
</template>
