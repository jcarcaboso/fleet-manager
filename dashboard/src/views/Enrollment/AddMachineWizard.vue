<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { CreateEnrollmentLinkResponse, EnrollmentLink, NodeDetail } from '@/api/types';
import DeviceArt from '@/components/DeviceArt.vue';
import Icon from '@/components/Icon.vue';
import Modal from '@/components/Modal.vue';
import StatusGlyph from '@/components/StatusGlyph.vue';
import StatusPill from '@/components/StatusPill.vue';
import StepsList from '@/components/StepsList.vue';
import CopyBox from '@/components/CopyBox.vue';
import Countdown from '@/components/Countdown.vue';
import CountdownBar from '@/components/CountdownBar.vue';
import { useNow } from '@/composables/useNow';
import { useView } from '@/composables/useView';
import { useFleet } from '@/context';
import { isSilent } from '@/lib/errors';
import { clock, enc, fmtTime, ms, now, platformLabel } from '@/lib/format';
import type { Token } from '@/lib/lanes';
import { nodeRoute } from '@/router';
import { ALIAS_HINT, EXPIRIES, aliasError, installSteps, type WizardPlatform } from './enrollment';
import { useEnrollmentBus } from './enrollmentBus';

/**
 * The Add machine wizard (ported from view-enrollment.js): name it, install and enroll, then wait for the first check-in.
 * `AppShell` mounts it while `useFleet().wizard.open` is true. The Enrollment page starts it with an alias and an expiry through the
 * enrollment bus; everything else opens it empty.
 *
 * API: POST enrollment-links (admin), POST enrollment-links/{id}/revoke, and, while it waits, GET enrollment-links/{id} for its own link
 * and then GET nodes/{node} to detect the first check-in. Polling stops when the Node is found, when the link's expiry passes unused, when
 * the link is revoked, when the Node has not checked in for NODE_WAIT_MS after enrolling, and when the wizard closes or the route changes.
 * Every poll request has its own timeout, and the deadlines are checked before each request and after each failure, so a failing Server
 * cannot keep the wizard waiting past them. The created link is shown once, kept only in this dialog, and cleared when it closes.
 */
const emit = defineEmits<{ close: [] }>();
const { api, session, toasts } = useFleet();
const bus = useEnrollmentBus();
const route = useRoute();
const view = useView();
const polling = view.lane(); // only the newest poll counts
const clockNow = useNow();

const POLL_MS = 4000;
const NODE_WAIT_MS = 10 * 60 * 1000;
const REQUEST_MS = 8000;

const allowed = session.can('admin');
interface WizardLink {
  id: string;
  alias: string;
  expiresAt: string;
  url: string;
}
const W = reactive({
  step: 1, alias: '', expiry: 900, platform: 'macos' as WizardPlatform, err: null as string | null, link: null as WizardLink | null,
  phase: 0, node: null as NodeDetail | null, startedAt: 0, expired: false, stalled: false, expiresMs: 0, consumedMs: 0,
  nodeKey: null as string | null, busy: false, revoking: false,
});
/* Changes whenever the wizard is reset or closed, so a request that is still in flight can tell it is obsolete. */
let gen = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

const heading = ref<HTMLElement | null>(null);
const aliasInput = ref<HTMLInputElement | null>(null);
const dialog = (): HTMLElement | null => heading.value?.closest<HTMLElement>('.modal') ?? null;
/* The first thing worth focusing in the dialog (the old `focusModal`). */
function focusModal(): void {
  const d = dialog();
  (d?.querySelector<HTMLElement>('[data-autofocus]') ?? d?.querySelector<HTMLElement>('input:not([disabled]), button:not(.icon-btn):not([disabled]), a[href]'))?.focus();
}
/* After the content changed: focus moves on when what had it is gone. */
async function refocus(force = false): Promise<void> {
  await nextTick();
  const d = dialog();
  if (force || !d || !d.contains(document.activeElement) || document.activeElement === d) focusModal();
}

const online = computed(() => W.phase === 2);
const preview = computed(() => ({ platform: W.platform, freshness: online.value ? 'fresh' : 'never_contacted', revoked: false }));
const title = computed(() => [
  'Name your new machine', 'Install the Agent and enroll', online.value ? `${W.alias} is online` : `Waiting for ${W.alias} to check in`,
][W.step - 1] as string);
const STEPS = ['Name it', 'Install & enroll', 'First check-in'];
const stepClass = (i: number): string => (i + 1 < W.step || (i === 2 && online.value) ? 'done' : i + 1 === W.step ? 'cur' : '');
const elapsed = computed(() => clock(clockNow.value - W.startedAt));
const mac = computed(() => W.platform === 'macos');
const steps = computed(() => installSteps(mac.value));
const checks = computed(() => [
  { done: true, cur: false, text: 'Enrollment link created' },
  { done: W.phase >= 1, cur: W.phase === 0 && !W.expired, text: W.phase >= 1 ? 'Agent enrolled and the link was used' : 'Waiting for the Agent to enroll…' },
  { done: online.value, cur: W.phase === 1 && !W.stalled, text: online.value ? `First check-in received ${fmtTime(W.node?.lastContactAt ?? null)} UTC` : 'Waiting for the first check-in…' },
]);

/* ---------------------------------------------------------------- lifecycle */

function halt(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  polling.cancel();
}
/* The wizard closes (or restarts): polling stops, and the link and the machine are forgotten. A link that was created is reflected in the lists behind. */
function stop(): void {
  const created = !!W.link;
  gen++;
  halt();
  W.link = null;
  W.node = null;
  W.err = null;
  if (created) bus.changed();
}
onBeforeUnmount(stop);

/* A new wizard in the same dialog ("Create a new link", "Add another"). */
function restart(alias = ''): void {
  stop();
  Object.assign(W, { step: 1, alias, expiry: 900, platform: 'macos', err: null, link: null, phase: 0, node: null, expired: false, stalled: false, nodeKey: null, busy: false, revoking: false });
  void refocus(true);
}

/* Going to another page closes the wizard. */
watch(() => route.fullPath, () => emit('close'));
/* A revocation from the Enrollment page that answers late: close the wizard only if it still shows that link. */
watch(() => bus.revokedTick, () => { if (W.link && W.link.id === bus.revokedId) emit('close'); });

onMounted(() => {
  if (!allowed) {
    toasts.push('Not available', { tone: 'warning', text: session.denied('admin') });
    emit('close');
  }
});

/* ---------------------------------------------------------------- step 1: create the link */

/* The request outlives the dialog that started it: the user can close the wizard, or open another one, before it answers.
   `gen` says whether this wizard is still the one on screen. An obsolete answer changes nothing, and a link that was created for
   a wizard nobody is looking at is only reflected in the lists behind it. */
async function createLink(): Promise<void> {
  const alias = W.alias.trim();
  const err = aliasError(alias);
  if (err) {
    W.err = err;
    await nextTick();
    aliasInput.value?.focus();
    return;
  }
  W.alias = alias;
  const mine = gen;
  const expiry = W.expiry;
  W.busy = true;
  let created: CreateEnrollmentLinkResponse | null = null;
  let failure: { message: string; silent?: boolean } | null = null;
  try {
    created = await api.post<CreateEnrollmentLinkResponse>('enrollment-links', { alias, expiresInSeconds: expiry });
  } catch (e) {
    failure = e as { message: string; silent?: boolean };
  }
  if (mine !== gen) {
    if (created) bus.changed();
    return;
  }
  W.busy = false;
  if (failure) {
    if (isSilent(failure)) return;
    W.err = failure.message;
    bus.formMsg = failure.message;
    bus.formErr = true;
    await nextTick();
    aliasInput.value?.focus();
    return;
  }
  if (!created) return;
  W.link = { id: created.id, alias, expiresAt: created.expiresAt, url: created.link };
  W.expiresMs = ms(created.expiresAt) ?? now() + expiry * 1000;
  W.step = 2;
  W.err = null;
  W.expired = false;
  W.stalled = false;
  toasts.push('Enrollment link created', { text: `Valid until ${fmtTime(created.expiresAt)} UTC.` });
  void refocus(true);
}

/* ---------------------------------------------------------------- step 3: wait for the Agent */

/* Detect enrollment and the first check-in with the same read endpoints the rest of the dashboard uses.
   The wizard asks for its own link by ID, so it never depends on where the link falls in the list.
   Each phase has a deadline: the link's expiry, then NODE_WAIT_MS after it was used. A poll that starts after the deadline takes one
   last bounded look, so a link used in its final seconds is not reported as expired, and then gives up whatever that look returns.
   A request that fails or times out is not a reason to stop early, and it is never a reason to wait past the deadline. */
const deadline = (): number => (W.phase === 0 ? W.expiresMs : W.consumedMs + NODE_WAIT_MS);
function schedule(token: Token): void {
  const wait = Math.max(250, Math.min(POLL_MS, deadline() - now() + 50));
  timer = setTimeout(() => void poll(token), wait);
}
function startPoll(delay: number): void {
  halt();
  const token = polling.begin();
  timer = setTimeout(() => void poll(token), delay);
}
/* One GET bounded by REQUEST_MS. A timeout is reported as an error with `timedOut` set, so it is told apart from a cancel. */
function read<T>(path: string, token: Token): Promise<T> {
  const ctl = new AbortController();
  let timedOut = false;
  const abort = (): void => ctl.abort();
  if (token.signal.aborted) ctl.abort();
  token.signal.addEventListener('abort', abort, { once: true });
  const guard = setTimeout(() => { timedOut = true; ctl.abort(); }, REQUEST_MS);
  return api.get<T>(path, undefined, { signal: ctl.signal })
    .catch((e: unknown) => { if (timedOut && e && typeof e === 'object') (e as { timedOut?: boolean }).timedOut = true; throw e; })
    .finally(() => { clearTimeout(guard); token.signal.removeEventListener('abort', abort); });
}
/* Whether polling goes on after this failure: not when the wizard moved on, the user was signed out or the request was cancelled. */
const retryable = (e: unknown, token: Token): boolean => token.isCurrent() && (!isSilent(e) || !!(e as { timedOut?: boolean }).timedOut);

async function poll(token: Token): Promise<void> {
  if (!token.isCurrent() || W.step !== 3 || !W.link) return;
  const link = W.link;
  if (W.phase === 0) {
    const last = now() >= W.expiresMs;
    let mine: EnrollmentLink | null = null;
    try {
      mine = await read<EnrollmentLink>(`enrollment-links/${enc(link.id)}`, token);
    } catch (e) {
      if (!retryable(e, token)) return;
    }
    if (!token.isCurrent()) return;
    if (mine?.state === 'consumed') {
      W.phase = 1;
      W.consumedMs = now();
      W.nodeKey = mine.nodeId || null;
      void refocus();
    } else if (mine?.state === 'revoked' || mine?.state === 'expired' || last || now() >= W.expiresMs) {
      W.expired = true;
      void refocus(true);
      return;
    } else if (mine) W.nodeKey = mine.nodeId || null;
  }
  if (W.phase === 1) {
    const last = now() - W.consumedMs > NODE_WAIT_MS;
    try {
      const node = await read<NodeDetail>(`nodes/${enc(W.nodeKey || link.alias)}`, token);
      if (!token.isCurrent()) return;
      if (node?.lastContactAt) {
        W.node = node;
        W.phase = 2;
        toasts.push(`${link.alias} checked in`);
        void refocus(true);
        return;
      }
    } catch (e) {
      if ((e as { code?: string }).code !== 'node_not_found' && !retryable(e, token)) return;
    }
    if (!token.isCurrent()) return;
    if (last || now() > deadline()) {
      W.stalled = true;
      void refocus(true);
      return;
    }
  }
  schedule(token);
}

/* ---------------------------------------------------------------- actions */

function wait(): void {
  W.step = 3;
  W.phase = 0;
  W.expired = false;
  W.stalled = false;
  W.startedAt = now();
  gen++;
  startPoll(1200);
  void refocus(true);
}
function back(): void {
  halt();
  W.step = 2;
  void refocus(true);
}
function recheck(): void {
  W.stalled = false;
  W.consumedMs = now();
  startPoll(300);
  void refocus(true);
}
async function revokeLink(): Promise<void> {
  const l = W.link;
  if (!l || W.revoking) return;
  W.revoking = true;
  try {
    await api.post(`enrollment-links/${enc(l.id)}/revoke`, {});
    toasts.push('Enrollment link revoked');
    bus.revoked(l.id);
    /* Close the wizard only if it is still showing this link. */
    if (W.link && W.link.id === l.id) emit('close');
  } catch (e) {
    W.revoking = false;
    toasts.fail(e, 'Link was not revoked');
  }
}
function setPlatform(p: WizardPlatform): void {
  W.platform = p;
  void nextTick(() => document.getElementById(`os-${p}`)?.focus());
}
function tabKey(e: KeyboardEvent): void {
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    setPlatform(W.platform === 'macos' ? 'linux' : 'macos');
  }
}

/* The Enrollment page's form hands over an alias and an expiry and the link is created at once. */
const request = bus.request;
bus.request = null;
if (request) {
  W.alias = request.alias;
  W.expiry = request.expiry;
  if (allowed) void createLink();
}
</script>

<template>
  <Modal v-if="allowed" title="Add a machine" wide bare @close="emit('close')">
    <template #head="{ titleId }">
      <div class="modal-head wz-head">
        <div><p class="eyebrow">Add machine · step {{ W.step }} of 3</p><h2 :id="titleId" ref="heading">{{ title }}</h2></div>
        <button type="button" class="icon-btn" data-act="modal-close" aria-label="Close" @click="emit('close')"><Icon name="x" /></button>
      </div>
      <ol class="wz-steps">
        <li v-for="(s, i) in STEPS" :key="s" :class="stepClass(i)"><span class="wz-n"><StatusGlyph v-if="stepClass(i) === 'done'" level="good" kind="check" /><template v-else>{{ i + 1 }}</template></span>{{ s }}</li>
      </ol>
    </template>

    <form v-if="W.step === 1" class="wz-body wz-1" data-form="wz" novalidate @submit.prevent="createLink">
      <div id="wz-art" class="wz-art"><DeviceArt :node="preview" :health="null" /></div>
      <div class="wz-form">
        <label for="wz-alias">Machine alias</label>
        <input id="wz-alias" ref="aliasInput" v-model="W.alias" class="input" placeholder="e.g. office-mini" maxlength="201" autocomplete="off" spellcheck="false" data-autofocus aria-describedby="wz-alias-msg" :aria-invalid="!!W.err" @input="W.err = null">
        <p id="wz-alias-msg" class="field-msg" :class="{ 'is-err': W.err }" role="status">{{ W.err || ALIAS_HINT }}</p>
        <fieldset class="radios"><legend>Platform</legend>
          <label class="radio-card"><input v-model="W.platform" type="radio" name="wz-plat" value="macos"><span><Icon name="apple" />macOS</span></label>
          <label class="radio-card"><input v-model="W.platform" type="radio" name="wz-plat" value="linux"><span><Icon name="tux" />Linux</span></label>
        </fieldset>
        <fieldset class="radios"><legend>Link expires after</legend>
          <label v-for="[v, l] in EXPIRIES" :key="v" class="radio-card"><input v-model="W.expiry" type="radio" name="wz-exp" :value="v"><span>{{ l }}</span></label>
        </fieldset>
        <p class="muted small">The link is single-use, bound to this alias and includes the Server’s public CA. Treat it as a secret until it is used or expires.</p>
      </div>
      <div class="modal-foot wz-foot">
        <button type="button" class="btn btn-secondary" data-act="modal-close" @click="emit('close')">Cancel</button>
        <button id="wz-create" type="submit" class="btn btn-primary" :disabled="W.busy">Create link<Icon name="arrowR" /></button>
      </div>
    </form>

    <template v-else-if="W.step === 2 && W.link">
      <div class="wz-body">
        <div class="wz-link">
          <div class="wz-link-top"><b>One-time enrollment link for {{ W.link.alias }}</b><span class="cd"><Icon name="clock" />Expires in <b><Countdown :to="W.link.expiresAt" fmt="clock" /></b></span></div>
          <div class="wz-meter" role="presentation"><CountdownBar :to="W.link.expiresAt" :total-ms="W.expiry * 1000" /></div>
          <CopyBox :cmd="W.link.url" label="Copy link" class="cmd--link" />
          <p class="muted small">Anyone with this link can enroll <b>{{ W.link.alias }}</b> until it expires or is used. It is shown only here and is not stored; copy it only to the intended machine.</p>
        </div>
        <div class="os-tabs" role="tablist" aria-label="Platform" @keydown="tabKey">
          <button id="os-macos" type="button" role="tab" :aria-selected="W.platform === 'macos'" aria-controls="os-panel" data-act="wz-os" :tabindex="W.platform === 'macos' ? 0 : -1" @click="setPlatform('macos')"><Icon name="apple" />macOS</button>
          <button id="os-linux" type="button" role="tab" :aria-selected="W.platform === 'linux'" aria-controls="os-panel" data-act="wz-os" :tabindex="W.platform === 'linux' ? 0 : -1" @click="setPlatform('linux')"><Icon name="tux" />Linux</button>
        </div>
        <div id="os-panel" class="os-panel" role="tabpanel" :aria-labelledby="`os-${W.platform}`"><StepsList :steps="steps" /></div>
      </div>
      <div class="modal-foot wz-foot">
        <button type="button" class="btn btn-ghost btn-danger-ghost" data-act="revoke-link" :disabled="W.revoking" @click="revokeLink"><Icon name="ban" />Revoke link</button>
        <span class="spacer"></span>
        <button type="button" class="btn btn-primary" data-act="wz-wait" @click="wait">I have run these commands<Icon name="arrowR" /></button>
      </div>
    </template>

    <template v-else-if="W.step === 3">
      <div class="wz-body wz-3">
        <div class="wz-art wz-art--big" :class="online ? 'is-online' : 'is-waiting'"><span class="pulse" aria-hidden="true"></span><DeviceArt :node="preview" :health="null" /></div>
        <div class="wz-wait">
          <template v-if="W.expired"><p class="lead"><StatusGlyph level="warning" kind="bang" /> The link expired before {{ W.alias }} used it.</p><p>Create a new link for the same alias.</p></template>
          <template v-else-if="W.stalled"><p class="lead"><StatusGlyph level="warning" kind="bang" /> {{ W.alias }} enrolled, but it has not checked in yet.</p><p>Fleet stopped listening. Check that the Agent service is running on the machine, then check again.</p></template>
          <p v-else-if="!online" class="lead">Fleet is listening for <b>{{ W.alias }}</b>. This usually takes less than a minute after <code>brew services start</code>.</p>
          <template v-else><p class="lead"><StatusPill level="good" kind="check" label="Checked in" /> {{ platformLabel(W.node?.platform || W.platform) }}</p><p>Add {{ W.alias }} to <span class="mono">fleet.yml</span> to choose its Skill groups, agent files and AI clients.</p></template>
          <ul class="wz-checks" aria-live="polite">
            <li v-for="(c, i) in checks" :key="i" :class="c.done ? 'done' : c.cur ? 'cur' : ''">
              <StatusGlyph v-if="c.done" level="good" kind="check" /><span v-else-if="c.cur" class="spinner" aria-hidden="true"></span><StatusGlyph v-else level="pending" kind="clock" /><span>{{ c.text }}</span>
            </li>
          </ul>
          <p v-if="!online && !W.expired && !W.stalled" class="muted small">Waiting <span>{{ elapsed }}</span> · checking every few seconds</p>
        </div>
      </div>
      <div class="modal-foot wz-foot">
        <template v-if="online">
          <button type="button" class="btn btn-secondary" data-act="wz-again" @click="restart()"><Icon name="plus" />Add another</button>
          <span class="spacer"></span>
          <RouterLink class="btn btn-primary" data-act="wz-view" :to="nodeRoute(W.alias)">View {{ W.alias }}<Icon name="arrowR" /></RouterLink>
        </template>
        <template v-else-if="W.expired">
          <button type="button" class="btn btn-secondary" data-act="modal-close" @click="emit('close')">Close</button>
          <span class="spacer"></span>
          <button type="button" class="btn btn-primary" data-act="wz-new" @click="restart(W.link?.alias || W.alias)"><Icon name="link" />Create a new link</button>
        </template>
        <template v-else-if="W.stalled">
          <button type="button" class="btn btn-secondary" data-act="modal-close" @click="emit('close')">Close</button>
          <span class="spacer"></span>
          <button type="button" class="btn btn-primary" data-act="wz-recheck" @click="recheck"><Icon name="retry" />Check again</button>
        </template>
        <template v-else>
          <button type="button" class="btn btn-secondary" data-act="wz-back" @click="back"><Icon name="chevL" />Show commands</button>
          <span class="spacer"></span>
          <button type="button" class="btn btn-secondary" data-act="modal-close" @click="emit('close')">Close and stop waiting</button>
        </template>
      </div>
    </template>
  </Modal>
</template>
