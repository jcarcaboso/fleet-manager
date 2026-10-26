<script setup lang="ts">
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import CopyBox from '@/components/CopyBox.vue';
import StatusGlyph from '@/components/StatusGlyph.vue';
import { useNodePage } from './nodePage';

/** The Revoke and Remove confirmations. They belong to the page: leaving the machine closes them, and a late answer cannot touch another dialog. */
const page = useNodePage();
/** Shown for copying; a fixed string, nothing from the Server goes into it. */
const STOP_CMD = 'brew services stop jcarcaboso/fleet/fleet-agent';
</script>

<template>
  <ConfirmDialog
    v-if="page.dialog.value?.kind === 'revoke'" :title="`Revoke access for ${page.dialog.value.alias}?`"
    subtitle="Its certificates stop working immediately and the Agent can no longer poll." icon="ban" tone="serious"
    confirm-label="Revoke access" confirm-icon="ban" danger :busy="page.dialog.value.busy"
    @confirm="page.confirmRevoke()" @close="page.closeDialog()"
  >
    <ul class="ticks">
      <li><StatusGlyph level="good" /><span>The machine record, its history and its alias stay. The alias remains reserved.</span></li>
      <li><StatusGlyph level="good" /><span>Nothing is deleted on the machine.</span></li>
      <li><StatusGlyph level="warning" kind="bang" /><span>{{ page.dialog.value.alias }} moves to Retired. To use the alias again you would remove it and enroll it again.</span></li>
    </ul>
    <p class="kv-label">Then stop the Agent on {{ page.dialog.value.alias }}</p>
    <CopyBox :cmd="STOP_CMD" />
    <p class="muted small">Installed it as a user service instead? Run <code>fleet-agent service stop</code>.</p>
    <!-- Always present, so a screen reader hears the error when it appears (and the dialog keeps the height of the old one). -->
    <p id="modal-msg" class="field-msg" :class="{ 'is-err': page.dialog.value.error }" role="alert">{{ page.dialog.value.error }}</p>
  </ConfirmDialog>
  <ConfirmDialog
    v-else-if="page.dialog.value?.kind === 'remove'" :title="`Remove ${page.dialog.value.alias} permanently?`"
    subtitle="This deletes its server record, credentials, assignments and attempts. It cannot be undone." icon="trash" tone="critical"
    confirm-label="Remove machine" confirm-icon="trash" danger :confirm-phrase="page.dialog.value.alias" :busy="page.dialog.value.busy" :error="page.dialog.value.error"
    @confirm="page.confirmRemove()" @close="page.closeDialog()"
  >
    <ul class="ticks">
      <li><StatusGlyph level="good" /><span>Audit history and shared release data remain.</span></li>
      <li><StatusGlyph level="good" /><span>The alias <b>{{ page.dialog.value.alias }}</b> becomes available for a new enrollment.</span></li>
      <li><StatusGlyph level="warning" kind="bang" /><span>Files on the machine are not erased. Stop its Agent and remove its fleet.yml entry unless you will enroll a replacement.</span></li>
    </ul>
  </ConfirmDialog>
</template>
