'use strict';
/* Fleet dashboard: Enrollment links and the Add machine wizard.
   API: GET enrollment-links, POST enrollment-links (admin), POST enrollment-links/{id}/revoke (admin),
   and, while the wizard waits, GET enrollment-links/{id} for its own link and then GET nodes/{node} to detect the first check-in.
   Polling stops when the Node is found, when the link's expiry passes unused, when the link is revoked, when the Node has not checked in
   for NODE_WAIT_MS after enrolling, and when the wizard closes. Every poll request has its own timeout, and the deadlines are checked
   before each request and after each failure, so a failing Server cannot keep the wizard waiting past them.
   The created link is shown once, kept only in the open dialog, and cleared when it closes. */
(function () {
  const Fleet = window.Fleet = window.Fleet || {};
  const u = Fleet.u, ui = Fleet.ui, api = Fleet.api, model = Fleet.model;
  const { esc, ic, glyph, enc } = u;
  Fleet.views = Fleet.views || {};

  const S = { links: [], truncated: false, filter: 'all', formMsg: '', formErr: false, gen: 0 };
  const LS = { active: ['info', 'clock', 'Active'], consumed: ['good', 'check', 'Used'], expired: ['neutral', 'minus', 'Expired'], revoked: ['neutral', 'ban', 'Revoked'] };

  /* ---------------------------------------------------------------- page */
  const linkRow = l => {
    const [lv, k, label] = LS[l.state] || LS.expired;
    const detail = l.state === 'active' ? `Expires <span data-countdown="${esc(l.expiresAt)}" data-fmt="in">${esc(u.until(l.expiresAt))}</span> · ${esc(u.fmtTime(l.expiresAt))} UTC`
      : l.state === 'consumed' ? `Used ${esc(u.rel(l.consumedAt))} · enrolled ${esc(l.alias)}`
        : l.state === 'expired' ? `Expired ${esc(u.rel(l.expiresAt))}, never used` : `Revoked ${esc(u.rel(l.revokedAt))}${l.revokedBy ? ` by ${esc(l.revokedBy)}` : ''}`;
    const action = l.state === 'active' ? ui.gate('admin', 'btn-sm btn-secondary', `${ic('ban')}Revoke`, `data-act="revoke-link" data-id="${esc(l.id)}"`)
      : l.state === 'consumed' && l.nodeId ? `<a class="btn btn-sm btn-ghost" href="#/nodes/${enc(l.nodeId)}">Open machine${ic('chevR')}</a>` : '';
    return `<li class="link-row link-row--${esc(l.state)}"><span class="link-ic">${ic('link')}</span><div class="link-main"><b>${esc(l.alias)}</b><span class="muted small">Expiry ${esc(u.fmtFull(l.expiresAt))} UTC</span></div>
    <div class="link-state">${u.pill(lv, k, label)}<span class="small">${detail}</span></div><div class="link-act">${action}</div></li>`;
  };

  const paint = () => {
    const L = S.links, f = S.filter;
    const shown = f === 'all' ? L : L.filter(l => l.state === f);
    const c = s => L.filter(l => l.state === s).length;
    const admin = api.can('admin');
    return `<div class="wrap">
    ${ui.pageHead('Enrollment', 'One-time links that let a new machine join this Workspace.', ui.gate('admin', 'btn-primary', `${ic('plus')}Add machine`, 'data-act="add"'))}
    ${ui.lockNote('admin')}
    <div class="cols">
      <section class="panel"><header class="panel-head"><h2>Create a link</h2><p>Bound to one alias, single-use, and it includes the Server’s public CA.</p></header>
        <form class="form" data-form="enroll" novalidate>
          <label for="en-alias">Machine alias</label><input id="en-alias" name="alias" placeholder="e.g. office-mini" maxlength="201" autocomplete="off" spellcheck="false" aria-describedby="en-msg" ${admin ? '' : 'disabled'}>
          <label for="en-exp">Link expires after</label><div class="sel sel--block"><select id="en-exp" name="expiry" ${admin ? '' : 'disabled'}><option value="900">15 minutes (default)</option><option value="1800">30 minutes</option><option value="3600">1 hour (maximum)</option></select>${ic('chevD', 'sel-chev')}</div>
          <p class="field-msg${S.formErr ? ' is-err' : ''}" id="en-msg" role="status">${esc(S.formMsg || 'The guided setup shows the install and enroll commands next.')}</p>
          ${admin ? `<button class="btn btn-primary" type="submit">${ic('link')}Create link</button>` : ui.locked('admin', 'btn-primary', `${ic('link')}Create link`)}
        </form>
      </section>
      <section class="panel"><header class="panel-head"><h2>How enrollment works</h2><p>The machine creates its own identity. Fleet never sees its private key.</p></header>
        <ol class="how"><li><span class="how-n">1</span><div><b>Create a link for an alias</b><p>Treat it as a secret until it expires or is used. You can revoke it before then.</p></div></li><li><span class="how-n">2</span><div><b>Run <code>fleet-agent enroll --link</code> on the machine</b><p>Paste the link at the prompt. The Agent generates a P-256 key and stores state in <span class="mono">~/.local/state/fleet-agent</span>.</p></div></li><li><span class="how-n">3</span><div><b>Start the service</b><p>With Homebrew: <code>brew services start jcarcaboso/fleet/fleet-agent</code>. The machine appears here at its first check-in.</p></div></li></ol>
      </section>
    </div>
    <section class="panel"><header class="panel-head row"><div><h2>Links</h2><p>Active, used, expired and revoked links, newest expiry first. Links themselves are never shown again after creation.</p></div>
      ${ui.chips('link-filter', f, [['all', 'All', L.length], ['active', 'Active', c('active')], ['consumed', 'Used', c('consumed')], ['expired', 'Expired', c('expired')], ['revoked', 'Revoked', c('revoked')]], 'Filter links')}</header>
      <ul class="links">${shown.map(linkRow).join('') || `<li class="empty-mini">${ic('link')}<p>${L.length ? `No ${esc((LS[f] || [])[2]?.toLowerCase() || '')} links.` : 'No enrollment links yet.'}</p></li>`}</ul>
      ${S.truncated ? '<p class="muted small">Showing the newest links only.</p>' : ''}
    </section></div>`;
  };

  Fleet.views.enrollment = {
    title: 'Enrollment',
    async load() {
      const gen = ++S.gen;
      const r = await api.all('enrollment-links', { maxPages: 3 });
      if (gen !== S.gen) throw Fleet.superseded();
      S.links = r.items; S.truncated = r.truncated;
      Fleet.model.refreshSummary();
      return paint();
    },
    paint,
  };

  Fleet.actions['link-filter'] = el => { S.filter = el.dataset.v; Fleet.repaint(); };
  Fleet.actions['revoke-link'] = async el => {
    const id = el.dataset.id;
    el.disabled = true;
    try {
      await api.post(`enrollment-links/${enc(id)}/revoke`, {});
      ui.toast('Enrollment link revoked');
      /* Close the wizard only if it is still showing this link. Another dialog may be open by now. */
      if (W.link && W.link.id === id) ui.closeModal(true);
    } catch (e) { el.disabled = false; ui.fail(e, 'Link was not revoked'); }
    /* The list is on the Enrollment page and the Machines tile. Any other page loads fresh when it is opened. */
    if (['enrollment', 'nodes', 'add'].includes(Fleet.nav.current?.name) && !Fleet.nav.current.params?.[0]) await Fleet.reload({ quiet: true });
  };
  Fleet.on.submit.enroll = form => {
    const alias = form.alias.value.trim(), m = u.$('#en-msg');
    const err = aliasError(alias);
    if (err) { m.textContent = err; m.className = 'field-msg is-err'; form.alias.setAttribute('aria-invalid', 'true'); form.alias.focus(); return; }
    openWizard(alias); W.expiry = +form.expiry.value; createLink();
  };

  /* ---------------------------------------------------------------- wizard */
  /* gen changes whenever the wizard opens, closes or leaves step 3, so a poll that is still in flight can tell it is obsolete. */
  const W = { step: 1, alias: '', expiry: 900, platform: 'macos', err: null, link: null, phase: 0, timers: [], ctl: null, node: null, startedAt: 0, expired: false, stalled: false, gen: 0, expiresMs: 0, consumedMs: 0, nodeKey: null };
  const POLL_MS = 4000, NODE_WAIT_MS = 10 * 60 * 1000, REQUEST_MS = 8000;
  /* Cancels the pending poll timer and the poll request in flight. Callers bump W.gen first so the cancelled poll knows it is obsolete. */
  const halt = () => { W.timers.forEach(clearTimeout); W.timers = []; W.ctl?.abort(); W.ctl = null; };
  const aliasError = a => (!a || a.length > 200) ? 'Choose a nonblank alias of at most 200 characters.' : null;
  const stopWizard = () => {
    const created = !!W.link;
    W.gen++; halt(); W.link = null; W.node = null; W.err = null;
    if (Fleet.nav.current?.name === 'add') Fleet.go('#/nodes');
    else if (created && ['enrollment', 'nodes'].includes(Fleet.nav.current?.name)) { Fleet.galleryReset?.(); Fleet.reload({ quiet: true }); }
  };

  const previewNode = () => ({ platform: W.platform, freshness: W.phase === 2 ? 'fresh' : 'never_contacted', revoked: false });
  const install = mac => [
    { t: `Install the Agent with Homebrew${mac ? ' (macOS 13 or newer, Apple silicon or Intel)' : ' on Linux amd64'}.`, cmd: 'brew tap jcarcaboso/fleet https://github.com/jcarcaboso/fleet-manager\nbrew install jcarcaboso/fleet/fleet-agent' },
    { t: 'Enroll. Paste the link when the Agent asks for it.', cmd: 'agent_bin="$(brew --prefix jcarcaboso/fleet/fleet-agent)/bin/fleet-agent"\n"$agent_bin" enroll --link' },
    { t: mac ? 'Start the service. On macOS it starts at login from now on.' : 'Start the service. It runs under systemd --user.', cmd: 'brew services start jcarcaboso/fleet/fleet-agent' },
    ...(mac ? [] : [{ or: true, t: 'Need it to start at boot, before anyone signs in? Enable lingering.', cmd: 'sudo loginctl enable-linger "$USER"' }]),
  ];

  const wizardHTML = () => {
    const S3 = ['Name it', 'Install & enroll', 'First check-in'];
    const online = W.phase === 2;
    const titles = ['Name your new machine', 'Install the Agent and enroll', online ? `${W.alias} is online` : `Waiting for ${W.alias} to check in`];
    const head = `<div class="modal-head wz-head"><div><p class="eyebrow">Add machine · step ${W.step} of 3</p><h2 id="modal-title">${esc(titles[W.step - 1])}</h2></div><button type="button" class="icon-btn" data-act="modal-close" aria-label="Close">${ic('x')}</button></div>
    <ol class="wz-steps">${S3.map((s, i) => { const done = i + 1 < W.step || (i === 2 && online); return `<li class="${done ? 'done' : i + 1 === W.step ? 'cur' : ''}"><span class="wz-n">${done ? glyph('good', 'check') : i + 1}</span>${s}</li>`; }).join('')}</ol>`;
    if (W.step === 1) {
      return head + `<form class="wz-body wz-1" data-form="wz" novalidate><div class="wz-art" id="wz-art">${Fleet.art.device(previewNode(), null)}</div><div class="wz-form">
      <label for="wz-alias">Machine alias</label><input id="wz-alias" class="input" value="${esc(W.alias)}" placeholder="e.g. office-mini" maxlength="201" autocomplete="off" spellcheck="false" data-autofocus aria-describedby="wz-alias-msg" aria-invalid="${!!W.err}">
      <p id="wz-alias-msg" class="field-msg${W.err ? ' is-err' : ''}" role="status">${esc(W.err || 'Lowercase letters, numbers and dashes work best. fleet.yml uses this name under nodes:.')}</p>
      <fieldset class="radios"><legend>Platform</legend>${[['macos', 'macOS', 'apple'], ['linux', 'Linux', 'tux']].map(([v, l, i]) => `<label class="radio-card"><input type="radio" name="wz-plat" value="${v}" ${W.platform === v ? 'checked' : ''}><span>${ic(i)}${l}</span></label>`).join('')}</fieldset>
      <fieldset class="radios"><legend>Link expires after</legend>${[[900, '15 min'], [1800, '30 min'], [3600, '1 hour']].map(([v, l]) => `<label class="radio-card"><input type="radio" name="wz-exp" value="${v}" ${W.expiry === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</fieldset>
      <p class="muted small">The link is single-use, bound to this alias and includes the Server’s public CA. Treat it as a secret until it is used or expires.</p>
    </div><div class="modal-foot wz-foot"><button type="button" class="btn btn-secondary" data-act="modal-close">Cancel</button><button type="submit" class="btn btn-primary" id="wz-create">Create link${ic('arrowR')}</button></div></form>`;
    }
    if (W.step === 2) {
      const l = W.link, mac = W.platform === 'macos';
      return head + `<div class="wz-body">
      <div class="wz-link"><div class="wz-link-top"><b>One-time enrollment link for ${esc(l.alias)}</b><span class="cd">${ic('clock')}Expires in <b data-countdown="${esc(l.expiresAt)}" data-fmt="clock">${esc(u.clock(u.ms(l.expiresAt) - u.now()))}</b></span></div>
        <div class="wz-meter" role="presentation"><span data-countdown-bar="${esc(l.expiresAt)}" data-total="${W.expiry * 1000}" data-w="100"></span></div>
        ${u.cmdBlock(l.url, 'Copy link', 'cmd--link')}
        <p class="muted small">Anyone with this link can enroll <b>${esc(l.alias)}</b> until it expires or is used. It is shown only here and is not stored; copy it only to the intended machine.</p></div>
      <div class="os-tabs" role="tablist" aria-label="Platform">${[['macos', 'macOS', 'apple'], ['linux', 'Linux', 'tux']].map(([v, t, i]) => `<button type="button" role="tab" id="os-${v}" aria-selected="${W.platform === v}" aria-controls="os-panel" data-act="wz-os" data-v="${v}" tabindex="${W.platform === v ? 0 : -1}">${ic(i)}${t}</button>`).join('')}</div>
      <div class="os-panel" id="os-panel" role="tabpanel" aria-labelledby="os-${W.platform}">${ui.stepsList(install(mac))}</div></div>
      <div class="modal-foot wz-foot"><button type="button" class="btn btn-ghost btn-danger-ghost" data-act="revoke-link" data-id="${esc(l.id)}">${ic('ban')}Revoke link</button><span class="spacer"></span><button type="button" class="btn btn-primary" data-act="wz-wait">I have run these commands${ic('arrowR')}</button></div>`;
    }
    const n = W.node;
    const item = (done, cur, text) => `<li class="${done ? 'done' : cur ? 'cur' : ''}">${done ? glyph('good', 'check') : cur ? '<span class="spinner" aria-hidden="true"></span>' : glyph('pending', 'clock')}<span>${text}</span></li>`;
    return head + `<div class="wz-body wz-3"><div class="wz-art wz-art--big${online ? ' is-online' : ' is-waiting'}"><span class="pulse" aria-hidden="true"></span>${Fleet.art.device(previewNode(), null)}</div>
    <div class="wz-wait">${W.expired ? `<p class="lead">${glyph('warning', 'bang')} The link expired before ${esc(W.alias)} used it.</p><p>Create a new link for the same alias.</p>`
      : W.stalled ? `<p class="lead">${glyph('warning', 'bang')} ${esc(W.alias)} enrolled, but it has not checked in yet.</p><p>Fleet stopped listening. Check that the Agent service is running on the machine, then check again.</p>`
      : !online ? `<p class="lead">Fleet is listening for <b>${esc(W.alias)}</b>. This usually takes less than a minute after <code>brew services start</code>.</p>`
        : `<p class="lead">${u.pill('good', 'check', 'Checked in')} ${esc(u.platformLabel(n?.platform || W.platform))}</p><p>Add ${esc(W.alias)} to <span class="mono">fleet.yml</span> to choose its Skill groups, agent files and AI clients.</p>`}
      <ul class="wz-checks" aria-live="polite">${item(true, false, 'Enrollment link created')}${item(W.phase >= 1, W.phase === 0 && !W.expired, W.phase >= 1 ? 'Agent enrolled and the link was used' : 'Waiting for the Agent to enroll…')}${item(online, W.phase === 1 && !W.stalled, online ? `First check-in received ${esc(u.fmtTime(n?.lastContactAt))} UTC` : 'Waiting for the first check-in…')}</ul>
      ${!online && !W.expired && !W.stalled ? `<p class="muted small">Waiting <span data-elapsed="${W.startedAt}">0:00</span> · checking every few seconds</p>` : ''}</div></div>
    <div class="modal-foot wz-foot">${online ? `<button type="button" class="btn btn-secondary" data-act="wz-again">${ic('plus')}Add another</button><span class="spacer"></span><a class="btn btn-primary" href="#/nodes/${enc(W.alias)}" data-act="wz-view">View ${esc(W.alias)}${ic('arrowR')}</a>`
      : W.expired ? `<button type="button" class="btn btn-secondary" data-act="modal-close">Close</button><span class="spacer"></span><button type="button" class="btn btn-primary" data-act="wz-new">${ic('link')}Create a new link</button>`
        : W.stalled ? `<button type="button" class="btn btn-secondary" data-act="modal-close">Close</button><span class="spacer"></span><button type="button" class="btn btn-primary" data-act="wz-recheck">${ic('retry')}Check again</button>`
          : `<button type="button" class="btn btn-secondary" data-act="wz-back">${ic('chevL')}Show commands</button><span class="spacer"></span><button type="button" class="btn btn-secondary" data-act="modal-close">Close and stop waiting</button>`}</div>`;
  };

  const render = () => ui.renderModal(wizardHTML());
  function openWizard(alias = '') {
    Object.assign(W, { step: 1, alias, expiry: 900, platform: 'macos', err: null, link: null, phase: 0, node: null, expired: false, stalled: false, nodeKey: null });
    W.gen++; halt();
    ui.openModal(wizardHTML(), { wide: true, onClose: stopWizard });
  }
  Fleet.openWizard = openWizard;

  /* The request outlives the dialog that started it: the user can close the wizard, or open another one, before it answers.
     W.gen says whether this wizard is still the one on screen. An obsolete answer changes nothing, and a link that was created for
     a wizard nobody is looking at is only reflected in the list behind it. */
  async function createLink() {
    const alias = W.alias.trim(), err = aliasError(alias);
    if (err) { W.err = err; render(); return; }
    W.alias = alias;
    const gen = W.gen, expiry = W.expiry;
    const btn = u.$('#wz-create'); if (btn) btn.disabled = true;
    let created = null, failure = null;
    try { created = await api.post('enrollment-links', { alias, expiresInSeconds: expiry }); }
    catch (e) { failure = e; }
    if (gen !== W.gen) {
      if (created && ['enrollment', 'nodes'].includes(Fleet.nav.current?.name) && !Fleet.nav.current.params?.[0]) Fleet.reload({ quiet: true });
      return;
    }
    if (failure) {
      if (failure.silent) return;
      W.err = failure.message; S.formMsg = failure.message; S.formErr = true;
      if (!ui.modalOpen()) { const m = u.$('#en-msg'); if (m) { m.textContent = failure.message; m.className = 'field-msg is-err'; } return; }
    } else {
      W.link = { id: created.id, alias, expiresAt: created.expiresAt, url: created.link };
      W.expiresMs = u.ms(created.expiresAt) ?? u.now() + expiry * 1000;
      W.step = 2; W.err = null; W.expired = false; W.stalled = false;
      ui.toast('Enrollment link created', { text: `Valid until ${u.fmtTime(created.expiresAt)} UTC.` });
    }
    if (ui.modalOpen()) render();
  }

  /* Detect enrollment and the first check-in with the same read endpoints the rest of the dashboard uses.
     The wizard asks for its own link by ID, so it never depends on where the link falls in the list.
     Each phase has a deadline: the link's expiry, then NODE_WAIT_MS after it was used. A poll that starts after the deadline takes one
     last bounded look, so a link used in its final seconds is not reported as expired, and then gives up whatever that look returns.
     A request that fails or times out is not a reason to stop early, and it is never a reason to wait past the deadline. */
  const deadline = () => W.phase === 0 ? W.expiresMs : W.consumedMs + NODE_WAIT_MS;
  const schedule = gen => {
    const wait = Math.max(250, Math.min(POLL_MS, deadline() - u.now() + 50));
    W.timers.push(setTimeout(() => poll(gen), wait));
  };
  /* One GET bounded by REQUEST_MS. A timeout is reported as an error with timedOut set, so it is told apart from a cancel. */
  function read(path) {
    const ctl = W.ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, REQUEST_MS);
    return api.get(path, undefined, { signal: ctl.signal })
      .catch(e => { if (timedOut) e.timedOut = true; throw e; })
      .finally(() => { clearTimeout(timer); if (W.ctl === ctl) W.ctl = null; });
  }
  /* Whether polling goes on after this failure: not when the wizard moved on, the user was signed out or the request was cancelled. */
  const retryable = (e, gen) => gen === W.gen && (!e.silent || e.timedOut);
  async function poll(gen) {
    if (gen !== W.gen || !ui.modalOpen() || W.step !== 3 || !W.link) return;
    const link = W.link;
    if (W.phase === 0) {
      const last = u.now() >= W.expiresMs;
      let mine = null;
      try { mine = await read(`enrollment-links/${enc(link.id)}`); }
      catch (e) { if (!retryable(e, gen)) return; }
      if (gen !== W.gen) return;
      if (mine?.state === 'consumed') { W.phase = 1; W.consumedMs = u.now(); W.nodeKey = mine.nodeId || null; render(); }
      else if (mine?.state === 'revoked' || mine?.state === 'expired' || last || u.now() >= W.expiresMs) { W.expired = true; render(); return; }
      else if (mine) W.nodeKey = mine.nodeId || null;
    }
    if (W.phase === 1) {
      const last = u.now() - W.consumedMs > NODE_WAIT_MS;
      try {
        const node = await read(`nodes/${enc(W.nodeKey || link.alias)}`);
        if (gen !== W.gen) return;
        if (node?.lastContactAt) { W.node = node; W.phase = 2; render(); ui.toast(`${link.alias} checked in`); Fleet.galleryReset?.(); return; }
      } catch (e) { if (e.code !== 'node_not_found' && !retryable(e, gen)) return; }
      if (gen !== W.gen) return;
      if (last || u.now() > deadline()) { W.stalled = true; render(); return; }
    }
    schedule(gen);
  }

  Fleet.actions.add = () => {
    if (!api.can('admin')) { ui.toast('Not available', { tone: 'warning', text: api.denied('admin') }); return; }
    openWizard();
  };
  Fleet.actions['wz-os'] = el => { W.platform = el.dataset.v; render(); document.getElementById(`os-${W.platform}`)?.focus(); };
  Fleet.actions['wz-wait'] = () => {
    W.step = 3; W.phase = 0; W.expired = false; W.stalled = false; W.startedAt = u.now(); render();
    const gen = ++W.gen;
    halt(); W.timers = [setTimeout(() => poll(gen), 1200)];
  };
  Fleet.actions['wz-back'] = () => { W.gen++; halt(); W.step = 2; render(); };
  Fleet.actions['wz-recheck'] = () => {
    W.stalled = false; W.consumedMs = u.now(); render();
    const gen = ++W.gen;
    halt(); W.timers = [setTimeout(() => poll(gen), 300)];
  };
  Fleet.actions['wz-new'] = () => { openWizard(W.link?.alias || W.alias); };
  Fleet.actions['wz-again'] = () => { openWizard(); };
  Fleet.actions['wz-view'] = () => { ui.closeModal(true); };
  Fleet.on.submit.wz = () => { W.alias = u.$('#wz-alias').value; createLink(); };
  Fleet.on.input['wz-alias'] = t => {
    W.alias = t.value; W.err = null;
    const art = u.$('#wz-art'); if (art) art.innerHTML = Fleet.art.device(previewNode(), null);
    const m = u.$('#wz-alias-msg'); if (m) { m.className = 'field-msg'; m.textContent = 'Lowercase letters, numbers and dashes work best. fleet.yml uses this name under nodes:.'; }
    t.setAttribute('aria-invalid', 'false');
  };
  Fleet.on.change['wz-plat'] = t => { W.platform = t.value; const art = u.$('#wz-art'); if (art) art.innerHTML = Fleet.art.device(previewNode(), null); };
  Fleet.on.change['wz-exp'] = t => { W.expiry = +t.value; };
  Fleet.wizardKeydown = e => {
    const tab = e.target.closest?.('.os-tabs [role="tab"]');
    if (tab && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { W.platform = W.platform === 'macos' ? 'linux' : 'macos'; render(); document.getElementById(`os-${W.platform}`)?.focus(); }
  };
})();
