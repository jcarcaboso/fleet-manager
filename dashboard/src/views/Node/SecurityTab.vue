<script setup lang="ts">
import { computed } from 'vue';
import CopyButton from '@/components/CopyButton.vue';
import Icon from '@/components/Icon.vue';
import LockNote from '@/components/LockNote.vue';
import ScopeButton from '@/components/ScopeButton.vue';
import { DAY, fmtFull, ms, now, num, rel } from '@/lib/format';
import { certText, type NodeDetailView } from '@/lib/model';
import { nodeRoute } from '@/router';
import { useNodePage } from './nodePage';

/** Security: the node credential with its validity bar, and Revoke access (admin). */
const props = defineProps<{ node: NodeDetailView }>();
const page = useNodePage();
const c = computed(() => props.node.credential);
const bar = computed(() => {
  const cr = c.value;
  if (!cr) return null;
  const from = ms(cr.notBefore) ?? 0;
  const to = ms(cr.notAfter) ?? 0;
  const total = Math.max(1, to - from);
  const left = to - now();
  const pNow = Math.max(0, Math.min(100, ((now() - from) / total) * 100));
  return { left, pNow, level: props.node.revoked ? 'neutral' : left <= 0 ? 'critical' : left < DAY ? 'warning' : 'good' };
});
const pct = (x: number): string => `${x.toFixed(1)}%`;
</script>

<template>
  <section v-if="!c || !bar" class="panel">
    <header class="panel-head"><h2>Node credential</h2></header>
    <div class="empty-mini"><Icon name="key" /><p>This machine has no credential on record.</p></div>
  </section>
  <div v-else class="cols">
    <section class="panel">
      <header class="panel-head"><h2>Node credential</h2><p>The Agent proves possession of its private key with this client certificate. The key never leaves {{ node.alias }}.</p></header>
      <div v-if="node.revoked" class="note"><Icon name="ban" /><p><b>Revoked {{ rel(c.revokedAt || node.revokedAt) }}<template v-if="c.revokedBy"> by {{ c.revokedBy }}</template>.</b> Every certificate for this machine is blocked.</p></div>
      <div v-else class="validity" role="img" :aria-label="`Certificate validity: issued ${fmtFull(c.notBefore)}, expires ${fmtFull(c.notAfter)} UTC, ${certText(node)}.`">
        <div class="vbar">
          <span class="vb-used" :style="{ width: pct(bar.pNow) }"></span>
          <span class="vb-left" :class="`v-${bar.level}`" :style="{ left: pct(bar.pNow), width: pct(100 - bar.pNow) }"></span>
          <span class="vb-now" :style="{ left: pct(bar.pNow) }"></span>
        </div>
        <div class="vb-nowrow"><span class="vb-now-l" :style="{ left: pct(Math.max(14, Math.min(86, bar.pNow))) }">Now · {{ certText(node) }}</span></div>
        <div class="vb-labels"><span>Issued {{ fmtFull(c.notBefore) }} UTC</span><span>Expires {{ fmtFull(c.notAfter) }} UTC</span></div>
      </div>
      <dl class="kv kv--grid">
        <div><dt>Credential ID</dt><dd class="mono">{{ c.credentialId }}<CopyButton :text="c.credentialId" aria-label="Copy credential ID" /></dd></div>
        <div><dt>Renewals</dt><dd>{{ num(c.renewals) }} since enrollment</dd></div>
        <div><dt>Valid from</dt><dd>{{ fmtFull(c.notBefore) }} UTC</dd></div>
        <div><dt>Valid until</dt><dd>{{ fmtFull(c.notAfter) }} UTC</dd></div>
        <div><dt>Enrolled</dt><dd>{{ fmtFull(node.enrolledAt) }} UTC</dd></div>
        <div><dt>Node ID</dt><dd class="mono">{{ node.id }}<CopyButton :text="node.id" aria-label="Copy Node ID" /></dd></div>
      </dl>
      <div v-if="!node.revoked && bar.left <= 0" class="note"><Icon name="info" /><p>An expired certificate renews by itself when the Agent next reconnects.</p></div>
    </section>
    <section class="panel panel--danger">
      <header class="panel-head"><h2>Access</h2><p>Revoking does not delete files on the machine.</p></header>
      <div v-if="node.revoked" class="note"><Icon name="ban" /><p>This machine is already revoked. To free its alias, remove it on the <RouterLink :to="nodeRoute(page.alias, 'settings')">Settings</RouterLink> tab.</p></div>
      <div v-else class="danger-row">
        <div><h3>Revoke access</h3><p>Blocks all of this machine's certificates right away. Its record, history and alias stay.</p></div>
        <ScopeButton level="admin" cls="btn-secondary" data-act="revoke-node" @click="page.openDialog('revoke')"><Icon name="ban" />Revoke…</ScopeButton>
      </div>
      <LockNote level="admin" />
    </section>
  </div>
</template>
