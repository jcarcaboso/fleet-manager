<script setup lang="ts">
import { computed } from 'vue';
import type { CliProxyStatus, DesiredRevisionItem, EnrollmentLink, SourceStatus } from '@/api/types';
import Icon from '@/components/Icon.vue';
import Legend from '@/components/Legend.vue';
import ScopeButton from '@/components/ScopeButton.vue';
import Segbar, { type SegPart } from '@/components/Segbar.vue';
import StatusGlyph from '@/components/StatusGlyph.vue';
import { useHeadingFocus } from '@/composables/useHeadingFocus';
import { useSession } from '@/context';
import { listText, ms, num, plural, rel, shortSha, until } from '@/lib/format';
import { DISK_WARN, commit, diskHot, type NodeView } from '@/lib/model';
import { addCounts, countTotal, emptyCounts } from '@/lib/targets';
import type { HealthOf } from './gallery';

/**
 * The top of the Machines page: the health sentence and bar, the Sync and Add machine buttons, and the four tiles that lead to
 * Deployments, Repository, Models and Enrollment (ported from header() in view-gallery.js).
 */
const props = defineProps<{
  live: NodeView[];
  healthOf: HealthOf;
  source: SourceStatus | null;
  rev: DesiredRevisionItem | null;
  proxy: CliProxyStatus | null;
  links: EnrollmentLink[] | null;
  syncing: boolean;
}>();
const emit = defineEmits<{ sync: []; add: []; jump: [key: string] }>();
const session = useSession();
const h1 = useHeadingFocus();

type HealthBucket = 'ok' | 'updating' | 'offline' | 'failing';
const bucketOf = (n: NodeView): HealthBucket => {
  const k = props.healthOf(n).key;
  return k === 'never' ? 'offline' : k === 'retired' ? 'ok' : k;
};
const counts = computed(() => {
  const c: Record<HealthBucket, number> = { ok: 0, updating: 0, offline: 0, failing: 0 };
  for (const n of props.live) c[bucketOf(n)]++;
  return c;
});
const parts = computed<SegPart[]>(() => {
  const c = counts.value;
  const names = (key: HealthBucket): string => props.live.filter(n => bucketOf(n) === key).map(n => n.alias).join(', ');
  return ([
    { key: 'ok', label: 'Up to date', level: 'good', kind: 'check', value: c.ok },
    { key: 'updating', label: 'Updating', level: 'info', kind: 'sync', value: c.updating },
    { key: 'offline', label: 'Offline', level: 'serious', kind: 'moon', value: c.offline },
    { key: 'failing', label: 'Action needed', level: 'critical', kind: 'bang', value: c.failing },
  ] as const).map(p => ({ ...p, unit: p.value === 1 ? 'machine' : 'machines', tip: names(p.key) }));
});

const attention = computed(() => counts.value.offline + counts.value.failing);
const sentence = computed(() => {
  const c = counts.value;
  const full = props.live.filter(diskHot).length;
  return [
    c.updating ? `${c.updating} ${c.updating === 1 ? 'is' : 'are'} updating` : null,
    attention.value ? `${attention.value} need${attention.value === 1 ? 's' : ''} your attention` : null,
    full ? `${full} ${full === 1 ? 'has' : 'have'} a disk that is ${DISK_WARN}% full or more` : null,
  ].filter((x): x is string => !!x);
});
const sub = computed(() => {
  const c = counts.value;
  if (!props.live.length) return 'Add a machine to start delivering Skills, agent files and AI-client settings.';
  const base = sentence.value.length ? listText(sentence.value) + '.' : 'Every machine has all of its Targets in sync.';
  return base + (c.failing ? ` ${c.failing} ${c.failing === 1 ? 'has a problem' : 'have problems'} Fleet cannot fix on its own.` : '');
});

const greeting = computed(() => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
});

const assignments = computed(() => {
  const c = emptyCounts();
  for (const n of props.live) addCounts(c, n.counts);
  return { succeeded: c.succeeded, total: countTotal(c) };
});
const commitInfo = computed(() => commit(props.rev?.commit));
const deployTitle = computed(() => (props.rev ? `${assignments.value.succeeded < assignments.value.total ? 'Deploying' : 'Latest revision'} ${shortSha(props.rev.sourceRevision)}` : 'Deployments'));
const commitTip = computed(() => `${commitInfo.value?.subject}|${commitInfo.value?.author ? `by ${commitInfo.value.author}` : 'commit subject'}`);

const scanOk = computed(() => !!props.source && (props.source.outcome === 'accepted' || props.source.outcome === 'unchanged'));
const scanText = computed(() => {
  const s = props.source;
  if (!s) return 'No scans recorded yet';
  return `${scanOk.value ? 'Up to date' : s.outcome === 'invalid' ? 'Last scan was rejected' : 'Last scan failed'} · scanned ${rel(s.observedAt)}`;
});
const badCats = computed(() => (props.proxy?.catalogs || []).filter(x => x.outcome === 'failed').length);
const modelsText = computed(() => {
  const p = props.proxy;
  if (!p) return 'Open to see CLIProxy catalogs';
  if (!p.enabled) return 'Model sync is not configured';
  if (!p.catalogs.length) return 'No CLIProxy catalogs in use';
  return badCats.value ? `${badCats.value} of ${p.catalogs.length} catalogs failing` : 'All catalogs healthy';
});
const activeLinks = computed(() => (props.links || []).filter(l => l.state === 'active').sort((a, b) => (ms(a.expiresAt) ?? 0) - (ms(b.expiresAt) ?? 0)));
const linksText = computed(() => {
  if (props.links === null) return 'Open to see links';
  const first = activeLinks.value[0];
  return first ? `${plural(activeLinks.value.length, 'link')} active · ${first.alias} expires ${until(first.expiresAt)}` : 'No active links';
});
const lockText = computed(() => `${session.scopeTitle()} access: ${!session.can('operate') ? 'sync and add are' : 'adding machines is'} unavailable.`);
</script>

<template>
  <section class="health" aria-labelledby="h-health">
    <div class="health-main">
      <p class="eyebrow">{{ greeting }}, {{ session.state.actor }} · Fleet health</p>
      <h1 id="h-health" ref="h1" tabindex="-1">{{ live.length ? `${counts.ok} of ${live.length} ${live.length === 1 ? 'machine is' : 'machines are'} up to date` : 'No machines yet' }}</h1>
      <p class="health-sub">{{ sub }}</p>
      <div v-if="live.length" class="health-bar">
        <Segbar :parts="parts" label="Machines by health" />
        <Legend :parts="parts" clickable @pick="emit('jump', $event)" />
      </div>
    </div>
    <div class="health-actions">
      <div class="btn-row">
        <ScopeButton level="operate" cls="btn-secondary" data-act="sync" :disabled="syncing" @click="emit('sync')"><Icon name="sync" :class="{ spin: syncing }" />{{ syncing ? 'Syncing…' : 'Sync repository' }}</ScopeButton>
        <ScopeButton level="admin" cls="btn-primary" data-act="add" @click="emit('add')"><Icon name="plus" />Add machine</ScopeButton>
      </div>
      <p class="muted small">{{ source ? `Last scan ${rel(source.observedAt)}` : 'No repository scan yet' }}{{ rev ? ` · ${shortSha(rev.sourceRevision)} published ${rel(rev.acceptedAt)}` : '' }}</p>
      <p v-if="!(session.can('operate') && session.can('admin'))" class="lock-note"><Icon name="lock" /><span>{{ lockText }}</span></p>
    </div>
    <div class="tiles">
      <RouterLink class="tile" :to="{ name: 'deployments' }">
        <span class="tile-ic t-info"><Icon name="rocket" /></span>
        <span class="tile-txt">
          <b>{{ deployTitle }}</b>
          <span v-if="commitInfo?.subject" class="tile-commit" :data-tip="commitTip">{{ commitInfo.subject }}</span>
          <span>{{ assignments.total ? `${num(assignments.succeeded)} of ${num(assignments.total)} assignments done` : 'No assignments yet' }}
            <span class="tile-meter" role="img" :aria-label="`${assignments.succeeded} of ${assignments.total} assignments succeeded`"><span :style="{ width: ((assignments.succeeded / Math.max(1, assignments.total)) * 100).toFixed(1) + '%' }"></span></span></span>
        </span>
        <Icon name="chevR" class="tile-chev" />
      </RouterLink>
      <RouterLink class="tile" :to="{ name: 'repository' }">
        <span class="tile-ic" :class="!source || scanOk ? 't-good' : 't-warning'"><Icon name="branch" /></span>
        <span class="tile-txt"><b>Repository</b><span>{{ scanText }}</span></span>
        <StatusGlyph v-if="source && !scanOk" level="warning" kind="bang" class="tile-g" />
        <Icon name="chevR" class="tile-chev" />
      </RouterLink>
      <RouterLink class="tile" :to="{ name: 'models' }">
        <span class="tile-ic" :class="badCats ? 't-warning' : 't-good'"><Icon name="spark" /></span>
        <span class="tile-txt"><b>Models</b><span>{{ modelsText }}</span></span>
        <StatusGlyph v-if="badCats" level="warning" kind="bang" class="tile-g" />
        <Icon name="chevR" class="tile-chev" />
      </RouterLink>
      <RouterLink class="tile" :to="{ name: 'enrollment' }">
        <span class="tile-ic t-neutral"><Icon name="link" /></span>
        <span class="tile-txt"><b>Enrollment</b><span>{{ linksText }}</span></span>
        <Icon name="chevR" class="tile-chev" />
      </RouterLink>
    </div>
  </section>
</template>
