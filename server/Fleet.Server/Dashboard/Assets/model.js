'use strict';
/* Fleet dashboard: derived state. Turns Operator API records into the health, reason and issue
   models the views share. Nothing here invents data: it only reads fields the contract defines. */
(function () {
  const Fleet = window.Fleet = window.Fleet || {};
  const u = Fleet.u;
  const model = Fleet.model = {};

  /* ---------------------------------------------------------------- Nodes */
  /* GET nodes item -> view model. */
  model.fromList = raw => ({
    id: raw.nodeId, alias: raw.name, platform: raw.platform || null, revoked: !!raw.revoked, revokedAt: raw.revokedAt || null,
    lastContactAt: raw.lastContactAt || null, freshness: raw.freshness, enrolledAt: raw.enrolledAt || null,
    notAfter: raw.credentialNotAfter || null, counts: { ...u.emptyCounts(), ...(raw.targets || {}) }, currentRevision: raw.currentRevision || null,
  });
  /* GET nodes/{node} -> view model with Targets and credential. */
  model.fromDetail = raw => {
    const targets = raw.targets || [];
    const newest = targets.map(t => t.desiredRevision).filter(Boolean).sort((a, b) => (u.ms(b.acceptedAt) || 0) - (u.ms(a.acceptedAt) || 0))[0];
    return {
      id: raw.nodeId, alias: raw.name, platform: raw.platform || null, revoked: !!raw.revoked, revokedAt: raw.revokedAt || null,
      lastContactAt: raw.lastContactAt || null, freshness: raw.freshness, enrolledAt: raw.enrolledAt || null,
      notAfter: raw.credential?.notAfter || null, credential: raw.credential || null, targets,
      counts: { ...u.emptyCounts(), ...(raw.summary || {}) }, currentRevision: newest?.sourceRevision || null, currentAcceptedAt: newest?.acceptedAt || null,
    };
  };
  model.total = n => u.countTotal(n.counts);

  /* ---------------------------------------------------------------- Health */
  const HL = {
    failing: { level: 'critical', kind: 'bang', label: 'Action needed', rank: 0 },
    offline: { level: 'serious', kind: 'moon', label: 'Offline', rank: 1 },
    never: { level: 'serious', kind: 'clock', label: 'Not checked in', rank: 1 },
    updating: { level: 'info', kind: 'sync', label: 'Updating', rank: 2 },
    ok: { level: 'good', kind: 'check', label: 'Up to date', rank: 3 },
    retired: { level: 'neutral', kind: 'minus', label: 'Retired', rank: 4 },
  };
  model.HL = HL;
  /* failures: [{ target: {name, file?, aiClient?}, errorCode }] describing the Node's failed Targets, when known. */
  model.health = (n, failures = []) => {
    if (n.revoked) return { key: 'retired', ...HL.retired, reason: `Revoked ${u.rel(n.revokedAt)}. Its alias stays reserved.` };
    const failed = n.counts.failed;
    if (failed > 0) {
      const first = failures[0];
      const reason = first ? Fleet.catalog.title(first.errorCode) : `${u.plural(failed, 'Target')} failing`;
      const same = failures.length > 1 && failures.every(f => f.errorCode === first.errorCode);
      const extra = failures.length > 1 ? (same ? `affects ${u.listText(failures.map(f => u.targetShort(f.target)))}` : `+${failures.length - 1} more`)
        : (!first && failed > 1 ? null : null);
      return { key: 'failing', ...HL.failing, reason, extra, target: first?.target || null };
    }
    if (n.freshness === 'never_contacted') return { key: 'never', ...HL.never, reason: `Enrolled ${u.rel(n.enrolledAt)}, but the Agent has not checked in yet` };
    if (n.freshness === 'stale') return { key: 'offline', ...HL.offline, reason: `No check-in for ${u.span(u.now() - (u.ms(n.lastContactAt) || u.now()), true)}` };
    const busy = n.counts.applying + n.counts.pending;
    if (busy > 0) {
      const rev = n.currentRevision ? ` revision ${u.shortSha(n.currentRevision)}` : '';
      return { key: 'updating', ...HL.updating, reason: n.counts.applying ? `Applying${rev} to ${u.plural(n.counts.applying, 'Target')}` : `${u.plural(n.counts.pending, 'Target')} waiting for the next check-in` };
    }
    const total = model.total(n);
    return { key: 'ok', ...HL.ok, reason: total === 0 ? 'No Targets are assigned yet' : `In sync${n.currentRevision ? ` at revision ${u.shortSha(n.currentRevision)}` : ''}` };
  };
  model.isAttention = h => ['failing', 'offline', 'never'].includes(h.key);
  model.seenText = n => n.revoked ? 'Revoked' : !n.lastContactAt ? 'Never seen' : 'Seen ' + u.rel(n.lastContactAt);

  /* ---------------------------------------------------------------- Certificate */
  model.certLeft = n => n.notAfter ? u.ms(n.notAfter) - u.now() : null;
  model.certText = n => {
    if (n.revoked) return 'Revoked';
    const left = model.certLeft(n);
    return left === null ? 'Unknown' : left <= 0 ? 'Expired' : `${u.span(left)} left`;
  };
  /* A certificate is only worth flagging when the Agent cannot renew it because it is not polling. */
  model.certFlag = n => {
    if (n.revoked || n.freshness === 'fresh') return null;
    const left = model.certLeft(n);
    if (left === null || left > u.DAY) return null;
    return left <= 0
      ? { level: 'warning', kind: 'bang', text: 'Certificate expired. It renews when the Agent reconnects.' }
      : { level: 'warning', kind: 'bang', text: `Certificate expires in ${u.span(left)}` };
  };

  /* ---------------------------------------------------------------- Issues (GET issues) */
  /* A Node that never contacted the Server gets the same node_not_contacting issue, with since = its enrollment time. */
  model.issueLevel = i => i.severity === 'error' ? 'critical' : i.code === 'node_not_contacting' ? 'serious' : i.severity === 'warning' ? 'warning' : 'info';
  model.issueKind = (level, i) => ({ critical: 'x', serious: 'moon', warning: 'bang', info: 'info' }[level]);
  model.issueBadge = (level, i) => ({ critical: 'Error', serious: 'Offline', warning: 'Warning', info: 'Notice' }[level]);
  model.LRANK = { critical: 0, serious: 1, warning: 2, info: 3 };
  model.issuesByNode = items => {
    const map = new Map();
    for (const i of items) if (i.nodeId) { if (!map.has(i.nodeId)) map.set(i.nodeId, []); map.get(i.nodeId).push(i); }
    return map;
  };
  /* Failed-Target descriptions for a Node, taken from the Node's issues. */
  model.failuresFromIssues = list => (list || []).filter(i => i.target && i.errorCode).map(i => ({ target: { name: i.target }, errorCode: i.errorCode, issue: i }));
  model.sortIssues = items => items.slice().sort((a, b) =>
    model.LRANK[model.issueLevel(a)] - model.LRANK[model.issueLevel(b)] || String(a.nodeName || '').localeCompare(String(b.nodeName || '')) || String(a.target || '').localeCompare(String(b.target || '')));
  model.issueSection = i => {
    if (i.nodeId) return 'machines';
    const s = String(i.section || '') + ' ' + i.code;
    if (/repo|source|scan|manifest|warning|skill/i.test(s)) return 'repository';
    if (/model|cliproxy|catalog/i.test(s)) return 'models';
    return 'other';
  };

  /* ---------------------------------------------------------------- Navigation summary */
  const summary = model.summary = { errors: 0, modelsBad: false, at: 0, issues: null };
  model.refreshSummary = async (force = false) => {
    if (!force && u.now() - summary.at < 20000) return summary;
    summary.at = u.now();
    try {
      const [issues, status] = await Promise.all([
        Fleet.api.get('issues').catch(e => { if (e.silent) throw e; return null; }),
        Fleet.api.get('cliproxy/status').catch(e => { if (e.silent) throw e; return null; }),
      ]);
      if (issues) { summary.issues = issues.items || []; summary.errors = summary.issues.filter(i => i.severity === 'error').length; }
      if (status) summary.modelsBad = (status.catalogs || []).some(c => c.outcome === 'failed');
    } catch { /* signed out: the 401 handler already switched to the login view */ }
    if (Fleet.renderNav) Fleet.renderNav();
    return summary;
  };
})();
