'use strict';
/* Development fixture. NOT embedded and NOT served by the Server (see Dev/README.md).
   Replaces window.fetch for /dashboard/api/* with an in-memory fake of docs/technical-design/operator-api.md.
   Data comes from artifacts/dashboard-prototypes/data.js (window.FLEET), restricted to fields the contract defines.
   Query switches (harness.html?...): scope=read|operate|admin, signedout=1, empty=1, fail=<path prefix>,
   forbid=1 (403 on every POST), slow=<ms>, pagesize=<n>, diag=0 (no attempt detail at all, like a Server or Agents before phase 2), xss=1 (hostile diagnostic and path on every failure that has detail), enroll=0 (no simulated enrollment), enroll=link (the link is consumed but the machine never checks in),
   weirdalias=1 (one machine is named "rack/A 100%" to exercise path-segment encoding),
   delay=<alias or id>:<ms>[,...] (delays responses for that machine's /nodes/{node} routes: used to reproduce overlapping loads),
   expiry=<seconds> (links created by the wizard expire after this many seconds instead of the requested time),
   lag=<text>:<ms>[,...] (a POST whose path contains <text> does its work at once but answers <ms> later: used to complete a mutation after the user has moved on),
   hang=<path prefix> (GET routes under the prefix never answer; only the caller's abort ends them),
   diskdelay=<ms> (a refreshed Agent answers this long after POST nodes/{node}/disk-usage/refresh; default 7000; agents before 0.9.0 and offline machines never answer).
   Mutations follow the Server: PostgresFleetCoordinator and Transport/OperatorApi.cs, including their order of checks and their error codes.
   window.__FIXTURE.calls records every call with settled (the response was delivered or the call was aborted) and aborted (the caller's signal fired). */
(function () {
  const F = window.FLEET;
  if (!F) throw new Error('fixture.js needs artifacts/dashboard-prototypes/data.js loaded first');
  const params = new URLSearchParams(location.search);
  const cfg = {
    scope: params.get('scope') || 'admin', signedOut: params.has('signedout'), empty: params.has('empty'),
    fail: params.get('fail'), forbid: params.has('forbid'), slow: +(params.get('slow') || 0), pageSize: +(params.get('pagesize') || 100),
    diag: params.get('diag') !== '0', xss: params.has('xss'), enroll: params.get('enroll') !== '0', consumeOnly: params.get('enroll') === 'link', weirdAlias: params.has('weirdalias'),
    delay: Object.fromEntries((params.get('delay') || '').split(',').filter(Boolean).map(x => { const i = x.lastIndexOf(':'); return [x.slice(0, i), +x.slice(i + 1)]; })),
    expiry: +(params.get('expiry') || 0), hang: params.get('hang'), diskDelay: +(params.get('diskdelay') || 7000),
    lag: Object.fromEntries((params.get('lag') || '').split(',').filter(Boolean).map(x => { const i = x.lastIndexOf(':'); return [x.slice(0, i), +x.slice(i + 1)]; })),
  };
  const realFetch = window.fetch.bind(window);
  const HOUR = 36e5, DAY = 24 * HOUR;
  const shift = Date.now() - Date.parse(F.now);
  const T = iso => iso ? new Date(Date.parse(iso) + shift).toISOString() : null;
  const nowIso = () => new Date().toISOString();

  /* deterministic hex from a seed string */
  const hex = (seed, n) => { let h = 2166136261, out = ''; const s = String(seed); while (out.length < n) { for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; h = (h + out.length + 1) >>> 0; out += h.toString(16).padStart(8, '0'); } return out.slice(0, n); };
  const guid = seed => { const h = hex(seed, 32); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
  const revBySha = sha => F.revisions.find(r => r.shortSha === sha);

  /* ---------------------------------------------------------------- mutable state */
  const state = { signedIn: !cfg.signedOut, scope: cfg.scope, actor: 'joan', csrf: 'fixture-csrf-' + hex(Date.now(), 12) };
  const nodes = cfg.empty ? [] : JSON.parse(JSON.stringify(F.nodes));
  if (cfg.weirdAlias && nodes.length) nodes[0].alias = 'rack/A 100%';
  const links = cfg.empty ? [] : JSON.parse(JSON.stringify(F.enrollmentLinks));
  const audit = cfg.empty ? [] : JSON.parse(JSON.stringify(F.audit)).map(e => ({ ...e }));
  const scans = JSON.parse(JSON.stringify(F.source.scans));
  const catalogs = JSON.parse(JSON.stringify(F.cliproxy.catalogs));
  const policies = new Map();
  const targetAttempts = new Map(); // `${nodeId}:${target}` -> extra attempts created by retry

  const skillDigest = name => 'sha256:' + hex('skill:' + name, 64);
  /* data.js is anchored at a fixed "now". Shift every record so relative times ("5 min ago") hold today. */
  const tm = (n, v) => v || null;
  nodes.forEach(n => {
    n._abs = true;
    ['enrolledAt', 'lastContactAt', 'revokedAt'].forEach(k => { n[k] = T(n[k]); });
    ['notBefore', 'notAfter', 'revokedAt'].forEach(k => { n.credential[k] = T(n.credential[k]); });
    n.targets.forEach(t => {
      t.updatedAt = T(t.updatedAt);
      if (t.failure) t.failure.firstSeenAt = T(t.failure.firstSeenAt);
      t.attempts.forEach(a => { a.startedAt = T(a.startedAt); a.finishedAt = T(a.finishedAt); });
    });
  });
  links.forEach(l => { l._abs = true; ['expiresAt', 'consumedAt', 'revokedAt'].forEach(k => { l[k] = T(l[k]); }); });
  audit.forEach(e => { e._abs = true; e.recordedAt = T(e.recordedAt); });
  scans.forEach(s => { s._abs = true; s.observedAt = T(s.observedAt); });
  const counts = n => { const c = { pending: 0, applying: 0, succeeded: 0, failed: 0, superseded: 0 }; n.targets.forEach(t => { c[t.state] = (c[t.state] || 0) + 1; }); return c; };
  const desiredOf = (n, t) => { const r = revBySha(t.desiredRevision); return r ? { desiredRevisionId: r.id, sourceRevision: r.sourceRevision, acceptedAt: T(r.acceptedAt) } : null; };
  const currentRevision = n => n.revokedAt ? null : n.targets.map(t => desiredOf(n, t)).filter(Boolean).sort((a, b) => Date.parse(b.acceptedAt) - Date.parse(a.acceptedAt))[0]?.sourceRevision || null;
  const credNotAfter = n => n.revokedAt ? null : tm(n, n.credential.notAfter);

  /* Disk usage (docs/technical-design/operator-api.md, "Disk usage"). Each Node keeps the latest report only: n._disk = { measuredAt, volumes } or null
     (never reported), n._diskReq = pending refresh request time or null. Percentages are used / (used + available), like df; the filesystem keeps 3% back. */
  const GIB = 1024 ** 3;
  const XSS_LABEL = '<img src=x onerror=alert(1)>"><script>alert(5)</script>';
  const vol = (label, totalGiB, pct) => {
    const fit = Math.round(totalGiB * GIB * 0.97), used = Math.round(fit * pct / 100);
    return { label, totalBytes: Math.round(totalGiB * GIB), usedBytes: used, availableBytes: fit - used };
  };
  /* alias -> [measured ago in minutes, volumes]. Missing aliases never reported. kitchen-mini is an Agent before 0.9.0: it never reports and never answers a refresh. */
  const DISK = {
    'mbp-joan': [130, [vol('home', 926, 62.4)]],
    'studio-mini': [60, [vol('home', 1863, 78.2)]],
    'homelab-nuc': [52, [vol(cfg.xss ? XSS_LABEL : 'home', 954, 96.4), vol('state', 476, 41.3)]],
    'fedora-ws': [185, [vol('home', 476, 88.7)]],
    'build-runner-01': [90, [vol('home', 233, 34.9)]],
    'build-runner-03': [192, [vol('home', 233, 72.0)]],
    'mba-travel': [3000, [vol('home', 233, 55.1)]],
    'design-imac': [40, [vol('home', 1863, 83.9)]],
    'gpu-box': [15, [vol('home', 1863, 85.0)]],
    'laptop-ana': [200, [vol('home', 466, 29.6)]],
  };
  const NO_DISK_AGENT = new Set(['kitchen-mini']);
  nodes.forEach(n => {
    const d = !cfg.empty && !n.revokedAt && DISK[n.alias];
    n._disk = d ? { measuredAt: new Date(Date.now() - d[0] * 60e3).toISOString(), volumes: d[1].map(v => ({ ...v })) } : null;
    n._diskReq = null;
  });
  const pctOf = v => Math.round(v.usedBytes / (v.usedBytes + v.availableBytes) * 1000) / 10;
  const volOut = v => ({ label: v.label, totalBytes: v.totalBytes, usedBytes: v.usedBytes, availableBytes: v.availableBytes, usedPercent: pctOf(v) });
  const fullest = n => n._disk && n._disk.volumes.slice().sort((a, b) => pctOf(b) - pctOf(a))[0];
  const listDisk = n => { const v = n._disk && fullest(n); return v ? { ...volOut(v), measuredAt: n._disk.measuredAt } : null; };
  const detailDisk = n => n._disk || n._diskReq ? { measuredAt: n._disk ? n._disk.measuredAt : null, refreshRequestedAt: n._diskReq, volumes: n._disk ? n._disk.volumes.map(volOut) : [] } : null;
  const GIBTXT = b => (b / GIB).toFixed(1) + ' GiB';

  const listItem = n => ({
    nodeId: n.id, name: n.alias, revoked: !!n.revokedAt, lastContactAt: tm(n, n.lastContactAt), freshness: freshnessOfAbs(n),
    platform: n.platform, enrolledAt: tm(n, n.enrolledAt), revokedAt: tm(n, n.revokedAt), credentialNotAfter: credNotAfter(n), targets: counts(n), currentRevision: currentRevision(n), disk: listDisk(n),
  });
  const freshnessOfAbs = n => !n.lastContactAt ? 'never_contacted' : Date.now() - Date.parse(n.lastContactAt) > 300e3 ? 'stale' : 'fresh';

  /* Phase 2 attempt detail (docs/technical-design/operator-api.md, "Phase 2: attempt detail"): diagnostic, path (relative to the Target base, never
     starting with "/"), step. Only a failed Attempt reported by an Agent that sends detail has any; everything else is null. The diagnostics come from
     data.js. data.js predates phase 2, so the fixture picks path and step by error code and Target, and treats the Nodes in OLD_AGENT as Agents
     that send only the error code. */
  const OLD_AGENT = new Set(['kitchen-mini', 'fedora-ws']);
  const XSS = { diagnostic: 'bad <img src=x onerror=alert(1)> and "><script>alert(2)</script> \'x\' & done', path: '"><script>alert(3)</script>/<img src=x onerror=alert(4)>.md', step: 'verify' };
  const detailOf = (n, t, a) => {
    const none = { diagnostic: null, path: null, step: null };
    if (!cfg.diag || a.state !== 'failed' || !a.diagnostic || OLD_AGENT.has(n.alias)) return none;
    if (cfg.xss) return { ...XSS };
    const dir = t.path || '';
    const byCode = {
      ai_client_reconcile_failed: { path: `${dir}/settings.json`, step: 'configure' },
      ownership_conflict: { path: '.agents/skills/postgres-migrations', step: 'stage' },
      bundle_digest_mismatch: { path: '.agents/skills/postgres-migrations', step: 'verify' },
      /* The lock file is outside the Target base, so there is no path; the agent-file Target also reports the file it was about to write. */
      lock_failed: { path: t.kind === 'agent-file' ? `${dir}/${t.file}` : null, step: 'lock' },
    }[a.errorCode] || { path: null, step: null };
    return { diagnostic: a.diagnostic, ...byCode };
  };
  const attemptOf = (n, t, a) => ({ attemptId: a.id, assignmentId: guid(n.id + t.name), rolloutId: F.rollouts.find(r => r.shortSha === a.revision)?.id || F.rollouts[0].id, targetName: t.name,
    sourceRevision: revBySha(a.revision)?.sourceRevision || a.revision, state: a.state, errorCode: a.errorCode, ...detailOf(n, t, a), updatedAt: tm(n, a.finishedAt || a.startedAt) });
  const allAttempts = n => n.targets.flatMap(t => [...(targetAttempts.get(n.id + ':' + t.name) || []), ...t.attempts.map(a => attemptOf(n, t, a))]).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  const targetDetail = (n, t) => {
    const latest = allAttempts(n).find(a => a.targetName === t.name) || null;
    const applied = revBySha(t.appliedRevision);
    const kind = t.kind;
    return {
      name: t.name, kind, base: t.base, path: t.path, assignmentId: guid(n.id + t.name), state: t.state, assignedAt: tm(n, t.updatedAt) || nowIso(),
      desiredRevision: desiredOf(n, t), lastSucceededRevision: applied ? applied.sourceRevision : null,
      latestAttempt: latest && { attemptId: latest.attemptId, state: latest.state, errorCode: latest.errorCode, diagnostic: latest.diagnostic ?? null, path: latest.path ?? null, step: latest.step ?? null, updatedAt: latest.updatedAt },
      failedAttempts: t.state === 'failed' ? (t.failure?.retries || 1) : 0, firstFailedAt: t.state === 'failed' && t.failure ? tm(n, t.failure.firstSeenAt) : null,
      skills: kind === 'skills' ? (t.skills || []).map(name => ({ name, bundleDigest: skillDigest(name) })) : [],
      file: kind === 'agent-file' ? { name: t.file, bundleDigest: 'sha256:' + hex('file:' + n.id + t.name, 64) } : null,
      aiClient: kind === 'ai-client' ? { client: t.aiClient.client, mode: t.aiClient.mode, baseUrl: t.aiClient.baseUrl, model: t.aiClient.model } : null,
    };
  };
  const detail = n => {
    const targets = n.targets.map(t => targetDetail(n, t)).sort((a, b) => a.name.localeCompare(b.name));
    return {
      nodeId: n.id, name: n.alias, platform: n.platform, enrolledAt: tm(n, n.enrolledAt), lastContactAt: tm(n, n.lastContactAt), freshness: listItem(n).freshness, revoked: !!n.revokedAt, revokedAt: tm(n, n.revokedAt),
      credential: { credentialId: guid('cred:' + n.id), notBefore: tm(n, n.credential.notBefore), notAfter: tm(n, n.credential.notAfter), revokedAt: tm(n, n.credential.revokedAt), revokedBy: n.revokedAt ? n.revokedBy : null, renewals: n.credential.renewals },
      targets, summary: counts(n), disk: detailDisk(n),
    };
  };
  const findNode = key => nodes.find(n => n.id === key) || nodes.find(n => n.alias === key);

  /* ---------------------------------------------------------------- check-ins */
  const ASLEEP = new Set(['mbp-joan', 'laptop-ana']);
  const checkins = (n, hours) => {
    const out = [], now = Date.now(), cur = Math.floor(now / HOUR) * HOUR;
    const contact = n.lastContactAt ? Date.parse(tm(n, n.lastContactAt)) : null, enrolled = Date.parse(tm(n, n.enrolledAt));
    const revoked = n.revokedAt ? Date.parse(tm(n, n.revokedAt)) : null;
    for (let k = hours - 1; k >= 0; k--) {
      const start = cur - k * HOUR, end = Math.min(start + HOUR, now);
      let polls = 0;
      const alive = contact !== null && end > enrolled && (!revoked || start < revoked) && start < contact + 60e3;
      if (alive) {
        const h = new Date(start).getUTCHours();
        if (!(ASLEEP.has(n.alias) && (h >= 22 || h < 6))) {
          const span = Math.min(end, contact) - Math.max(start, enrolled);
          polls = Math.max(0, Math.round(span / 60e3 - (hex(n.id + start, 2).charCodeAt(0) % 3)));
        }
      }
      out.push({ hour: new Date(start).toISOString().replace('.000Z', 'Z'), polls });
    }
    return out;
  };

  /* ---------------------------------------------------------------- errors catalog and issues */
  const cat = (code, source, title, explanation, fix) => ({ code, source, title, explanation, fix });
  /* Agent codes come from the prototype data; the others use the codes that the Server's ErrorCatalog and OperatorIssues define. */
  const catalogItems = () => [
    ...Object.entries(F.errorCatalog).map(([code, e]) => cat(code, 'agent', e.title, e.explanation, e.fix)),
    cat('assignment_superseded', 'agent', 'Assignment was replaced', 'A newer assignment replaced this one before it finished.', ['No action needed.']),
    cat('node_not_found', 'server', 'No Node matches', 'No Node in this Workspace has that ID or alias.', ['Run `fleet nodes list` to see the aliases.']),
    cat('target_not_found', 'server', 'Target not found', 'The Node has no current Assignment for that Target.', ['Run `fleet nodes show <node>` to list its Targets.']),
    cat('target_not_failed', 'server', 'Target is not failed', 'Only a failed current Assignment can be retried.', ['Run `fleet nodes show <node>` to see the Target state.']),
    cat('node_revoked', 'server', 'Node is revoked', 'A revoked Node receives no new Assignments, so it cannot be retried.', ['Enroll the machine again under a new alias.']),
    cat('insufficient_scope', 'server', 'Scope too narrow', 'The Operator credential does not have the scope this action needs.', ['Use a credential with a broader scope.']),
    cat('invalid_request', 'server', 'Invalid request', 'The Server rejected the request parameters.', ['Check the parameters of the call.']),
    cat('assignment_failed', 'issue', 'A Target failed on a Node', 'The Agent reported a failure for the Node’s current Assignment of a Target. The error code on the issue says why.', ['Run `fleet explain <code>` for the reported error code and follow its fix steps.', 'When the cause is fixed, run `fleet retry <node> <target>`.']),
    cat('more_failed_assignments', 'issue', 'More failed assignments than listed', 'Only the first failures are listed.', ['Run `fleet nodes list` to see the failed counts for every Node.']),
    cat('node_not_contacting', 'issue', 'Node is not checking in', 'The Server has not received an authenticated poll from this Agent for several minutes, or it has never received one since the Node enrolled. Freshness only says when Fleet last heard from the machine; it cannot tell whether the machine is powered on.', ['Wake the machine and connect it to the network. The Agent catches up at its next poll.', 'Check that the Agent service is running (`brew services info jcarcaboso/fleet/fleet-agent`).', 'On Linux, enable lingering so the service starts at boot: `sudo loginctl enable-linger "$USER"`.']),
    cat('cliproxy_key_missing', 'issue', 'CLIProxy API key is missing', 'Nodes are assigned to CLIProxy, but the Server cannot retrieve or distribute their models.', ['Set `Fleet:CliProxyApiKey` in the Server’s private configuration, recreate the Server, then refresh models.']),
    cat('cliproxy_discovery_pending', 'issue', 'Model discovery has not completed', 'The Server has not fetched the model catalog of a CLIProxy endpoint yet.', ['Refresh models or wait for the next discovery check.']),
    cat('cliproxy_refresh_failed', 'issue', 'CLIProxy model refresh failed', 'The Server could not fetch the model catalog from a CLIProxy endpoint. Agents keep the last valid catalog, so AI clients keep working, but new models will not arrive.', ['Check that CLIProxy accepts the dedicated Fleet key.', 'Rotate the Fleet CLIProxy key on the Server if it changed.', 'Refresh models to confirm the fix.']),
    cat('disk_space_low', 'issue', 'Disk is filling up', 'The disk that holds the user’s home directory on this machine is 85% full or more. Git worktrees, caches and build output are the usual cause. When a disk is full, the Agent can no longer write Skills, agent files or AI-client settings.',
      ['Run `fleet nodes disk <node>` to see how much space is used and available.', 'Ask the person who uses the machine to remove Git worktrees, caches and build output they no longer need. Fleet never deletes files for you.', 'Run `fleet nodes disk <node> --refresh` to measure again.']),
    cat('disk_space_critical', 'issue', 'Disk is nearly full', 'The disk that holds the user’s home directory on this machine is 95% full or more. Writes can start failing at any moment, including the Agent’s own.',
      ['Run `fleet nodes disk <node>` to see how much space is left.', 'Ask the person who uses the machine to free space now: remove Git worktrees (`git worktree list`, `git worktree remove`), caches and build output. Fleet never deletes files for you.', 'Run `fleet nodes disk <node> --refresh` to measure again.']),
    cat('source_not_configured', 'issue', 'No repository is configured', 'The Server cannot publish new assignments from Git.', ['Set `Source:Remote`, then sync the repository.']),
    cat('source_sync_failed', 'issue', 'Repository sync failed', 'The last repository scan was rejected or failed. Existing assignments remain active.', ['Check repository access and fleet.yml validation in the Server logs, then sync the repository again.']),
    cat('source_not_scanned', 'issue', 'Repository has not been synced', 'No source scan has been recorded.', ['Sync the repository to validate configuration and publish assignments.']),
  ];
  /* Quotes a value for a POSIX shell command line unless it only has plain characters, like OperatorIssues.Quote. */
  const quote = v => /^[A-Za-z0-9_@%+=:,./-]+$/.test(v) ? v : "'" + String(v).replace(/'/g, "'\\''") + "'";
  const stamp = iso => new Date(iso).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  const cmpNull = (a, b) => (a === null ? (b === null ? 0 : -1) : b === null ? 1 : a < b ? -1 : a > b ? 1 : 0);
  const issues = () => {
    const out = [];
    for (const n of nodes) {
      if (n.revokedAt) continue;
      const alias = quote(n.alias);
      /* Never-contacted Nodes get the same issue code as stale ones. Their since is the enrollment time. */
      const f = listItem(n).freshness, last = tm(n, n.lastContactAt), enrolled = tm(n, n.enrolledAt);
      const quiet = f === 'stale' || (f === 'never_contacted' && Date.now() - Date.parse(enrolled) > 300e3);
      if (quiet) out.push({ id: `node_not_contacting:${n.id}`, code: 'node_not_contacting', severity: 'warning', title: `${n.alias} is not checking in`,
        detail: last ? `The last contact was at ${stamp(last)}.` : `The Node has not contacted the Server since it enrolled at ${stamp(enrolled)}.`,
        action: 'Check the Agent service, its running version, network connection and certificate. Restart the service after upgrading the binary.',
        section: 'nodes', errorCode: null, nodeId: n.id, nodeName: n.alias, target: null, since: last || enrolled, commands: [`fleet nodes show ${alias}`, `fleet nodes checkins ${alias}`] });
      const worst = fullest(n);
      if (worst && pctOf(worst) >= 85) {
        const crit = pctOf(worst) >= 95, code = crit ? 'disk_space_critical' : 'disk_space_low';
        out.push({ id: `${code}:${n.id}`, code, severity: crit ? 'error' : 'warning', title: `${n.alias}: disk is ${pctOf(worst)}% full`,
          detail: `The ${worst.label} volume is ${pctOf(worst)}% used: ${GIBTXT(worst.availableBytes)} available of ${GIBTXT(worst.totalBytes)}.`,
          action: 'Free space by removing Git worktrees, caches and build output that are no longer needed, then refresh the disk usage.',
          section: 'nodes', errorCode: null, nodeId: n.id, nodeName: n.alias, target: null, since: n._disk.measuredAt, commands: [`fleet nodes disk ${alias}`, `fleet nodes disk ${alias} --refresh`] });
      }
      for (const t of n.targets) if (t.state === 'failed') {
        const code = (allAttempts(n).find(a => a.targetName === t.name && a.errorCode) || {}).errorCode || t.failure?.code || null;
        const failedAttempt = allAttempts(n).find(a => a.targetName === t.name && a.state === 'failed');
        const known = code && catalogItems().find(x => x.code === code);
        out.push({ id: `assignment_failed:${n.id}:${t.name}`, code: 'assignment_failed', severity: 'error', title: `${n.alias}: ${t.name} failed`,
          detail: code ? `The Agent reported ${code}${known ? ` (${known.title})` : ''} for this current assignment.` : 'The Agent reported a failure for this current assignment.',
          action: known ? known.fix[0] : 'Check Agent logs for permissions, ownership conflicts or download failures.',
          section: 'nodes', errorCode: code, nodeId: n.id, nodeName: n.alias, target: t.name, since: t.failure ? tm(n, t.failure.firstSeenAt) : null,
          diagnostic: failedAttempt?.diagnostic ?? null, path: failedAttempt?.path ?? null, step: failedAttempt?.step ?? null,
          commands: [`fleet nodes show ${alias}`, ...(code ? [`fleet explain ${quote(code)}`] : []), `fleet retry ${alias} ${quote(t.name)}`] });
      }
    }
    for (const c of catalogs) if (c.status !== 'ok') {
      const cached = c.models.length > 0;
      out.push({ id: 'cliproxy_refresh_failed:' + c.baseUrl, code: 'cliproxy_refresh_failed', severity: cached ? 'warning' : 'error', title: 'CLIProxy model refresh failed',
        detail: `${c.baseUrl}: ${c.errorCode}. ` + (cached ? 'Agents can use the last valid catalog.' : 'No model catalog is available.'),
        action: 'Check that CLIProxy accepts the dedicated Fleet key, then refresh models.', section: 'models', errorCode: null, nodeId: null, nodeName: null, target: null, since: null, commands: ['fleet models refresh'] });
    }
    const last = cfg.empty ? null : scans[0];
    if (last && (last.outcome === 'failed' || last.outcome === 'invalid')) out.push({ id: 'source_sync_failed', code: 'source_sync_failed', severity: 'error', title: 'Repository sync failed',
      detail: `The last scan at ${stamp(last.observedAt)} was ${last.outcome}. Existing assignments remain active.`, action: 'Check repository access and fleet.yml validation in the Server logs, then sync the repository again.',
      section: 'repository', errorCode: null, nodeId: null, nodeName: null, target: null, since: last.observedAt, commands: ['fleet source rescan'] });
    /* Errors first, then Node name (issues without a Node first), Target, code and ID. */
    return out.map(i => ({ diagnostic: null, path: null, step: null, ...i })).sort((a, b) => (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1) || cmpNull(a.nodeName, b.nodeName) || cmpNull(a.target, b.target) || cmpNull(a.code, b.code) || cmpNull(a.id, b.id)).slice(0, 200);
  };

  /* ---------------------------------------------------------------- CLIProxy */
  const fam = m => ({ key: m.family.toLowerCase().replace(/[^a-z0-9]+/g, '-'), label: m.family });
  const policyFor = c => {
    if (policies.has(c.baseUrl)) return policies.get(c.baseUrl);
    const enabled = [], disabled = [], overrides = {};
    const groups = new Map(); c.models.forEach(m => { const k = fam(m).key; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); });
    for (const [k, ms] of groups) { const on = ms.filter(m => m.selected).length; (on * 2 >= ms.length ? enabled : disabled).push(k); ms.forEach(m => { if (m.selected !== (on * 2 >= ms.length)) overrides[m.id] = m.selected; }); }
    const p = { includeNew: c.newFamiliesEnabled, disabledFamilies: disabled, modelOverrides: overrides, enabledFamilies: enabled, skipClaudeModelsForOtherClients: c.restrictClaude };
    policies.set(c.baseUrl, p); return p;
  };
  const selected = (p, m) => { const k = fam(m).key; return typeof p.modelOverrides[m.id] === 'boolean' ? p.modelOverrides[m.id] : p.disabledFamilies.includes(k) ? false : p.enabledFamilies.includes(k) ? true : p.includeNew; };
  const selectionEntry = c => { const p = policyFor(c); return { baseUrl: c.baseUrl, models: c.models.map(m => ({ id: m.id, reasoningLevels: m.reasoning, familyKey: fam(m).key, familyLabel: fam(m).label, selected: selected(p, m) })), policy: p, version: c.version }; };
  const proxyStatus = () => ({ enabled: true, intervalSeconds: F.cliproxy.refreshIntervalHours * 3600, errorCode: null, catalogs: catalogs.map(c => ({ baseUrl: c.baseUrl, modelCount: c.models.length, lastSuccess: T(c.lastSuccessAt), nextRefresh: T(c.nextRefreshAt), outcome: c.status === 'ok' ? 'succeeded' : 'failed', errorCode: c.errorCode })) });

  /* ---------------------------------------------------------------- responses */
  const json = (body, status = 200) => new Response(body === null ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  /* Every error is { code, message }. */
  const MESSAGES = { unauthorized: 'Sign in with a valid Operator token.', invalid_csrf: 'The CSRF token is missing or wrong.', invalid_request: 'The request is not valid.', node_not_found: 'No Node matches that ID or alias.',
    insufficient_scope: 'This credential does not have the scope required for this action.', target_not_found: 'The Node has no such Target.', target_not_failed: 'The current Assignment for that Target is not failed.',
    node_revoked: 'The Node is revoked.', enrollment_link_not_found: 'No enrollment link has that ID.' };
  const err = (status, code, message) => json({ code, message: message || MESSAGES[code] || code }, status);
  const seg = value => decodeURIComponent(value); // one path segment, decoded once
  /* Lists: limit is 1 to 100 (else 400). Cursors are only valid with the order they came from. */
  const orderOf = q => { const o = q.get('order'); return o === null ? 'id' : o === 'newest' ? 'newest' : null; };
  const paged = (items, q, order = 'id') => {
    let limit = 100;
    if (q.get('limit') !== null) { limit = +q.get('limit'); if (!Number.isInteger(limit) || limit < 1 || limit > 100) return err(400, 'invalid_request', 'limit must be from 1 to 100.'); }
    limit = Math.min(limit, cfg.pageSize);
    let start = 0;
    if (q.get('after')) {
      const m = /^(id|newest):(\d+)$/.exec(q.get('after'));
      if (!m || m[1] !== order) return err(400, 'invalid_request', 'The cursor is not valid for this request.');
      start = +m[2];
    }
    return json({ items: items.slice(start, start + limit), nextCursor: start + limit < items.length ? `${order}:${start + limit}` : null });
  };
  /* ID order by default; order=newest sorts by the timestamp, newest first, ties by ID. */
  const sortFor = (items, q, idKey, timeKey) => {
    const order = orderOf(q);
    if (order === null) return null;
    const byId = (a, b) => (a[idKey] < b[idKey] ? -1 : a[idKey] > b[idKey] ? 1 : 0);
    return { order, items: items.slice().sort(order === 'newest' ? (a, b) => Date.parse(b[timeKey]) - Date.parse(a[timeKey]) || -byId(a, b) : byId) };
  };
  const listOf = (items, q, idKey, timeKey) => {
    const sorted = sortFor(items, q, idKey, timeKey);
    return sorted ? paged(sorted.items, q, sorted.order) : err(400, 'invalid_request', 'order must be newest.');
  };
  const RANK = { read: 0, operate: 1, admin: 2 };
  const need = level => RANK[state.scope] >= RANK[level];
  const addAudit = (action, extra = {}) => audit.unshift({ recordedAt: nowIso(), action, actor: state.actor, subject: '', nodeId: null, credentialId: null, ...extra });

  const pickCounts = c => ({ pending: c.pending || 0, applying: c.applying || 0, succeeded: c.succeeded || 0, failed: c.failed || 0, superseded: c.superseded || 0 });
  const auditOut = () => audit.map(e => {
    const node = e.nodeId ? nodes.find(n => n.id === e.nodeId) : (['node_enrolled', 'node_credential_renewed', 'node_alias_changed', 'node_revoked', 'node_removed'].includes(e.action) ? findNode(String(e.subject).split('→').pop().trim()) : null);
    const nodeId = e.nodeId || node?.id || null;
    return { recordedAt: e.recordedAt, action: e.action, actor: e.action === 'node_credential_renewed' && nodeId ? nodeId : e.actor, nodeId, credentialId: e.action.startsWith('node_credential') && nodeId ? guid('cred:' + nodeId) : null, nodeName: node ? node.alias : null };
  }).concat(cfg.empty ? [] : [{ recordedAt: T(F.audit[F.audit.length - 1].recordedAt), action: 'node_removed', actor: 'ana', nodeId: guid('removed-node'), credentialId: null, nodeName: null }]);

  /* The state follows the Server's ToLink: consumed wins over revoked, revoked over expired, expired over active. */
  const linkOut = l => {
    const exp = l.expiresAt;
    const st = l.state === 'consumed' || l.consumedAt ? 'consumed' : l.state === 'revoked' || l.revokedAt ? 'revoked'
      : l.state === 'expired' || Date.parse(exp) <= Date.now() ? 'expired' : 'active';
    return { id: l.id, alias: l.alias, expiresAt: exp, consumedAt: l.consumedAt || null, revokedAt: l.revokedAt || null, revokedBy: l.revokedBy || null,
      nodeId: l.nodeId || (st === 'consumed' ? nodes.find(n => n.alias === l.alias)?.id || null : null), state: st };
  };

  const b64url = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  /* The Agent enrolls with the link some seconds later. As on the Server, a link that was revoked or has expired by then is refused, and
     so is an alias that a Node already has (node_alias_in_use at enrollment time, the link stays unused). */
  const usable = link => !link.revokedAt && Date.parse(link.expiresAt) > Date.now() && !nodes.some(n => n.alias === link.alias);
  const simulateEnrollment = link => {
    if (!cfg.enroll) return;
    setTimeout(() => { if (!usable(link)) return; link.state = 'consumed'; link.consumedAt = nowIso(); addAudit('node_enrolled', { actor: 'enrollment', subject: link.alias }); }, 5000);
    setTimeout(() => {
      if (link.state !== 'consumed' || nodes.some(n => n.alias === link.alias)) return;
      const now = nowIso(), mac = link._platform !== 'linux';
      const n = { id: guid('new:' + link.alias + Date.now()), alias: link.alias, platform: mac ? 'macos' : 'linux', enrolledAt: now, lastContactAt: cfg.consumeOnly ? null : now, freshness: cfg.consumeOnly ? 'never_contacted' : 'fresh', revokedAt: null, revokedBy: null, _abs: true,
        credential: { notBefore: now, notAfter: new Date(Date.now() + 7 * DAY).toISOString(), renewals: 0, revokedAt: null }, targets: [] };
      nodes.unshift(n); link.nodeId = n.id;
    }, 9000);
  };

  async function handle(method, path, q, body, headers) {
    if (cfg.slow) await new Promise(r => setTimeout(r, cfg.slow));
    if (method === 'GET') { const d = /^nodes\/([^/]+)/.exec(path); const wait = d && cfg.delay[seg(d[1])]; if (wait) await new Promise(r => setTimeout(r, wait)); }
    if (cfg.fail && path.startsWith(cfg.fail) && method === 'GET') return err(500, 'fixture_failure', 'Fixture was told to fail ' + cfg.fail);
    if (path === 'csrf') return json({ token: state.csrf });
    if (path === 'login' && method === 'POST') {
      if (headers['x-fleet-csrf'] !== state.csrf) return err(400, 'invalid_csrf');
      /* The Server rejects tokens shorter than 32 characters before it compares them. */
      if (!body || typeof body.token !== 'string' || body.token.length < 32 || body.token.length > 1024 || body.token.startsWith('bad')) return err(401, 'unauthorized');
      state.signedIn = true; return json({ actor: state.actor, scope: state.scope });
    }
    if (!state.signedIn) return err(401, 'unauthorized');
    if (path === 'session') return json({ actor: state.actor, scope: state.scope });
    if (method !== 'GET') {
      if (headers['x-fleet-csrf'] !== state.csrf) return err(400, 'invalid_csrf');
      if (path === 'logout') { state.signedIn = false; return json({ signedOut: true }); }
      if (cfg.forbid) return err(403, 'insufficient_scope', 'This credential cannot do that.');
    }
    let m;
    if (method === 'GET') {
      if (path === 'nodes') return paged(nodes.map(listItem).sort((a, b) => a.nodeId.localeCompare(b.nodeId)), q);
      /* {node} is a Node ID or an exact alias, one percent-encoded path segment. A UUID-shaped value is an ID first. */
      if ((m = /^nodes\/([^/]+)(?:\/(attempts|checkins))?$/.exec(path))) {
        const n = findNode(seg(m[1]));
        if (!n) return err(404, 'node_not_found');
        if (!m[2]) return json(detail(n));
        if (m[2] === 'attempts') { let list = allAttempts(n); if (q.get('target')) list = list.filter(a => a.targetName === q.get('target')); return paged(list, q); }
        const hours = q.get('hours') === null ? 168 : +q.get('hours');
        if (!Number.isInteger(hours) || hours < 1 || hours > 168) return err(400, 'invalid_request', 'hours must be from 1 to 168.');
        return json({ hours, buckets: checkins(n, hours) });
      }
      if (path === 'issues') return json({ items: issues() });
      if (path === 'errors') return json({ items: catalogItems() });
      if ((m = /^errors\/([^/]+)$/.exec(path))) { const e = catalogItems().find(x => x.code === seg(m[1])); return e ? json(e) : err(404, 'invalid_request', 'No error catalog entry exists for that code.'); }
      if (path === 'source/status') return json(cfg.empty ? null : { sourceRevision: scans[0].sourceRevision, outcome: scans[0].outcome, code: scans[0].code, diagnostic: scans[0].diagnostic, observedAt: scans[0].observedAt, requestedBy: scans[0].requestedBy });
      if (path === 'source/scans') return paged(cfg.empty ? [] : scans.map(s => ({ scanId: s.id, sourceRevision: s.sourceRevision, outcome: s.outcome, code: s.code, diagnostic: s.diagnostic, observedAt: s.observedAt, requestedBy: s.requestedBy })), q);
      if (path === 'desired-revisions') return listOf(cfg.empty ? [] : F.revisions.map(r => ({ desiredRevisionId: r.id, sourceRevision: r.sourceRevision, acceptedAt: T(r.acceptedAt) })), q, 'desiredRevisionId', 'acceptedAt');
      if (path === 'rollouts') return listOf(cfg.empty ? [] : F.rollouts.map(r => ({ rolloutId: r.id, desiredRevisionId: r.revisionId, createdAt: T(r.createdAt), ...pickCounts(r.assignments) })), q, 'rolloutId', 'createdAt');
      if ((m = /^rollouts\/([^/]+)\/attempts$/.exec(path))) {
        const r = F.rollouts.find(x => x.id === seg(m[1])); if (!r) return err(404, 'invalid_request', 'No rollout has that ID.');
        /* AttemptStatus: exactly these eight fields. */
        return paged(nodes.flatMap(n => allAttempts(n)).filter(a => a.rolloutId === r.id)
          .map(a => ({ attemptId: a.attemptId, assignmentId: a.assignmentId, state: a.state, errorCode: a.errorCode, diagnostic: a.diagnostic ?? null, path: a.path ?? null, step: a.step ?? null, updatedAt: a.updatedAt })), q);
      }
      if (path === 'warnings') return paged(cfg.empty ? [] : F.revisions.flatMap(r => r.warnings.map(w => ({ desiredRevisionId: r.id, code: w.code, message: w.message, sourceLocations: w.sourceLocations }))), q);
      if (path === 'audit') {
        let list = auditOut().map((e, i) => ({ ...e, _i: i }));
        if (q.get('node')) { const n = findNode(q.get('node')); if (!n) return err(404, 'node_not_found'); list = list.filter(e => e.nodeId === n.id); }
        const order = orderOf(q);
        if (order === null) return err(400, 'invalid_request', 'order must be newest.');
        /* Without order the Server keeps ID order, which is oldest first. */
        list.sort(order === 'newest' ? (a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt) || b._i - a._i : (a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt) || a._i - b._i);
        return paged(list.map(({ _i, ...e }) => e), q, order);
      }
      if (path === 'enrollment-links') return paged(links.map(linkOut).sort((a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt)), q);
      if ((m = /^enrollment-links\/([^/]+)$/.exec(path))) { const l = links.find(x => x.id === seg(m[1])); return l ? json(linkOut(l)) : err(404, 'enrollment_link_not_found'); }
      if (path === 'cliproxy/status') return json(proxyStatus());
      if (path === 'cliproxy/selection') return json({ catalogs: catalogs.map(selectionEntry) });
      return err(404, 'invalid_request', 'Unknown route ' + path);
    }
    /* POST routes and their scopes */
    const scopeFor = { 'nodes/rename': 'admin', 'enrollment-links': 'admin', 'source/rescan': 'operate', 'cliproxy/refresh': 'operate', 'cliproxy/selection': 'operate' };
    let level = scopeFor[path] || (/^nodes\/[^/]+\/(retry|disk-usage\/refresh)$/.test(path) ? 'operate' : /^(nodes\/[^/]+\/(revoke|remove)|enrollment-links\/[^/]+\/revoke)$/.test(path) ? 'admin' : 'admin');
    if (!need(level)) return err(403, 'insufficient_scope', `This operation needs the ${level} scope.`);
    if ((m = /^nodes\/([^/]+)\/retry$/.exec(path))) {
      /* OperatorApi rejects a blank target before it looks for the Node; the coordinator bounds it at 100 characters. */
      if (typeof body?.target !== 'string' || !body.target.trim()) return err(400, 'invalid_request', 'target is required.');
      const n = findNode(seg(m[1])); if (!n) return err(404, 'node_not_found');
      if (body.target.length > 100) return err(400, 'invalid_request', 'target is required and bounded.');
      if (n.revokedAt) return err(409, 'node_revoked');
      const t = n.targets.find(x => x.name === body.target); if (!t) return err(404, 'target_not_found');
      if (t.state !== 'failed') return err(409, 'target_not_failed');
      t.state = 'pending'; t.failure = null;
      const a = { attemptId: guid('retry' + Date.now()), state: 'pending', errorCode: null, diagnostic: null, path: null, step: null, updatedAt: nowIso() };
      targetAttempts.set(n.id + ':' + t.name, [{ ...a, assignmentId: guid(n.id + t.name), rolloutId: F.rollouts[0].id, targetName: t.name, sourceRevision: F.revisions[0].sourceRevision }, ...(targetAttempts.get(n.id + ':' + t.name) || [])]);
      addAudit('assignment.retry_requested', { nodeId: n.id, subject: n.alias });
      return json({ assignmentId: guid(n.id + t.name), attemptId: a.attemptId, state: 'pending' });
    }
    if ((m = /^nodes\/([^/]+)\/disk-usage\/refresh$/.exec(path))) {
      /* Scope operate, then the Node (404 node_not_found), then a revoked Node (409 node_revoked). A repeated request keeps the original time until the Agent answers.
         An Agent before 0.9.0, or a machine that is not checking in, never answers. */
      const n = findNode(seg(m[1])); if (!n) return err(404, 'node_not_found');
      if (n.revokedAt) return err(409, 'node_revoked');
      /* Only a new request is audited (node.disk_refresh_requested, with the Node ID); a repeat keeps the time and records nothing, like the Server. */
      if (!n._diskReq) { n._diskReq = nowIso(); addAudit('node.disk_refresh_requested', { nodeId: n.id, subject: n.alias }); }
      if (!NO_DISK_AGENT.has(n.alias) && freshnessOfAbs(n) === 'fresh' && !n._diskTimer) {
        n._diskTimer = setTimeout(() => {
          n._diskTimer = null;
          const old = n._disk;
          n._disk = { measuredAt: nowIso(), volumes: old ? old.volumes.map(v => { const step = Math.round((v.usedBytes + v.availableBytes) * 0.003); return { ...v, usedBytes: v.usedBytes + step, availableBytes: v.availableBytes - step }; }) : [vol('home', 464, 38.2)] };
          n._diskReq = null;
        }, cfg.diskDelay);
      }
      return json({ refreshRequestedAt: n._diskReq }, 202);
    }
    if (path === 'nodes/rename') {
      /* RenameNodeAliasAsOperatorAsync: both aliases are validated first (invalid_node_alias), then the Node is looked up by its exact
         current alias, then a revoked Node is refused. Renaming to the alias it already has succeeds and records nothing. */
      const bad = a => typeof a !== 'string' || !a.trim() || a.length > 200;
      if (bad(body?.currentAlias) || bad(body?.alias)) return err(400, 'invalid_node_alias', 'node_alias is required and bounded.');
      const n = nodes.find(x => x.alias === body.currentAlias); if (!n) return err(404, 'node_not_found', 'The Node alias is not registered in this Workspace.');
      if (n.revokedAt) return err(409, 'node_revoked', 'A revoked Node cannot change its alias.');
      if (n.alias !== body.alias) {
        if (nodes.some(x => x.alias === body.alias && x.id !== n.id)) return err(409, 'node_alias_in_use', 'The Node alias is already registered in this Workspace.');
        const old = n.alias; n.alias = body.alias; addAudit('node_alias_changed', { nodeId: n.id, subject: `${old} → ${n.alias}` });
      }
      return json({ nodeId: n.id, alias: n.alias });
    }
    /* These routes take {id:guid}: anything else does not match a route. */
    const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if ((m = /^(?:nodes|enrollment-links)\/([^/]+)\/(?:revoke|remove)$/.exec(path)) && !GUID.test(seg(m[1]))) return err(404, 'invalid_request', 'Unknown route ' + path);
    if ((m = /^nodes\/([^/]+)\/revoke$/.exec(path))) {
      /* RevokeNodeAsync: idempotent for the Node (the first revocation time stays) but every call writes an audit event. Assignments are untouched. */
      const n = nodes.find(x => x.id === m[1]); if (!n) return err(404, 'node_not_found', 'Node was not found.');
      if (!n.revokedAt) { n.revokedAt = nowIso(); n.revokedBy = state.actor; }
      if (!n.credential.revokedAt) n.credential.revokedAt = n.revokedAt;
      addAudit('node_revoked', { nodeId: n.id, subject: n.alias }); return json({ revoked: true });
    }
    if ((m = /^nodes\/([^/]+)\/remove$/.exec(path))) {
      /* RemoveNodeAsync: the confirmation alias is validated first, then the Node is found, then its exact alias is compared.
         The enrollment links that created the Node are deleted with it. */
      if (typeof body?.alias !== 'string' || !body.alias.trim() || body.alias.length > 200) return err(400, 'invalid_node_alias', 'node_alias is required and bounded.');
      const i = nodes.findIndex(x => x.id === m[1]); if (i < 0) return err(404, 'node_not_found', 'Node was not found.');
      if (nodes[i].alias !== body.alias) return err(409, 'node_alias_changed', 'Node alias changed; refresh before removing it.');
      const gone = nodes[i];
      for (let k = links.length - 1; k >= 0; k--) if (links[k].nodeId === gone.id || (links[k].state === 'consumed' && !links[k].nodeId && links[k].alias === gone.alias)) links.splice(k, 1);
      addAudit('node_removed', { nodeId: gone.id, subject: gone.alias }); nodes.splice(i, 1); return json({ removed: true });
    }
    if (path === 'enrollment-links') {
      /* OperatorApi: expiresInSeconds defaults to 900 and must be 60 to 3600, then the alias is checked. The alias is only bound to the link:
         whether a Node already has it is decided when the Agent enrolls, not here. */
      const expires = body?.expiresInSeconds === undefined ? 900 : body.expiresInSeconds;
      if (!Number.isInteger(expires)) return err(400, 'invalid_request', 'The request is malformed or a parameter is invalid.');
      if (expires < 60 || expires > 3600) return err(400, 'invalid_expiry', 'expiresInSeconds must be between 60 and 3600.');
      if (typeof body?.alias !== 'string' || !body.alias.trim() || body.alias.length > 200) return err(400, 'invalid_alias', 'alias must not be blank and may be at most 200 characters.');
      const id = guid('link' + Date.now() + Math.random()), expiresAt = new Date(Date.now() + (cfg.expiry || expires) * 1000).toISOString();
      const link = { id, alias: body.alias, state: 'active', expiresAt, _abs: true, _platform: params.get('platform') || 'macos' };
      links.unshift(link); addAudit('enrollment_authorization_created', { subject: body.alias }); simulateEnrollment(link);
      const payload = b64url(JSON.stringify({ version: 1, serverUrl: 'https://fleet.lab.internal:8443', token: hex(id, 43), alias: body.alias, caPem: '-----BEGIN CERTIFICATE-----\nFIXTURE\n-----END CERTIFICATE-----', expiresAt }));
      return json({ id, expiresAt, link: 'https://fleet.lab.internal:8443/enroll#fleet-v1=' + payload });
    }
    if ((m = /^enrollment-links\/([^/]+)\/revoke$/.exec(path))) {
      /* RevokeEnrollmentAuthorizationAsync: an unknown link is the legacy code enrollment_not_found (400, it is not in the 404 list).
         Revoking is idempotent and only the first revocation is recorded. A link that was used still reads as consumed. */
      const l = links.find(x => x.id === m[1]); if (!l) return err(400, 'enrollment_not_found', 'Enrollment authorization was not found.');
      if (!l.revokedAt) { l.revokedAt = nowIso(); l.revokedBy = state.actor; addAudit('enrollment_authorization_revoked', { subject: l.alias }); }
      return json({ revoked: true });
    }
    if (path === 'source/rescan') {
      await new Promise(r => setTimeout(r, cfg.slow ? 0 : 400));
      scans.unshift({ id: guid('scan' + Date.now()), outcome: 'unchanged', sourceRevision: F.revisions[0].sourceRevision, code: null, diagnostic: null, observedAt: nowIso(), requestedBy: state.actor, _abs: true });
      return json({ outcome: 'unchanged', sourceRevision: F.revisions[0].sourceRevision });
    }
    if (path === 'cliproxy/refresh') { const now = nowIso(); catalogs.forEach(c => { c.lastAttemptAt = now; if (c.status === 'ok') c.lastSuccessAt = now; }); await new Promise(r => setTimeout(r, 300)); return json(proxyStatus()); }
    if (path === 'cliproxy/selection') {
      /* CliProxySelectionStore.SaveAsync checks, in this order: the shape (400 invalid_selection), the catalog (404 catalog_unavailable),
         pinned models (409 pinned_model_excluded), an empty selection (400 invalid_selection) and, last, the version (409 stale_selection).
         Families that appear in the catalog but in neither list are frozen to the submitted includeNew default before anything is stored. */
      const id = x => typeof x === 'string' && x.length > 0 && x.length <= 200 && /^[!-~]+$/.test(x), p = body?.policy;
      const invalid = () => err(400, 'invalid_selection', 'The selection is malformed or leaves no model selected.');
      if (typeof body?.baseUrl !== 'string' || !body.baseUrl.trim() || body.baseUrl.length > 2048 || !p || typeof body.version !== 'number' || body.version < 0
        || !Array.isArray(p.disabledFamilies) || !Array.isArray(p.enabledFamilies) || !p.modelOverrides || typeof p.modelOverrides !== 'object'
        || !p.disabledFamilies.every(id) || !p.enabledFamilies.every(id) || p.disabledFamilies.some(k => p.enabledFamilies.includes(k))
        || !Object.keys(p.modelOverrides).every(id)) return invalid();
      const c = catalogs.find(x => x.baseUrl === body.baseUrl); if (!c) return err(404, 'catalog_unavailable', 'No model catalog is available for that proxy yet.');
      const en = new Set(p.enabledFamilies), dis = new Set(p.disabledFamilies);
      for (const m of c.models) { const k = fam(m).key; if (!en.has(k) && !dis.has(k)) (p.includeNew ? en : dis).add(k); }
      const saved = { ...p, enabledFamilies: [...en].sort(), disabledFamilies: [...dis].sort(), skipClaudeModelsForOtherClients: p.skipClaudeModelsForOtherClients !== false };
      const pinned = nodes.flatMap(n => n.targets).filter(t => t.aiClient?.mode === 'cliproxy' && t.aiClient.baseUrl === c.baseUrl && t.aiClient.model)
        .filter(t => (saved.skipClaudeModelsForOtherClients && t.aiClient.client !== 'claude' && /^claude-/i.test(t.aiClient.model))
          || c.models.some(mm => mm.id === t.aiClient.model && !selected(saved, mm))).map(t => t.aiClient.model);
      if (pinned.length) return json({ code: 'pinned_model_excluded', message: 'The selection excludes a model that a Node is assigned.', models: [...new Set(pinned)] }, 409);
      if (!c.models.some(mm => selected(saved, mm))) return invalid();
      if (body.version !== c.version) return err(409, 'stale_selection', 'The selection changed since it was loaded. Reload it and try again.');
      policies.set(c.baseUrl, saved); c.version += 1; c.models.forEach(mm => { mm.selected = selected(saved, mm); });
      return json({ catalog: selectionEntry(c) });
    }
    return err(404, 'invalid_request', 'Unknown route ' + path);
  }

  const calls = [];
  window.fetch = async (input, init = {}) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (!url.startsWith('/dashboard/api/')) return realFetch(input, init);
    const u = new URL(url, 'https://fixture.invalid');
    const path = u.pathname.replace('/dashboard/api/', '');
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    let body = null; try { body = init.body ? JSON.parse(init.body) : null; } catch { body = null; }
    const method = (init.method || 'GET').toUpperCase();
    const call = { method, path, query: Object.fromEntries(u.searchParams), at: Date.now(), settled: false, aborted: false };
    calls.push(call);
    let run = cfg.hang && method === 'GET' && path.startsWith(cfg.hang) ? new Promise(() => {}) : handle(method, path, u.searchParams, body, headers).catch(e => {
      if (e instanceof URIError) return err(400, 'invalid_request', 'The path is not correctly percent-encoded.');
      console.error('fixture error', e); return err(500, 'fixture_error', String(e.message || e));
    });
    const lag = method !== 'GET' && Object.entries(cfg.lag).find(([text]) => path.includes(text));
    if (lag) run = run.then(r => new Promise(resolve => setTimeout(() => resolve(r), lag[1])));
    if (!init.signal) return run.finally(() => { call.settled = true; });
    return new Promise((resolve, reject) => {
      const abort = () => { call.aborted = true; call.settled = true; reject(new DOMException('The operation was aborted.', 'AbortError')); };
      if (init.signal.aborted) return abort();
      init.signal.addEventListener('abort', abort, { once: true });
      run.then(resolve, reject).finally(() => { call.settled = true; });
    });
  };
  window.__FIXTURE = { cfg, state, nodes, links, audit, calls };
})();
