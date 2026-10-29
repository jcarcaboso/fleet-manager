<script setup lang="ts">
import { computed, ref } from 'vue';
import type { AgentUpdatesRequest, AgentUpdatesResponse } from '@/api/types';
import Icon from '@/components/Icon.vue';
import LockNote from '@/components/LockNote.vue';
import MdText from '@/components/MdText.vue';
import Modal from '@/components/Modal.vue';
import ScopeButton from '@/components/ScopeButton.vue';
import StatusGlyph from '@/components/StatusGlyph.vue';
import { useFleet } from '@/context';
import { isSilent, serverMessage } from '@/lib/errors';
import { listText, plural } from '@/lib/format';
import { agentOutdated, updatePending, type NodeView } from '@/lib/model';
import { nodeRoute } from '@/router';

/**
 * The bulk Agent update of the Machines page: a bar while Agents are older than the Server, and a dialog that lists them, asks first,
 * and then shows what the Server did for each machine. It sends `{ nodes: [...] }` with the ticked Node IDs, never `allOutdated`, which
 * would also replace updates the Server considers abandoned and reach machines the page does not show. Agents that cannot update
 * themselves, or are already updating, cannot be ticked; a stranded update (see `updateStranded`) can be.
 * The request is not tied to the page: the first one of a release can take minutes while the Server fetches it.
 */
const props = defineProps<{ nodes: NodeView[] }>();
const emit = defineEmits<{ requested: [] }>();
const { api, toasts } = useFleet();

const outdated = computed(() => props.nodes.filter(agentOutdated).sort((a, b) => a.alias.localeCompare(b.alias)));
const eligible = (n: NodeView): boolean => n.agent?.selfUpdate === true && !updatePending(n);
const ready = computed(() => outdated.value.filter(eligible));
const updating = computed(() => outdated.value.filter(updatePending).length);
const manual = computed(() => outdated.value.filter(n => n.agent?.selfUpdate === false).length);
/** A Server before Agent self-update says nothing about it and has no update routes. */
const supported = computed(() => props.nodes.some(n => n.agent?.selfUpdate != null));
/** "2 can update themselves, 1 is updating and 1 needs a manual upgrade first", capitalised. */
const summary = computed(() => listText([
  ready.value.length ? `${ready.value.length} can update ${ready.value.length === 1 ? 'itself' : 'themselves'}` : 'none can be updated now',
  updating.value ? `${updating.value} ${updating.value === 1 ? 'is' : 'are'} updating` : '',
  manual.value ? `${manual.value} ${manual.value === 1 ? 'needs' : 'need'} a manual upgrade first` : '',
].filter(Boolean)).replace(/^./, c => c.toUpperCase()));
const why = (n: NodeView): string => (updatePending(n) ? 'Already updating.' : 'Cannot update itself yet. Upgrade it by hand once, then run fleet-agent service install.');

const open = ref(false);
const picked = ref(new Set<string>());
const busy = ref(false);
const error = ref<string | null>(null);
const result = ref<AgentUpdatesResponse | null>(null);
const requested = computed(() => result.value?.items.filter(i => i.requested).length ?? 0);
/** The request names machines by Node ID; the results show their aliases. */
const aliases = computed(() => new Map(props.nodes.map(n => [n.id, n.alias] as const)));
const nameOf = (item: { node: string; nodeId?: string | null }): string => (item.nodeId && aliases.value.get(item.nodeId)) || item.node;

function show(): void {
  picked.value = new Set(ready.value.map(n => n.id));
  error.value = null;
  result.value = null;
  open.value = true;
}
function close(): void {
  if (!busy.value) open.value = false;
}
function toggle(id: string, on: boolean): void {
  const next = new Set(picked.value);
  if (on) next.add(id);
  else next.delete(id);
  picked.value = next;
}

async function submit(): Promise<void> {
  if (busy.value || !picked.value.size) return;
  const body: AgentUpdatesRequest = { nodes: [...picked.value] };
  busy.value = true;
  error.value = null;
  let res: AgentUpdatesResponse;
  try {
    res = await api.post<AgentUpdatesResponse>('agent-updates', body);
  } catch (e) {
    busy.value = false;
    if (!isSilent(e)) error.value = serverMessage(e, 'The updates were not requested.');
    return;
  }
  busy.value = false;
  result.value = res;
  const n = res.items.filter(i => i.requested).length;
  toasts.push(n ? `Update requested for ${plural(n, 'machine')}` : 'No update was requested', {
    tone: n ? 'good' : 'warning', text: n ? `The Agents install ${res.targetVersion} after their next check-in.` : 'See the dialog for why.',
  });
  emit('requested');
}
</script>

<template>
  <section v-if="supported && outdated.length" id="agent-updates" class="upd-bar" aria-label="Outdated Agents">
    <span><StatusGlyph level="warning" kind="bang" /><span><b>{{ plural(outdated.length, 'Agent') }} older than the Server.</b> {{ summary }}.</span></span>
    <ScopeButton level="admin" cls="btn-secondary btn-sm" data-act="update-outdated" :disabled="!ready.length || undefined" @click="show()"><Icon name="sync" />Update outdated Agents</ScopeButton>
    <LockNote level="admin" />
  </section>
  <Modal
    v-if="open" title="Update outdated Agents" :subtitle="result ? undefined : 'Each Agent downloads the signed release from the Server, restarts into it and rolls back if the new version fails.'"
    icon="sync" tone="info" :persistent="busy" @close="close()"
  >
    <template v-if="!result">
      <ul class="upd-list" aria-label="Outdated machines">
        <li v-for="n in outdated" :key="n.id" :data-node="n.alias">
          <label v-if="eligible(n)" class="model-check">
            <input type="checkbox" :checked="picked.has(n.id)" :disabled="busy" @change="toggle(n.id, ($event.target as HTMLInputElement).checked)">
            <span><b>{{ n.alias }}</b>{{ ` · Agent ${n.agent?.version}` }}</span>
          </label>
          <template v-else><StatusGlyph level="neutral" kind="minus" /><span><b>{{ n.alias }}</b>{{ ` · Agent ${n.agent?.version}` }}<span class="muted">{{ why(n) }}</span></span></template>
        </li>
      </ul>
      <p v-if="busy" class="muted small">The Server fetches and checks the release first. The first request of a release can take a few minutes.</p>
      <p class="field-msg" :class="{ 'is-err': error }" role="alert"><MdText v-if="error" :text="error" /></p>
    </template>
    <template v-else>
      <p>{{ `Requested for ${requested} of ${plural(result.items.length, 'machine')}.` }}{{ requested ? ` They install ${result.targetVersion} after their next check-in.` : '' }}</p>
      <ul class="upd-list" aria-label="Results">
        <li v-for="item in result.items" :key="item.node" :data-node="nameOf(item)" :data-requested="item.requested">
          <StatusGlyph :level="item.requested ? 'good' : 'warning'" :kind="item.requested ? 'check' : 'bang'" />
          <span>
            <RouterLink v-if="item.nodeId" :to="nodeRoute(nameOf(item))" @click="close()"><b>{{ nameOf(item) }}</b></RouterLink><b v-else>{{ nameOf(item) }}</b>
            {{ item.requested ? ' · Update requested' : ' · Not requested' }}
            <span v-if="!item.requested" class="muted"><code v-if="item.code">{{ item.code }}</code>{{ item.code ? ' ' : '' }}<MdText :text="item.message" /></span>
          </span>
        </li>
      </ul>
    </template>
    <template #footer>
      <template v-if="!result">
        <button type="button" class="btn btn-secondary" :disabled="busy" data-autofocus @click="close()">Cancel</button>
        <button type="button" class="btn btn-primary" data-act="update-outdated-confirm" :disabled="busy || !picked.size" :aria-busy="busy ? 'true' : undefined" @click="submit()">
          <Icon name="sync" :class="{ spin: busy }" />{{ busy ? 'Requesting…' : `Update ${plural(picked.size, 'Agent')}` }}
        </button>
      </template>
      <button v-else type="button" class="btn btn-primary" data-autofocus @click="close()">Done</button>
    </template>
  </Modal>
</template>
