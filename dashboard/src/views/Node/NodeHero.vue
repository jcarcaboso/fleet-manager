<script setup lang="ts">
import { computed } from 'vue';
import DeviceArt from '@/components/DeviceArt.vue';
import Icon from '@/components/Icon.vue';
import ScopeButton from '@/components/ScopeButton.vue';
import StatusGlyph from '@/components/StatusGlyph.vue';
import StatusPill from '@/components/StatusPill.vue';
import { useHeadingFocus } from '@/composables/useHeadingFocus';
import { DAY, fmtDay, fmtFull, listText, plural, platformLabel, rel, shortSha, ms } from '@/lib/format';
import { certLeft, certText, osText } from '@/lib/model';
import { STATES } from '@/lib/targets';
import { nodeRoute } from '@/router';
import { agentFact, heroSub } from './nodeModel';
import { useNodePage } from './nodePage';

/**
 * The header of the machine page: the illustration, the name with its health, the reason (a link to the tab that explains it), the
 * facts, and Fix / Rename / Revoke / Remove. Ported from `paint()` of view-node.js.
 */
const page = useNodePage();
const h1 = useHeadingFocus();
const n = computed(() => page.node.value!);
const h = computed(() => page.health.value!);
const total = computed(() => Object.values(n.value.counts).reduce((a, b) => a + b, 0));
const serious = computed(() => page.openProblems.value.filter(p => p.level !== 'info').length);
const reasonTab = computed(() => (h.value.key === 'failing' || h.value.key === 'offline' || h.value.key === 'never' ? 'problems' : 'overview'));
const sub = computed(() => heroSub(n.value, osText(n.value)));
const agent = computed(() => agentFact(n.value));
const left = computed(() => certLeft(n.value));
const meter = computed(() => {
  const c = n.value.credential;
  const l = left.value;
  if (!c || n.value.revoked || l === null) return null;
  const tot = Math.max(1, (ms(c.notAfter) ?? 0) - (ms(c.notBefore) ?? 0));
  return { level: l <= 0 ? 'critical' : l < DAY ? 'warning' : 'good', pct: Math.max(0, Math.min(100, (l / tot) * 100)) };
});
const counts = computed(() => (total.value ? listText(STATES.filter(s => n.value.counts[s.key] > 0).map(s => `${n.value.counts[s.key]} ${s.label.toLowerCase()}`)) : 'none yet'));
</script>

<template>
  <section class="nhero" :class="`nhero--${h.key}`">
    <div class="nhero-stage">
      <DeviceArt :node="n" :health="h" />
      <span class="nhero-model"><Icon v-if="n.platform === 'macos'" name="apple" /><Icon v-else-if="n.platform === 'linux'" name="tux" />{{ platformLabel(n.platform) }}</span>
    </div>
    <div class="nhero-info">
      <div class="nhero-top"><h1 ref="h1" tabindex="-1">{{ n.alias }}</h1><StatusPill :level="h.level" :kind="h.kind" :label="h.label" /></div>
      <p class="nhero-sub"><span v-if="sub.host" class="mono">{{ sub.host }}</span>{{ sub.text }}</p>
      <RouterLink class="reason reason--lg" :class="`reason--${h.level}`" :to="nodeRoute(page.alias, reasonTab)">
        <StatusGlyph :level="h.level" :kind="h.kind" /><span>{{ h.reason }}<span v-if="h.extra" class="reason-extra"> · {{ h.extra }}</span></span><Icon name="chevR" class="rchev" />
      </RouterLink>
      <dl class="facts">
        <div><dt>Last check-in</dt><dd>{{ n.lastContactAt ? rel(n.lastContactAt) : 'Never' }}</dd><dd class="sub">{{ n.lastContactAt ? `${fmtFull(n.lastContactAt)} UTC` : `enrolled ${rel(n.enrolledAt)}` }}</dd></div>
        <div><dt>Revision</dt><dd>{{ n.currentRevision ? shortSha(n.currentRevision) : '—' }}</dd><dd class="sub">{{ total ? `${n.counts.succeeded} of ${total} Targets in sync` : 'no Targets assigned' }}</dd></div>
        <div>
          <dt>Certificate</dt><dd>{{ certText(n) }}</dd><dd class="sub">{{ n.revoked ? `revoked ${rel(n.revokedAt)}` : n.notAfter ? `until ${fmtFull(n.notAfter)} UTC` : '' }}</dd>
          <div v-if="meter" class="meter" :class="`m-${meter.level}`" role="img" :aria-label="`Certificate: ${certText(n)}`"><span :style="{ width: `${meter.pct.toFixed(1)}%` }"></span></div>
        </div>
        <div><dt>Targets</dt><dd>{{ String(total) }}</dd><dd class="sub">{{ counts }}</dd></div>
        <div v-if="agent"><dt>Agent</dt><dd><StatusGlyph v-if="agent.warn" level="warning" kind="bang" />{{ agent.version }}</dd><dd class="sub">{{ agent.sub }}</dd></div>
        <div v-else><dt>Agent</dt><dd>—</dd><dd class="sub">not reported</dd></div>
        <div><dt>Enrolled</dt><dd>{{ fmtDay(n.enrolledAt) }}</dd><dd class="sub">{{ rel(n.enrolledAt) }}</dd></div>
      </dl>
      <div class="nhero-actions">
        <RouterLink v-if="serious" class="btn btn-primary" :to="nodeRoute(page.alias, 'problems')"><Icon name="alert" />Fix {{ plural(serious, 'problem') }}</RouterLink>
        <RouterLink class="btn btn-secondary" :to="nodeRoute(page.alias, 'settings')"><Icon name="pencil" />Rename</RouterLink>
        <ScopeButton v-if="!n.revoked" level="admin" cls="btn-secondary" data-act="revoke-node" @click="page.openDialog('revoke')"><Icon name="ban" />Revoke</ScopeButton>
        <ScopeButton level="admin" cls="btn-secondary btn-danger-ghost" data-act="remove-node" @click="page.openDialog('remove')"><Icon name="trash" />Remove</ScopeButton>
      </div>
    </div>
  </section>
</template>
