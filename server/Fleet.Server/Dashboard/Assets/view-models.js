'use strict';
/* Fleet dashboard: Models (CLIProxy catalogs and per-proxy model selection).
   API: GET cliproxy/status, GET cliproxy/selection, GET errors, POST cliproxy/refresh (operate), POST cliproxy/selection (operate). */
(function () {
  const Fleet = window.Fleet = window.Fleet || {};
  const u = Fleet.u, ui = Fleet.ui, api = Fleet.api, catalog = Fleet.catalog;
  const { esc, ic, glyph } = u;
  Fleet.views = Fleet.views || {};

  const S = { status: null, sel: [], selErr: null, tab: 0, msg: '', saving: false, gen: 0 };

  /* ---------------------------------------------------------------- policy logic (same rules as the Server's selection) */
  const familyKey = m => m.familyKey || 'other';
  const familyBase = (policy, key) => policy.disabledFamilies.includes(key) ? false : policy.enabledFamilies.includes(key) ? true : policy.includeNew;
  const effective = (policy, model) => typeof policy.modelOverrides[model.id] === 'boolean' ? policy.modelOverrides[model.id] : familyBase(policy, familyKey(model));
  const snapshot = p => JSON.stringify({ includeNew: p.includeNew, skip: p.skipClaudeModelsForOtherClients, en: [...p.enabledFamilies].sort(), dis: [...p.disabledFamilies].sort(), ov: Object.fromEntries(Object.entries(p.modelOverrides).sort(([a], [b]) => a.localeCompare(b))) });
  const normPolicy = p => ({ includeNew: !!p.includeNew, skipClaudeModelsForOtherClients: p.skipClaudeModelsForOtherClients ?? true, enabledFamilies: [...(p.enabledFamilies || [])], disabledFamilies: [...(p.disabledFamilies || [])], modelOverrides: { ...(p.modelOverrides || {}) } });
  const makeEntry = e => { const policy = normPolicy(e.policy || {}); return { ...e, policy, saved: JSON.stringify(policy) }; };
  const dirty = e => snapshot(e.policy) !== snapshot(JSON.parse(e.saved));
  const families = e => {
    const groups = new Map();
    for (const m of e.models) { const k = familyKey(m); if (!groups.has(k)) groups.set(k, { key: k, label: m.familyLabel || 'Other models', models: [] }); groups.get(k).models.push(m); }
    return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
  };
  const preserveVisible = e => {
    const en = new Set(e.policy.enabledFamilies), dis = new Set(e.policy.disabledFamilies);
    for (const f of families(e)) if (!en.has(f.key) && !dis.has(f.key)) (familyBase(e.policy, f.key) ? en : dis).add(f.key);
    e.policy.enabledFamilies = [...en]; e.policy.disabledFamilies = [...dis];
  };
  const changedCount = e => { const old = JSON.parse(e.saved); let d = (old.includeNew !== e.policy.includeNew) + (old.skipClaudeModelsForOtherClients !== e.policy.skipClaudeModelsForOtherClients); for (const m of e.models) if (effective(old, m) !== effective(e.policy, m)) d++; return d; };

  /* ---------------------------------------------------------------- rendering */
  const interval = s => s % 86400 === 0 ? u.plural(s / 86400, 'day') : s % 3600 === 0 ? u.plural(s / 3600, 'hour') : s % 60 === 0 ? u.plural(s / 60, 'minute') : u.plural(s, 'second');

  const catalogCard = c => {
    const ok = c.outcome !== 'failed';
    const cat = catalog.get(c.errorCode);
    const lastOld = c.lastSuccess ? u.span(u.now() - u.ms(c.lastSuccess)) : null;
    return `<section class="panel cat${ok ? '' : ' cat--err'}"><header class="cat-head"><span class="cat-ic">${ic('server')}</span><div><h2 class="mono">${esc(u.hostOf(c.baseUrl))}</h2><p class="mono small muted">${esc(c.baseUrl)}</p></div>${ok ? u.pill('good', 'check', 'Healthy') : u.pill('critical', 'x', 'Refresh failing')}</header>
    <dl class="kv kv--grid kv--3">
      <div><dt>Models</dt><dd>${u.num(c.modelCount)}</dd></div>
      <div><dt>Last success</dt><dd>${c.lastSuccess ? esc(u.rel(c.lastSuccess)) : 'Never'}</dd></div>
      <div><dt>Next refresh</dt><dd>${c.nextRefresh ? esc(u.until(c.nextRefresh)) : '—'}</dd></div>
    </dl>
    ${ok ? '' : `<div class="callout callout--critical">${glyph('critical', 'x')}<div><b><code>${esc(c.errorCode || 'refresh_failed')}</code>${cat ? `: ${esc(cat.title)}` : ''}</b><p>${cat ? u.md(cat.explanation) + ' ' : ''}${c.modelCount ? `Agents keep the last valid catalog${lastOld ? `, ${esc(lastOld)} old` : ''}, so AI clients keep working. New models will not arrive until this is fixed.` : 'No catalog is available yet.'}</p><a class="more" href="#/problems">See Problems${ic('arrowR')}</a></div></div>`}
    </section>`;
  };

  const sw = (on, act, attrs, label, disabled) => `<button type="button" role="switch" class="switch" aria-checked="${on}" data-act="${act}" ${attrs} ${disabled ? 'disabled' : ''} aria-label="${esc(label)}"><span></span></button>`;

  const editor = i => {
    const e = S.sel[i], p = e.policy, off = !api.can('operate') || S.saving, d = changedCount(e), isDirty = dirty(e);
    const fams = families(e);
    return `<div class="sel-opts">
      <div class="opt">${sw(p.skipClaudeModelsForOtherClients, 'sel-flag', `data-i="${i}" data-flag="skipClaudeModelsForOtherClients"`, 'Skip Claude models for other clients', off)}<div><b>Skip Claude models for other clients</b><p>Codex and OpenCode skip Claude models. Claude Code can still use the selected Claude models.</p></div></div>
      <div class="opt">${sw(p.includeNew, 'sel-flag', `data-i="${i}" data-flag="includeNew"`, 'Enable newly discovered families by default', off)}<div><b>Enable newly discovered families by default</b><p>New models in an enabled family follow its switch. Only families first discovered later use this default.</p></div></div>
    </div>
    <div class="fams">${fams.map(f => {
      const on = f.models.filter(m => effective(p, m)).length;
      return `<fieldset class="fam"><legend class="sr">${esc(f.label)} models</legend><div class="fam-head"><span class="fam-name">${esc(f.label)}</span><span class="muted small">${on} of ${f.models.length} selected</span>${sw(familyBase(p, f.key), 'sel-fam', `data-i="${i}" data-fam="${esc(f.key)}"`, `Sync ${f.label} models`, off)}</div>
        <ul class="models">${f.models.map(m => `<li><label class="model-check"><input type="checkbox" data-on="sel-model" data-sel-model="${esc(m.id)}" data-i="${i}" data-fam="${esc(f.key)}" ${effective(p, m) ? 'checked' : ''} ${off ? 'disabled' : ''}><span class="mono">${esc(m.id)}</span></label>${(m.reasoningLevels || []).length ? `<span class="levels" aria-label="Reasoning levels">${m.reasoningLevels.map(r => `<span class="lvl">${esc(r)}</span>`).join('')}</span>` : ''}</li>`).join('')}</ul></fieldset>`;
    }).join('')}</div>
    <div class="sel-bar${isDirty ? ' is-dirty' : ''}" role="status"><span>${isDirty ? `${u.plural(Math.max(1, d), 'unsaved change')} for ${esc(u.hostOf(e.baseUrl))}` : 'All changes saved'}</span>
      <button type="button" class="btn btn-secondary btn-sm" data-act="sel-reset" data-i="${i}" ${isDirty && !S.saving ? '' : 'disabled'}>Reset</button>
      ${api.can('operate') ? `<button type="button" class="btn btn-primary btn-sm" data-act="sel-save" data-i="${i}" ${isDirty && !S.saving ? '' : 'disabled'}>${S.saving ? 'Saving…' : 'Save selection'}</button>` : ui.locked('operate', 'btn-primary btn-sm', 'Save selection')}</div>`;
  };

  const paint = () => {
    const st = S.status, refreshing = Fleet.shared.refreshing, tab = Math.min(S.tab, Math.max(0, S.sel.length - 1));
    const header = ui.pageHead('Models', 'CLIProxy model catalogs that Fleet sends to AI clients. They refresh on their own schedule, independently of the repository.',
      ui.gate('operate', 'btn-secondary', `${ic('sync', refreshing ? 'spin' : '')}${refreshing ? 'Refreshing…' : 'Refresh models'}`, `data-act="refresh-models" ${refreshing ? 'disabled' : ''}`));
    const keybar = `<div class="keybar">${st.enabled ? glyph('good', 'check') : glyph('critical', 'x')}<span><b>${st.enabled ? 'Fleet key configured' : 'No CLIProxy key'}</b> <span class="muted">· set as FLEET_CLIPROXY_API_KEY on the Server, never in Git</span></span><span class="keybar-sep"></span><span>${ic('clock')}Refreshes every ${esc(interval(st.intervalSeconds))}</span></div>`;
    const cats = st.catalogs || [];
    const note = !st.enabled ? `<div class="callout callout--warning">${glyph('warning', 'bang')}<div><b>Model sync is disabled</b><p>Configure the CLIProxy API key on the Server to fetch model catalogs.</p></div></div>`
      : !cats.length ? ui.empty({ icon: 'spark', title: 'No CLIProxy catalogs yet', text: 'Catalogs appear once an active machine is assigned an AI client that uses CLIProxy. Enable one in the repository and sync it first.' }) : '';
    return `<div class="wrap">${header}${keybar}
    ${Fleet.shared.lastRefresh ? `<p class="result" role="status">${glyph(Fleet.shared.lastRefresh.level, Fleet.shared.lastRefresh.kind)}${esc(Fleet.shared.lastRefresh.text)}</p>` : ''}
    ${ui.lockNote('operate')}
    ${note}
    ${cats.length ? `<div class="cols">${cats.map(catalogCard).join('')}</div>` : ''}
    <section class="panel"><header class="panel-head row"><div><h2>Model selection</h2><p>Choose which models Fleet sends to assigned Agents. Each proxy address has its own selection. Models pinned in fleet.yml cannot be excluded.</p></div>
      ${S.sel.length > 1 ? `<div class="seg-ctl" role="group" aria-label="Catalog">${S.sel.map((e, k) => `<button type="button" data-act="sel-tab" data-v="${k}" aria-pressed="${k === tab}">${esc(u.hostOf(e.baseUrl))}${dirty(e) ? '<span class="dirty-dot" aria-label="unsaved changes"></span>' : ''}</button>`).join('')}</div>` : ''}</header>
      ${S.selErr ? ui.inlineError(S.selErr, 'the model selection') : ''}
      <p class="field-msg" id="sel-msg" role="status">${esc(S.msg)}</p>
      ${S.sel.length ? editor(tab) : (S.selErr ? '' : `<div class="empty-mini">${ic('spark')}<p>No model selections are available. Refresh models after assigning CLIProxy to an active machine.</p></div>`)}
    </section></div>`;
  };

  /* Returns the selections without touching S, so the caller can drop a result that a newer load has replaced. */
  async function readSelection() {
    try { return { sel: ((await api.get('cliproxy/selection'))?.catalogs || []).map(makeEntry), err: null }; }
    catch (e) { if (e.silent) throw e; return { sel: [], err: e }; }
  }
  async function loadSelection(gen) {
    const r = await readSelection();
    if (gen !== undefined && gen !== S.gen) throw Fleet.superseded();
    S.sel = r.sel; S.selErr = r.err;
  }

  Fleet.views.models = {
    title: 'Models',
    async load() {
      const gen = ++S.gen;
      const [status, selection] = await Promise.all([api.get('cliproxy/status'), readSelection(), catalog.load()]);
      if (gen !== S.gen) throw Fleet.superseded();
      S.status = status; S.sel = selection.sel; S.selErr = selection.err; S.msg = ''; S.saving = false;
      Fleet.model.refreshSummary();
      return paint();
    },
    paint,
  };

  /* ---------------------------------------------------------------- actions */
  Fleet.actions['sel-tab'] = el => { S.tab = +el.dataset.v; Fleet.repaint(); };
  Fleet.actions['sel-flag'] = el => {
    const e = S.sel[+el.dataset.i], flag = el.dataset.flag;
    if (flag === 'includeNew') { preserveVisible(e); e.policy.includeNew = !e.policy.includeNew; }
    else e.policy.skipClaudeModelsForOtherClients = !e.policy.skipClaudeModelsForOtherClients;
    Fleet.repaint();
  };
  Fleet.actions['sel-fam'] = el => {
    const e = S.sel[+el.dataset.i], key = el.dataset.fam, enable = !familyBase(e.policy, key);
    const dis = new Set(e.policy.disabledFamilies), en = new Set(e.policy.enabledFamilies);
    if (enable) { dis.delete(key); en.add(key); } else { dis.add(key); en.delete(key); }
    e.policy.disabledFamilies = [...dis]; e.policy.enabledFamilies = [...en];
    for (const m of e.models.filter(x => familyKey(x) === key)) delete e.policy.modelOverrides[m.id];
    Fleet.repaint();
  };
  Fleet.on.change['sel-model'] = t => {
    const e = S.sel[+t.dataset.i], id = t.dataset.selModel;
    if (t.checked === familyBase(e.policy, t.dataset.fam)) delete e.policy.modelOverrides[id]; else e.policy.modelOverrides[id] = t.checked;
    Fleet.repaint();
  };
  Fleet.actions['sel-reset'] = el => { const e = S.sel[+el.dataset.i]; e.policy = JSON.parse(e.saved); Fleet.repaint(); };
  /* A save or refresh outlives the screen that started it. S.gen changes with every load of this view, and the view can also be left
     without a load. An answer for a screen that is gone is not painted: it is reported in a toast, and if the Models page is open again
     (possibly with a load that started before the Server saved) it is reloaded so it shows the saved state. */
  const shown = () => Fleet.nav.current?.view === Fleet.views.models;
  const live = gen => gen === S.gen && shown();
  const catchUp = () => { if (shown()) Fleet.reload({ quiet: true }); };
  Fleet.actions['sel-save'] = async el => {
    const gen = S.gen, i = +el.dataset.i, e = S.sel[i];
    preserveVisible(e);
    S.saving = true; S.msg = `Saving selection for ${u.hostOf(e.baseUrl)}…`; Fleet.repaint();
    let saved = null, failure = null;
    try { saved = await api.post('cliproxy/selection', { baseUrl: e.baseUrl, version: e.version, policy: e.policy }); }
    catch (err) { failure = err; }
    if (failure) {
      if (failure.silent) { if (gen === S.gen) S.saving = false; return; }
      ui.fail(failure, 'Selection was not saved');
      if (gen !== S.gen) { catchUp(); return; }
      if (failure.code === 'stale_selection' || failure.code === 'catalog_unavailable') {
        try { await loadSelection(gen); } catch { return; } // a newer load took over
        S.msg = failure.message;
      } else S.msg = failure.message + (failure.code === 'pinned_model_excluded' && failure.details?.models?.length ? ` Pinned models: ${failure.details.models.join(', ')}.` : '');
    } else {
      ui.toast('Selection saved', { text: `${u.hostOf(e.baseUrl)}. Agents receive it on their next poll.` });
      if (gen !== S.gen) { catchUp(); return; }
      const at = S.sel.indexOf(e);
      if (at >= 0) S.sel[at] = makeEntry(saved.catalog);
      S.msg = `Selection saved for ${u.hostOf(e.baseUrl)}. Agents receive it on their next poll.`;
    }
    S.saving = false;
    if (live(gen)) Fleet.repaint();
  };
  Fleet.actions['refresh-models'] = async () => {
    if (Fleet.shared.refreshing) return;
    const gen = S.gen;
    Fleet.shared.refreshing = true; Fleet.repaint();
    ui.toast('Refreshing model catalogs', { tone: 'info', text: 'Fetching models and reasoning efforts from CLIProxy…' });
    let reloaded = false;
    try {
      const st = await api.post('cliproxy/refresh', {});
      const bad = (st.catalogs || []).filter(c => c.outcome === 'failed');
      Fleet.shared.lastRefresh = bad.length
        ? { level: 'warning', kind: 'bang', text: `Refreshed. ${(st.catalogs.length - bad.length)} catalog${st.catalogs.length - bad.length === 1 ? '' : 's'} updated; ${bad.map(c => `${u.hostOf(c.baseUrl)} still fails (${c.errorCode || 'refresh_failed'})`).join(', ')}.` }
        : { level: 'good', kind: 'check', text: st.catalogs?.length ? 'Refreshed. All catalogs updated.' : 'Refreshed. No catalogs are in use yet.' };
      ui.toast(bad.length ? 'A catalog is still failing' : 'Model catalogs refreshed', { tone: bad.length ? 'warning' : 'good', text: Fleet.shared.lastRefresh.text });
      if (gen === S.gen) { S.status = st; await loadSelection(gen); } else reloaded = true;
    } catch (e) { if (!e.silent) ui.fail(e, 'Model refresh could not be confirmed'); }
    Fleet.shared.refreshing = false;
    Fleet.model.refreshSummary(true);
    if (reloaded) catchUp();
    else if (live(gen)) Fleet.repaint();
  };
})();
