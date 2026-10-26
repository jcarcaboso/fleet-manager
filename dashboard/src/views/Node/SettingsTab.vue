<script setup lang="ts">
import { ref, watch } from 'vue';
import CopyButton from '@/components/CopyButton.vue';
import Icon from '@/components/Icon.vue';
import LockNote from '@/components/LockNote.vue';
import ScopeButton from '@/components/ScopeButton.vue';
import { useSession } from '@/context';
import { fmtFull, platformLabel, rel } from '@/lib/format';
import type { NodeDetailView } from '@/lib/model';
import { useNodePage } from './nodePage';

/** Settings: rename (admin), the read-only identity, and Remove from Fleet (admin, with the alias typed to confirm). */
const props = defineProps<{ node: NodeDetailView }>();
const page = useNodePage();
const session = useSession();
const draft = ref(props.node.alias);
watch(() => props.node.alias, a => { draft.value = a; });
</script>

<template>
  <div class="cols">
    <section class="panel">
      <header class="panel-head"><h2>Alias</h2><p>The alias is how fleet.yml refers to this machine. It must be unique; revoked aliases stay reserved.</p></header>
      <form class="form" data-form="rename" novalidate @submit.prevent="page.rename(draft)">
        <label for="rename-alias">Alias</label>
        <div class="input-row">
          <input
            id="rename-alias" v-model="draft" name="alias" maxlength="201" autocomplete="off" spellcheck="false" aria-describedby="rename-msg"
            :aria-invalid="page.renameInvalid.value ? 'true' : undefined" :disabled="node.revoked || !session.can('admin')"
          >
          <ScopeButton level="admin" type="submit" cls="btn-primary" :disabled="node.revoked || page.renaming.value || undefined">Save alias</ScopeButton>
        </div>
        <p
          id="rename-msg" class="field-msg" :class="page.renameMsg.value?.err ? 'is-err' : page.renameMsg.value ? 'is-ok' : undefined" role="status"
        >{{ page.renameMsg.value ? page.renameMsg.value.text : node.revoked ? 'Revoked machines cannot be renamed.' : !session.can('admin') ? session.denied('admin') : 'After renaming, update the key under nodes: in fleet.yml too.' }}</p>
      </form>
    </section>
    <section class="panel">
      <header class="panel-head"><h2>Identity</h2><p>Read-only facts Fleet stores for this machine.</p></header>
      <dl class="kv">
        <div><dt>Node ID</dt><dd class="mono">{{ node.id }}<CopyButton :text="node.id" aria-label="Copy Node ID" /></dd></div>
        <div><dt>Platform</dt><dd>{{ platformLabel(node.platform) }}</dd></div>
        <div><dt>Enrolled</dt><dd>{{ fmtFull(node.enrolledAt) }} UTC · {{ rel(node.enrolledAt) }}</dd></div>
      </dl>
    </section>
  </div>
  <section class="panel panel--danger">
    <header class="panel-head"><h2>Remove from Fleet</h2><p>Permanently deletes the server record, credentials, assignments and attempts. The alias becomes available again; audit history stays. Files on the machine are not erased.</p></header>
    <div class="danger-row">
      <div><h3>Remove {{ node.alias }}</h3><p>Afterwards, stop its Agent and remove its fleet.yml entry unless you will enroll a replacement.</p></div>
      <ScopeButton level="admin" cls="btn-danger" data-act="remove-node" @click="page.openDialog('remove')"><Icon name="trash" />Remove…</ScopeButton>
    </div>
    <LockNote level="admin" />
  </section>
</template>
