<script setup lang="ts">
import { computed } from 'vue';
import Icon from '@/components/Icon.vue';
import MdText from '@/components/MdText.vue';
import ScopeButton from '@/components/ScopeButton.vue';
import StatusGlyph from '@/components/StatusGlyph.vue';
import { useFleet } from '@/context';
import { fmtFull, rel } from '@/lib/format';
import { updateActive, updateMeta, type NodeDetailView } from '@/lib/model';
import { useNodePage } from './nodePage';

/**
 * The latest Agent update of the machine: its state, from and to which version, who asked and when, and for a failed update the
 * Agent's error code with the catalog's explanation. Cancel while the Agent has not picked the request up.
 */
const props = defineProps<{ node: NodeDetailView }>();
const { catalog } = useFleet();
const page = useNodePage();
const u = computed(() => props.node.update!);
const meta = computed(() => updateMeta(u.value.state));
const moving = computed(() => updateActive(u.value) && u.value.state !== 'requested');
const failure = computed(() => (u.value.state === 'failed' && u.value.errorCode ? catalog.get(u.value.errorCode) : null));
const text = computed(() => {
  switch (u.value.state) {
    case 'requested': return props.node.freshness === 'fresh'
      ? 'Waiting for the Agent’s next check-in.'
      : `${props.node.alias} is not checking in. Its Agent starts the update when it is back.`;
    case 'downloading': return 'The Agent is downloading the signed release and checking it.';
    case 'restarting': return 'The Agent is restarting into the new version. It rolls back by itself if the new version fails.';
    case 'succeeded': return 'The Agent runs the new version.';
    case 'failed': return 'The Agent kept its previous version.';
    case 'cancelled': return 'Cancelled before the Agent started it.';
    default: return '';
  }
});
const versions = computed(() => `${u.value.fromVersion ?? 'Unknown version'} → ${u.value.targetVersion ?? '—'}`);
const when = computed(() => [
  `Requested${u.value.requestedBy ? ` by ${u.value.requestedBy}` : ''} ${rel(u.value.requestedAt)}`,
  u.value.finishedAt ? `finished ${rel(u.value.finishedAt)}` : updateActive(u.value) && u.value.updatedAt !== u.value.requestedAt ? `last progress ${rel(u.value.updatedAt)}` : null,
].filter(Boolean).join(' · '));
const cancelling = computed(() => page.update.busy === 'cancel');
</script>

<template>
  <div id="agent-update" class="aupd" :class="`aupd--${meta.level}`" :data-state="u.state" role="group" aria-labelledby="agent-update-h">
    <Icon v-if="moving" name="sync" class="spin" />
    <StatusGlyph v-else :level="meta.level" :kind="meta.kind" />
    <div>
      <div class="aupd-head"><b id="agent-update-h">{{ meta.label }}</b>{{ ' ' }}<span class="mono">{{ versions }}</span></div>
      <p>{{ text }}</p>
      <p v-if="u.state === 'failed' && u.errorCode" class="aupd-why">
        <code>{{ u.errorCode }}</code><template v-if="failure">{{ ' ' }}<b>{{ failure.title }}.</b>{{ ' ' }}<MdText :text="failure.explanation" /></template>
      </p>
      <p class="muted small" :data-tip="u.requestedAt ? `${fmtFull(u.requestedAt)} UTC|requested` : undefined">{{ when }}</p>
      <ScopeButton
        v-if="u.state === 'requested'" level="admin" cls="btn-secondary btn-sm" data-act="agent-update-cancel"
        :disabled="cancelling || undefined" :aria-busy="cancelling ? 'true' : undefined" @click="page.cancelUpdate()"
      ><Icon name="x" />{{ cancelling ? 'Cancelling…' : 'Cancel update' }}</ScopeButton>
    </div>
  </div>
</template>
