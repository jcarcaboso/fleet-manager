'use strict';
/* Fleet dashboard: Problems page.
   API: GET issues, GET errors, POST nodes/{node}/retry (retry button), POST source/rescan (sync button). */
(function () {
  const Fleet = window.Fleet = window.Fleet || {};
  const u = Fleet.u, ui = Fleet.ui, api = Fleet.api, model = Fleet.model, catalog = Fleet.catalog;
  const { esc, ic, glyph, enc } = u;
  Fleet.views = Fleet.views || {};

  const S = { items: [], filter: 'all', retrying: new Set(), gen: 0 };

  const decorate = i => {
    const level = model.issueLevel(i);
    return { i, level, kind: model.issueKind(level, i), badge: model.issueBadge(level, i), section: model.issueSection(i),
      cat: catalog.get(i.errorCode) || catalog.get(i.code), id: i.id };
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
    const fix = cat?.fix?.length ? cat.fix.map(t => ({ t })) : (i.action ? [{ t: i.action }] : []);
    const factList = [['Since', i.since ? `${u.fmtFull(i.since)} UTC` : '—', i.since ? u.rel(i.since) : ''], ...(i.errorCode ? [['Error code', i.errorCode, '', true]] : []),
      ...(i.nodeName ? [['Machine', i.nodeName, '']] : []), ...(i.target ? [['Target', i.target, '', true]] : [])];
    const retrying = S.retrying.has(i.id);
    const link = i.nodeName ? `<a class="btn btn-sm btn-ghost" href="#/nodes/${enc(i.nodeName)}/problems">Open ${esc(i.nodeName)}${ic('chevR')}</a>`
      : p.section === 'models' ? `<a class="btn btn-sm btn-ghost" href="#/models">Open models${ic('chevR')}</a>`
        : p.section === 'repository' ? `<a class="btn btn-sm btn-ghost" href="#/repository">Open repository${ic('chevR')}</a>` : '';
    return `<article class="prob prob--${p.level}"><div class="prob-body">
      ${explanation ? `<p class="prob-expl">${u.md(explanation)}${specific ? ` <strong>${u.md(specific)}</strong>` : ''}</p>` : '<p class="prob-expl muted">The Server has no catalog entry for this problem yet.</p>'}
      <dl class="facts-row">${factList.map(([k, v, s, m]) => `<div><dt>${esc(k)}</dt><dd${m ? ' class="mono"' : ''}>${esc(v)}</dd>${s ? `<dd class="sub">${esc(s)}</dd>` : ''}</div>`).join('')}</dl>
      ${i.code === 'assignment_failed' ? ui.failureDetail(i) : ''}
      <div class="prob-cols">
        <section class="fix" aria-label="How to fix"><h4>How to fix</h4>${fix.length ? ui.stepsList(fix) : '<p class="muted">No fix steps are published for this problem.</p>'}</section>
        <section class="why">${(i.commands || []).length ? `<h4>Run in a terminal</h4>${i.commands.map(c => u.cmdBlock(c)).join('')}` : '<h4>Run in a terminal</h4><p class="muted small">There is no CLI command for this problem.</p>'}</section>
      </div>
      <footer class="prob-actions">
        ${retryable ? ui.gate('operate', 'btn-sm btn-primary', `${ic('retry', retrying ? 'spin' : '')}${retrying ? 'Requesting…' : 'Retry now'}`, `data-act="issue-retry" data-id="${esc(i.id)}" ${retrying ? 'disabled' : ''}`) : ''}
        ${link}
        ${retryable && !api.can('operate') ? `<span class="muted small">${esc(api.denied('operate'))}</span>` : ''}
      </footer></div></article>`;
  };

  const row = (p, idx) => {
    const key = p.id, i = p.i;
    const open = Fleet.openState.has(key) ? Fleet.openState.get(key) : idx === 0;
    const meta = i.since ? `Since ${u.rel(i.since)}` : '';
    return `<details class="prow prow--${p.level}" data-open-key="${esc(key)}" ${open ? 'open' : ''}>
    <summary><span class="prob-ic t-${p.level}">${glyph(p.level, p.kind)}</span><span class="prow-main"><b>${esc(i.title)}</b><span class="prow-where">${esc(whereText(p))}</span></span><span class="prow-meta">${esc(meta)}</span>${u.pill(p.level, p.kind, p.badge)}${ic('chevD', 'sumchev')}</summary>
    ${card(p)}</details>`;
  };

  const paint = () => {
    const all = model.sortIssues(S.items).map(decorate);
    const f = S.filter;
    const list = all.filter(p => f === 'all' || p.section === f);
    const cnt = l => all.filter(p => p.level === l).length;
    const machines = new Set(all.filter(p => p.level === 'critical' && p.i.nodeId).map(p => p.i.nodeId)).size;
    const G = [['critical', 'Errors', 'Something failed and needs a fix.', 'x'], ['serious', 'Offline machines', 'Fleet has not heard from these Agents recently.', 'moon'], ['warning', 'Warnings', 'Fine for now, but they can become problems if left alone.', 'bang'], ['info', 'Notices', 'Good to know. Nothing is broken.', 'info']];
    const chips = [['all', 'Everything', all.length], ['machines', 'Machines', all.filter(p => p.section === 'machines').length], ['repository', 'Repository', all.filter(p => p.section === 'repository').length], ['models', 'Models', all.filter(p => p.section === 'models').length], ['other', 'Other', all.filter(p => p.section === 'other').length]].filter(c => c[0] === 'all' || c[2] > 0 || f === c[0]);
    let first = true;
    const groups = G.map(([l, title, sub]) => {
      const items = list.filter(p => p.level === l);
      if (!items.length) return '';
      const html = items.map(p => { const r = row(p, first ? 0 : 1); first = false; return r; }).join('');
      return `<section class="pgroup" aria-labelledby="pg-${l}"><header class="gsec-head"><h2 id="pg-${l}">${esc(title)} <span class="cnt">${items.length}</span></h2><p>${esc(sub)}</p></header>${html}</section>`;
    }).join('');
    const sync = Fleet.shared.syncing;
    return `<div class="wrap">
    ${ui.pageHead('Problems', all.length ? `${u.plural(cnt('critical'), 'error')}${machines ? ` on ${u.plural(machines, 'machine')}` : ''}, explained with the steps to fix them. Each problem links to its machine.` : 'Everything Fleet monitors is healthy right now.',
      ui.gate('operate', 'btn-secondary', `${ic('sync', sync ? 'spin' : '')}${sync ? 'Syncing…' : 'Sync repository'}`, `data-act="sync" ${sync ? 'disabled' : ''}`) + `<button type="button" class="btn btn-secondary" data-act="reload">${ic('retry')}Check again</button>`)}
    ${all.length ? `<div class="sumrow">${G.map(([l, label, , k]) => `<div class="sumtile"><span class="sumtile-ic t-${l}">${glyph(l, k)}</span><span><b>${cnt(l)}</b><span>${esc(label)}</span></span></div>`).join('')}</div>
    <div class="toolbar toolbar--plain">${ui.chips('prob-filter', f, chips, 'Filter problems')}</div>` : ''}
    ${groups || (all.length ? ui.empty({ good: true, title: 'Nothing here', text: 'No problems match this filter.' })
      : ui.empty({ good: true, title: 'No problems', text: 'No failing Targets, offline machines, repository warnings or model sync failures right now.' }))}
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
      model.summary.issues = S.items; model.summary.errors = S.items.filter(i => i.severity === 'error').length;
      Fleet.renderNav();
      return paint();
    },
    paint,
  };

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
})();
