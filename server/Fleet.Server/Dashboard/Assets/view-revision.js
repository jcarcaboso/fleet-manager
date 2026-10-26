'use strict';
/* Fleet dashboard: one revision, at #/deployments/<desiredRevisionId>.
   API: GET desired-revisions/{id} (commit, previous revision, what changed), GET rollouts/{id} (per-machine progress), GET errors.
   The revision is read first, then its rollout. Both reads carry one AbortController, and every await checks the load generation, so a
   revision the user has left (or a newer load of the same one) never paints. A rollout that cannot be read shows an error beside the
   diff; a revision without a rollout says so. Every string from the Server goes through esc(). */
(function () {
  const Fleet = window.Fleet = window.Fleet || {};
  const u = Fleet.u, ui = Fleet.ui, api = Fleet.api, model = Fleet.model, catalog = Fleet.catalog;
  const { esc, ic, glyph, enc } = u;
  Fleet.views = Fleet.views || {};

  const S = { id: null, rev: null, roll: null, rollErr: null, filter: 'all', sort: 'state', gen: 0, ctl: null };
  const SORTS = {
    state: (a, b) => model.nodeRank(a.state) - model.nodeRank(b.state) || a.name.localeCompare(b.name),
    name: (a, b) => a.name.localeCompare(b.name),
    recent: (a, b) => (u.ms(b.last) || 0) - (u.ms(a.last) || 0) || a.name.localeCompare(b.name),
  };
  const STATE_OF = new Map(u.STATES.map(s => [s.key, s]));
  const stateOf = key => STATE_OF.get(key) || { key, label: u.tstate(key).label, level: u.tstate(key).level, kind: u.tstate(key).kind };

  const notFound = (error) => `<div class="wrap">${ui.empty({ icon: 'rocket', h: 'h1', title: 'We could not find that revision', text: error?.message || 'It may have been removed, or the address is wrong.', action: '<a class="btn btn-secondary" href="#/deployments">Back to deployments</a>' })}</div>`;

  /* One Target of a machine: its state, and its error code when it has one. A Target with an error code links to the machine's Problems tab. */
  const targetChip = (n, t) => {
    const m = stateOf(t.state), label = u.targetShort({ name: t.name });
    const tip = `${u.targetLabel({ name: t.name })}|${m.label}${t.errorCode ? `\n${catalog.title(t.errorCode)}` : ''}${t.updatedAt ? `\nUpdated ${u.rel(t.updatedAt)}` : ''}`;
    const inner = `${glyph(m.level, m.kind)}<span class="sr">${esc(m.label)}: </span><span>${esc(label)}</span>${t.errorCode ? `<code>${esc(t.errorCode)}</code>` : ''}`;
    return t.errorCode
      ? `<a class="tchip tchip--error" href="#/nodes/${enc(n.name)}/problems" data-tip="${esc(tip)}">${inner}</a>`
      : `<span class="tchip" data-tip="${esc(tip)}">${inner}</span>`;
  };
  const when = (iso, label) => iso ? `<span class="rv-t" data-tip="${esc(`${label}|${u.fmtFull(iso)} UTC`)}"><span class="muted">${esc(label)}</span> <time datetime="${esc(iso)}">${esc(u.rel(iso))}</time></span>` : '';

  const row = n => {
    const m = stateOf(n.state);
    return `<li class="rv-row rv-row--${esc(n.state)}">
      <a class="rv-node" href="#/nodes/${enc(n.name)}"><b>${esc(n.name)}</b></a>
      <span class="rv-state">${glyph(m.level, m.kind)}<span>${esc(m.label)}</span></span>
      <div class="rv-times">${n.first || n.last ? `${when(n.first, 'First attempt')}${when(n.last, 'Last attempt')}` : '<span class="muted small">No attempt yet</span>'}</div>
      <ul class="rv-targets" aria-label="Targets of ${esc(n.name)}">${n.targets.map(t => `<li>${targetChip(n, t)}</li>`).join('')}</ul></li>`;
  };

  const machines = () => {
    if (!S.rev.rolloutId) return `<section class="panel"><header class="panel-head"><h2>Machines</h2></header><div class="empty-mini">${ic('rocket')}<p>No rollout was created for this revision, so there is no per-machine progress to show.</p></div></section>`;
    if (S.rollErr) return `<section class="panel"><header class="panel-head"><h2>Machines</h2></header>${ui.inlineError(S.rollErr, 'the rollout')}<div class="empty-retry"><button type="button" class="btn btn-secondary" data-act="reload">${ic('retry')}Try again</button></div></section>`;
    const nodes = S.roll.nodes, by = k => nodes.filter(n => n.state === k).length;
    const shown = (S.filter === 'all' ? nodes : nodes.filter(n => n.state === S.filter)).slice().sort(SORTS[S.sort]);
    const chips = [['all', 'All', nodes.length], ...u.STATES.map(s => [s.key, s.label, by(s.key)]).filter(c => c[2] > 0 || S.filter === c[0])];
    return `<section class="panel"><header class="panel-head row"><div><h2>Machines <span class="cnt">${u.num(nodes.length)}</span></h2><p>How each machine is converging on this revision. A machine is as far along as its slowest Target.</p></div>
      <div class="head-tools">${ui.chips('rv-filter', S.filter, chips, 'Filter machines by state')}
      <label class="sel"><span>Sort</span><select id="rv-sort">${[['state', 'Needs attention first'], ['name', 'Name'], ['recent', 'Latest attempt']].map(([k, l]) => `<option value="${k}" ${S.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select>${ic('chevD', 'sel-chev')}</label></div></header>
      ${nodes.length ? `<div class="rv-legend" aria-hidden="true"><span>Machine</span><span>State</span><span>Attempts</span><span>Targets</span></div>
      <ul class="rv-list">${shown.map(row).join('') || `<li class="empty-mini">${ic('grid')}<p>No machines in this state.</p></li>`}</ul>
      ${nodes.length >= 500 ? '<p class="muted small">Only the first 500 machines are listed.</p>' : ''}`
        : `<div class="empty-mini">${ic('grid')}<p>No machine has an Assignment in this rollout.</p></div>`}</section>`;
  };

  const paint = () => {
    const r = S.rev, commit = r.commit, roll = S.roll, sum = roll ? roll.summary : null;
    const parts = sum ? u.stateParts(sum) : [], work = sum ? u.countTotal(sum) : 0;
    const active = !!sum && sum.pending + sum.applying > 0;
    const eyebrow = !sum ? 'Revision' : active ? '<span class="live-dot" aria-hidden="true"></span>Rolling out now' : sum.failed ? 'Rollout with failures' : 'Rollout finished';
    const done = roll ? roll.nodes.filter(n => n.state === 'succeeded' || n.state === 'superseded').length : 0;
    return `<div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="#/deployments">${ic('chevL')}All deployments</a><span aria-hidden="true">/</span><span aria-current="page">${esc(u.shortSha(r.sourceRevision))}</span></nav>
    <section class="dep-hero">
      <div class="dep-hero-main">
        <p class="eyebrow ${active ? 'live' : ''}">${eyebrow}</p>
        <h1 class="dep-title" tabindex="-1">${esc(model.revTitle(r))}</h1>
        <p class="dep-meta">${u.revChip(r.sourceRevision, r.sourceRevision)}${commit?.author ? `${u.avatar(commit.author, 'av-xs')}<b>${esc(commit.author)}</b>` : ''}<span>${commit?.subject ? 'committed' : 'Published'} ${esc(u.rel(commit?.committedAt || r.acceptedAt))} · published ${esc(u.fmtFull(r.acceptedAt))} UTC</span></p>
        <h2 class="mini-h">What changed</h2>
        ${ui.changeChips(r)}
        <p class="dep-prev small">${ic('commit')}<span>${r.previous ? `Compared with the previous revision <a href="#/deployments/${enc(r.previous.id)}">${esc(u.shortSha(r.previous.sourceRevision))}</a>.` : 'This is the first revision, so there is nothing to compare it with.'}</span></p>
        <dl class="kv kv--grid kv--3"><div><dt>Source revision</dt><dd class="mono">${esc(r.sourceRevision)}</dd></div><div><dt>Desired revision</dt><dd class="mono">${esc(r.id)}</dd></div><div><dt>Rollout</dt><dd class="mono">${esc(r.rolloutId || '—')}</dd></div></dl>
      </div>
      <div class="dep-hero-side">${sum ? `<p class="stat-l">Assignments succeeded</p>
        <p class="hero-fig">${u.num(sum.succeeded)}<span> of ${u.num(work)}</span></p>
        ${u.segbar(parts, `Rollout ${u.shortSha(r.sourceRevision)} assignments`, 'segbar--lg')}
        ${u.legend(parts)}
        <p class="muted small">${roll.nodes.length ? `${done} of ${u.plural(roll.nodes.length, 'machine')} ${done === 1 ? 'has' : 'have'} nothing left to apply. ` : ''}A rollout is not a transaction: each machine reconciles on its own.</p>`
        : S.rollErr ? `<p class="stat-l">Rollout</p><p class="muted">The rollout could not be read. See the error below.</p>` : `<p class="stat-l">Rollout</p><p class="muted">${r.rolloutId ? 'Loading…' : 'No rollout was created for this revision.'}</p>`}</div>
    </section>
    ${machines()}
  </div>`;
  };

  Fleet.views.revision = {
    title: () => S.rev ? u.shortSha(S.rev.sourceRevision) : 'Revision',
    async load(params) {
      const id = params[0], gen = ++S.gen;
      if (S.ctl) S.ctl.abort();
      const ctl = S.ctl = new AbortController(), opts = { signal: ctl.signal };
      if (id !== S.id) { S.id = id; S.filter = 'all'; S.sort = 'state'; }
      let raw;
      try { [raw] = await Promise.all([api.get(`desired-revisions/${enc(id)}`, undefined, opts), catalog.load()]); }
      catch (e) {
        if (gen !== S.gen) throw Fleet.superseded();
        if (e.code === 'revision_not_found') { S.rev = null; return notFound(e); }
        throw e;
      }
      if (gen !== S.gen) throw Fleet.superseded();
      const rev = model.revisionDetail(raw);
      let roll = null, rollErr = null;
      if (rev.rolloutId) {
        try { roll = model.rolloutDetail(await api.get(`rollouts/${enc(rev.rolloutId)}`, undefined, opts)); }
        catch (e) { if (gen !== S.gen || e.silent) throw Fleet.superseded(); rollErr = e; }
      }
      if (gen !== S.gen) throw Fleet.superseded();
      S.rev = rev; S.roll = roll; S.rollErr = rollErr;
      model.refreshSummary();
      return paint();
    },
    paint: () => S.rev ? paint() : notFound(),
    unmount() { S.gen++; if (S.ctl) { S.ctl.abort(); S.ctl = null; } },
  };

  Fleet.actions['rv-filter'] = el => { S.filter = el.dataset.v; Fleet.repaint(); };
  Fleet.on.change['rv-sort'] = t => { S.sort = t.value; Fleet.repaint(); };
})();
