'use strict';
/* Fleet dashboard: Problems page.
   API: GET issues, GET errors, POST nodes/{node}/retry (retry button), POST source/rescan (sync button), POST issues/state (acknowledge, snooze, reopen).
   Issues are open, acknowledged or snoozed. The page shows one state at a time (Open first), and the navigation badge counts open errors only. */
(function () {
  const Fleet = window.Fleet = window.Fleet || {};
  const u = Fleet.u, ui = Fleet.ui, api = Fleet.api, model = Fleet.model, catalog = Fleet.catalog;
  const { esc, ic, glyph, enc } = u;
  Fleet.views = Fleet.views || {};

  const S = { items: [], filter: 'all', state: 'open', retrying: new Set(), gen: 0 };

  const decorate = i => {
    const level = model.issueLevel(i);
    return { i, level, kind: model.issueKind(level, i), badge: model.issueBadge(level, i), section: model.issueSection(i),
      cat: catalog.get(i.errorCode) || catalog.get(i.code), id: i.id, st: model.issueState(i) };
  };
  const whereText = p => {
    const i = p.i;
    if (i.nodeName && i.target) return `${u.targetLabel({ name: i.target })} on ${i.nodeName}`;
    if (i.nodeName) return i.nodeName;
    if (p.section === 'models') return 'CLIProxy models';
    if (p.section === 'repository') return 'Repository';
    return i.section === 'nodes' ? 'Machines' : (i.section || 'Server');
  };
  const where = p => {
    const i = p.i;
    if (i.nodeName) return `${i.target ? `${esc(u.targetLabel({ name: i.target }))} <code>${esc(i.target)}</code> on ` : ''}<a href="#/nodes/${enc(i.nodeName)}${i.target ? '/problems' : ''}">${esc(i.nodeName)}</a>`;
    if (p.section === 'models') return `<a href="#/models">CLIProxy models</a>`;
    if (p.section === 'repository') return `<a href="#/repository">Repository</a>`;
    return i.section === 'nodes' ? '<a href="#/nodes">Machines</a>' : esc(i.section || 'Server');
  };

  const card = p => {
    const i = p.i, cat = p.cat, retryable = i.code === 'assignment_failed' && i.nodeId && i.target;
    const explanation = cat?.explanation || i.detail || '';
    const specific = cat?.explanation && i.detail && i.detail !== cat.explanation ? i.detail : '';
    const fix = model.fixSteps(i, cat);
    const factList = [['Since', i.since ? `${u.fmtFull(i.since)} UTC` : '—', i.since ? u.rel(i.since) : ''], ...(i.errorCode ? [['Error code', i.errorCode, '', true]] : []),
      ...(i.nodeName ? [['Machine', i.nodeName, '']] : []), ...(i.target ? [['Target', i.target, '', true]] : [])];
    const retrying = S.retrying.has(i.id);
    const link = i.nodeName ? `<a class="btn btn-sm btn-ghost" href="#/nodes/${enc(i.nodeName)}/problems">Open ${esc(i.nodeName)}${ic('chevR')}</a>`
      : p.section === 'models' ? `<a class="btn btn-sm btn-ghost" href="#/models">Open models${ic('chevR')}</a>`
        : p.section === 'repository' ? `<a class="btn btn-sm btn-ghost" href="#/repository">Open repository${ic('chevR')}</a>` : '';
    return `<article class="prob prob--${p.level}"><div class="prob-body">
      ${ui.issueBanner(i)}
      ${explanation ? `<p class="prob-expl">${u.md(explanation)}${specific ? ` <strong>${u.md(specific)}</strong>` : ''}</p>` : '<p class="prob-expl muted">The Server has no catalog entry for this problem yet.</p>'}
      <dl class="facts-row">${factList.map(([k, v, s, m]) => `<div><dt>${esc(k)}</dt><dd${m ? ' class="mono"' : ''}>${esc(v)}</dd>${s ? `<dd class="sub">${esc(s)}</dd>` : ''}</div>`).join('')}</dl>
      ${i.code === 'assignment_failed' ? ui.failureDetail(i) : ''}
      <div class="prob-cols">
        <section class="fix" aria-label="How to fix"><h4>How to fix</h4>${fix.length ? ui.stepsList(fix) : '<p class="muted">No fix steps are published for this problem.</p>'}</section>
        <section class="why">${(i.commands || []).length ? `<h4>Run in a terminal</h4>${i.commands.map(c => u.cmdBlock(c)).join('')}` : '<h4>Run in a terminal</h4><p class="muted small">There is no CLI command for this problem.</p>'}</section>
      </div>
      <footer class="prob-actions">
        ${retryable ? ui.gate('operate', 'btn-sm btn-primary', `${ic('retry', retrying ? 'spin' : '')}${retrying ? 'Requesting…' : 'Retry now'}`, `data-act="issue-retry" data-id="${esc(i.id)}" ${retrying ? 'disabled' : ''}`) : ''}
        ${ui.issueActions(i, Fleet.issueBusy.has(i.id))}
        ${link}
        ${retryable && !api.can('operate') ? `<span class="muted small">${esc(api.denied('operate'))}</span>` : ''}
      </footer></div></article>`;
  };

  const row = (p, idx) => {
    const key = p.id, i = p.i;
    const open = Fleet.openState.has(key) ? Fleet.openState.get(key) : idx === 0;
    const meta = i.since ? `Since ${u.rel(i.since)}` : '';
    const quiet = p.st.key !== 'open';
    return `<details class="prow prow--${p.level}${quiet ? ' is-quiet' : ''}" data-open-key="${esc(key)}" ${open ? 'open' : ''}>
    <summary><span class="prob-ic t-${p.level}">${glyph(p.level, p.kind)}</span><span class="prow-main"><b>${esc(i.title)}</b><span class="prow-where">${esc(whereText(p))}</span></span><span class="prow-meta">${esc(meta)}</span>${quiet ? `<span class="tag tag--state">${esc(model.STATE_LABEL[p.st.key])}</span>` : ''}${u.pill(p.level, p.kind, p.badge)}${ic('chevD', 'sumchev')}</summary>
    ${card(p)}</details>`;
  };

  const paint = () => {
    const everything = model.sortIssues(S.items).map(decorate);
    const inState = k => everything.filter(p => p.st.key === k);
    const all = inState(S.state), open = inState('open');
    const f = S.filter;
    const list = all.filter(p => f === 'all' || p.section === f);
    const cnt = l => all.filter(p => p.level === l).length;
    const machines = new Set(open.filter(p => p.level === 'critical' && p.i.nodeId).map(p => p.i.nodeId)).size;
    const G = [['critical', 'Errors', 'Something failed and needs a fix.', 'x'], ['serious', 'Offline machines', 'Fleet has not heard from these Agents recently.', 'moon'], ['warning', 'Warnings', 'Fine for now, but they can become problems if left alone.', 'bang'], ['info', 'Notices', 'Good to know. Nothing is broken.', 'info']];
    const chips = [['all', 'Everything', all.length], ['machines', 'Machines', all.filter(p => p.section === 'machines').length], ['repository', 'Repository', all.filter(p => p.section === 'repository').length], ['models', 'Models', all.filter(p => p.section === 'models').length], ['other', 'Other', all.filter(p => p.section === 'other').length]].filter(c => c[0] === 'all' || c[2] > 0 || f === c[0]);
    const quietCount = everything.length - open.length;
    let first = true;
    const groups = G.map(([l, title, sub]) => {
      const items = list.filter(p => p.level === l);
      if (!items.length) return '';
      const html = items.map(p => { const r = row(p, first ? 0 : 1); first = false; return r; }).join('');
      return `<section class="pgroup" aria-labelledby="pg-${l}"><header class="gsec-head"><h2 id="pg-${l}">${esc(title)} <span class="cnt">${items.length}</span></h2><p>${esc(sub)}</p></header>${html}</section>`;
    }).join('');
    const sync = Fleet.shared.syncing;
    const sub = open.length ? `${u.plural(open.filter(p => p.level === 'critical').length, 'open error')}${machines ? ` on ${u.plural(machines, 'machine')}` : ''}, explained with the steps to fix them. Each problem links to its machine.${quietCount ? ` ${u.num(quietCount)} more ${quietCount === 1 ? 'is' : 'are'} acknowledged or snoozed.` : ''}`
      : everything.length ? `No open problems. ${u.num(quietCount)} ${quietCount === 1 ? 'is' : 'are'} acknowledged or snoozed and stays listed under its tab.` : 'Everything Fleet monitors is healthy right now.';
    const stateChips = ui.chips('prob-state', S.state, [['open', 'Open', open.length], ['acknowledged', 'Acknowledged', inState('acknowledged').length], ['snoozed', 'Snoozed', inState('snoozed').length]], 'Filter problems by state');
    const none = !everything.length ? ui.empty({ good: true, title: 'No problems', text: 'No failing Targets, offline machines, repository warnings or model sync failures right now.' })
      : !all.length ? (S.state === 'open' ? ui.empty({ good: true, title: 'No open problems', text: 'Everything that needs attention is acknowledged or snoozed. Open the other tabs to review it.' })
        : ui.empty({ good: true, title: `Nothing ${S.state}`, text: S.state === 'snoozed' ? 'Snooze a problem to hide it from Open for a while. It returns by itself when the time is up.' : 'Acknowledge a problem you know about. It stays listed here and returns to Open if it starts over.' }))
        : ui.empty({ good: true, title: 'Nothing here', text: 'No problems match this filter.' });
    return `<div class="wrap">
    ${ui.pageHead('Problems', sub,
      ui.gate('operate', 'btn-secondary', `${ic('sync', sync ? 'spin' : '')}${sync ? 'Syncing…' : 'Sync repository'}`, `data-act="sync" ${sync ? 'disabled' : ''}`) + `<button type="button" class="btn btn-secondary" data-act="reload">${ic('retry')}Check again</button>`)}
    ${all.length ? `<div class="sumrow">${G.map(([l, label, , k]) => `<div class="sumtile"><span class="sumtile-ic t-${l}">${glyph(l, k)}</span><span><b>${cnt(l)}</b><span>${esc(label)}</span></span></div>`).join('')}</div>` : ''}
    ${everything.length ? `<div class="toolbar toolbar--plain toolbar--states">${stateChips}${all.length ? ui.chips('prob-filter', f, chips, 'Filter problems') : ''}</div>` : ''}
    ${groups || none}
    ${ui.lockNote('operate')}
  </div>`;
  };

  Fleet.views.problems = {
    title: 'Problems',
    async load() {
      const gen = ++S.gen;
      const [issues] = await Promise.all([api.get('issues'), catalog.load()]);
      if (gen !== S.gen) throw Fleet.superseded();
      S.items = issues?.items || [];
      model.summary.issues = S.items; model.summary.errors = model.errorCount(S.items);
      Fleet.renderNav();
      return paint();
    },
    paint,
    /* An acknowledge, snooze or reopen answered with the updated issue. */
    issueUpdated(item) { S.items = model.patchIssue(S.items, item); },
  };

  Fleet.actions['prob-state'] = el => { S.state = el.dataset.v; Fleet.repaint(); };
  Fleet.actions['prob-filter'] = el => { S.filter = el.dataset.v; Fleet.repaint(); };
  Fleet.actions['issue-retry'] = async el => {
    const i = S.items.find(x => x.id === el.dataset.id);
    if (!i || S.retrying.has(i.id)) return;
    S.retrying.add(i.id); Fleet.repaint();
    try {
      await api.post(`nodes/${enc(i.nodeId)}/retry`, { target: i.target });
      ui.toast(`Retry requested for ${i.nodeName}`, { text: 'The Agent applies it on its next poll.' });
    } catch (e) { ui.fail(e, 'Retry was not requested'); }
    S.retrying.delete(i.id);
    if (Fleet.nav.current?.view === Fleet.views.problems) await Fleet.reload({ quiet: true });
  };

  /* ---------------------------------------------------------------- acknowledge, snooze, reopen (shared with the machine's Problems tab)
     The issue ID contains ":" and can contain URLs, so it travels in the JSON body, never in the path. The Server answers with the updated issue.
     The views that hold issues patch their copy through view.issueUpdated; a view the user has left is left alone. */
  Fleet.issueBusy = Fleet.issueBusy || new Set();
  const DONE = {
    acknowledge: () => ['Problem acknowledged', 'It stays listed under Acknowledged and returns to Open if it starts over.'],
    snooze: h => [`Snoozed for ${(model.SNOOZE.find(x => x[0] === h) || [0, `${h} h`, `${h} hours`])[2]}`, 'It returns to Open by itself when the time is up.'],
    reopen: () => ['Problem reopened', 'It is back under Open.'],
  };
  Fleet.actions['issue-state'] = async el => {
    const id = el.dataset.id, op = el.dataset.op, hours = op === 'snooze' ? +el.dataset.hours : 0;
    if (!id || !DONE[op] || Fleet.issueBusy.has(id)) return;
    const view = Fleet.nav.current?.view, here = () => Fleet.nav.current?.view === view;
    Fleet.issueBusy.add(id); Fleet.repaint();
    let item = null, gone = false;
    try { item = await api.post('issues/state', { id, action: op, ...(op === 'snooze' ? { hours } : {}) }); }
    catch (e) { gone = e.code === 'issue_not_found'; ui.fail(e, 'The problem was not changed'); }
    Fleet.issueBusy.delete(id);
    if (item && item.id) {
      const [title, text] = DONE[op](hours);
      ui.toast(title, { text });
      if (here()) view.issueUpdated?.(item);
      const sum = model.summary;
      if (sum.issues) { sum.issues = model.patchIssue(sum.issues, item); sum.errors = model.errorCount(sum.issues); Fleet.renderNav(); }
      model.refreshSummary(true);
    }
    if (here()) { if (gone) await Fleet.reload({ quiet: true }); else Fleet.repaint(); }
  };
})();
