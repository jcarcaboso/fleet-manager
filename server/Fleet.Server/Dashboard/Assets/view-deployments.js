'use strict';
/* Fleet dashboard: Deployments.
   API: GET desired-revisions?order=newest, GET rollouts?order=newest, GET desired-revisions/{id} (the newest revision, for what changed), GET warnings, GET nodes, GET errors, GET rollouts/{id}/attempts (on demand).
   The Server returns revisions and rollouts newest first, one page at a time, so the first revision is the newest. A rollout belongs to the
   revision named by its desiredRevisionId. "Load older revisions" follows both cursors.
   Each revision shows its commit subject, author and time (the short SHA when the Server has no commit for it) and links to its own page,
   #/deployments/<revisionId> (view-revision.js), with the diff and per-machine rollout progress. */
(function () {
  const Fleet = window.Fleet = window.Fleet || {};
  const u = Fleet.u, ui = Fleet.ui, api = Fleet.api, model = Fleet.model, catalog = Fleet.catalog;
  const { esc, ic, glyph, enc } = u;
  Fleet.views = Fleet.views || {};

  const S = { revs: [], revsNext: null, rollouts: new Map(), rolloutsNext: null, loadingMore: false, warnings: [], nodes: [], filter: 'all', attempts: new Map(), loadingAttempts: new Set(), truncated: false, focus: null, gen: 0, curDetail: null };
  const PAGE = 10;

  const countsOf = r => ({ pending: r?.pending || 0, applying: r?.applying || 0, succeeded: r?.succeeded || 0, failed: r?.failed || 0, superseded: r?.superseded || 0 });
  const deployState = n => n.counts.failed ? 'blocked' : n.counts.applying ? 'progress' : (n.counts.pending || (n.freshness !== 'fresh' && model.total(n) > n.counts.succeeded + n.counts.superseded)) ? 'waiting' : 'done';
  const statusText = n => {
    const c = n.counts;
    if (c.failed) return `${u.plural(c.failed, 'Target')} failing. ${c.succeeded ? `${c.succeeded} applied.` : ''}`;
    if (c.applying) return `Applying ${u.plural(c.applying, 'Target')} now.`;
    if (c.pending) return n.freshness === 'fresh' ? `${u.plural(c.pending, 'Target')} queued for the next poll.` : n.freshness === 'never_contacted' ? 'Waiting for the first check-in. Nothing has been delivered yet.' : `Waiting for ${n.alias} to come back online.`;
    if (!model.total(n)) return 'No Targets assigned.';
    return `All ${u.plural(c.succeeded, 'Target')} in sync.`;
  };

  const warningsFor = rev => S.warnings.filter(w => w.desiredRevisionId === rev.desiredRevisionId);
  const warnCallout = w => `<div class="callout callout--warning">${glyph('warning', 'bang')}<div><b>${esc(w.code)}</b><p>${esc(w.message)}</p>${(w.sourceLocations || []).length ? `<div class="loc-chips">${w.sourceLocations.map(l => `<span class="loc">${ic('folder')}<code>${esc(l)}</code></span>`).join('')}</div>` : ''}</div></div>`;

  /* Failed attempts of a rollout with the step and a one-line diagnostic (phase 2 detail; both are null for older Agents). */
  const FAILED_SHOWN = 20;
  const failedList = items => {
    const failed = items.filter(a => a.state === 'failed');
    if (!failed.length) return '';
    return `<p class="kv-label">Failed attempts <span class="cnt">${u.num(failed.length)}</span></p>
      <ul class="attlist">${failed.slice(0, FAILED_SHOWN).map(a => `<li class="attitem"><div class="attitem-top"><span class="mono">${esc(u.shortId(a.attemptId))}</span>${a.errorCode ? `<code>${esc(a.errorCode)}</code>` : ''}${u.stepChip(a.step)}<time class="muted small" datetime="${esc(a.updatedAt)}">${esc(u.fmtFull(a.updatedAt))} UTC</time></div>${a.path ? `<p class="attitem-path small"><span class="muted">Path</span> <code>${esc(a.path)}</code></p>` : ''}${ui.diagLine(a.diagnostic, a.attemptId)}</li>`).join('')}</ul>
      ${failed.length > FAILED_SHOWN ? `<p class="muted small">Showing ${FAILED_SHOWN} of ${u.num(failed.length)} failed attempts.</p>` : ''}`;
  };

  const attemptsBlock = r => {
    const d = S.attempts.get(r.rolloutId);
    if (S.loadingAttempts.has(r.rolloutId)) return '<div class="skel skel-block"></div>';
    if (!d) return `<button type="button" class="btn btn-sm btn-secondary" data-act="load-attempts" data-id="${esc(r.rolloutId)}">${ic('list')}Show attempts</button>`;
    if (d.error) return ui.inlineError(d.error, 'attempts');
    const byState = u.emptyCounts(); d.items.forEach(a => { if (a.state in byState) byState[a.state]++; });
    const failed = new Map();
    d.items.filter(a => a.state === 'failed' || a.errorCode).forEach(a => { const k = a.errorCode || 'unknown'; failed.set(k, (failed.get(k) || 0) + 1); });
    return `<p class="kv-label">Attempts in this rollout <span class="cnt">${u.num(d.items.length)}</span></p>
      ${u.legend(u.stateParts(byState, 'attempts'))}
      ${failed.size ? `<div class="tbl-wrap"><table class="tbl tbl--compact"><thead><tr><th>Error code</th><th>What it means</th><th class="num">Attempts</th></tr></thead><tbody>${[...failed].sort((a, b) => b[1] - a[1]).map(([code, c]) => `<tr><td><code>${esc(code)}</code></td><td>${esc(catalog.get(code)?.title || 'No catalog entry')}</td><td class="num">${c}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted small">No failed attempts.</p>'}
      ${failedList(d.items)}
      ${d.truncated ? '<p class="muted small">Showing the first attempts only.</p>' : ''}`;
  };

  const histItem = (rev, i) => {
    const r = S.rollouts.get(rev.desiredRevisionId), counts = countsOf(r), p = u.stateParts(counts), warns = warningsFor(rev);
    const key = 'rev:' + u.shortSha(rev.sourceRevision);
    const open = Fleet.openState.has(key) ? Fleet.openState.get(key) : S.focus === u.shortSha(rev.sourceRevision);
    const live = counts.pending + counts.applying > 0, commit = model.commit(rev.commit);
    return `<li class="hist-item" id="rev-${esc(u.shortSha(rev.sourceRevision))}"><span class="hist-dot">${i === 0 ? (live ? glyph('info', 'sync') : counts.failed ? glyph('critical', 'x') : glyph('good', 'check')) : glyph('good', 'check')}</span>
      <details data-open-key="${esc(key)}" ${open ? 'open' : ''}><summary><span class="hist-main"><span class="hist-top">${u.revChip(rev.sourceRevision, rev.sourceRevision)}${i === 0 ? '<span class="tag tag--live">Newest</span>' : ''}<b>${commit?.subject ? esc(commit.subject) : `Published ${esc(u.fmtFull(rev.acceptedAt))} UTC`}</b></span>
        <span class="hist-meta">${commit?.author ? `${u.avatar(commit.author, 'av-xs')}${esc(commit.author)} · ` : ''}${commit?.subject ? `${esc(u.fmtFull(rev.acceptedAt))} UTC · ` : ''}${esc(u.rel(rev.acceptedAt))}${warns.length ? ` · ${glyph('warning', 'bang')}${u.plural(warns.length, 'warning')}` : ''}${r || S.rolloutsNext ? '' : ' · no rollout recorded'}</span></span>
        <span class="hist-bar">${r ? u.segbar(p, `Rollout ${u.shortSha(rev.sourceRevision)}`, 'segbar--sm') : ''}<span class="hist-sum">${r ? esc(p.filter(x => x.value).map(x => `${x.value} ${x.label.toLowerCase()}`).join(' · ') || 'No assignments') : ''}</span></span>${ic('chevD', 'sumchev')}</summary>
        <div class="hist-body">${warns.map(warnCallout).join('')}
          <dl class="kv kv--grid kv--3"><div><dt>Source revision</dt><dd class="mono">${esc(rev.sourceRevision)}${u.copyBtn(rev.sourceRevision, '', 'Copy source revision')}</dd></div><div><dt>Desired revision</dt><dd class="mono">${esc(rev.desiredRevisionId)}</dd></div><div><dt>Rollout</dt><dd class="mono">${esc(r?.rolloutId || '—')}</dd></div></dl>
          <p class="hist-open"><a class="btn btn-sm btn-secondary" href="#/deployments/${enc(rev.desiredRevisionId)}">${ic('list')}What changed and where it stands${ic('chevR')}</a></p>
          ${r ? u.legend(p) : ''}
          ${r ? `<div class="attempts" id="att-${esc(r.rolloutId)}">${attemptsBlock(r)}</div>` : ''}
        </div></details></li>`;
  };

  const paint = () => {
    const revs = S.revs, cur = revs[0], curRollout = cur ? S.rollouts.get(cur.desiredRevisionId) : null;
    const live = S.nodes.filter(n => !n.revoked);
    const rows = live.map(n => ({ n, st: deployState(n) }));
    const order = { blocked: 0, progress: 1, waiting: 2, done: 3 };
    rows.sort((a, b) => order[a.st] - order[b.st] || a.n.alias.localeCompare(b.n.alias));
    const c = k => rows.filter(r => r.st === k).length;
    const shown = S.filter === 'all' ? rows : rows.filter(r => r.st === S.filter);
    if (!revs.length) return `<div class="wrap">${ui.pageHead('Deployments', 'What Fleet is delivering to your machines, and what it delivered before.')}${ui.empty({ icon: 'rocket', title: 'Nothing has been published yet', text: 'When the repository is scanned and accepted, each publication appears here with its rollout.', action: ui.gate('operate', 'btn-primary', `${ic('sync')}Sync repository`, 'data-act="sync"') })}</div>`;
    const counts = countsOf(curRollout), parts = u.stateParts(counts), warns = warningsFor(cur), commit = model.commit(cur.commit);
    const work = counts.pending + counts.applying + counts.succeeded + counts.failed;
    const active = counts.pending + counts.applying > 0;
    return `<div class="wrap">
    ${ui.pageHead('Deployments', 'What Fleet is delivering to your machines right now, and what it delivered before.', `<button type="button" class="btn btn-secondary" data-act="reload">${ic('sync')}Refresh</button>`)}
    <section class="dep-hero">
      <div class="dep-hero-main">
        <p class="eyebrow ${active ? 'live' : ''}">${active ? '<span class="live-dot" aria-hidden="true"></span>Rolling out now' : counts.failed ? 'Newest revision, with failures' : 'Newest revision'}</p>
        <h2 class="dep-title">${esc(model.revTitle(cur))}</h2>
        <p class="dep-meta">${u.revChip(cur.sourceRevision, cur.sourceRevision)}${commit?.author ? `${u.avatar(commit.author, 'av-xs')}<span><b>${esc(commit.author)}</b> · published ${esc(u.rel(cur.acceptedAt))} · ${esc(u.fmtFull(cur.acceptedAt))} UTC</span>` : `<span>Published <b>${esc(u.rel(cur.acceptedAt))}</b> · ${esc(u.fmtFull(cur.acceptedAt))} UTC</span>`}</p>
        ${S.curDetail ? `<h3 class="mini-h">What changed</h3>${ui.changeChips(S.curDetail)}` : ''}
        <p class="dep-more"><a class="btn btn-sm btn-secondary" href="#/deployments/${enc(cur.desiredRevisionId)}">${ic('list')}Open this revision${ic('chevR')}</a></p>
        ${warns.map(w => `<div class="callout callout--warning">${glyph('warning', 'bang')}<div><b>Source warning: ${esc(w.code)}</b><p>${esc(w.message)}</p>${(w.sourceLocations || []).length ? `<div class="loc-chips">${w.sourceLocations.map(l => `<span class="loc">${ic('folder')}<code>${esc(l)}</code></span>`).join('')}</div>` : ''}</div></div>`).join('')}
      </div>
      <div class="dep-hero-side">
        <p class="stat-l">Assignments succeeded</p>
        <p class="hero-fig">${u.num(counts.succeeded)}<span> of ${u.num(work)}</span></p>
        ${u.segbar(parts, `Rollout ${u.shortSha(cur.sourceRevision)} assignments`, 'segbar--lg')}
        ${u.legend(parts)}
        <p class="muted small">${curRollout ? `${c('done')} of ${rows.length} machines have every Target in sync. ` : ''}A rollout is not a transaction: each machine reconciles on its own.</p>
      </div>
    </section>
    <section class="panel"><header class="panel-head row"><div><h2>Machines</h2><p>Where each machine stands, from its Target state counts.</p></div>
      ${ui.chips('dep-filter', S.filter, [['all', 'All', rows.length], ['blocked', 'Blocked', c('blocked')], ['progress', 'In progress', c('progress')], ['waiting', 'Waiting', c('waiting')], ['done', 'Done', c('done')]], 'Filter machines')}</header>
      <div class="dep-legend" aria-hidden="true"><span>Machine</span><span>Current revision</span><span>Targets</span><span>Status</span></div>
      <ul class="dep-list">${shown.map(({ n, st }) => `<li class="dep-row dep-row--${st}">
        <a class="dep-node" href="#/nodes/${enc(n.alias)}">${Fleet.art.device(n, model.health(n), 'dev-sm')}<span><b>${esc(n.alias)}</b><span class="muted small">${esc(u.platformLabel(n.platform))} · ${esc(model.seenText(n).toLowerCase())}</span></span></a>
        <div class="dep-rev">${u.revChip(n.currentRevision, n.currentRevision)}</div>
        <div class="dep-targets">${model.total(n) ? u.segbar(u.stateParts(n.counts, 'Targets'), `${n.alias} Targets`, 'segbar--sm') + `<span class="hist-sum">${esc(u.stateParts(n.counts).filter(x => x.value).map(x => `${x.value} ${x.label.toLowerCase()}`).join(' · '))}</span>` : '<span class="muted small">None</span>'}</div>
        <p class="dep-status">${esc(statusText(n))}</p></li>`).join('') || `<li class="empty-mini">${ic('grid')}<p>No machines in this state.</p></li>`}</ul>
      ${S.truncated ? '<p class="muted small">Only the first machines are listed.</p>' : ''}
    </section>
    <section class="panel"><header class="panel-head"><h2>Revision history</h2><p>Each publication creates an immutable desired revision. Its rollout tracks delivery until a newer revision supersedes it.</p></header>
      <ol class="hist">${revs.map(histItem).join('')}</ol>
      ${S.revsNext ? `<div class="load-more"><button type="button" class="btn btn-secondary" data-act="more-revisions" ${S.loadingMore ? 'disabled' : ''}>Load older revisions</button></div>` : ''}
    </section>
  </div>`;
  };

  Fleet.views.deployments = {
    title: 'Deployments',
    async load(params) {
      const gen = ++S.gen;
      const [revs, rollouts, warnings, nodes] = await Promise.all([
        api.page('desired-revisions', { order: 'newest', limit: PAGE }), api.page('rollouts', { order: 'newest', limit: PAGE }),
        api.all('warnings', { maxPages: 3 }).catch(Fleet.soft), api.all('nodes', { maxPages: 5 }), catalog.load(),
      ]);
      if (gen !== S.gen) throw Fleet.superseded();
      /* What the newest revision changed: a failure (a Server before phase 4) only hides that block. */
      const newest = revs.items[0];
      const detail = newest ? await api.get(`desired-revisions/${enc(newest.desiredRevisionId)}`).catch(Fleet.soft) : null;
      if (gen !== S.gen) throw Fleet.superseded();
      S.curDetail = detail ? model.revisionDetail(detail) : null;
      S.revs = revs.items; S.revsNext = revs.nextCursor;
      S.rollouts = new Map(rollouts.items.map(r => [r.desiredRevisionId, r])); S.rolloutsNext = rollouts.nextCursor;
      S.warnings = warnings ? warnings.items : []; S.nodes = nodes.items.map(model.fromList); S.truncated = nodes.truncated;
      S.focus = params[0] || null; S.loadingMore = false; S.attempts = new Map(); S.loadingAttempts = new Set();
      model.refreshSummary();
      return paint();
    },
    paint,
    mount() { if (S.focus) document.getElementById('rev-' + S.focus)?.scrollIntoView({ block: 'center' }); },
  };

  Fleet.actions['more-revisions'] = async () => {
    if (S.loadingMore || !S.revsNext) return;
    const gen = S.gen, revsAfter = S.revsNext, rolloutsAfter = S.rolloutsNext;
    S.loadingMore = true; Fleet.repaint();
    try {
      const [revs, rollouts] = await Promise.all([
        api.page('desired-revisions', { order: 'newest', limit: PAGE, after: revsAfter }),
        rolloutsAfter ? api.page('rollouts', { order: 'newest', limit: PAGE, after: rolloutsAfter }) : { items: [], nextCursor: null },
      ]);
      if (gen !== S.gen) return;
      S.revs = S.revs.concat(revs.items); S.revsNext = revs.nextCursor;
      for (const r of rollouts.items) S.rollouts.set(r.desiredRevisionId, r);
      S.rolloutsNext = rollouts.nextCursor;
    } catch (e) { if (e.silent) return; ui.fail(e, 'Could not load older revisions'); }
    if (gen === S.gen) { S.loadingMore = false; Fleet.repaint(); }
  };
  Fleet.actions['dep-filter'] = el => { S.filter = el.dataset.v; Fleet.repaint(); };
  Fleet.actions['load-attempts'] = async el => {
    const id = el.dataset.id;
    S.loadingAttempts.add(id); Fleet.repaint();
    try { const r = await api.all(`rollouts/${enc(id)}/attempts`, { maxPages: 5 }); S.attempts.set(id, r); }
    catch (e) { if (!e.silent) S.attempts.set(id, { error: e, items: [] }); }
    S.loadingAttempts.delete(id);
    if (Fleet.nav.current?.view === Fleet.views.deployments) Fleet.repaint();
  };
})();
