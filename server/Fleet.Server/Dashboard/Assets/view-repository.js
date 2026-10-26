'use strict';
/* Fleet dashboard: Repository.
   API: GET source/status, GET source/scans, GET desired-revisions?order=newest&limit=1, GET warnings, GET errors, POST source/rescan.
   The remote URL, branch and skill library are not in the Operator API, so they are not shown. */
(function () {
  const Fleet = window.Fleet = window.Fleet || {};
  const u = Fleet.u, ui = Fleet.ui, api = Fleet.api, catalog = Fleet.catalog;
  const { esc, ic, glyph } = u;
  Fleet.views = Fleet.views || {};

  const S = { status: null, scans: [], next: null, rev: null, warnings: [], loadingMore: false, gen: 0 };
  const SO = {
    accepted: { level: 'info', kind: 'down', label: 'Published' },
    unchanged: { level: 'good', kind: 'check', label: 'No changes' },
    invalid: { level: 'serious', kind: 'bang', label: 'Rejected' },
    failed: { level: 'critical', kind: 'x', label: 'Fetch failed' },
  };
  const outcome = o => SO[o] || { level: 'neutral', kind: 'minus', label: o ? String(o).replace(/_/g, ' ') : 'Unknown' };
  Fleet.scanOutcome = outcome;

  const scanBody = s => {
    const cat = catalog.get(s.code);
    return `<div class="diag">
      ${cat ? `<p class="prob-expl"><strong>${esc(cat.title)}.</strong> ${u.md(cat.explanation)}</p>` : ''}
      ${s.code ? `<dl class="facts-row"><div><dt>Code</dt><dd class="mono">${esc(s.code)}</dd></div><div><dt>Scanned</dt><dd>${esc(u.fmtFull(s.observedAt))} UTC</dd><dd class="sub">${esc(u.rel(s.observedAt))}</dd></div>${s.sourceRevision ? `<div><dt>Revision</dt><dd class="mono">${esc(u.shortSha(s.sourceRevision))}</dd></div>` : ''}</dl>` : ''}
      ${cat?.fix?.length ? `<h4 class="mini-h">How to fix</h4>${ui.stepsList(cat.fix.map(t => ({ t })))}` : ''}
      ${s.diagnostic ? `<p class="kv-label">Diagnostic</p><pre class="code code--diag">${esc(s.diagnostic)}</pre>` : ''}
    </div>`;
  };

  const scanItem = (s, i) => {
    const o = outcome(s.outcome), has = !!(s.diagnostic || (s.code && catalog.get(s.code)));
    const key = 'scan:' + s.scanId;
    const open = Fleet.openState.has(key) ? Fleet.openState.get(key) : (i === 0 && s.outcome !== 'unchanged' && s.outcome !== 'accepted');
    const top = `<span class="scan-top"><b>${esc(o.label)}</b>${s.sourceRevision ? u.revChip(u.shortSha(s.sourceRevision), s.sourceRevision) : ''}${s.code ? `<code class="small">${esc(s.code)}</code>` : ''}<span class="muted small">${s.requestedBy ? `requested by ${esc(s.requestedBy)}` : 'scheduled scan'}</span></span><time class="scan-t" datetime="${esc(s.observedAt)}">${esc(u.fmtFull(s.observedAt))} · ${esc(u.rel(s.observedAt))}</time>`;
    return `<li class="scan scan--${esc(s.outcome)}"><span class="scan-dot">${glyph(o.level, o.kind)}</span><div class="scan-card">
      ${has ? `<details data-open-key="${esc(key)}" ${open ? 'open' : ''}><summary>${top}${ic('chevD', 'sumchev')}</summary>${scanBody(s)}</details>` : `<div class="scan-sum">${top}</div>`}</div></li>`;
  };

  const paint = () => {
    const cur = S.rev;
    const last = S.status || S.scans[0] || null;
    const o = last ? outcome(last.outcome) : null;
    const curWarns = cur ? S.warnings.filter(w => w.desiredRevisionId === cur.desiredRevisionId) : [];
    const olderWarns = cur ? S.warnings.filter(w => w.desiredRevisionId !== cur.desiredRevisionId) : S.warnings;
    const sync = Fleet.shared.syncing;
    const warnCard = w => `<div class="callout callout--warning">${glyph('warning', 'bang')}<div><b>${esc(w.code)}</b>${catalog.get(w.code) ? ` <span class="muted">· ${esc(catalog.get(w.code).title)}</span>` : ''}<p>${esc(w.message)}</p>${(w.sourceLocations || []).length ? `<div class="loc-chips">${w.sourceLocations.map(l => `<span class="loc">${ic('folder')}<code>${esc(l)}</code></span>`).join('')}</div>` : ''}</div></div>`;
    return `<div class="wrap">
    ${ui.pageHead('Repository', 'Fleet publishes Skills, agent files and AI-client settings from your Git repository. A publication only happens when the manifest is valid.',
      ui.gate('operate', 'btn-primary', `${ic('sync', sync ? 'spin' : '')}${sync ? 'Syncing…' : 'Sync repository'}`, `data-act="sync" ${sync ? 'disabled' : ''}`))}
    ${ui.lockNote('operate')}
    <section class="panel repo-card">
      <div class="repo-id"><span class="repo-ic">${ic('branch')}</span><div><p class="eyebrow">Source</p><h2>Skills repository</h2><p class="muted small">Scanned automatically on a schedule, and whenever an Operator syncs.</p></div></div>
      <dl class="kv kv--grid kv--3">
        <div><dt>Published revision</dt><dd>${cur ? `${u.revChip(cur.sourceRevision, cur.sourceRevision)} <span class="muted small">${esc(u.rel(cur.acceptedAt))}</span>` : '<span class="muted">Nothing published yet</span>'}</dd></div>
        <div><dt>Last scan</dt><dd>${last ? `${glyph(o.level, o.kind)} ${esc(o.label)} <span class="muted small">${esc(u.rel(last.observedAt))}</span>` : '<span class="muted">No scans recorded yet</span>'}</dd></div>
        <div><dt>Last scan requested by</dt><dd>${last ? esc(last.requestedBy || 'Scheduled scan') : '—'}</dd></div>
        <div><dt>Source warnings</dt><dd>${curWarns.length ? `${glyph('warning', 'bang')} ${u.plural(curWarns.length, 'warning')}` : 'None'}</dd></div>
      </dl>
      ${Fleet.shared.lastSync ? `<p class="result" role="status">${glyph(Fleet.shared.lastSync.level, Fleet.shared.lastSync.kind)}${esc(Fleet.shared.lastSync.text)}</p>` : ''}
    </section>
    ${curWarns.length || olderWarns.length ? `<section class="panel"><header class="panel-head"><h2>Source warnings <span class="cnt">${curWarns.length}</span></h2><p>Raised while scanning the current revision. They do not block publication.</p></header>
      ${curWarns.length ? curWarns.map(warnCard).join('') : '<p class="muted">The current revision has no warnings.</p>'}
      ${olderWarns.length ? `<details class="tech"><summary>${ic('list')}Warnings on earlier revisions (${olderWarns.length})${ic('chevD', 'sumchev')}</summary><div class="tech-body">${olderWarns.slice(0, 20).map(warnCard).join('')}</div></details>` : ''}</section>` : ''}
    <section class="panel"><header class="panel-head"><h2>Recent scans</h2><p>Every fetch and validation, newest first. Rejected and failed scans never change what machines receive.</p></header>
      ${S.scans.length ? `<ol class="scans">${S.scans.map(scanItem).join('')}</ol>` : `<div class="empty-mini">${ic('branch')}<p>No scans have been recorded yet.</p></div>`}
      ${S.next ? `<div class="load-more"><button type="button" class="btn btn-secondary" data-act="more-scans" ${S.loadingMore ? 'disabled' : ''}>Load older scans</button></div>` : ''}
    </section>
  </div>`;
  };

  Fleet.views.repository = {
    title: 'Repository',
    async load() {
      const gen = ++S.gen;
      const [status, scans, revs, warnings] = await Promise.all([
        api.get('source/status').catch(Fleet.soft), api.page('source/scans', { limit: 20 }), api.page('desired-revisions', { order: 'newest', limit: 1 }),
        api.all('warnings', { maxPages: 3 }).catch(Fleet.soft), catalog.load(),
      ]);
      if (gen !== S.gen) throw Fleet.superseded();
      S.status = status; S.scans = scans.items; S.next = scans.nextCursor; S.rev = revs.items[0] || null; S.warnings = warnings ? warnings.items : []; S.loadingMore = false;
      model_refresh();
      return paint();
    },
    paint,
  };
  const model_refresh = () => Fleet.model.refreshSummary();

  /* ---------------------------------------------------------------- actions */
  const OUTCOMES = {
    accepted: r => ({ level: 'good', kind: 'check', title: 'Repository synced', text: `Published ${u.plural(r.changedAssignmentCount ?? 0, 'changed assignment')}. Running Agents fetch them on their next poll.` }),
    unchanged: () => ({ level: 'good', kind: 'check', title: 'Repository is up to date', text: 'No new assignments were needed. Agents continue syncing their current assignments.' }),
    disabled: () => ({ level: 'info', kind: 'info', title: 'No repository configured', text: 'No source repository is configured on this Server.' }),
    already_running: () => ({ level: 'info', kind: 'info', title: 'A sync is already running', text: 'Try again shortly to check for changes.' }),
    invalid: () => ({ level: 'warning', kind: 'bang', title: 'Repository sync was rejected', text: 'The manifest did not validate. Current assignments remain active. See Recent scans for the reason.' }),
    failed: () => ({ level: 'critical', kind: 'x', title: 'Repository sync failed', text: 'Check the Server’s Git access. Current assignments remain active.' }),
  };
  Fleet.actions.sync = async () => {
    if (Fleet.shared.syncing) return;
    Fleet.shared.syncing = true; Fleet.repaint();
    ui.toast('Repository sync started', { tone: 'info', text: 'Fetching and validating repository changes…' });
    try {
      const r = await api.post('source/rescan', {});
      const f = (OUTCOMES[r?.outcome] || (() => ({ level: 'warning', kind: 'bang', title: 'Unknown sync result', text: 'The Server returned an unknown result. Check Recent scans before retrying.' })))(r || {});
      Fleet.shared.lastSync = { level: f.level, kind: f.kind, text: `${f.title}. ${f.text}` };
      ui.toast(f.title, { tone: f.level === 'critical' ? 'critical' : f.level === 'warning' ? 'warning' : f.level === 'info' ? 'info' : 'good', text: f.text });
    } catch (e) { ui.fail(e, 'Repository sync could not be confirmed'); }
    Fleet.shared.syncing = false;
    /* The sync button and its result are on Machines, Problems and Repository. On any other page the user has moved on and nothing
       is reloaded for them: every page fetches fresh data when it is opened. */
    if (['nodes', 'problems', 'repository'].includes(Fleet.nav.current?.name) && !Fleet.nav.current.params?.[0]) await Fleet.reload({ quiet: true });
  };
  Fleet.actions['more-scans'] = async () => {
    if (S.loadingMore) return;
    const gen = S.gen;
    S.loadingMore = true; Fleet.repaint();
    try {
      const r = await api.page('source/scans', { limit: 20, after: S.next });
      if (gen !== S.gen) return;
      S.scans = S.scans.concat(r.items); S.next = r.nextCursor;
    } catch (e) { if (e.silent) return; ui.fail(e, 'Could not load older scans'); }
    if (gen === S.gen) { S.loadingMore = false; Fleet.repaint(); }
  };
})();
