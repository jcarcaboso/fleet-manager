'use strict';
/* Fleet dashboard: one machine, with Overview, Installed, Problems, Activity, Security and Settings tabs.
   API: GET nodes/{node}, GET nodes/{node}/checkins, GET nodes/{node}/attempts, GET audit?node=&order=newest, GET issues, GET errors,
   POST nodes/{node}/retry, POST nodes/rename, POST nodes/{id}/revoke, POST nodes/{id}/remove. */
(function () {
  const Fleet = window.Fleet = window.Fleet || {};
  const u = Fleet.u, ui = Fleet.ui, api = Fleet.api, model = Fleet.model, catalog = Fleet.catalog;
  const { esc, ic, glyph, enc } = u;
  Fleet.views = Fleet.views || {};

  const TABS = ['overview', 'installed', 'problems', 'activity', 'security', 'settings'];
  /* Everything that belongs to one loaded machine. A load builds it locally and commits it only if no newer load started. */
  const blank = () => ({ checkins: {}, checkinsErr: null, attempts: [], attemptsNext: null, attemptsErr: null,
    audit: [], auditNext: null, auditErr: null, tAttempts: new Map(), actFilter: 'all' });
  const S = { alias: null, tab: 'overview', raw: null, n: null, issues: [], issuesOk: false, hours: 168, ...blank(),
    renameMsg: null, retrying: new Set(), cacheAt: 0, token: 0, loadingMore: null, visit: 0, key: null };
  const PAGE = 25;
  const here = n => S.n?.id === n.id && Fleet.nav.current?.view === Fleet.views.node;
  /* A visit is one stay on one machine: it ends when the user opens another machine or leaves the machine view, and survives
     tab changes and quiet reloads. S.token changes with every load, so it cannot tell "the user left" from "the page refreshed".
     A mutation captures the visit and the machine before it asks the Server, and after the answer it may touch the page or
     navigate only if both still hold. Otherwise it only drops what is cached, because the answer is about a place the user has left. */
  const staying = (n, visit) => visit === S.visit && here(n);

  const targetByName = name => S.n?.targets.find(t => t.name === name) || { name };
  const failedTargets = () => (S.n?.targets || []).filter(t => t.state === 'failed');
  const failuresOf = () => failedTargets().map(t => ({ target: t, errorCode: t.latestAttempt?.errorCode || null }));
  const nodeIssues = () => S.issues.filter(i => i.nodeId === S.n.id);
  const health = () => model.health(S.n, failuresOf());

  /* ---------------------------------------------------------------- problems model for this machine */
  const problems = () => {
    const n = S.n, out = [];
    if (n.revoked) return out;
    const issues = nodeIssues();
    const used = new Set();
    for (const t of failedTargets()) {
      const match = issues.find(i => i.target === t.name);
      if (match) used.add(match.id);
      const code = t.latestAttempt?.errorCode || match?.errorCode || null;
      const cat = catalog.get(code);
      out.push({ kind: 'target', id: `target:${t.name}`, level: 'critical', glyph: 'x', badge: 'Error', target: t, issue: match || null, code, cat,
        title: cat?.title || code || `${u.targetLabel(t)} failed`, since: t.firstFailedAt });
    }
    for (const i of issues) {
      if (used.has(i.id)) continue;
      const level = model.issueLevel(i);
      out.push({ kind: 'issue', id: i.id, level, glyph: model.issueKind(level, i), badge: model.issueBadge(level, i), issue: i, code: i.errorCode || i.code,
        cat: catalog.get(i.errorCode) || catalog.get(i.code), title: i.title, since: i.since });
    }
    return out.sort((a, b) => model.LRANK[a.level] - model.LRANK[b.level]);
  };

  const facts = list => `<dl class="facts-row">${list.map(([k, v, sub, mono]) => `<div><dt>${esc(k)}</dt><dd${mono ? ' class="mono"' : ''}>${esc(v)}</dd>${sub ? `<dd class="sub">${esc(sub)}</dd>` : ''}</div>`).join('')}</dl>`;
  const attemptRows = list => `<div class="tbl-wrap"><table class="tbl tbl--compact"><thead><tr><th>Attempt</th><th>Revision</th><th>Result</th><th>Updated (UTC)</th><th>Error code</th></tr></thead><tbody>${list.map(a => `<tr><td class="mono">${esc(u.shortId(a.attemptId))}</td><td>${u.revChip(a.sourceRevision, a.sourceRevision)}</td><td>${u.stateTag(a.state)}</td><td>${esc(u.fmtFull(a.updatedAt))}</td><td>${a.errorCode ? `<code>${esc(a.errorCode)}</code>` : '<span class="muted">—</span>'}</td></tr>`).join('')}</tbody></table></div>`;

  const problemCard = p => {
    const n = S.n, cat = p.cat, i = p.issue, t = p.target;
    const where = t ? `${esc(u.targetLabel(t))} <code>${esc(t.name)}</code> on <a href="#/nodes/${enc(n.alias)}">${esc(n.alias)}</a>`
      : `<a href="#/nodes/${enc(n.alias)}">${esc(n.alias)}</a>${i?.target ? ` · <code>${esc(i.target)}</code>` : ''}`;
    const explanation = cat?.explanation || i?.detail || '';
    const specific = i && cat?.explanation && i.detail && i.detail !== cat.explanation ? i.detail : '';
    let factList = [];
    if (t) {
      factList = [
        ['First failed', u.fmtFull(t.firstFailedAt) + ' UTC', u.rel(t.firstFailedAt)],
        ['Failed attempts', u.num(t.failedAttempts ?? 0), 'on the current assignment'],
        ['Latest attempt', t.latestAttempt ? u.rel(t.latestAttempt.updatedAt) : '—', t.latestAttempt ? `${u.tstate(t.latestAttempt.state).label} · ${u.fmtFull(t.latestAttempt.updatedAt)} UTC` : ''],
        ['Desired revision', t.desiredRevision ? u.shortSha(t.desiredRevision.sourceRevision) : '—', t.desiredRevision ? `published ${u.rel(t.desiredRevision.acceptedAt)}` : ''],
        ['Last in sync at', t.lastSucceededRevision ? u.shortSha(t.lastSucceededRevision) : 'Never', t.lastSucceededRevision ? '' : 'nothing has been applied for this Target'],
      ];
    } else if (i) {
      factList = [['Since', i.since ? u.fmtFull(i.since) + ' UTC' : '—', i.since ? u.rel(i.since) : ''], ['Severity', i.severity === 'error' ? 'Error' : 'Warning', ''], ...(i.errorCode ? [['Error code', i.errorCode, '', true]] : [])];
    }
    const diag = t?.latestAttempt?.diagnostic;
    const fix = cat?.fix?.length ? cat.fix.map(x => ({ t: x })) : (i?.action ? [{ t: i.action }] : []);
    const commands = i?.commands || [];
    const attempts = t ? S.tAttempts.get(t.name) : null;
    const retrying = t && S.retrying.has(n.id + ':' + t.name);
    const retry = !t ? '' : n.revoked ? ui.locked('operate', 'btn-primary', `${ic('retry')}Retry now`)
      : !api.can('operate') ? ui.locked('operate', 'btn-primary', `${ic('retry')}Retry now`)
        : `<button type="button" class="btn btn-sm btn-primary" data-act="retry" data-target="${esc(t.name)}" ${retrying ? 'disabled' : ''}>${ic('retry', retrying ? 'spin' : '')}${retrying ? 'Requesting…' : 'Retry now'}</button>`;
    const retryBtn = retry.replace('class="btn btn-primary', 'class="btn btn-sm btn-primary');
    return `<article class="prob prob--${p.level}" id="p-${u.slug(p.id)}">
    <header class="prob-head"><span class="prob-ic t-${p.level}">${glyph(p.level, p.glyph)}</span><div class="prob-titles"><h3>${esc(p.title)}</h3><p class="prob-where">${where}</p></div>${u.pill(p.level, p.glyph, p.badge)}</header>
    <div class="prob-body">
      ${explanation ? `<p class="prob-expl">${u.md(explanation)}${specific ? ` <strong>${u.md(specific)}</strong>` : ''}</p>` : '<p class="prob-expl muted">The Server has no catalog entry for this code yet.</p>'}
      ${factList.length ? facts(factList) : ''}
      ${diag ? `<p class="kv-label">Diagnostic from the Agent</p><pre class="code code--diag">${esc(diag)}</pre>` : ''}
      <div class="prob-cols">
        <section class="fix" aria-label="How to fix"><h4>How to fix</h4>${fix.length ? ui.stepsList(fix) : '<p class="muted">No fix steps are published for this problem.</p>'}${t ? '<p class="muted small prob-note">The Agent applies a retry on its next poll.</p>' : ''}</section>
        <section class="why">
          ${commands.length ? `<h4>From the CLI</h4>${commands.map(c => u.cmdBlock(c)).join('')}` : ''}
          ${t && t.lastSucceededRevision ? `<h4>Last known good</h4><p class="small">${u.revChip(t.lastSucceededRevision, t.lastSucceededRevision)} <span class="muted">is still what this Target last applied successfully.</span></p>` : ''}
        </section>
      </div>
      <details class="tech" data-open-key="tech:${esc(n.id + p.id)}" ${Fleet.openState.get('tech:' + n.id + p.id) ? 'open' : ''}><summary>${ic('terminal')}Technical details${ic('chevD', 'sumchev')}</summary><div class="tech-body">
        <dl class="kv"><div><dt>Error code</dt><dd><code>${esc(p.code || '—')}</code></dd></div>${t ? `<div><dt>Target path</dt><dd class="mono">${esc(u.targetWhere(t))}</dd></div><div><dt>Assignment</dt><dd class="mono">${esc(t.assignmentId)}</dd></div>${t.latestAttempt ? `<div><dt>Latest attempt</dt><dd class="mono">${esc(t.latestAttempt.attemptId)}</dd></div>` : ''}` : ''}${i ? `<div><dt>Issue</dt><dd class="mono">${esc(i.id)}</dd></div>` : ''}</dl>
        ${attempts ? `<p class="kv-label">Recent attempts</p>${attempts.length ? attemptRows(attempts) : '<p class="muted small">No attempts recorded.</p>'}` : ''}
      </div></details>
      ${t ? `<footer class="prob-actions">${retryBtn}${n.revoked ? '<span class="muted small">Revoked machines cannot be retried.</span>' : ui.lockNote('operate').replace('lock-note', 'lock-note lock-note--inline')}</footer>` : ''}
    </div></article>`;
  };

  /* ---------------------------------------------------------------- tabs */
  const healthChecks = () => {
    const n = S.n, out = [], total = model.total(n), left = model.certLeft(n);
    if (n.revoked) out.push({ level: 'neutral', kind: 'minus', title: 'Access revoked', text: `Revoked ${u.rel(n.revokedAt)}${n.credential?.revokedBy ? ` by ${n.credential.revokedBy}` : ''}. Its certificates no longer work.` });
    else if (n.freshness === 'fresh') out.push({ level: 'good', kind: 'check', title: 'Checking in', text: `Last poll ${u.rel(n.lastContactAt)}` });
    else if (n.freshness === 'stale') out.push({ level: 'serious', kind: 'moon', title: 'Not checking in', text: `No poll for ${u.span(u.now() - u.ms(n.lastContactAt), true)}, since ${u.fmtFull(n.lastContactAt)} UTC` });
    else out.push({ level: 'serious', kind: 'clock', title: 'Never checked in', text: `Enrolled ${u.rel(n.enrolledAt)}; no poll yet` });
    const fail = failedTargets(), ok = n.counts.succeeded;
    if (n.revoked) out.push({ level: 'neutral', kind: 'minus', title: 'Targets frozen', text: 'Revoked machines receive no further assignments.' });
    else if (total === 0) out.push({ level: 'pending', kind: 'clock', title: 'No Targets assigned', text: 'Add this machine to fleet.yml, then sync the repository.' });
    else if (fail.length) out.push({ level: 'critical', kind: 'x', title: `${fail.length} of ${total} Targets failing`, text: u.listText(fail.map(t => u.targetLabel(t))) });
    else if (ok === total) out.push({ level: 'good', kind: 'check', title: `All ${total} Targets in sync`, text: n.currentRevision ? `At revision ${u.shortSha(n.currentRevision)}` : '' });
    else out.push({ level: 'info', kind: 'sync', title: `${ok} of ${total} Targets in sync`, text: `${u.listText(n.targets.filter(t => t.state !== 'succeeded').map(t => u.targetShort(t)))} still to apply` });
    if (!n.revoked && left !== null) {
      out.push(left <= 0 ? { level: 'warning', kind: 'bang', title: 'Certificate expired', text: n.freshness === 'fresh' ? 'It renews at the next poll.' : 'The Agent renews it when it reconnects.' }
        : left < u.DAY ? { level: 'warning', kind: 'bang', title: 'Certificate expires soon', text: `${u.span(left)} left${n.freshness === 'fresh' ? ' · renews at the next poll' : ' · cannot renew while offline'}` }
          : { level: 'good', kind: 'check', title: 'Certificate valid', text: `${u.span(left)} left · renews automatically` });
    }
    if (n.credential) out.push({ level: 'neutral', kind: 'info', title: `${u.plural(n.credential.renewals, 'renewal')} since enrollment`, text: `Issued ${u.fmtFull(n.credential.notBefore)} UTC` });
    return out;
  };

  const targetContent = t => {
    if (t.skills?.length || u.targetKind(t.name) === 'skills') return u.plural((t.skills || []).length, 'Skill');
    if (t.file) return t.file.bundleDigest ? t.file.name : `${t.file.name} (removal)`;
    if (t.aiClient) return t.aiClient.mode === 'cliproxy' ? `CLIProxy · ${t.aiClient.model || 'default model'}` : 'Native login';
    return '—';
  };
  const targetsTable = () => {
    const n = S.n;
    if (!n.targets.length) return `<div class="empty-mini">${ic('layers')}<p>No Targets are assigned to this machine yet.</p></div>`;
    return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Target</th><th>Content</th><th>Last in sync</th><th aria-label="changes to"></th><th>Desired</th><th>State</th><th>Updated</th></tr></thead><tbody>${n.targets.map(t => {
      const same = t.lastSucceededRevision && t.desiredRevision && t.lastSucceededRevision === t.desiredRevision.sourceRevision;
      const updated = t.latestAttempt?.updatedAt || t.assignedAt;
      return `<tr><td><span class="tcell">${ic(u.targetIcon(t))}<span><b>${esc(u.targetLabel(t))}</b><span class="mono muted">${esc(u.targetWhere(t))}</span></span></span></td><td>${esc(targetContent(t))}</td><td>${u.revChip(t.lastSucceededRevision, t.lastSucceededRevision)}</td><td>${same ? '<span class="muted" aria-label="same">=</span>' : ic('arrowR', 'muted')}</td><td>${t.desiredRevision ? u.revChip(t.desiredRevision.sourceRevision, `${t.desiredRevision.sourceRevision}|published ${u.rel(t.desiredRevision.acceptedAt)}`) : '<span class="muted">—</span>'}</td><td>${u.stateTag(t.state)}</td><td class="muted">${esc(u.rel(updated))}</td></tr>`;
    }).join('')}</tbody></table></div>`;
  };

  const tabOverview = () => {
    const n = S.n, checks = healthChecks();
    const buckets = S.checkins[S.hours];
    const rev = n.currentRevision;
    const rowTime = t => t.state === 'succeeded' ? (t.latestAttempt ? 'applied ' + u.rel(t.latestAttempt.updatedAt) : 'in sync') : t.state === 'failed' ? `since ${u.rel(t.firstFailedAt)}` : t.state === 'applying' ? `started ${u.rel(t.latestAttempt?.updatedAt || t.assignedAt)}` : t.state === 'superseded' ? 'replaced' : 'not started';
    return `<div class="cols">
    <section class="panel"><header class="panel-head"><h2>Health checks</h2><p>What Fleet knows about ${esc(n.alias)} right now.</p></header>
      <ul class="hchecks">${checks.map(c => `<li>${glyph(c.level, c.kind)}<div><b>${esc(c.title)}</b><span>${esc(c.text)}</span></div></li>`).join('')}</ul></section>
    <section class="panel"><header class="panel-head"><h2>${rev ? `Targets at revision ${esc(u.shortSha(rev))}` : 'Targets'}</h2><p>${rev && n.currentAcceptedAt ? `Newest desired revision for this machine, published ${esc(u.rel(n.currentAcceptedAt))}.` : 'The current assignment of each Target.'}</p></header>
      ${n.targets.length ? `<ul class="trows">${n.targets.map(t => `<li><span class="trow-ic">${ic(u.targetIcon(t))}</span><span class="trow-name">${esc(u.targetLabel(t))}</span>${u.stateTag(t.state)}<span class="trow-t">${esc(rowTime(t))}</span></li>`).join('')}</ul>`
        : `<div class="empty-mini">${ic('layers')}<p>Nothing is assigned yet.</p></div>`}
      <a class="more" href="#/deployments">See all deployments${ic('arrowR')}</a></section>
  </div>
  <section class="panel"><header class="panel-head"><h2>Targets: last in sync vs desired</h2><p>The revision each Target last applied successfully, next to the revision it should reach.</p></header>${targetsTable()}</section>
  <section class="panel"><header class="panel-head row"><div><h2>Check-ins</h2><p>Authenticated polls received per hour. Times in UTC.</p></div>
    <div class="head-tools"><div class="seg-ctl" role="group" aria-label="Range">${[[168, '7 days'], [24, '24 hours']].map(([h, l]) => `<button type="button" data-act="range" data-v="${h}" aria-pressed="${S.hours === h}">${l}</button>`).join('')}</div>
    <div class="stat"><span class="stat-l">Total</span><b class="stat-v">${buckets ? u.num(Fleet.charts.total(buckets)) : '—'}</b></div></div></header>
    ${buckets ? (buckets.length ? Fleet.charts.chart(`${n.id}:${S.hours}`, buckets) + Fleet.charts.gapList(buckets, { revoked: n.revoked }) : '<div class="empty-mini"><p>No check-in data yet.</p></div>')
      : S.checkinsErr ? ui.inlineError(S.checkinsErr, 'check-ins') : '<div class="skel skel-block"></div>'}
  </section>`;
  };

  const tabInstalled = () => {
    const n = S.n, st = n.targets.find(t => u.targetKind(t.name) === 'skills');
    const files = n.targets.filter(t => u.targetKind(t.name) === 'agent-file'), clients = n.targets.filter(t => u.targetKind(t.name) === 'ai-client');
    const other = n.targets.filter(t => !['skills', 'agent-file', 'ai-client'].includes(u.targetKind(t.name)) && t !== st);
    const mono = c => `<span class="mono-ic m-${esc(['claude', 'codex', 'opencode'].includes(c) ? c : 'other')}" aria-hidden="true">${esc(u.initial(c))}</span>`;
    const skills = st?.skills || [];
    return `<section class="panel"><header class="panel-head row"><div><h2>Skills <span class="cnt">${skills.length}</span></h2><p>${st ? `<span class="mono">${esc(u.targetWhere(st))}</span> · in manifest order` : 'No Skills Target is assigned to this machine.'}</p></div>${st ? u.stateTag(st.state) : ''}</header>
    ${skills.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Skill</th><th>Bundle digest</th><th>Status</th></tr></thead><tbody>${skills.map(s => `<tr><td><b>${esc(s.name)}</b></td><td><span class="digest"><code data-tip="${esc(s.bundleDigest || '')}">${esc(u.digestShort(s.bundleDigest))}</code>${s.bundleDigest ? u.copyBtn(s.bundleDigest, '', `Copy digest of ${s.name}`) : ''}</span></td><td>${u.stateTag(st.state)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty-note">No Skills assigned.</p>'}
  </section>
  <div class="cols">
    <section class="panel"><header class="panel-head"><h2>Agent files</h2><p>Instruction files Fleet writes for AI clients on this machine.</p></header>
      ${files.length ? `<ul class="icards">${files.map(t => `<li class="icard"><span class="icard-ic">${ic('file')}</span><div class="icard-main"><h3>${esc(t.file?.name || 'Agent file')} ${u.targetClient(t) ? `<span class="muted">for ${esc(u.clientName(u.targetClient(t)))}</span>` : ''}</h3><p class="mono small">${esc(u.targetWhere(t))}${t.file ? '/' + esc(t.file.name) : ''}</p><p class="muted small">${t.file ? (t.file.bundleDigest ? `digest ${esc(u.digestShort(t.file.bundleDigest))}` : 'Assigned for removal') : 'No file in this assignment'}${t.lastSucceededRevision ? ` · last applied at ${esc(u.shortSha(t.lastSucceededRevision))}` : ' · not applied yet'}</p></div>${u.stateTag(t.state)}</li>`).join('')}</ul>` : `<div class="empty-mini">${ic('file')}<p>No agent files on this machine.</p></div>`}
    </section>
    <section class="panel"><header class="panel-head"><h2>AI clients</h2><p>Connections Fleet manages. Fleet owns only the connection fields, never the login.</p></header>
      ${clients.length ? `<ul class="icards">${clients.map(t => { const a = t.aiClient; const c = a?.client || u.targetClient(t); return `<li class="icard">${mono(c)}<div class="icard-main"><h3>${esc(u.clientName(c))}</h3>
        <dl class="mini-kv"><div><dt>Connection</dt><dd>${a ? (a.mode === 'cliproxy' ? 'CLIProxy' : a.mode === 'native' ? 'Native login' : esc(a.mode)) : '—'}</dd></div>${a?.baseUrl ? `<div><dt>Endpoint</dt><dd class="mono">${esc(u.hostOf(a.baseUrl))}</dd></div>` : ''}${a && a.mode !== 'native' ? `<div><dt>Model</dt><dd class="mono">${esc(a.model || 'catalog default')}</dd></div>` : ''}</dl></div>${u.stateTag(t.state)}</li>`; }).join('')}</ul>` : `<div class="empty-mini">${ic('spark')}<p>Fleet does not manage any AI client here.</p></div>`}
    </section>
  </div>
  ${other.length ? `<section class="panel"><header class="panel-head"><h2>Other Targets</h2></header><ul class="icards">${other.map(t => `<li class="icard"><span class="icard-ic">${ic('file')}</span><div class="icard-main"><h3>${esc(t.name)}</h3><p class="mono small">${esc(u.targetWhere(t))}</p></div>${u.stateTag(t.state)}</li>`).join('')}</ul></section>` : ''}`;
  };

  const tabProblems = () => {
    const n = S.n, list = problems();
    if (n.revoked) return `<div class="empty empty--good"><div class="empty-art good">${glyph('neutral', 'minus')}</div><h2>${esc(n.alias)} is retired</h2><p>Revoked machines get no new assignments, so Fleet no longer tracks problems for them.</p></div>`;
    const note = S.issuesOk ? '' : `<div class="callout callout--warning">${glyph('warning', 'bang')}<div><b>Issue details are unavailable</b><p>Failed Targets are shown from the machine record, without CLI commands or other issues.</p></div></div>`;
    if (!list.length) return note + `<div class="empty empty--good"><div class="empty-art good">${glyph('good', 'check')}</div><h2>Nothing to fix on ${esc(n.alias)}</h2><p>${model.total(n) ? `All ${u.plural(model.total(n), 'Target')} are in sync and the Agent is checking in.` : 'Nothing is assigned to this machine yet.'}</p></div>`;
    return note + list.map(problemCard).join('');
  };

  const events = () => {
    const n = S.n, ev = [];
    for (const a of S.attempts) {
      const m = u.tstate(a.state);
      ev.push({ at: a.updatedAt, level: m.level, kind: m.kind, cat: 'attempt', title: `${u.targetLabel(targetByName(a.targetName))} ${u.attemptVerb(a.state)}`,
        sub: [u.shortSha(a.sourceRevision), a.errorCode ? catalog.title(a.errorCode) : null, a.errorCode].filter(Boolean).join(' · '), text: a.diagnostic });
    }
    for (const e of S.audit) {
      const sec = /credential/.test(e.action);
      const bad = /revoked|removed/.test(e.action);
      ev.push({ at: e.recordedAt, level: bad ? 'neutral' : 'good', kind: bad ? 'minus' : 'check', cat: sec ? 'security' : 'change', title: Fleet.auditLabel(e.action), sub: `by ${Fleet.actorName(e)}` });
    }
    if (n.enrolledAt && !S.auditNext && !S.audit.some(e => e.action === 'node_enrolled')) ev.push({ at: n.enrolledAt, level: 'good', kind: 'check', cat: 'change', title: `Enrolled as ${n.alias}`, sub: `${u.platformLabel(n.platform)} machine` });
    return ev.filter(e => u.valid(e.at)).sort((a, b) => u.ms(b.at) - u.ms(a.at));
  };
  const tabActivity = () => {
    const all = events();
    const cats = [['all', 'Everything'], ['attempt', 'Attempts'], ['change', 'Changes'], ['security', 'Certificates']];
    const f = S.actFilter, ev = f === 'all' ? all : all.filter(e => e.cat === f);
    const errs = [S.attemptsErr && ui.inlineError(S.attemptsErr, 'attempts'), S.auditErr && ui.inlineError(S.auditErr, 'the audit log')].filter(Boolean).join('');
    return `<section class="panel"><header class="panel-head row"><div><h2>Activity</h2><p>Attempts and changes for ${esc(S.n.alias)}, newest first. Times in UTC.</p></div>
      ${ui.chips('act-filter', f, cats.map(([k, l]) => [k, l, k === 'all' ? all.length : all.filter(e => e.cat === k).length]), 'Filter activity')}</header>
      ${errs}${ui.timeline(ev)}
      ${S.attemptsNext || S.auditNext ? `<div class="load-more"><button type="button" class="btn btn-secondary" data-act="more-activity" ${S.loadingMore ? 'disabled' : ''}>Load older activity</button></div>` : ''}</section>`;
  };

  const tabSecurity = () => {
    const n = S.n, c = n.credential;
    if (!c) return `<section class="panel"><header class="panel-head"><h2>Node credential</h2></header><div class="empty-mini">${ic('key')}<p>This machine has no credential on record.</p></div></section>`;
    const from = u.ms(c.notBefore), to = u.ms(c.notAfter), total = Math.max(1, to - from), left = to - u.now();
    const pNow = Math.max(0, Math.min(100, (u.now() - from) / total * 100));
    const lvl = n.revoked ? 'neutral' : left <= 0 ? 'critical' : left < u.DAY ? 'warning' : 'good';
    return `<div class="cols">
    <section class="panel"><header class="panel-head"><h2>Node credential</h2><p>The Agent proves possession of its private key with this client certificate. The key never leaves ${esc(n.alias)}.</p></header>
      ${n.revoked ? `<div class="note">${ic('ban')}<p><b>Revoked ${esc(u.rel(c.revokedAt || n.revokedAt))}${c.revokedBy ? ` by ${esc(c.revokedBy)}` : ''}.</b> Every certificate for this machine is blocked.</p></div>` : `
      <div class="validity" role="img" aria-label="Certificate validity: issued ${esc(u.fmtFull(c.notBefore))}, expires ${esc(u.fmtFull(c.notAfter))} UTC, ${esc(model.certText(n))}.">
        <div class="vbar"><span class="vb-used" data-w="${pNow.toFixed(1)}"></span><span class="vb-left v-${lvl}" data-l="${pNow.toFixed(1)}" data-w="${(100 - pNow).toFixed(1)}"></span><span class="vb-now" data-l="${pNow.toFixed(1)}"></span></div>
        <div class="vb-nowrow"><span class="vb-now-l" data-l="${Math.max(14, Math.min(86, pNow)).toFixed(1)}">Now · ${esc(model.certText(n))}</span></div>
        <div class="vb-labels"><span>Issued ${esc(u.fmtFull(c.notBefore))} UTC</span><span>Expires ${esc(u.fmtFull(c.notAfter))} UTC</span></div>
      </div>`}
      <dl class="kv kv--grid">
        <div><dt>Credential ID</dt><dd class="mono">${esc(c.credentialId)}${u.copyBtn(c.credentialId, '', 'Copy credential ID')}</dd></div>
        <div><dt>Renewals</dt><dd>${u.num(c.renewals)} since enrollment</dd></div>
        <div><dt>Valid from</dt><dd>${esc(u.fmtFull(c.notBefore))} UTC</dd></div>
        <div><dt>Valid until</dt><dd>${esc(u.fmtFull(c.notAfter))} UTC</dd></div>
        <div><dt>Enrolled</dt><dd>${esc(u.fmtFull(n.enrolledAt))} UTC</dd></div>
        <div><dt>Node ID</dt><dd class="mono">${esc(n.id)}${u.copyBtn(n.id, '', 'Copy Node ID')}</dd></div>
      </dl>
      ${!n.revoked && left <= 0 ? `<div class="note">${ic('info')}<p>An expired certificate renews by itself when the Agent next reconnects.</p></div>` : ''}
    </section>
    <section class="panel panel--danger"><header class="panel-head"><h2>Access</h2><p>Revoking does not delete files on the machine.</p></header>
      ${n.revoked ? `<div class="note">${ic('ban')}<p>This machine is already revoked. To free its alias, remove it on the <a href="#/nodes/${enc(n.alias)}/settings">Settings</a> tab.</p></div>`
        : `<div class="danger-row"><div><h3>Revoke access</h3><p>Blocks all of this machine's certificates right away. Its record, history and alias stay.</p></div>${ui.gate('admin', 'btn-secondary', `${ic('ban')}Revoke…`, 'data-act="revoke-node"')}</div>`}
      ${ui.lockNote('admin')}
    </section></div>`;
  };

  const tabSettings = () => {
    const n = S.n, admin = api.can('admin'), off = n.revoked || !admin;
    return `<div class="cols">
    <section class="panel"><header class="panel-head"><h2>Alias</h2><p>The alias is how fleet.yml refers to this machine. It must be unique; revoked aliases stay reserved.</p></header>
      <form class="form" data-form="rename" novalidate>
        <label for="rename-alias">Alias</label>
        <div class="input-row"><input id="rename-alias" name="alias" value="${esc(n.alias)}" maxlength="201" autocomplete="off" spellcheck="false" aria-describedby="rename-msg" ${off ? 'disabled' : ''}>${admin ? `<button class="btn btn-primary" type="submit" ${n.revoked ? 'disabled' : ''}>Save alias</button>` : ui.locked('admin', 'btn-primary', 'Save alias')}</div>
        <p class="field-msg${S.renameMsg?.err ? ' is-err' : S.renameMsg ? ' is-ok' : ''}" id="rename-msg" role="status">${S.renameMsg ? esc(S.renameMsg.text) : n.revoked ? 'Revoked machines cannot be renamed.' : !admin ? esc(api.denied('admin')) : 'After renaming, update the key under nodes: in fleet.yml too.'}</p>
      </form></section>
    <section class="panel"><header class="panel-head"><h2>Identity</h2><p>Read-only facts Fleet stores for this machine.</p></header>
      <dl class="kv"><div><dt>Node ID</dt><dd class="mono">${esc(n.id)}${u.copyBtn(n.id, '', 'Copy Node ID')}</dd></div><div><dt>Platform</dt><dd>${esc(u.platformLabel(n.platform))}</dd></div><div><dt>Enrolled</dt><dd>${esc(u.fmtFull(n.enrolledAt))} UTC · ${esc(u.rel(n.enrolledAt))}</dd></div></dl></section>
  </div>
  <section class="panel panel--danger"><header class="panel-head"><h2>Remove from Fleet</h2><p>Permanently deletes the server record, credentials, assignments and attempts. The alias becomes available again; audit history stays. Files on the machine are not erased.</p></header>
    <div class="danger-row"><div><h3>Remove ${esc(n.alias)}</h3><p>Afterwards, stop its Agent and remove its fleet.yml entry unless you will enroll a replacement.</p></div>${ui.gate('admin', 'btn-danger', `${ic('trash')}Remove…`, 'data-act="remove-node"')}</div>${ui.lockNote('admin')}
  </section>`;
  };

  /* ---------------------------------------------------------------- page */
  const paint = () => {
    const n = S.n, h = health(), a = enc(n.alias), tab = S.tab;
    const probs = problems();
    const serious = probs.filter(p => p.level !== 'info').length;
    const worst = probs[0]?.level || 'info';
    const total = model.total(n), synced = n.counts.succeeded;
    const left = model.certLeft(n);
    const fact = [
      ['Last check-in', n.lastContactAt ? u.rel(n.lastContactAt) : 'Never', n.lastContactAt ? `${u.fmtFull(n.lastContactAt)} UTC` : `enrolled ${u.rel(n.enrolledAt)}`],
      ['Revision', n.currentRevision ? u.shortSha(n.currentRevision) : '—', total ? `${synced} of ${total} Targets in sync` : 'no Targets assigned'],
      ['Certificate', model.certText(n), n.revoked ? `revoked ${u.rel(n.revokedAt)}` : n.notAfter ? `until ${u.fmtFull(n.notAfter)} UTC` : ''],
      ['Targets', String(total), total ? u.listText(u.STATES.filter(s => n.counts[s.key] > 0).map(s => `${n.counts[s.key]} ${s.label.toLowerCase()}`)) : 'none yet'],
      ['Platform', u.platformLabel(n.platform), 'reported at enrollment'],
      ['Enrolled', u.fmtDay(n.enrolledAt), u.rel(n.enrolledAt)],
    ];
    let meter = '';
    if (n.credential && !n.revoked && left !== null) {
      const tot = Math.max(1, u.ms(n.credential.notAfter) - u.ms(n.credential.notBefore));
      const lvl = left <= 0 ? 'critical' : left < u.DAY ? 'warning' : 'good';
      meter = `<div class="meter m-${lvl}" role="img" aria-label="Certificate: ${esc(model.certText(n))}"><span data-w="${Math.max(0, Math.min(100, left / tot * 100)).toFixed(1)}"></span></div>`;
    }
    const tabContent = { overview: tabOverview, installed: tabInstalled, problems: tabProblems, activity: tabActivity, security: tabSecurity, settings: tabSettings }[tab]();
    return `<div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="#/nodes">${ic('chevL')}All machines</a><span aria-hidden="true">/</span><span aria-current="page">${esc(n.alias)}</span></nav>
    <section class="nhero nhero--${h.key}">
      <div class="nhero-stage">${Fleet.art.device(n, h)}<span class="nhero-model">${n.platform === 'macos' ? ic('apple') : n.platform === 'linux' ? ic('tux') : ''}${esc(u.platformLabel(n.platform))}</span></div>
      <div class="nhero-info">
        <div class="nhero-top"><h1 tabindex="-1">${esc(n.alias)}</h1>${u.pill(h.level, h.kind, h.label)}</div>
        <p class="nhero-sub">${esc(u.platformLabel(n.platform))} machine · enrolled ${esc(u.fmtDay(n.enrolledAt))}</p>
        <a class="reason reason--lg reason--${h.level}" href="#/nodes/${a}/${h.key === 'failing' || h.key === 'offline' || h.key === 'never' ? 'problems' : 'overview'}">${glyph(h.level, h.kind)}<span>${esc(h.reason)}${h.extra ? `<span class="reason-extra"> · ${esc(h.extra)}</span>` : ''}</span>${ic('chevR', 'rchev')}</a>
        <dl class="facts">${fact.map(([k, v, s]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd><dd class="sub">${esc(s)}</dd>${k === 'Certificate' ? meter : ''}</div>`).join('')}</dl>
        <div class="nhero-actions">
          ${serious ? `<a class="btn btn-primary" href="#/nodes/${a}/problems">${ic('alert')}Fix ${u.plural(serious, 'problem')}</a>` : ''}
          <a class="btn btn-secondary" href="#/nodes/${a}/settings">${ic('pencil')}Rename</a>
          ${n.revoked ? '' : ui.gate('admin', 'btn-secondary', `${ic('ban')}Revoke`, 'data-act="revoke-node"')}
          ${ui.gate('admin', 'btn-secondary btn-danger-ghost', `${ic('trash')}Remove`, 'data-act="remove-node"')}
        </div>
      </div>
    </section>
    <nav class="tabs" aria-label="${esc(n.alias)} sections">${[['overview', 'Overview'], ['installed', 'Installed'], ['problems', 'Problems', probs.length], ['activity', 'Activity'], ['security', 'Security'], ['settings', 'Settings']].map(([k, l, c]) => `<a href="#/nodes/${a}/${k}" ${k === tab ? 'aria-current="page"' : ''}>${l}${c ? `<span class="tab-cnt t-${worst}">${c}</span>` : ''}</a>`).join('')}</nav>
    <div class="tabpanel" id="tabpanel">${tabContent}</div>
  </div>`;
  };

  const notFound = alias => `<div class="wrap">${ui.empty({ icon: 'search', h: 'h1', title: `We could not find “${alias}”`, text: 'It may have been renamed or removed. Removed machines free their alias.', action: '<a class="btn btn-secondary" href="#/nodes">Back to all machines</a>' })}</div>`;

  /* Reads what a tab shows for machine n. Returns the changes to commit; nothing here touches S, so a response that arrives
     after a newer load cannot overwrite the machine now on screen. base is the state the changes apply to. */
  async function loadTabData(n, tab, base) {
    const id = n.id, hours = S.hours, patch = {}, jobs = [];
    const quiet = e => { if (e.silent) throw e; };
    if (tab === 'overview' && !base.checkins[hours]) {
      patch.checkinsErr = null;
      jobs.push(api.get(`nodes/${id}/checkins`, { hours }).then(r => { patch.checkins = { ...base.checkins, [hours]: r?.buckets || [] }; }, e => { quiet(e); patch.checkinsErr = e; }));
    }
    if (tab === 'activity') {
      patch.attemptsErr = patch.auditErr = null;
      jobs.push(api.page(`nodes/${id}/attempts`, { limit: PAGE }).then(r => { patch.attempts = r.items; patch.attemptsNext = r.nextCursor; }, e => { quiet(e); patch.attemptsErr = e; patch.attempts = []; patch.attemptsNext = null; }));
      jobs.push(api.page('audit', { node: id, order: 'newest', limit: PAGE }).then(r => { patch.audit = r.items; patch.auditNext = r.nextCursor; }, e => { quiet(e); patch.auditErr = e; patch.audit = []; patch.auditNext = null; }));
    }
    if (tab === 'problems') {
      const tAttempts = patch.tAttempts = new Map(base.tAttempts);
      for (const t of n.targets.filter(x => x.state === 'failed').slice(0, 5)) {
        jobs.push(api.get(`nodes/${id}/attempts`, { target: t.name, limit: 8 }).then(r => tAttempts.set(t.name, r?.items || []), e => { quiet(e); tAttempts.delete(t.name); }));
      }
    }
    await Promise.all(jobs);
    return patch;
  }

  Fleet.views.node = {
    title: params => params[0] || 'Machine',
    async load(params, { force = false } = {}) {
      const key = params[0];
      const tab = TABS.includes(params[1]) ? params[1] : 'overview';
      /* The address may name the machine by alias or by ID, and tabs switch between them, so compare with the machine on screen too. */
      if (S.key !== null && key !== S.key && !(S.n && (S.n.alias === key || S.n.id === key))) S.visit++;
      S.key = key;
      /* Every await below can outlive this navigation. The generation says whether this load is still the newest. */
      const gen = ++S.token;
      const current = () => { if (gen !== S.token) throw Fleet.superseded(); };
      const same = S.n && (S.n.alias === key || S.n.id === key) && !force && u.now() - S.cacheAt < 15000;
      let n = S.n, detail = S.raw, issues = null;
      if (!same) {
        try {
          [detail] = await Promise.all([api.get(`nodes/${enc(key)}`), catalog.load()]);
        } catch (e) {
          if (e.code !== 'node_not_found') throw e;
          current();
          S.n = null; S.alias = key;
          return notFound(key);
        }
        current();
        issues = await api.get('issues').catch(Fleet.soft);
        current();
        n = model.fromDetail(detail);
      }
      const patch = await loadTabData(n, tab, same ? S : blank());
      current();
      if (!same) {
        Object.assign(S, blank(), { alias: n.alias, raw: detail, n, issues: issues?.items || [], issuesOk: !!issues, cacheAt: u.now(), renameMsg: S.pendingMsg || null, pendingMsg: null });
      }
      Object.assign(S, patch, { tab });
      Fleet.model.refreshSummary(true);
      return paint();
    },
    paint: () => S.n ? paint() : notFound(S.alias),
    unmount() { S.visit++; S.key = null; },
  };

  /* ---------------------------------------------------------------- actions */
  /* Actions read S.n when clicked and keep that machine. After an await they apply their result only if the same machine is still on screen. */
  Fleet.actions.range = async el => {
    const n = S.n, gen = S.token, hours = +el.dataset.v;
    S.hours = hours;
    if (!S.checkins[hours]) {
      let buckets = null, error = null;
      S.checkinsErr = null;
      try { buckets = (await api.get(`nodes/${n.id}/checkins`, { hours }))?.buckets || []; }
      catch (e) { if (e.silent) return; error = e; }
      if (gen !== S.token || !here(n)) return;
      if (error) S.checkinsErr = error; else S.checkins = { ...S.checkins, [hours]: buckets };
    }
    Fleet.repaint();
  };
  Fleet.actions['act-filter'] = el => { S.actFilter = el.dataset.v; Fleet.repaint(); };
  Fleet.actions['more-activity'] = async () => {
    if (S.loadingMore) return;
    const n = S.n, gen = S.token, attemptsAfter = S.attemptsNext, auditAfter = S.auditNext, mine = S.loadingMore = {};
    Fleet.repaint();
    let attempts = null, audit = null, failure = null;
    await Promise.all([
      attemptsAfter && api.page(`nodes/${n.id}/attempts`, { limit: PAGE, after: attemptsAfter }).then(r => { attempts = r; }),
      auditAfter && api.page('audit', { node: n.id, order: 'newest', limit: PAGE, after: auditAfter }).then(r => { audit = r; }),
    ].filter(Boolean).map(job => job.catch(e => { failure = failure || e; })));
    if (S.loadingMore === mine) S.loadingMore = null;
    if (gen !== S.token || !here(n)) return;
    if (attempts) { S.attempts = S.attempts.concat(attempts.items); S.attemptsNext = attempts.nextCursor; }
    if (audit) { S.audit = S.audit.concat(audit.items); S.auditNext = audit.nextCursor; }
    if (failure) ui.fail(failure, 'Could not load older activity');
    Fleet.repaint();
  };
  Fleet.actions.retry = async el => {
    const n = S.n, visit = S.visit, name = el.dataset.target, t = targetByName(name), key = n.id + ':' + name;
    if (S.retrying.has(key)) return;
    S.retrying.add(key); Fleet.repaint();
    try {
      await api.post(`nodes/${n.id}/retry`, { target: name });
      ui.toast(`Retry requested for ${u.targetLabel(t)} on ${n.alias}`, { text: 'The Agent applies it on its next poll.' });
    } catch (e) { ui.fail(e, 'Retry was not requested'); }
    S.retrying.delete(key);
    if (staying(n, visit)) await Fleet.reload({ quiet: true });
    else if (S.n?.id === n.id) S.cacheAt = 0; // the cached copy predates the retry
  };

  const stopCmd = 'brew services stop jcarcaboso/fleet/fleet-agent';
  Fleet.actions['revoke-node'] = () => {
    const n = S.n;
    ui.openModal(`<div class="modal-head"><span class="modal-ic t-serious">${ic('ban')}</span><div><h2 id="modal-title">Revoke access for ${esc(n.alias)}?</h2><p>Its certificates stop working immediately and the Agent can no longer poll.</p></div><button type="button" class="icon-btn" data-act="modal-close" aria-label="Close">${ic('x')}</button></div>
    <div class="modal-body"><ul class="ticks"><li>${glyph('good')}<span>The machine record, its history and its alias stay. The alias remains reserved.</span></li><li>${glyph('good')}<span>Nothing is deleted on the machine.</span></li><li>${glyph('warning', 'bang')}<span>${esc(n.alias)} moves to Retired. To use the alias again you would remove it and enroll it again.</span></li></ul>
    <p class="kv-label">Then stop the Agent on ${esc(n.alias)}</p>${u.cmdBlock(stopCmd)}<p class="muted small">Installed it as a user service instead? Run <code>fleet-agent service stop</code>.</p>
    <p class="field-msg" id="modal-msg" role="alert"></p></div>
    <div class="modal-foot"><button type="button" class="btn btn-secondary" data-act="modal-close" data-autofocus>Cancel</button><button type="button" class="btn btn-danger" data-act="confirm-revoke">${ic('ban')}Revoke access</button></div>`);
  };
  /* el is a button inside the dialog that asked. While it is attached that dialog is still open, so closing it closes the right one. */
  Fleet.actions['confirm-revoke'] = async el => {
    const n = S.n, visit = S.visit;
    el.disabled = true;
    try {
      await api.post(`nodes/${n.id}/revoke`, {});
    } catch (e) {
      el.disabled = false;
      const m = el.isConnected && u.$('#modal-msg'); if (m) { m.textContent = e.message; m.className = 'field-msg is-err'; }
      ui.fail(e);
      return;
    }
    if (el.isConnected) ui.closeModal(true);
    ui.toast(`${n.alias} revoked`, { text: 'Node access revoked. Stop its Agent on the machine.' });
    if (staying(n, visit)) await Fleet.reload({ quiet: true });
    else if (S.n?.id === n.id) S.cacheAt = 0;
  };
  Fleet.actions['remove-node'] = () => {
    const n = S.n;
    ui.openModal(`<div class="modal-head"><span class="modal-ic t-critical">${ic('trash')}</span><div><h2 id="modal-title">Remove ${esc(n.alias)} permanently?</h2><p>This deletes its server record, credentials, assignments and attempts. It cannot be undone.</p></div><button type="button" class="icon-btn" data-act="modal-close" aria-label="Close">${ic('x')}</button></div>
    <div class="modal-body"><ul class="ticks"><li>${glyph('good')}<span>Audit history and shared release data remain.</span></li><li>${glyph('good')}<span>The alias <b>${esc(n.alias)}</b> becomes available for a new enrollment.</span></li><li>${glyph('warning', 'bang')}<span>Files on the machine are not erased. Stop its Agent and remove its fleet.yml entry unless you will enroll a replacement.</span></li></ul>
    <label class="confirm-label" for="rm-confirm">Type <b class="mono">${esc(n.alias)}</b> to confirm</label><input id="rm-confirm" class="input" data-confirm="${esc(n.alias)}" autocomplete="off" spellcheck="false" data-autofocus aria-describedby="rm-msg">
    <p class="field-msg" id="rm-msg" role="status">The alias must match exactly, including case.</p></div>
    <div class="modal-foot"><button type="button" class="btn btn-secondary" data-act="modal-close">Cancel</button><button type="button" class="btn btn-danger" id="rm-go" data-act="confirm-remove" disabled>${ic('trash')}Remove machine</button></div>`);
  };
  Fleet.on.input['rm-confirm'] = t => {
    const ok = t.value === t.dataset.confirm, m = u.$('#rm-msg');
    u.$('#rm-go').disabled = !ok;
    m.textContent = ok ? 'Alias matches. This will permanently remove the machine.' : t.value && t.dataset.confirm.startsWith(t.value) ? 'Keep typing…' : t.value ? 'That does not match the alias.' : 'The alias must match exactly, including case.';
    m.className = 'field-msg' + (ok ? ' is-ok' : t.value && !t.dataset.confirm.startsWith(t.value) ? ' is-err' : '');
  };
  Fleet.actions['confirm-remove'] = async el => {
    const typed = u.$('#rm-confirm')?.value, n = S.n, visit = S.visit;
    if (typed !== n.alias) return;
    el.disabled = true;
    try {
      await api.post(`nodes/${n.id}/remove`, { alias: typed });
    } catch (e) {
      el.disabled = false;
      const m = el.isConnected && u.$('#rm-msg'); if (m) { m.textContent = e.message; m.className = 'field-msg is-err'; }
      ui.fail(e);
      return;
    }
    /* The machine is gone either way. Only the page it was removed from goes back to the list. */
    const stay = staying(n, visit);
    if (el.isConnected) ui.closeModal(true);
    ui.toast(`${n.alias} removed`, { text: 'Its alias is available for a new enrollment.' });
    if (S.n?.id === n.id) { S.n = null; S.cacheAt = 0; }
    Fleet.galleryReset?.();
    if (stay) Fleet.go('#/nodes');
  };
  Fleet.on.submit.rename = async form => {
    const n = S.n, visit = S.visit, v = form.alias.value.trim(), m = u.$('#rename-msg');
    if (v === n.alias) { m.textContent = 'That is already the alias.'; m.className = 'field-msg'; return; }
    if (!v || v.length > 200) { m.textContent = 'Choose a nonblank alias of at most 200 characters.'; m.className = 'field-msg is-err'; form.alias.setAttribute('aria-invalid', 'true'); return; }
    form.alias.setAttribute('aria-invalid', 'false');
    const btn = form.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
    try {
      await api.post('nodes/rename', { currentAlias: n.alias, alias: v });
    } catch (e) {
      if (btn) btn.disabled = false;
      if (staying(n, visit)) { const msg = u.$('#rename-msg') || m; msg.textContent = e.message; msg.className = 'field-msg is-err'; form.alias.setAttribute('aria-invalid', 'true'); }
      ui.fail(e, 'Rename failed');
      return;
    }
    const stay = staying(n, visit);
    if (S.n?.id === n.id) { S.alias = null; S.cacheAt = 0; }
    Fleet.galleryReset?.();
    if (stay) {
      S.pendingMsg = { text: `Renamed from ${n.alias}. Update its entry in fleet.yml too.` };
      ui.toast('Alias changed', { text: 'Update its entry in fleet.yml too.' });
      Fleet.go(`#/nodes/${enc(v)}/settings`);
    } else ui.toast(`${n.alias} is now ${v}`, { text: 'Update its entry in fleet.yml too.' });
  };
  Fleet.on.input['rename-alias'] = () => { S.renameMsg = null; };
})();
