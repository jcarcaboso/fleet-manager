<script setup lang="ts">
import { computed } from 'vue';
import StatusGlyph from '@/components/StatusGlyph.vue';
import StepsList from '@/components/StepsList.vue';
import { fmtFull, rel } from '@/lib/format';
import { agentOutdated, INSTALL, INSTALLED, osText, SERVICE, upgradePlan, type NodeDetailView } from '@/lib/model';

/**
 * What the Agent reported about the machine (OS, kernel, version, install method, state directory) and, for an outdated Agent, the
 * upgrade steps for how it was installed. Commands come from `upgradePlan`, which builds them from fixed strings and a version
 * that passed `SEMVER`. Ported from `machinePanel()` and `upgradeCallout()` of view-node.js.
 */
const props = defineProps<{ node: NodeDetailView }>();
const a = computed(() => props.node.agent);
const old = computed(() => agentOutdated(props.node));
const plan = computed(() => (old.value ? upgradePlan(props.node) : null));
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
          <p>{{ installed ? `This Agent was installed ${installed}.` : 'The install method was not reported.' }} Upgrade it on {{ node.alias }}. Its identity and state stay in place.</p>
          <StepsList :steps="steps" />
          <p v-if="plan.releaseUrl" class="small"><a :href="plan.releaseUrl" target="_blank" rel="noopener noreferrer">Release notes and archives on GitHub</a></p>
        </div>
      </div>
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
