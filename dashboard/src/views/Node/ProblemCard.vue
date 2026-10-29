<script setup lang="ts">
import { computed } from 'vue';
import CopyBox from '@/components/CopyBox.vue';
import FailureDetail from '@/components/FailureDetail.vue';
import Icon from '@/components/Icon.vue';
import IssueActions from '@/components/IssueActions.vue';
import IssueBanner from '@/components/IssueBanner.vue';
import LockNote from '@/components/LockNote.vue';
import MdText from '@/components/MdText.vue';
import RevChip from '@/components/RevChip.vue';
import ScopeButton from '@/components/ScopeButton.vue';
import StateTag from '@/components/StateTag.vue';
import StatusGlyph from '@/components/StatusGlyph.vue';
import StatusPill from '@/components/StatusPill.vue';
import StepsList from '@/components/StepsList.vue';
import { useFleet } from '@/context';
import { fmtFull, num, rel, shortId, shortSha, slug } from '@/lib/format';
import { canUpdateAgent, fixSteps, type NodeDetailView } from '@/lib/model';
import { hasDetail, stepLabel, targetLabel, targetWhere, tstate } from '@/lib/targets';
import { nodeRoute } from '@/router';
import type { ProblemEntry } from './nodeModel';
import { useNodePage } from './nodePage';

/**
 * One problem of the machine: a failed Target (with the Agent's detail, a retry, and its recent attempts) or an issue (disk, Agent
 * outdated, not contacting). The catalog's explanation and fix steps come first; commands from the Server are shown as text. An outdated
 * Agent that can update itself, or one whose update failed, gets Update Agent.
 */
const props = defineProps<{ node: NodeDetailView; problem: ProblemEntry }>();
const { openState } = useFleet();
const page = useNodePage();
const p = computed(() => props.problem);
const t = computed(() => p.value.target);
const i = computed(() => p.value.issue);
const cat = computed(() => p.value.cat);
const explanation = computed(() => cat.value?.explanation || i.value?.detail || '');
const specific = computed(() => (i.value && cat.value?.explanation && i.value.detail && i.value.detail !== cat.value.explanation ? i.value.detail : ''));
const facts = computed<Array<{ k: string; v: string; sub?: string; mono?: boolean }>>(() => {
  const tg = t.value;
  const is = i.value;
  if (tg) {
    return [
      { k: 'First failed', v: fmtFull(tg.firstFailedAt) + ' UTC', sub: rel(tg.firstFailedAt) },
      { k: 'Failed attempts', v: num(tg.failedAttempts ?? 0), sub: 'on the current assignment' },
      { k: 'Latest attempt', v: tg.latestAttempt ? rel(tg.latestAttempt.updatedAt) : '—', sub: tg.latestAttempt ? `${tstate(tg.latestAttempt.state).label} · ${fmtFull(tg.latestAttempt.updatedAt)} UTC` : '' },
      { k: 'Desired revision', v: tg.desiredRevision ? shortSha(tg.desiredRevision.sourceRevision) : '—', sub: tg.desiredRevision ? `published ${rel(tg.desiredRevision.acceptedAt)}` : '' },
      { k: 'Last in sync at', v: tg.lastSucceededRevision ? shortSha(tg.lastSucceededRevision) : 'Never', sub: tg.lastSucceededRevision ? '' : 'nothing has been applied for this Target' },
    ];
  }
  if (is) {
    return [
      { k: 'Since', v: is.since ? fmtFull(is.since) + ' UTC' : '—', sub: is.since ? rel(is.since) : '' },
      { k: 'Severity', v: is.severity === 'error' ? 'Error' : 'Warning', sub: '' },
      ...(is.errorCode ? [{ k: 'Error code', v: is.errorCode, sub: '', mono: true }] : []),
    ];
  }
  return [];
});
/* Detail of the latest failed Attempt: a failed Target has it on latestAttempt, an Issue carries the same three fields. */
const showDetail = computed(() => !!t.value || i.value?.code === 'assignment_failed');
const detailSrc = computed(() => {
  if (!t.value) return i.value;
  const la = t.value.latestAttempt;
  return hasDetail(la) || !i.value ? la : i.value;
});
const steps = computed(() => fixSteps(i.value, cat.value));
const commands = computed(() => i.value?.commands ?? []);
const attempts = computed(() => (t.value ? page.tab.tAttempts.get(t.value.name) : undefined));
const retrying = computed(() => !!t.value && page.retrying.has(props.node.id + ':' + t.value.name));
const quiet = computed(() => p.value.st.key !== 'open');
const busy = computed(() => !!i.value && page.issueBusy.has(i.value.id));
const updatable = computed(() => (i.value?.code === 'agent_outdated' || i.value?.code === 'agent_update_failed') && canUpdateAgent(props.node));
const requesting = computed(() => page.update.busy === 'request');
const techKey = computed(() => 'tech:' + props.node.id + p.value.id);
const onToggle = (e: Event): void => { openState.set(techKey.value, (e.target as HTMLDetailsElement).open); };
</script>

<template>
  <article :id="`p-${slug(p.id)}`" class="prob" :class="[`prob--${p.level}`, { 'is-quiet': quiet }]">
    <header class="prob-head">
      <span class="prob-ic" :class="`t-${p.level}`"><StatusGlyph :level="p.level" :kind="p.glyph" /></span>
      <div class="prob-titles">
        <h3>{{ p.title }}</h3>
        <p class="prob-where">
          <template v-if="t">{{ targetLabel(t) }} <code>{{ t.name }}</code> on <RouterLink :to="nodeRoute(page.alias)">{{ node.alias }}</RouterLink></template>
          <template v-else><RouterLink :to="nodeRoute(page.alias)">{{ node.alias }}</RouterLink><template v-if="i?.target"> · <code>{{ i.target }}</code></template></template>
        </p>
      </div>
      <StatusPill :level="p.level" :kind="p.glyph" :label="p.badge" />
    </header>
    <div class="prob-body">
      <IssueBanner v-if="i" :issue="i" />
      <p v-if="explanation" class="prob-expl"><MdText :text="explanation" /><template v-if="specific">{{ ' ' }}<strong><MdText :text="specific" /></strong></template></p>
      <p v-else class="prob-expl muted">The Server has no catalog entry for this code yet.</p>
      <dl v-if="facts.length" class="facts-row">
        <div v-for="f in facts" :key="f.k"><dt>{{ f.k }}</dt><dd :class="{ mono: f.mono }">{{ f.v }}</dd><dd v-if="f.sub" class="sub">{{ f.sub }}</dd></div>
      </dl>
      <FailureDetail v-if="showDetail" :src="detailSrc" :target="t" />
      <div class="prob-cols">
        <section class="fix" aria-label="How to fix">
          <h4>How to fix</h4>
          <StepsList v-if="steps.length" :steps="steps" />
          <p v-else class="muted">No fix steps are published for this problem.</p>
          <p v-if="t" class="muted small prob-note">The Agent applies a retry on its next poll.</p>
        </section>
        <section class="why">
          <template v-if="commands.length"><h4>From the CLI</h4><CopyBox v-for="c in commands" :key="c" :cmd="c" /></template>
          <template v-if="t && t.lastSucceededRevision"><h4>Last known good</h4><p class="small"><RevChip :sha="t.lastSucceededRevision" :tip="t.lastSucceededRevision" /> <span class="muted">is still what this Target last applied successfully.</span></p></template>
        </section>
      </div>
      <details class="tech" :data-open-key="techKey" :open="openState.get(techKey) === true" @toggle="onToggle">
        <summary><Icon name="terminal" />Technical details<Icon name="chevD" class="sumchev" /></summary>
        <div class="tech-body">
          <dl class="kv">
            <div><dt>Error code</dt><dd><code>{{ p.code || '—' }}</code></dd></div>
            <template v-if="t">
              <div><dt>Target path</dt><dd class="mono">{{ targetWhere(t) }}</dd></div>
              <div><dt>Assignment</dt><dd class="mono">{{ t.assignmentId }}</dd></div>
              <div v-if="t.latestAttempt"><dt>Latest attempt</dt><dd class="mono">{{ t.latestAttempt.attemptId }}</dd></div>
            </template>
            <div v-if="i"><dt>Issue</dt><dd class="mono">{{ i.id }}</dd></div>
          </dl>
          <template v-if="attempts">
            <p class="kv-label">Recent attempts</p>
            <div v-if="attempts.length" class="tbl-wrap">
              <table class="tbl tbl--compact">
                <thead><tr><th>Attempt</th><th>Revision</th><th>Result</th><th>Updated (UTC)</th><th>Error code</th><th>Step</th></tr></thead>
                <tbody>
                  <tr v-for="a in attempts" :key="a.attemptId">
                    <td class="mono">{{ shortId(a.attemptId) }}</td>
                    <td><RevChip :sha="a.sourceRevision" :tip="a.sourceRevision" /></td>
                    <td><StateTag :state="a.state" /></td>
                    <td>{{ fmtFull(a.updatedAt) }}</td>
                    <td><code v-if="a.errorCode">{{ a.errorCode }}</code><span v-else class="muted">—</span></td>
                    <td><template v-if="a.step">{{ stepLabel(a.step) }}</template><span v-else class="muted">—</span></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-else class="muted small">No attempts recorded.</p>
          </template>
        </div>
      </details>
      <footer v-if="t || i" class="prob-actions">
        <ScopeButton v-if="t" level="operate" cls="btn-sm btn-primary" data-act="retry" :data-target="t.name" :disabled="retrying || undefined" @click="page.retry(t.name)"><Icon name="retry" :class="{ spin: retrying }" />{{ retrying ? 'Requesting…' : 'Retry now' }}</ScopeButton>
        <ScopeButton
          v-if="updatable" level="admin" cls="btn-sm btn-primary" data-act="agent-update" :disabled="requesting || undefined" :aria-busy="requesting ? 'true' : undefined"
          @click="page.updateAgent()"
        ><Icon name="sync" :class="{ spin: requesting }" />{{ requesting ? 'Requesting…' : 'Update Agent' }}</ScopeButton>
        <IssueActions v-if="i" :issue="i" :busy="busy" @state="page.changeIssue($event)" />
        <LockNote level="operate" class="lock-note--inline" />
      </footer>
    </div>
  </article>
</template>
