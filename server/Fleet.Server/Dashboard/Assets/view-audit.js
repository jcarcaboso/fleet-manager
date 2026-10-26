'use strict';
/* Fleet dashboard: Audit log.
   API: GET audit?order=newest. Items are { recordedAt, action, actor, nodeId, credentialId, nodeName }. Names resolve at read time,
   so a removed machine shows as removed. The Server returns the newest events first, one page at a time; "Load older events" follows the cursor. */
(function () {
  const Fleet = window.Fleet = window.Fleet || {};
  const u = Fleet.u, ui = Fleet.ui, api = Fleet.api;
  const { esc, ic, enc } = u;
  Fleet.views = Fleet.views || {};

  const S = { events: [], next: null, loadingMore: false, q: '', actor: 'all', action: 'all', gen: 0 };
  const PAGE = 50;
  const ACTION = {
    enrollment_authorization_created: ['link', 'Created an enrollment link'], enrollment_authorization_revoked: ['ban', 'Revoked an enrollment link'],
    source_rescan_requested: ['sync', 'Requested a repository sync'], node_enrolled: ['check', 'Machine enrolled'], node_credential_renewed: ['key', 'Certificate renewed'],
    node_credential_revoked: ['ban', 'Revoked a credential'], cliproxy_selection_saved: ['spark', 'Saved a model selection'], cliproxy_refresh_requested: ['spark', 'Refreshed model catalogs'],
    node_alias_changed: ['pencil', 'Renamed a machine'], node_revoked: ['ban', 'Revoked a machine'], node_removed: ['trash', 'Removed a machine'],
    'assignment.retry_requested': ['retry', 'Requested a retry'],
    'issue.acknowledged': ['ack', 'Acknowledged a problem'], 'issue.snoozed': ['snooze', 'Snoozed a problem'], 'issue.reopened': ['retry', 'Reopened a problem'],
  };
  Fleet.auditLabel = a => (ACTION[a] || [])[1] || String(a).replace(/[._]/g, ' ').replace(/^./, c => c.toUpperCase());
  const icon = a => (ACTION[a] || ['info'])[0];
  const isAgent = e => u.isUuid(e.actor);
  Fleet.actorName = e => isAgent(e) ? 'Agent' : e.actor;
  const role = e => isAgent(e) ? 'Agent' : e.actor === 'enrollment' ? 'Enrollment' : 'Operator';

  const subject = e => {
    if (e.nodeName) return `<a class="subj" href="#/nodes/${enc(e.nodeId || e.nodeName)}">${esc(e.nodeName)}</a>`;
    if (e.nodeId) return `<span class="subj">Removed machine</span> <code class="small" data-tip="${esc(e.nodeId)}">${esc(u.shortId(e.nodeId))}</code>`;
    if (e.credentialId) return `<code class="small" data-tip="${esc(e.credentialId)}">credential ${esc(u.shortId(e.credentialId))}</code>`;
    return '<span class="muted">—</span>';
  };
  const rows = () => {
    const q = S.q.trim().toLowerCase();
    const list = S.events.filter(e => (S.actor === 'all' || e.actor === S.actor) && (S.action === 'all' || e.action === S.action) &&
      (!q || `${e.action} ${Fleet.auditLabel(e.action)} ${Fleet.actorName(e)} ${e.nodeName || ''}`.toLowerCase().includes(q)));
    const count = document.getElementById('audit-count'); if (count) count.textContent = u.plural(list.length, 'event');
    if (!list.length) return `<tr><td colspan="4"><div class="empty-mini">${ic('search')}<p>No audit events match these filters.</p></div></td></tr>`;
    return list.map(e => `<tr><td><span class="when"><b>${u.dayLabel(e.recordedAt) === 'Today' ? esc(u.fmtTime(e.recordedAt)) : esc(u.fmtFull(e.recordedAt))}</b><span class="muted small">${esc(u.rel(e.recordedAt))}</span></span></td>
      <td><span class="who">${u.avatar(Fleet.actorName(e))}<span><b>${esc(Fleet.actorName(e))}</b><span class="muted small">${role(e)}</span></span></span></td>
      <td><span class="what"><span class="what-ic">${ic(icon(e.action))}</span><span>${esc(Fleet.auditLabel(e.action))}<code class="small">${esc(e.action)}</code></span></span></td><td>${subject(e)}</td></tr>`).join('');
  };

  const paint = () => {
    const actors = [...new Set(S.events.map(e => e.actor))].sort(), actions = [...new Set(S.events.map(e => e.action))].sort();
    return `<div class="wrap">${ui.pageHead('Audit', 'Every change made by operators, Agents and enrollment. Audit history survives machine removal.', `<button type="button" class="btn btn-secondary" data-act="reload">${ic('sync')}Refresh</button>`)}
    <section class="panel">${!S.events.length ? ui.empty({ icon: 'list', title: 'No audit events yet', text: 'Operator actions, enrollment and certificate renewals are recorded here.' }) : `<div class="toolbar toolbar--plain">
      <label class="search search--sm">${ic('search')}<span class="sr">Search audit log</span><input id="audit-q" type="search" placeholder="Search actions, actors and machines" value="${esc(S.q)}" autocomplete="off"></label>
      <label class="sel"><span>Actor</span><select id="audit-actor"><option value="all">Everyone</option>${actors.map(a => `<option value="${esc(a)}" ${S.actor === a ? 'selected' : ''}>${esc(u.isUuid(a) ? 'Agent ' + u.shortId(a) : a)}</option>`).join('')}</select>${ic('chevD', 'sel-chev')}</label>
      <label class="sel"><span>Action</span><select id="audit-action"><option value="all">All actions</option>${actions.map(a => `<option value="${esc(a)}" ${S.action === a ? 'selected' : ''}>${esc(Fleet.auditLabel(a))}</option>`).join('')}</select>${ic('chevD', 'sel-chev')}</label>
      <span class="muted small" id="audit-count">${u.plural(S.events.length, 'event')}</span></div>
      <div class="tbl-wrap"><table class="tbl tbl--audit"><thead><tr><th>When (UTC)</th><th>Who</th><th>What</th><th>Machine</th></tr></thead><tbody id="audit-body">${rows()}</tbody></table></div>
      ${S.next ? `<p class="muted small" id="audit-more-note">Search and filters apply to the ${u.num(S.events.length)} newest events loaded so far.</p><div class="load-more"><button type="button" class="btn btn-secondary" data-act="more-audit" ${S.loadingMore ? 'disabled' : ''}>Load older events</button></div>` : ''}`}
    </section></div>`;
  };

  Fleet.views.audit = {
    title: 'Audit',
    async load() {
      const gen = ++S.gen;
      const r = await api.page('audit', { order: 'newest', limit: PAGE });
      if (gen !== S.gen) throw Fleet.superseded();
      S.events = r.items.filter(e => u.valid(e.recordedAt)); S.next = r.nextCursor; S.loadingMore = false;
      Fleet.model.refreshSummary();
      return paint();
    },
    paint,
  };
  Fleet.actions['more-audit'] = async () => {
    if (S.loadingMore || !S.next) return;
    const gen = S.gen;
    S.loadingMore = true; Fleet.repaint();
    try {
      const r = await api.page('audit', { order: 'newest', limit: PAGE, after: S.next });
      if (gen !== S.gen) return;
      S.events = S.events.concat(r.items.filter(e => u.valid(e.recordedAt))); S.next = r.nextCursor;
    } catch (e) { if (e.silent) return; ui.fail(e, 'Could not load older events'); }
    if (gen === S.gen) { S.loadingMore = false; Fleet.repaint(); }
  };
  const body = () => { const el = document.getElementById('audit-body'); if (el) ui.setHtml(el, rows()); };
  Fleet.on.input['audit-q'] = t => { S.q = t.value; body(); };
  Fleet.on.change['audit-actor'] = t => { S.actor = t.value; body(); };
  Fleet.on.change['audit-action'] = t => { S.action = t.value; body(); };
})();
