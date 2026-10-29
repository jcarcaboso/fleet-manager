<script setup lang="ts">
import { computed } from 'vue';
import Icon from '@/components/Icon.vue';
import LockNote from '@/components/LockNote.vue';
import MdText from '@/components/MdText.vue';
import ScopeButton from '@/components/ScopeButton.vue';
import StatusGlyph from '@/components/StatusGlyph.vue';
import StepsList from '@/components/StepsList.vue';
import { fmtFull, rel } from '@/lib/format';
import { agentOutdated, canUpdateAgent, INSTALL, INSTALLED, needsManualUpgrade, osText, SERVICE, upgradePlan, type NodeDetailView } from '@/lib/model';
import AgentUpdateState from './AgentUpdateState.vue';
import { useNodePage } from './nodePage';

/**
 * What the Agent reported about the machine (OS, kernel, version, install method, state directory) and, for an outdated Agent, how to
 * update it: Update Agent when the Agent can update itself, otherwise the upgrade steps for how it was installed. Commands come from
 * `upgradePlan`, which builds them from fixed strings and a version that passed `SEMVER`. Ported from `machinePanel()` and
 * `upgradeCallout()` of view-node.js. The update itself lives in the page controller, so it keeps going on another tab.
 */
const props = defineProps<{ node: NodeDetailView }>();
const page = useNodePage();
const a = computed(() => props.node.agent);
const old = computed(() => agentOutdated(props.node));
const plan = computed(() => (old.value ? upgradePlan(props.node) : null));
/** The Agent updates itself: Update Agent replaces the manual steps. */
const self = computed(() => old.value && a.value?.selfUpdate === true);
const manual = computed(() => needsManualUpgrade(props.node));
const offer = computed(() => canUpdateAgent(props.node));
const requesting = computed(() => page.update.busy === 'request');
const msg = computed(() => page.update.error);
const steps = computed(() => (plan.value?.steps ?? []).map(s => ({ t: s.text, cmd: s.cmd })));
const installed = computed(() => (a.value?.installMethod ? (INSTALLED as Record<string, string>)[a.value.installMethod] || `with ${a.value.installMethod}` : null));
const items = computed(() => {
  const x = a.value;
  if (!x) return [];
  const label = (map: Record<string, string>, key: string | null): string | null => (key ? map[key] || key : null);
  return [
    { label: 'Hostname', value: x.hostname, mono: true },
    { label: 'User', value: x.user },
    { label: 'Operating system', value: osText(props.node) },
    { label: 'Kernel', value: x.os.kernel, mono: true },
    { label: 'Architecture', value: x.arch, mono: true },
    { label: 'Agent version', value: '', version: true },
    { label: 'Install method', value: label(INSTALL, x.installMethod) },
    { label: 'Service manager', value: label(SERVICE, x.serviceManager) },
    { label: 'State directory', value: x.stateDirectory, mono: true },
    { label: 'Reported', value: x.reportedAt ? `${fmtFull(x.reportedAt)} UTC · ${rel(x.reportedAt)}` : null },
  ];
});
</script>

<template>
  <section id="machine-panel" class="panel" aria-labelledby="machine-h">
    <header class="panel-head">
      <h2 id="machine-h">Machine</h2>
      <p v-if="!a">The operating system and Agent that run {{ node.alias }}.</p>
      <p v-else>{{ a.reportedAt ? `Reported by the Agent ${rel(a.reportedAt)}. It sends this again whenever it changes.` : 'Reported by the Agent.' }}</p>
    </header>
    <p v-if="!a" class="muted machine-none">Not reported. Agents before 0.9.0 do not send machine details.</p>
    <template v-else>
      <div v-if="plan" id="agent-upgrade" class="callout callout--warning upgrade" :data-method="plan.method || 'unknown'">
        <StatusGlyph level="warning" kind="bang" />
        <div>
          <b>Update available: Agent {{ a.version }}<template v-if="a.latestVersion">{{ ` → ${a.latestVersion}` }}</template></b>
          <template v-if="self">
            <p>This Agent can update itself. It downloads the signed release from the Server, restarts into it and rolls back if the new version fails.</p>
            <div v-if="offer" class="btn-row">
              <ScopeButton
                level="admin" cls="btn-primary btn-sm" data-act="agent-update" :disabled="requesting || undefined" :aria-busy="requesting ? 'true' : undefined"
                @click="page.updateAgent()"
              ><Icon name="sync" :class="{ spin: requesting }" />{{ requesting ? 'Requesting…' : 'Update Agent' }}</ScopeButton>
            </div>
            <p v-if="requesting" class="small">The Server fetches and checks the release first. The first request of a release can take a few minutes.</p>
            <LockNote v-if="offer" level="admin" />
          </template>
          <template v-else>
            <p>{{ installed ? `This Agent was installed ${installed}.` : 'The install method was not reported.' }} Upgrade it on {{ node.alias }}. Its identity and state stay in place.</p>
            <StepsList :steps="steps" />
            <p v-if="manual" class="small" data-manual-once>This Agent cannot update itself. After this upgrade, run <code>fleet-agent service install</code> once; later updates can start from here.</p>
            <p v-if="plan.releaseUrl" class="small"><a :href="plan.releaseUrl" target="_blank" rel="noopener noreferrer">Release notes and archives on GitHub</a></p>
          </template>
        </div>
      </div>
      <p id="agent-update-msg" class="aupd-msg" :class="msg ? `aupd-msg--${msg.tone}` : undefined" role="status"><MdText v-if="msg" :text="msg.text" /></p>
      <AgentUpdateState v-if="node.update" :node="node" />
      <dl class="kv kv--grid kv--3">
        <div v-for="it in items" :key="it.label">
          <dt>{{ it.label }}</dt>
          <dd v-if="it.version">
            {{ a.version || '—' }}<template v-if="old">{{ ' ' }}<span class="chip chip--update"><StatusGlyph level="warning" kind="bang" />Update available</span></template><template v-if="a.latestVersion">{{ ' ' }}<span class="muted small">{{ old ? `latest ${a.latestVersion}` : node.revoked ? '' : 'latest release' }}</span></template>
          </dd>
          <dd v-else-if="it.value" :class="{ mono: it.mono }">{{ it.value }}</dd>
          <dd v-else><span class="muted">Not reported</span></dd>
        </div>
      </dl>
    </template>
  </section>
</template>
