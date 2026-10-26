'use strict';
/* Fleet dashboard: Machines gallery.
   API: GET nodes (with disk and agent), GET issues, GET errors, GET source/status, GET desired-revisions?order=newest&limit=1, GET cliproxy/status,
   GET enrollment-links, and GET nodes/{id}/checkins?hours=24 for the strip of each card that is on screen. */
(function () {
  const Fleet = window.Fleet = window.Fleet || {};
  const u = Fleet.u, ui = Fleet.ui, api = Fleet.api, model = Fleet.model;
  const { esc, ic, glyph, enc } = u;
  Fleet.views = Fleet.views || {};

  const S = { q: '', groupBy: 'status', sort: 'attention', retiredOpen: false, nodes: [], issues: null, source: null, rev: null, proxy: null, links: null, truncated: false, gen: 0 };
  const byId = new Map();
  const strips = new Map(); // node id -> { pending } | { buckets } | { error, at }. Cleared on every load.

  const issuesByNode = () => model.issuesByNode(S.issues || []);
  const healthOf = n => model.health(n, model.failuresFromIssues(issuesByNode().get(n.id)));
  const newestRev = () => S.rev;

  /* ---------------------------------------------------------------- card */
  const stateChips = n => {
    const order = [['failed', 'failed'], ['applying', 'applying'], ['pending', 'waiting'], ['succeeded', 'in sync'], ['superseded', 'superseded']];
    const chips = order.filter(([k]) => n.counts[k] > 0).map(([k, word]) => {
      const m = u.tstate(k);
      return `<span class="chip">${glyph(m.level, m.kind)}<span class="sr">${esc(m.label)}: </span>${n.counts[k]} ${word}</span>`;
    });
    return chips.length ? chips.join('') : '<span class="chip chip--empty">No Targets yet</span>';
  };
  const stripSlot = n => {
    if (n.revoked) return '<span class="muted small">Revoked</span>';
    const d = strips.get(n.id);
    if (d && d.buckets) return Fleet.charts.strip(n.id, d.buckets);
    if (d && d.error) return '<span class="muted small">Unavailable</span>';
    return '<span class="strip-pending" aria-hidden="true"></span>';
  };
  const stripTotal = n => { const d = strips.get(n.id); return d && d.buckets ? u.num(Fleet.charts.total(d.buckets)) : n.revoked ? '—' : '…'; };

  /* Compact disk meter: the fullest volume the Agent reported. The state is a glyph and a word as well as a colour. */
  const diskBlock = n => {
    if (n.revoked) return '';
    const d = n.disk;
    if (!d) return `<div class="diskm diskm--none"><div class="diskm-top"><span class="diskm-k">Disk</span><span class="diskm-state">${glyph('neutral', 'minus')}<span>No disk data</span></span></div></div>`;
    const lv = model.diskLevel(d.usedPercent), pct = d.usedPercent.toFixed(1), free = u.bytes(d.availableBytes), total = u.bytes(d.totalBytes);
    const age = u.ms(d.measuredAt) !== null && u.now() - u.ms(d.measuredAt) > 5 * u.HOUR ? ` · measured ${u.rel(d.measuredAt)}` : '';
    return `<div class="diskm diskm--${lv.key}"><div class="diskm-top"><span class="diskm-k">Disk <b>${esc(pct)}% used</b></span><span class="diskm-state t-${lv.level}">${glyph(lv.level, lv.kind)}<span>${esc(lv.label)}</span></span></div>
        <div class="meter meter--thin m-${lv.key}" role="img" aria-label="${esc(`Disk ${pct}% used, ${lv.label}`)}"><span data-w="${Math.min(100, d.usedPercent).toFixed(1)}"></span></div>
        <p class="diskm-sub"${u.ms(d.measuredAt) !== null ? ` data-tip="${esc(`Measured ${u.rel(d.measuredAt)}|${u.fmtFull(d.measuredAt)} UTC`)}"` : ''}>${esc(free)} free of ${esc(total)}${d.label !== 'home' ? ` · ${esc(d.label)} volume` : ''}${esc(age)}</p></div>`;
  };

  /* Top right of the picture: the Agent version when the Agent reported one (a warning glyph when it is outdated), else the platform. */
  const agentBadge = n => {
    const a = n.agent, platform = n.platform === 'macos' ? ic('apple') : n.platform === 'linux' ? ic('tux') : '';
    if (!a?.version) return `<span class="agent-badge">${platform}${esc(u.platformLabel(n.platform))}</span>`;
    const old = model.agentOutdated(n);
    return `<span class="agent-badge${old ? ' is-old' : ''}" data-tip="${esc(`Agent ${a.version}|${old ? 'Update available' : n.revoked ? 'Revoked' : 'Up to date'}`)}">${old ? glyph('warning', 'bang') : platform}Agent ${esc(a.version)}</span>`;
  };
  /* Under the name: the OS and architecture the Agent reported, or the platform from enrollment when it reported nothing. */
  const cardSub = n => {
    const a = n.agent;
    if (!a) return `${esc(u.platformLabel(n.platform))} · enrolled ${esc(u.fmtDay(n.enrolledAt))}`;
    return esc([model.osText(n) || u.platformLabel(n.platform), a.arch].filter(Boolean).join(' · '));
  };
  const cardHost = n => n.agent ? `<p class="card-host">${n.agent.hostname ? `<span class="mono">${esc(n.agent.hostname)}</span> · ` : ''}enrolled ${esc(u.fmtDay(n.enrolledAt))}</p>` : '';

  const card = n => {
    const h = healthOf(n), url = `#/nodes/${enc(n.alias)}`;
    const toProblems = model.isAttention(h) && h.key === 'failing';
    const flag = model.certFlag(n), outdated = model.agentOutdated(n);
    return `<article class="card card--${h.key}">
    <div class="stage">${Fleet.art.device(n, h)}
      <span class="pill on-stage t-${h.level}">${glyph(h.level, h.kind)}<span>${esc(h.label)}</span></span>
      ${agentBadge(n)}
    </div>
    <div class="card-body">
      <div class="card-title"><h3><a class="stretch" href="${url}">${esc(n.alias)}</a></h3><span class="seen">${esc(model.seenText(n))}</span></div>
      <p class="card-sub">${cardSub(n)}</p>
      ${cardHost(n)}
      <a class="reason reason--${h.level} z" href="${url}${toProblems ? '/problems' : ''}">${glyph(h.level, h.kind)}<span>${esc(h.reason)}${h.extra ? `<span class="reason-extra"> · ${esc(h.extra)}</span>` : ''}</span>${ic('chevR', 'rchev')}</a>
      ${flag || outdated ? `<div class="flags">${outdated ? `<span class="chip chip--update">${glyph('warning', 'bang')}Update available</span>` : ''}${flag ? `<span class="flag">${glyph(flag.level, flag.kind)}${esc(flag.text)}</span>` : ''}</div>` : ''}
      ${diskBlock(n)}
      <div class="vitals">
        <div class="vital"><div class="vital-top"><span>Check-ins, 24 h</span><b data-strip-total="${esc(n.id)}">${stripTotal(n)}</b></div><div class="strip-slot" ${n.revoked ? '' : `data-strip-slot="${esc(n.id)}"`}>${stripSlot(n)}</div></div>
        <div class="vital"><div class="vital-top"><span>Certificate</span><b>${esc(model.certText(n))}</b></div></div>
      </div>
      <div class="chips">${stateChips(n)}</div>
    </div>
  </article>`;
  };

  /* ---------------------------------------------------------------- list, sort, group */
  /* A disk at 85% or more counts as needing attention: a critical disk ranks with failures, a warning one just below offline machines. */
  const attentionRank = n => {
    const r = healthOf(n).rank, d = model.diskOf(n);
    return !d || d.key === 'good' ? r : Math.min(r, d.key === 'critical' ? 0.5 : 1.5);
  };
  const needsAttention = n => model.isAttention(healthOf(n)) || model.diskHot(n);
  const SORTS = {
    attention: (a, b) => attentionRank(a) - attentionRank(b) || a.alias.localeCompare(b.alias),
    disk: (a, b) => (b.disk?.usedPercent ?? -1) - (a.disk?.usedPercent ?? -1) || a.alias.localeCompare(b.alias),
    name: (a, b) => a.alias.localeCompare(b.alias),
    seen: (a, b) => (u.ms(b.lastContactAt) || 0) - (u.ms(a.lastContactAt) || 0) || a.alias.localeCompare(b.alias),
    outdated: (a, b) => model.agentOutdated(b) - model.agentOutdated(a) || attentionRank(a) - attentionRank(b) || a.alias.localeCompare(b.alias),
  };
  const searchText = n => [n.alias, n.platform, u.platformLabel(n.platform), n.currentRevision, healthOf(n).label,
    ...(n.agent ? [n.agent.hostname, model.osText(n), n.agent.os.name, n.agent.os.version, n.agent.arch, n.agent.version, n.agent.version && `agent ${n.agent.version}`, model.agentOutdated(n) && 'outdated update available'] : [])]
    .filter(Boolean).join(' ').toLowerCase();
  const matches = (n, q) => !q || q.split(/\s+/).every(w => searchText(n).includes(w));

  const sections = nodes => {
    if (S.groupBy === 'platform') {
      const known = [['macos', 'macOS', 'apple'], ['linux', 'Linux', 'tux']];
      const out = known.map(([k, t, i]) => ({ key: k, title: t, icon: i, sub: `${u.plural(nodes.filter(n => n.platform === k).length, 'machine')} running ${t}.`, nodes: nodes.filter(n => n.platform === k) }));
      const other = nodes.filter(n => n.platform !== 'macos' && n.platform !== 'linux');
      out.push({ key: 'other', title: 'Other', icon: 'server', sub: 'Platform not recognised by this dashboard.', nodes: other });
      return out.filter(s => s.nodes.length);
    }
    if (S.groupBy === 'os') {
      /* The OS the Agent reported, by name. Machines whose Agent reported none (before 0.9.0) go last. */
      const by = new Map(), unknown = [];
      nodes.forEach(n => { const name = n.agent?.os.name; if (!name) unknown.push(n); else by.set(name, [...(by.get(name) || []), n]); });
      const out = [...by].sort((a, b) => a[0].localeCompare(b[0])).map(([name, list]) => {
        const versions = [...new Set(list.map(n => n.agent.os.version).filter(Boolean))].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        const icon = /^mac/i.test(name) ? 'apple' : list[0].platform === 'linux' ? 'tux' : 'server';
        return { key: `os-${name}`, title: name, icon, sub: `${u.plural(list.length, 'machine')} running ${name}${versions.length ? ` ${u.listText(versions)}` : ''}.`, nodes: list };
      });
      if (unknown.length) out.push({ key: 'os-none', title: 'OS not reported', icon: 'server', sub: 'Agents before 0.9.0 do not send machine details.', nodes: unknown });
      return out;
    }
    const rev = newestRev();
    /* "Outdated Agents first" lifts those machines into a section of their own, ahead of the health sections. */
    const lifted = S.sort === 'outdated' ? nodes.filter(model.agentOutdated) : [], rest = nodes.filter(n => !lifted.includes(n));
    return [
      { key: 'outdated', title: 'Agent update available', sub: 'These Agents are older than the Server. Upgrade them on the machine; Fleet never does it for you. Their health is still shown on each card.', nodes: lifted },
      { key: 'attention', title: 'Needs attention', sub: 'Fix these first. The most serious problems are at the top. A disk that is 85% full or more is listed here too.', nodes: rest.filter(needsAttention) },
      { key: 'updating', title: 'Updating', sub: 'Receiving new assignments right now. No action needed.', nodes: rest.filter(n => !needsAttention(n) && healthOf(n).key === 'updating') },
      { key: 'ok', title: 'Up to date', sub: rev ? `Every assigned Target is in sync. Latest published revision: ${u.shortSha(rev.sourceRevision)}.` : 'Every assigned Target is in sync.', nodes: rest.filter(n => !needsAttention(n) && healthOf(n).key === 'ok') },
    ].filter(s => s.nodes.length);
  };

  const body = () => {
    const q = S.q.trim().toLowerCase();
    const live = S.nodes.filter(n => !n.revoked && matches(n, q)).sort(SORTS[S.sort]);
    const retired = S.nodes.filter(n => n.revoked && matches(n, q)).sort(SORTS.name);
    if (!S.nodes.length) {
      return ui.empty({ icon: 'server', title: 'No machines yet', text: 'Create an enrollment link, then run the Agent on a machine to add it to Fleet.', action: ui.gate('admin', 'btn-primary', `${ic('plus')}Add machine`, 'data-act="add"') + ui.lockNote('admin') });
    }
    if (!live.length && !retired.length) {
      return ui.empty({ icon: 'search', title: `No machines match “${S.q}”`, text: 'Try an alias, a hostname, an OS such as Fedora, an Agent version such as 0.9.0, or a status such as Offline.', action: `<button type="button" class="btn btn-secondary" data-act="clear-search">Clear search</button>` });
    }
    const secs = sections(live);
    return secs.map(s => `<section class="gsec" aria-labelledby="h-${u.slug(s.key)}" id="sec-${u.slug(s.key)}">
      <header class="gsec-head"><h2 id="h-${u.slug(s.key)}">${s.icon ? `<span class="gsec-ic">${ic(s.icon)}</span>` : ''}${esc(s.title)} <span class="cnt">${s.nodes.length}</span></h2><p>${esc(s.sub)}</p></header>
      <div class="grid">${s.nodes.map(card).join('')}</div></section>`).join('') +
      (retired.length ? `<details class="retired" ${S.retiredOpen ? 'open' : ''} data-retired>
      <summary><span class="gsec-ic">${ic('ban')}</span><span><b>Retired</b> <span class="cnt">${retired.length}</span><span class="retired-sub">Revoked machines keep their alias reserved. Remove one on its Settings tab to free the alias.</span></span>${ic('chevD', 'sumchev')}</summary>
      <div class="grid">${retired.map(card).join('')}</div></details>` : '') +
      (S.truncated ? `<p class="note">${ic('info')}<span>Showing the first ${u.num(S.nodes.length)} machines. Narrow the list with search to find others.</span></p>` : '');
  };

  /* ---------------------------------------------------------------- health header */
  const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };
  const header = () => {
    const live = S.nodes.filter(n => !n.revoked);
    const c = { ok: 0, updating: 0, offline: 0, failing: 0 };
    live.forEach(n => { const k = healthOf(n).key; c[k === 'never' ? 'offline' : k]++; });
    const attention = c.offline + c.failing;
    const names = key => live.filter(n => { const k = healthOf(n).key; return (k === 'never' ? 'offline' : k) === key; }).map(n => n.alias).join(', ');
    const parts = [
      { key: 'ok', label: 'Up to date', level: 'good', kind: 'check', value: c.ok },
      { key: 'updating', label: 'Updating', level: 'info', kind: 'sync', value: c.updating },
      { key: 'offline', label: 'Offline', level: 'serious', kind: 'moon', value: c.offline },
      { key: 'failing', label: 'Action needed', level: 'critical', kind: 'bang', value: c.failing },
    ].map(p => ({ ...p, unit: p.value === 1 ? 'machine' : 'machines', tip: names(p.key) }));
    const counts = u.emptyCounts(); live.forEach(n => u.addCounts(counts, n.counts));
    const total = u.countTotal(counts), rev = newestRev(), scan = S.source;
    const fullDisks = live.filter(model.diskHot).length;
    const sentence = [c.updating ? `${c.updating} ${c.updating === 1 ? 'is' : 'are'} updating` : null, attention ? `${attention} need${attention === 1 ? 's' : ''} your attention` : null,
      fullDisks ? `${fullDisks} ${fullDisks === 1 ? 'has' : 'have'} a disk that is ${model.DISK_WARN}% full or more` : null].filter(Boolean);
    const scanOk = scan && (scan.outcome === 'accepted' || scan.outcome === 'unchanged');
    const badCats = (S.proxy?.catalogs || []).filter(x => x.outcome === 'failed').length;
    const active = (S.links || []).filter(l => l.state === 'active').sort((a, b) => u.ms(a.expiresAt) - u.ms(b.expiresAt));
    const sync = Fleet.shared.syncing;
    return `<section class="health" aria-labelledby="h-health">
    <div class="health-main">
      <p class="eyebrow">${greeting()}, ${esc(api.session.actor)} · Fleet health</p>
      <h1 id="h-health" tabindex="-1">${live.length ? `${c.ok} of ${live.length} ${live.length === 1 ? 'machine is' : 'machines are'} up to date` : 'No machines yet'}</h1>
      <p class="health-sub">${live.length ? (sentence.length ? esc(u.listText(sentence)) + '.' : 'Every machine has all of its Targets in sync.') : 'Add a machine to start delivering Skills, agent files and AI-client settings.'}${c.failing ? ` ${c.failing} ${c.failing === 1 ? 'has a problem' : 'have problems'} Fleet cannot fix on its own.` : ''}</p>
      ${live.length ? `<div class="health-bar">${u.segbar(parts, 'Machines by health')}${u.legend(parts, 'jump')}</div>` : ''}
    </div>
    <div class="health-actions">
      <div class="btn-row">
        ${ui.gate('operate', 'btn-secondary', `${ic('sync', sync ? 'spin' : '')}${sync ? 'Syncing…' : 'Sync repository'}`, `data-act="sync" ${sync ? 'disabled' : ''}`)}
        ${ui.gate('admin', 'btn-primary', `${ic('plus')}Add machine`, 'data-act="add"')}
      </div>
      <p class="muted small">${scan ? `Last scan ${u.rel(scan.observedAt)}` : 'No repository scan yet'}${rev ? ` · ${u.shortSha(rev.sourceRevision)} published ${u.rel(rev.acceptedAt)}` : ''}</p>
      ${Fleet.api.can('operate') && Fleet.api.can('admin') ? '' : `<p class="lock-note">${ic('lock')}<span>${esc(`${api.scopeTitle()} access: ${!api.can('operate') ? 'sync and add are' : 'adding machines is'} unavailable.`)}</span></p>`}
    </div>
    <div class="tiles">
      <a class="tile" href="#/deployments"><span class="tile-ic t-info">${ic('rocket')}</span><span class="tile-txt"><b>${rev ? (counts.succeeded < total ? `Deploying ${esc(u.shortSha(rev.sourceRevision))}` : `Latest revision ${esc(u.shortSha(rev.sourceRevision))}`) : 'Deployments'}</b><span>${total ? `${u.num(counts.succeeded)} of ${u.num(total)} assignments done` : 'No assignments yet'}</span>
        <span class="tile-meter" role="img" aria-label="${counts.succeeded} of ${total} assignments succeeded"><span data-w="${(counts.succeeded / Math.max(1, total) * 100).toFixed(1)}"></span></span></span>${ic('chevR', 'tile-chev')}</a>
      <a class="tile" href="#/repository"><span class="tile-ic ${!scan || scanOk ? 't-good' : 't-warning'}">${ic('branch')}</span><span class="tile-txt"><b>Repository</b><span>${!scan ? 'No scans recorded yet' : `${scanOk ? 'Up to date' : scan.outcome === 'invalid' ? 'Last scan was rejected' : 'Last scan failed'} · scanned ${esc(u.rel(scan.observedAt))}`}</span></span>${scan && !scanOk ? glyph('warning', 'bang', 'tile-g') : ''}${ic('chevR', 'tile-chev')}</a>
      <a class="tile" href="#/models"><span class="tile-ic ${badCats ? 't-warning' : 't-good'}">${ic('spark')}</span><span class="tile-txt"><b>Models</b><span>${!S.proxy ? 'Open to see CLIProxy catalogs' : !S.proxy.enabled ? 'Model sync is not configured' : !S.proxy.catalogs.length ? 'No CLIProxy catalogs in use' : badCats ? `${badCats} of ${S.proxy.catalogs.length} catalogs failing` : 'All catalogs healthy'}</span></span>${badCats ? glyph('warning', 'bang', 'tile-g') : ''}${ic('chevR', 'tile-chev')}</a>
      <a class="tile" href="#/enrollment"><span class="tile-ic t-neutral">${ic('link')}</span><span class="tile-txt"><b>Enrollment</b><span>${S.links === null ? 'Open to see links' : active.length ? `${u.plural(active.length, 'link')} active · ${esc(active[0].alias)} expires ${esc(u.until(active[0].expiresAt))}` : 'No active links'}</span></span>${ic('chevR', 'tile-chev')}</a>
    </div>
  </section>`;
  };

  const toolbar = () => `<div class="toolbar" role="search">
    <label class="search">${ic('search')}<span class="sr">Search machines</span><input id="q" type="search" autocomplete="off" placeholder="Search by name, hostname, OS, Agent version or status" value="${esc(S.q)}"></label>
    <div class="seg-ctl" role="group" aria-label="Group by"><span class="seg-lbl">Group by</span>${[['status', 'Status'], ['platform', 'Platform'], ['os', 'OS']].map(([k, l]) => `<button type="button" data-act="group" data-v="${k}" aria-pressed="${S.groupBy === k}">${l}</button>`).join('')}</div>
    <label class="sel"><span>Sort</span><select id="sort">${[['attention', 'Attention first'], ['disk', 'Fullest disk first'], ['name', 'Name'], ['seen', 'Last seen'], ['outdated', 'Outdated Agents first']].map(([k, l]) => `<option value="${k}" ${S.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select>${ic('chevD', 'sel-chev')}</label>
  </div>`;

  const paint = () => `<div class="wrap">${S.nodes.length ? header() + toolbar() : ''}<div id="gallery-body">${body()}</div></div>`;

  /* ---------------------------------------------------------------- check-in strips */
  /* A card's strip is fetched only while the card is rendered and near the viewport, a few requests at a time.
     Every request has its own AbortController. A card that scrolls out of range, is removed by a search, or is replaced by a new
     paint loses its queued or running request at once and gives its slot to the next card. A cancelled request leaves no trace:
     nothing is cached or painted, and no error is shown, so the card asks again when it comes back into range.
     Every load starts a new epoch: the cache is cleared, requests are cancelled, and failures are retried. */
  const MAX_PARALLEL = 4, RETRY_AFTER = 10000;
  let epoch = 0, running = 0, io = null;
  const queue = [], queued = new Set();
  const active = new Map(); // node id -> { ctl, released } for the request that is running

  const slotOf = id => document.querySelector(`[data-strip-slot="${CSS.escape(id)}"]`);
  const paintStrip = id => {
    const n = byId.get(id), slot = slotOf(id);
    if (!n || !slot) return;
    slot.innerHTML = stripSlot(n);
    const total = document.querySelector(`[data-strip-total="${CSS.escape(id)}"]`);
    if (total) total.textContent = stripTotal(n);
  };
  const wanted = id => {
    const d = strips.get(id);
    return !queued.has(id) && (!d || (d.error && !d.pending && u.now() - d.at > RETRY_AFTER));
  };
  /* Gives the request's concurrency slot back, once, whether it finished or was cancelled. */
  const release = (id, req) => {
    if (req.released) return;
    req.released = true; running--;
    if (active.get(id) === req) active.delete(id);
  };
  const cancel = id => {
    if (queued.delete(id)) queue.splice(queue.indexOf(id), 1);
    const req = active.get(id);
    if (!req) return;
    req.cancelled = true; req.ctl.abort();
    release(id, req);
    if (strips.get(id)?.pending) strips.delete(id);
    pump();
  };
  const pump = () => {
    while (running < MAX_PARALLEL && queue.length) {
      const id = queue.shift();
      queued.delete(id);
      if (!byId.has(id) || !slotOf(id)) continue; // no longer shown
      const ep = epoch, req = { ctl: new AbortController(), released: false, cancelled: false };
      strips.set(id, { pending: true });
      active.set(id, req);
      running++;
      api.get(`nodes/${id}/checkins`, { hours: 24 }, { signal: req.ctl.signal }).then(
        r => { if (ep === epoch && !req.cancelled) strips.set(id, { buckets: r?.buckets || [] }); },
        e => { if (ep === epoch && !req.cancelled) { if (e.silent) strips.delete(id); else strips.set(id, { error: true, at: u.now() }); } },
      ).finally(() => {
        if (ep !== epoch || req.cancelled) return;
        release(id, req);
        paintStrip(id);
        pump();
      });
    }
  };
  const want = id => { if (wanted(id)) { queue.push(id); queued.add(id); pump(); } };
  /* Cards stay observed so that leaving the viewport is seen as well as entering it. */
  const watchStrips = () => {
    if (io) io.disconnect();
    const slots = document.querySelectorAll('[data-strip-slot]');
    /* Work for cards that are no longer in the page (search, regrouping) stops now. */
    const present = new Set([...slots].map(el => el.dataset.stripSlot));
    for (const id of [...queued, ...active.keys()]) if (!present.has(id)) cancel(id);
    if (typeof IntersectionObserver !== 'function') { slots.forEach(el => want(el.dataset.stripSlot)); return; }
    io = io || new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = entry.target.dataset.stripSlot;
        if (entry.isIntersecting) want(id); else cancel(id);
      }
    }, { rootMargin: '200px 0px' });
    slots.forEach(el => io.observe(el));
  };
  const resetStrips = () => {
    epoch++; running = 0;
    for (const req of active.values()) { req.cancelled = true; req.released = true; req.ctl.abort(); }
    active.clear();
    queue.length = 0; queued.clear(); strips.clear();
    if (io) io.disconnect();
  };

  /* ---------------------------------------------------------------- view */
  Fleet.views.gallery = {
    title: 'Machines',
    async load() {
      const gen = ++S.gen;
      resetStrips();
      const [nodes, issues, source, revs, proxy, links] = await Promise.all([
        api.all('nodes', { maxPages: 5 }),
        api.get('issues').catch(Fleet.soft),
        api.get('source/status').catch(Fleet.soft),
        api.page('desired-revisions', { order: 'newest', limit: 1 }).catch(Fleet.soft),
        api.get('cliproxy/status').catch(Fleet.soft),
        api.page('enrollment-links').catch(Fleet.soft),
        Fleet.catalog.load(),
      ]);
      if (gen !== S.gen) throw Fleet.superseded();
      S.nodes = nodes.items.map(model.fromList); S.truncated = nodes.truncated;
      byId.clear(); S.nodes.forEach(n => byId.set(n.id, n));
      S.issues = issues ? issues.items || [] : null; S.source = source; S.rev = revs ? revs.items[0] || null : null; S.proxy = proxy; S.links = links ? links.items : null;
      model.summary.issues = S.issues; if (issues) model.summary.errors = S.issues.filter(i => i.severity === 'error').length;
      Fleet.renderNav();
      return paint();
    },
    paint,
    mount: watchStrips,
    unmount: resetStrips,
    repaintBody() { const el = document.getElementById('gallery-body'); if (el) { ui.setHtml(el, body()); watchStrips(); } },
  };

  /* ---------------------------------------------------------------- interaction */
  Fleet.actions['clear-search'] = () => { S.q = ''; Fleet.repaint(); u.$('#q')?.focus(); };
  Fleet.actions.group = el => { S.groupBy = el.dataset.v; Fleet.repaint(); };
  Fleet.actions.jump = el => {
    if (S.groupBy !== 'status') { S.groupBy = 'status'; Fleet.repaint(); }
    const id = { ok: 'sec-ok', updating: 'sec-updating' }[el.dataset.v] || 'sec-attention';
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  Fleet.on.input.q = t => { S.q = t.value; Fleet.views.gallery.repaintBody(); };
  Fleet.on.change.sort = t => { S.sort = t.value; Fleet.views.gallery.repaintBody(); };
  Fleet.on.toggle['data-retired'] = d => { S.retiredOpen = d.open; };
  Fleet.galleryReset = () => { resetStrips(); S.q = ''; };
})();
