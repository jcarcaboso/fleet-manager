<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type { EnrollmentLink } from '@/api/types';
import ChipsFilter from '@/components/ChipsFilter.vue';
import Countdown from '@/components/Countdown.vue';
import ErrorState from '@/components/ErrorState.vue';
import Icon from '@/components/Icon.vue';
import LoadingBlock from '@/components/LoadingBlock.vue';
import LockNote from '@/components/LockNote.vue';
import PageHead from '@/components/PageHead.vue';
import ScopeButton from '@/components/ScopeButton.vue';
import StatusPill from '@/components/StatusPill.vue';
import { useLoad } from '@/composables/useLoad';
import { useFleet } from '@/context';
import { enc, fmtFull, fmtTime, rel } from '@/lib/format';
import { nodeRoute } from '@/router';
import { ALIAS_HINT, aliasError, linkState } from './enrollment';

/**
 * Enrollment: one-time links that let a new machine join, the form that starts the Add machine wizard, and how enrollment works
 * (ported from view-enrollment.js).
 * API: GET enrollment-links, POST enrollment-links (admin, through the wizard), POST enrollment-links/{id}/revoke (admin).
 */
const { api, session, summary, shell, toasts, wizard, enrollmentBus: bus } = useFleet();

const { data, error, loading, run, reload, view } = useLoad(async token => {
  const r = await api.all<EnrollmentLink>('enrollment-links', { maxPages: 3, signal: token.signal });
  token.check();
  void summary.refresh();
  shell.markLoaded();
  return r;
});
/* A link was created or revoked somewhere (the wizard, a revocation that answered late): the list is stale. */
watch(() => bus.version, () => { void run({ quiet: true }); });

const filter = ref('all');
const links = computed(() => data.value?.items ?? []);
const shown = computed(() => (filter.value === 'all' ? links.value : links.value.filter(l => l.state === filter.value)));
const count = (state: string): number => links.value.filter(l => l.state === state).length;
const chips = computed(() => [['all', 'All', links.value.length], ['active', 'Active', count('active')], ['consumed', 'Used', count('consumed')], ['expired', 'Expired', count('expired')], ['revoked', 'Revoked', count('revoked')]] as const);
const emptyText = computed(() => (links.value.length ? `No ${linkState(filter.value)[2].toLowerCase()} links.` : 'No enrollment links yet.'));

const admin = computed(() => session.can('admin'));
const alias = ref('');
const expiry = ref('900');
const aliasInput = ref<HTMLInputElement | null>(null);
const invalid = ref(false);
const local = ref<string | null>(null); // the validation message; the wizard's failure is in the bus
const message = computed(() => local.value ?? (bus.formMsg || 'The guided setup shows the install and enroll commands next.'));
const messageIsError = computed(() => local.value !== null || bus.formErr);

function submit(): void {
  local.value = null;
  const a = alias.value.trim();
  const err = aliasError(a);
  invalid.value = !!err;
  if (err) {
    local.value = err;
    aliasInput.value?.focus();
    return;
  }
  /* The wizard opens with the alias and expiry and creates the link at once. */
  bus.request = { alias: a, expiry: Number(expiry.value) };
  wizard.show();
}

const revoking = reactive(new Set<string>());
async function revoke(id: string): Promise<void> {
  revoking.add(id);
  try {
    await api.post(`enrollment-links/${enc(id)}/revoke`, {});
    toasts.push('Enrollment link revoked');
    bus.revoked(id); // reloads this list (and closes a wizard that still shows this link) while they are open
  } catch (e) {
    revoking.delete(id);
    toasts.fail(e, 'Link was not revoked');
    if (view.alive) await run({ quiet: true });
  }
}
</script>

<template>
  <LoadingBlock v-if="loading && !data" />
  <div v-else class="wrap">
    <ErrorState v-if="error" :error="error" what="Enrollment" @retry="reload()" />
    <template v-else-if="data">
      <PageHead title="Enrollment" sub="One-time links that let a new machine join this Workspace.">
        <template #actions><ScopeButton level="admin" cls="btn-primary" data-act="add" @click="wizard.show()"><Icon name="plus" />Add machine</ScopeButton></template>
      </PageHead>
      <LockNote level="admin" />
      <div class="cols">
        <section class="panel">
          <header class="panel-head"><h2>Create a link</h2><p>Bound to one alias, single-use, and it includes the Server’s public CA.</p></header>
          <form class="form" novalidate @submit.prevent="submit">
            <label for="en-alias">Machine alias</label>
            <input id="en-alias" ref="aliasInput" v-model="alias" name="alias" placeholder="e.g. office-mini" maxlength="201" autocomplete="off" spellcheck="false" aria-describedby="en-msg" :aria-invalid="invalid ? 'true' : undefined" :disabled="!admin" @input="invalid = false">
            <label for="en-exp">Link expires after</label>
            <div class="sel sel--block"><select id="en-exp" v-model="expiry" name="expiry" :disabled="!admin"><option value="900">15 minutes (default)</option><option value="1800">30 minutes</option><option value="3600">1 hour (maximum)</option></select><Icon name="chevD" class="sel-chev" /></div>
            <p id="en-msg" class="field-msg" :class="{ 'is-err': messageIsError }" role="status">{{ message }}</p>
            <ScopeButton level="admin" cls="btn-primary" type="submit"><Icon name="link" />Create link</ScopeButton>
          </form>
        </section>
        <section class="panel">
          <header class="panel-head"><h2>How enrollment works</h2><p>The machine creates its own identity. Fleet never sees its private key.</p></header>
          <ol class="how">
            <li><span class="how-n">1</span><div><b>Create a link for an alias</b><p>Treat it as a secret until it expires or is used. You can revoke it before then.</p></div></li>
            <li><span class="how-n">2</span><div><b>Run <code>fleet-agent enroll --link</code> on the machine</b><p>Paste the link at the prompt. The Agent generates a P-256 key and stores state in <span class="mono">~/.local/state/fleet-agent</span>.</p></div></li>
            <li><span class="how-n">3</span><div><b>Start the service</b><p>With Homebrew: <code>brew services start jcarcaboso/fleet/fleet-agent</code>. The machine appears here at its first check-in.</p></div></li>
          </ol>
        </section>
      </div>
      <section class="panel">
        <header class="panel-head row">
          <div><h2>Links</h2><p>Active, used, expired and revoked links, newest expiry first. Links themselves are never shown again after creation.</p></div>
          <ChipsFilter v-model="filter" :items="chips" label="Filter links" />
        </header>
        <ul class="links">
          <li v-for="l in shown" :key="l.id" class="link-row" :class="`link-row--${l.state}`">
            <span class="link-ic"><Icon name="link" /></span>
            <div class="link-main"><b>{{ l.alias }}</b><span class="muted small">Expiry {{ fmtFull(l.expiresAt) }} UTC</span></div>
            <div class="link-state">
              <StatusPill :level="linkState(l.state)[0]" :kind="linkState(l.state)[1]" :label="linkState(l.state)[2]" />
              <span class="small">
                <template v-if="l.state === 'active'">Expires <Countdown :to="l.expiresAt" /> · {{ fmtTime(l.expiresAt) }} UTC</template>
                <template v-else-if="l.state === 'consumed'">Used {{ rel(l.consumedAt) }} · enrolled {{ l.alias }}</template>
                <template v-else-if="l.state === 'expired'">Expired {{ rel(l.expiresAt) }}, never used</template>
                <template v-else>Revoked {{ rel(l.revokedAt) }}{{ l.revokedBy ? ` by ${l.revokedBy}` : '' }}</template>
              </span>
            </div>
            <div class="link-act">
              <ScopeButton v-if="l.state === 'active'" level="admin" cls="btn-sm btn-secondary" data-act="revoke-link" :disabled="revoking.has(l.id)" @click="revoke(l.id)"><Icon name="ban" />Revoke</ScopeButton>
              <RouterLink v-else-if="l.state === 'consumed' && l.nodeId" class="btn btn-sm btn-ghost" :to="nodeRoute(l.nodeId)">Open machine<Icon name="chevR" /></RouterLink>
            </div>
          </li>
          <li v-if="!shown.length" class="empty-mini"><Icon name="link" /><p>{{ emptyText }}</p></li>
        </ul>
        <p v-if="data.truncated" class="muted small">Showing the newest links only.</p>
      </section>
    </template>
  </div>
</template>
