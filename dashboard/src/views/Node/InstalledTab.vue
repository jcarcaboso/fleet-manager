<script setup lang="ts">
import { computed } from 'vue';
import CopyButton from '@/components/CopyButton.vue';
import Icon from '@/components/Icon.vue';
import StateTag from '@/components/StateTag.vue';
import { digestShort, hostOf, initial, shortSha } from '@/lib/format';
import type { NodeDetailView } from '@/lib/model';
import { clientName, targetClient, targetKind, targetWhere } from '@/lib/targets';

/** Installed: the Skills, the agent files and the AI client connections that Fleet manages on this machine. */
const props = defineProps<{ node: NodeDetailView }>();
const skillsTarget = computed(() => props.node.targets.find(t => targetKind(t.name) === 'skills'));
const files = computed(() => props.node.targets.filter(t => targetKind(t.name) === 'agent-file'));
const clients = computed(() => props.node.targets.filter(t => targetKind(t.name) === 'ai-client'));
const other = computed(() => props.node.targets.filter(t => !['skills', 'agent-file', 'ai-client'].includes(targetKind(t.name)) && t !== skillsTarget.value));
const skills = computed(() => skillsTarget.value?.skills ?? []);
const monoClass = (c: string | null): string => `m-${c && ['claude', 'codex', 'opencode'].includes(c) ? c : 'other'}`;
const connection = (mode: string): string => (mode === 'cliproxy' ? 'CLIProxy' : mode === 'native' ? 'Native login' : mode);
</script>

<template>
  <section class="panel">
    <header class="panel-head row">
      <div>
        <h2>Skills <span class="cnt">{{ skills.length }}</span></h2>
        <p v-if="skillsTarget"><span class="mono">{{ targetWhere(skillsTarget) }}</span> · in manifest order</p>
        <p v-else>No Skills Target is assigned to this machine.</p>
      </div>
      <StateTag v-if="skillsTarget" :state="skillsTarget.state" />
    </header>
    <div v-if="skills.length" class="tbl-wrap">
      <table class="tbl">
        <thead><tr><th>Skill</th><th>Bundle digest</th><th>Status</th></tr></thead>
        <tbody>
          <tr v-for="s in skills" :key="s.name">
            <td><b>{{ s.name }}</b></td>
            <td><span class="digest"><code :data-tip="s.bundleDigest || ''">{{ digestShort(s.bundleDigest) }}</code><CopyButton v-if="s.bundleDigest" :text="s.bundleDigest" :aria-label="`Copy digest of ${s.name}`" /></span></td>
            <td><StateTag :state="skillsTarget!.state" /></td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else class="empty-note">No Skills assigned.</p>
  </section>
  <div class="cols">
    <section class="panel">
      <header class="panel-head"><h2>Agent files</h2><p>Instruction files Fleet writes for AI clients on this machine.</p></header>
      <ul v-if="files.length" class="icards">
        <li v-for="t in files" :key="t.name" class="icard">
          <span class="icard-ic"><Icon name="file" /></span>
          <div class="icard-main">
            <h3>{{ t.file?.name || 'Agent file' }} <span v-if="targetClient(t)" class="muted">for {{ clientName(targetClient(t)) }}</span></h3>
            <p class="mono small">{{ targetWhere(t) }}<template v-if="t.file">/{{ t.file.name }}</template></p>
            <p class="muted small">{{ t.file ? (t.file.bundleDigest ? `digest ${digestShort(t.file.bundleDigest)}` : 'Assigned for removal') : 'No file in this assignment' }}{{ t.lastSucceededRevision ? ` · last applied at ${shortSha(t.lastSucceededRevision)}` : ' · not applied yet' }}</p>
          </div>
          <StateTag :state="t.state" />
        </li>
      </ul>
      <div v-else class="empty-mini"><Icon name="file" /><p>No agent files on this machine.</p></div>
    </section>
    <section class="panel">
      <header class="panel-head"><h2>AI clients</h2><p>Connections Fleet manages. Fleet owns only the connection fields, never the login.</p></header>
      <ul v-if="clients.length" class="icards">
        <li v-for="t in clients" :key="t.name" class="icard">
          <span class="mono-ic" :class="monoClass(t.aiClient?.client || targetClient(t))" aria-hidden="true">{{ initial(t.aiClient?.client || targetClient(t)) }}</span>
          <div class="icard-main">
            <h3>{{ clientName(t.aiClient?.client || targetClient(t)) }}</h3>
            <dl class="mini-kv">
              <div><dt>Connection</dt><dd>{{ t.aiClient ? connection(t.aiClient.mode) : '—' }}</dd></div>
              <div v-if="t.aiClient?.baseUrl"><dt>Endpoint</dt><dd class="mono">{{ hostOf(t.aiClient.baseUrl) }}</dd></div>
              <div v-if="t.aiClient && t.aiClient.mode !== 'native'"><dt>Model</dt><dd class="mono">{{ t.aiClient.model || 'catalog default' }}</dd></div>
            </dl>
          </div>
          <StateTag :state="t.state" />
        </li>
      </ul>
      <div v-else class="empty-mini"><Icon name="spark" /><p>Fleet does not manage any AI client here.</p></div>
    </section>
  </div>
  <section v-if="other.length" class="panel">
    <header class="panel-head"><h2>Other Targets</h2></header>
    <ul class="icards">
      <li v-for="t in other" :key="t.name" class="icard"><span class="icard-ic"><Icon name="file" /></span><div class="icard-main"><h3>{{ t.name }}</h3><p class="mono small">{{ targetWhere(t) }}</p></div><StateTag :state="t.state" /></li>
    </ul>
  </section>
</template>
