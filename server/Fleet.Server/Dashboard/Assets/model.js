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
    disk: model.diskVolume(raw.disk),
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
      disk: model.diskDetail(raw.disk),
    };
  };
  /* ---------------------------------------------------------------- Disk (operator-api.md, "Disk usage") */
  const byteCount = v => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : 0; };
  const round1 = x => Math.round(x * 10) / 10;
  /* One volume: { label, usedPercent, usedBytes, availableBytes, totalBytes, measuredAt? }. usedPercent is recomputed when the Server omits it. */
  model.diskVolume = raw => {
    if (!raw || typeof raw !== 'object') return null;
    const used = byteCount(raw.usedBytes), avail = byteCount(raw.availableBytes), total = byteCount(raw.totalBytes);
    const given = Number(raw.usedPercent);
    const pct = Number.isFinite(given) ? given : used + avail > 0 ? round1(used / (used + avail) * 100) : 0;
    return { label: String(raw.label ?? 'home'), usedPercent: Math.max(0, pct), usedBytes: used, availableBytes: avail, totalBytes: total, measuredAt: raw.measuredAt || null };
  };
  const VOLUME_ORDER = { home: 0, state: 1 };
  /* GET nodes/{node}.disk: { measuredAt, refreshRequestedAt, volumes }. A pending refresh on a Node that never reported has no volumes. */
  model.diskDetail = raw => {
    if (!raw || typeof raw !== 'object') return null;
    const volumes = (Array.isArray(raw.volumes) ? raw.volumes : []).map(model.diskVolume).filter(Boolean)
      .sort((a, b) => (VOLUME_ORDER[a.label] ?? 9) - (VOLUME_ORDER[b.label] ?? 9) || a.label.localeCompare(b.label));
    return { measuredAt: raw.measuredAt || null, refreshRequestedAt: raw.refreshRequestedAt || null, volumes };
  };
  /* Thresholds from the Server's issues: warning from 85% used, error from 95%. Colour always comes with an icon and a word. */
  model.DISK_WARN = 85; model.DISK_CRIT = 95;
  model.diskLevel = pct => pct >= model.DISK_CRIT ? { key: 'critical', level: 'critical', kind: 'x', label: 'Nearly full' }
    : pct >= model.DISK_WARN ? { key: 'warning', level: 'warning', kind: 'bang', label: 'Filling up' }
      : { key: 'good', level: 'good', kind: 'check', label: 'Enough space' };
  /* The state of a machine's disk for grouping and sorting; null when it never reported or is revoked. */
  model.diskOf = n => n.disk && !n.revoked ? model.diskLevel(n.disk.usedPercent) : null;
  model.diskHot = n => { const d = model.diskOf(n); return !!d && d.key !== 'good'; };
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
