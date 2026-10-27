<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue';
import type { CatalogStatus, CliProxySelectionResponse, CliProxyStatus, PinnedModelExcludedBody, SaveSelectionResponse } from '@/api/types';
import EmptyState from '@/components/EmptyState.vue';
import ErrorState from '@/components/ErrorState.vue';
import Icon from '@/components/Icon.vue';
import InlineError from '@/components/InlineError.vue';
import LoadingBlock from '@/components/LoadingBlock.vue';
import LockNote from '@/components/LockNote.vue';
import MdText from '@/components/MdText.vue';
import PageHead from '@/components/PageHead.vue';
import ScopeButton from '@/components/ScopeButton.vue';
import StatusGlyph from '@/components/StatusGlyph.vue';
import StatusPill from '@/components/StatusPill.vue';
import { useLoad } from '@/composables/useLoad';
import { useFleet } from '@/context';
import type { Token } from '@/lib/lanes';
import { isSilent } from '@/lib/errors';
import { hostOf, ms, now, num, rel, span, until } from '@/lib/format';
import {
  effective, families, familyBase, familyKey, interval, isDirty, makeEntry, preserveVisible, unsavedText, type SelectionEntry,
} from './modelsPolicy';
import { catchUpModelsPage, registerModelsPage } from './modelsPage';

/**
 * Models: CLIProxy catalog status and the per-proxy model selection. API: GET cliproxy/status, GET cliproxy/selection, GET errors,
 * POST cliproxy/refresh (operate), POST cliproxy/selection (operate).
 *
 * A save or refresh outlives the screen that started it. When its answer arrives for a screen that is gone (or replaced by a newer
 * load) nothing of that screen is painted: it is reported in a toast, and the Models page that is open now, if any, is reloaded
 * quietly so it shows the saved state.
 */
const { api, catalog, session, summary, shell, shared, toasts } = useFleet();

const status = shallowRef<CliProxyStatus | null>(null);
const sel = ref<SelectionEntry[]>([]);
const selErr = shallowRef<Error | null>(null);
const tab = ref(0);
const msg = ref('');
const saving = ref(false);

/* Returns the selections without touching state, so the caller can drop a result that a newer load has replaced. */
async function readSelection(token: Token): Promise<{ sel: SelectionEntry[]; err: Error | null }> {
  try {
    const r = await api.get<CliProxySelectionResponse>('cliproxy/selection', undefined, { signal: token.signal });
    return { sel: (r?.catalogs ?? []).map(makeEntry), err: null };
  } catch (e) {
    if (isSilent(e)) throw e;
    return { sel: [], err: e as Error };
  }
}
async function loadSelection(token: Token): Promise<void> {
  const r = await readSelection(token);
  token.check();
  sel.value = r.sel;
  selErr.value = r.err;
}

const load = useLoad(async token => {
  const [st, selection] = await Promise.all([api.get<CliProxyStatus>('cliproxy/status', undefined, { signal: token.signal }), readSelection(token), catalog.load()]);
  token.check();
  status.value = st;
  sel.value = selection.sel;
  selErr.value = selection.err;
  msg.value = '';
  saving.value = false;
  void summary.refresh();
  shell.markLoaded();
  return true;
});
const { data, error, loading, reload } = load;
registerModelsPage(() => { void load.run({ quiet: true }); });

const cur = computed(() => Math.min(tab.value, Math.max(0, sel.value.length - 1)));
const entry = computed(() => sel.value[cur.value]);
const cats = computed(() => status.value?.catalogs ?? []);
const refreshing = computed(() => shared.refreshing);

const ok = (c: CatalogStatus): boolean => c.outcome !== 'failed';
const lastOld = (c: CatalogStatus): string | null => (c.lastSuccess ? span(now() - (ms(c.lastSuccess) ?? now())) : null);

/* ------------------------------------------------------------------ editor */
const off = computed(() => !session.can('operate') || saving.value);
function toggleFlag(flag: 'includeNew' | 'skipClaudeModelsForOtherClients'): void {
  const e = entry.value;
  if (!e) return;
  if (flag === 'includeNew') {
    preserveVisible(e);
    e.policy.includeNew = !e.policy.includeNew;
  } else e.policy.skipClaudeModelsForOtherClients = !e.policy.skipClaudeModelsForOtherClients;
}
function toggleFamily(key: string): void {
  const e = entry.value;
  if (!e) return;
  const enable = !familyBase(e.policy, key);
  const dis = new Set(e.policy.disabledFamilies);
  const en = new Set(e.policy.enabledFamilies);
  if (enable) { dis.delete(key); en.add(key); } else { dis.add(key); en.delete(key); }
  e.policy.disabledFamilies = [...dis];
  e.policy.enabledFamilies = [...en];
  for (const m of e.models.filter(x => familyKey(x) === key)) delete e.policy.modelOverrides[m.id];
}
function toggleModel(famKey: string, id: string, checked: boolean): void {
  const e = entry.value;
  if (!e) return;
  if (checked === familyBase(e.policy, famKey)) delete e.policy.modelOverrides[id];
  else e.policy.modelOverrides[id] = checked;
}
function reset(): void {
  const e = entry.value;
  if (e) e.policy = JSON.parse(e.saved);
}

/* ------------------------------------------------------------------ save */
async function save(): Promise<void> {
  const e = entry.value;
  const tok = load.lane.current();
  if (!e || !tok || saving.value) return;
  preserveVisible(e);
  saving.value = true;
  const host = hostOf(e.baseUrl);
  msg.value = `Saving selection for ${host}…`;
  let saved: SaveSelectionResponse | null = null;
  type Failure = Error & { code?: string | null; details?: unknown; silent?: boolean };
  let failure = null as Failure | null;
  try {
    saved = await api.post<SaveSelectionResponse>('cliproxy/selection', { baseUrl: e.baseUrl, version: e.version, policy: e.policy });
  } catch (err) {
    failure = err as Failure;
  }
  if (failure) {
    if (failure.silent) {
      if (tok.isCurrent()) saving.value = false;
      return;
    }
    toasts.fail(failure, 'Selection was not saved');
    if (!tok.isCurrent()) { catchUpModelsPage(); return; }
    if (failure.code === 'stale_selection' || failure.code === 'catalog_unavailable') {
      try { await loadSelection(tok); } catch { return; } // a newer load took over
      msg.value = failure.message;
    } else {
      const pinned = failure.code === 'pinned_model_excluded' ? (failure.details as Partial<PinnedModelExcludedBody> | null)?.models : undefined;
      msg.value = failure.message + (pinned?.length ? ` Pinned models: ${pinned.join(', ')}.` : '');
    }
  } else if (saved) {
    toasts.push('Selection saved', { text: `${host}. Agents receive it on their next poll.` });
    if (!tok.isCurrent()) { catchUpModelsPage(); return; }
    const at = sel.value.findIndex(x => x.baseUrl === e.baseUrl);
    if (at >= 0) sel.value[at] = makeEntry(saved.catalog);
    msg.value = `Selection saved for ${host}. Agents receive it on their next poll.`;
  }
  saving.value = false;
}

/* ------------------------------------------------------------------ refresh */
async function refreshModels(): Promise<void> {
  if (shared.refreshing) return;
  const tok = load.lane.current();
  shared.refreshing = true;
  toasts.push('Refreshing model catalogs', { tone: 'info', text: 'Fetching models and reasoning efforts from CLIProxy…' });
  let reloaded = false;
  try {
    const st = await api.post<CliProxyStatus>('cliproxy/refresh', {});
    const all = st.catalogs || [];
    const bad = all.filter(c => c.outcome === 'failed');
    const good = all.length - bad.length;
    shared.lastRefresh = bad.length
      ? { level: 'warning', kind: 'bang', label: 'Refreshed', text: `Refreshed. ${good} catalog${good === 1 ? '' : 's'} updated; ${bad.map(c => `${hostOf(c.baseUrl)} still fails (${c.errorCode || 'refresh_failed'})`).join(', ')}.` }
      : { level: 'good', kind: 'check', label: 'Refreshed', text: all.length ? 'Refreshed. All catalogs updated.' : 'Refreshed. No catalogs are in use yet.' };
    toasts.push(bad.length ? 'A catalog is still failing' : 'Model catalogs refreshed', { tone: bad.length ? 'warning' : 'good', text: shared.lastRefresh.text });
    if (tok?.isCurrent()) { status.value = st; await loadSelection(tok); } else reloaded = true;
  } catch (e) {
    toasts.fail(e, 'Model refresh could not be confirmed');
  }
  shared.refreshing = false;
  void summary.refresh(true);
  if (reloaded) catchUpModelsPage();
}
</script>

<template>
  <LoadingBlock v-if="loading" />
  <div v-else class="wrap">
    <ErrorState v-if="error" :error="error" what="Models" @retry="reload()" />
    <template v-else-if="data && status">
      <PageHead title="Models" sub="CLIProxy model catalogs that Fleet sends to AI clients. They refresh on their own schedule, independently of the repository.">
        <template #actions>
          <ScopeButton level="operate" cls="btn-secondary" data-act="refresh-models" :disabled="refreshing" @click="refreshModels()"><Icon name="sync" :class="{ spin: refreshing }" />{{ refreshing ? 'Refreshing…' : 'Refresh models' }}</ScopeButton>
        </template>
      </PageHead>
      <div class="keybar">
        <StatusGlyph v-if="status.enabled" level="good" kind="check" /><StatusGlyph v-else level="critical" kind="x" />
        <span><b>{{ status.enabled ? 'Fleet key configured' : 'No CLIProxy key' }}</b> <span class="muted">· set as FLEET_CLIPROXY_API_KEY on the Server, never in Git</span></span>
        <span class="keybar-sep"></span>
        <span><Icon name="clock" />Refreshes every {{ interval(status.intervalSeconds) }}</span>
      </div>
      <p v-if="shared.lastRefresh" class="result" role="status"><StatusGlyph :level="shared.lastRefresh.level" :kind="shared.lastRefresh.kind" />{{ shared.lastRefresh.text }}</p>
      <LockNote level="operate" />
      <div v-if="!status.enabled" class="callout callout--warning">
        <StatusGlyph level="warning" kind="bang" />
        <div><b>Model sync is disabled</b><p>Configure the CLIProxy API key on the Server to fetch model catalogs.</p></div>
      </div>
      <EmptyState v-else-if="!cats.length" icon="spark" title="No CLIProxy catalogs yet" text="Catalogs appear once an active machine is assigned an AI client that uses CLIProxy. Enable one in the repository and sync it first." />
      <div v-if="cats.length" class="cols">
        <section v-for="c in cats" :key="c.baseUrl" class="panel cat" :class="{ 'cat--err': !ok(c) }">
          <header class="cat-head">
            <span class="cat-ic"><Icon name="server" /></span>
            <div><h2 class="mono">{{ hostOf(c.baseUrl) }}</h2><p class="mono small muted">{{ c.baseUrl }}</p></div>
            <StatusPill v-if="ok(c)" level="good" kind="check" label="Healthy" />
            <StatusPill v-else level="critical" kind="x" label="Refresh failing" />
          </header>
          <dl class="kv kv--grid kv--3">
            <div><dt>Models</dt><dd>{{ num(c.modelCount) }}</dd></div>
            <div><dt>Last success</dt><dd>{{ c.lastSuccess ? rel(c.lastSuccess) : 'Never' }}</dd></div>
            <div><dt>Next refresh</dt><dd>{{ c.nextRefresh ? until(c.nextRefresh) : '—' }}</dd></div>
          </dl>
          <div v-if="!ok(c)" class="callout callout--critical">
            <StatusGlyph level="critical" kind="x" />
            <div>
              <b><code>{{ c.errorCode || 'refresh_failed' }}</code><template v-if="catalog.get(c.errorCode)">: {{ catalog.get(c.errorCode)?.title }}</template></b>
              <p><template v-if="catalog.get(c.errorCode)"><MdText :text="catalog.get(c.errorCode)?.explanation" /> </template>{{ c.modelCount ? `Agents keep the last valid catalog${lastOld(c) ? `, ${lastOld(c)} old` : ''}, so AI clients keep working. New models will not arrive until this is fixed.` : 'No catalog is available yet.' }}</p>
              <RouterLink class="more" :to="{ name: 'problems' }">See Problems<Icon name="arrowR" /></RouterLink>
            </div>
          </div>
        </section>
      </div>
      <section class="panel">
        <header class="panel-head row">
          <div><h2>Model selection</h2><p>Choose which models Fleet sends to assigned Agents. Each proxy address has its own selection. Models pinned in fleet.yml cannot be excluded.</p></div>
          <div v-if="sel.length > 1" class="seg-ctl" role="group" aria-label="Catalog">
            <button v-for="(e, k) in sel" :key="e.baseUrl" type="button" data-act="sel-tab" :data-v="k" :aria-pressed="k === cur" @click="tab = k">{{ hostOf(e.baseUrl) }}<span v-if="isDirty(e)" class="dirty-dot" aria-label="unsaved changes"></span></button>
          </div>
        </header>
        <InlineError v-if="selErr" :error="selErr" what="the model selection" />
        <p id="sel-msg" class="field-msg" role="status">{{ msg }}</p>
        <template v-if="entry">
          <div class="sel-opts">
            <div class="opt">
              <button type="button" role="switch" class="switch" :aria-checked="entry.policy.skipClaudeModelsForOtherClients" data-act="sel-flag" data-flag="skipClaudeModelsForOtherClients" :disabled="off" aria-label="Skip Claude models for other clients" @click="toggleFlag('skipClaudeModelsForOtherClients')"><span></span></button>
              <div><b>Skip Claude models for other clients</b><p>Codex and OpenCode skip Claude models. Claude Code can still use the selected Claude models.</p></div>
            </div>
            <div class="opt">
              <button type="button" role="switch" class="switch" :aria-checked="entry.policy.includeNew" data-act="sel-flag" data-flag="includeNew" :disabled="off" aria-label="Enable newly discovered families by default" @click="toggleFlag('includeNew')"><span></span></button>
              <div><b>Enable newly discovered families by default</b><p>New models in an enabled family follow its switch. Only families first discovered later use this default.</p></div>
            </div>
          </div>
          <div class="fams">
            <fieldset v-for="f in families(entry)" :key="f.key" class="fam">
              <legend class="sr">{{ f.label }} models</legend>
              <div class="fam-head">
                <span class="fam-name">{{ f.label }}</span>
                <span class="muted small">{{ f.models.filter(m => effective(entry!.policy, m)).length }} of {{ f.models.length }} selected</span>
                <button type="button" role="switch" class="switch" :aria-checked="familyBase(entry.policy, f.key)" data-act="sel-fam" :data-fam="f.key" :disabled="off" :aria-label="`Sync ${f.label} models`" @click="toggleFamily(f.key)"><span></span></button>
              </div>
              <ul class="models">
                <li v-for="m in f.models" :key="m.id">
                  <label class="model-check"><input type="checkbox" :data-sel-model="m.id" :data-fam="f.key" :checked="effective(entry.policy, m)" :disabled="off" @change="toggleModel(f.key, m.id, ($event.target as HTMLInputElement).checked)"><span class="mono">{{ m.id }}</span></label>
                  <span v-if="(m.reasoningLevels || []).length" class="levels" aria-label="Reasoning levels"><span v-for="r in m.reasoningLevels" :key="r" class="lvl">{{ r }}</span></span>
                </li>
              </ul>
            </fieldset>
          </div>
          <div class="sel-bar" :class="{ 'is-dirty': isDirty(entry) }" role="status">
            <span>{{ isDirty(entry) ? unsavedText(entry, hostOf(entry.baseUrl)) : 'All changes saved' }}</span>
            <button type="button" class="btn btn-secondary btn-sm" data-act="sel-reset" :disabled="!isDirty(entry) || saving" @click="reset()">Reset</button>
            <ScopeButton level="operate" cls="btn-primary btn-sm" data-act="sel-save" :disabled="!isDirty(entry) || saving" @click="save()">{{ saving ? 'Saving…' : 'Save selection' }}</ScopeButton>
          </div>
        </template>
        <div v-else-if="!selErr" class="empty-mini"><Icon name="spark" /><p>No model selections are available. Refresh models after assigning CLIProxy to an active machine.</p></div>
      </section>
    </template>
  </div>
</template>
