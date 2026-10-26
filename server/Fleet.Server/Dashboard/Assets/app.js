'use strict';
/* Fleet dashboard: shell, hash router, sign-in and global event handling.
   Loaded last. The other files register views and handlers on window.Fleet. */
(function () {
  const Fleet = window.Fleet;
  const u = Fleet.u, ui = Fleet.ui, api = Fleet.api, model = Fleet.model;
  const { esc, ic, glyph } = u;

  const BRAND = '<svg class="brand-logo" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><rect width="32" height="32" rx="9" fill="url(#gLogo)"/><g stroke="#fff" stroke-width="2" stroke-linecap="round"><path d="M16 16L9.5 10M16 16l7.5-5M16 16v7.5"/></g><g fill="#fff"><circle cx="16" cy="16" r="3.4"/><circle cx="9.5" cy="10" r="2.4"/><circle cx="23.5" cy="11" r="2.4"/><circle cx="16" cy="23.5" r="2.4"/></g></svg>';
  let signedIn = false, booted = false, renderToken = 0, lastRendered = null;
  const el = id => document.getElementById(id);

  /* ---------------------------------------------------------------- shell */
  function buildShell() {
    document.body.classList.add('app');
    el('root').innerHTML = `${Fleet.art.defs}
    <a class="skip" href="#main" data-act="skip">Skip to content</a>
    <header class="topbar"><div class="topbar-in">
      <a class="brand" href="#/nodes">${BRAND}<span>Fleet</span></a>
      <nav class="nav" id="nav" aria-label="Primary" hidden></nav>
      <div class="me" id="me" hidden></div>
    </div></header>
    <main id="main" tabindex="-1"><div id="view"></div></main>
    <footer class="foot"><span>Fleet Manager · All times in UTC</span><span id="foot-note"></span></footer>
    <div id="modal-root" hidden></div>
    <div id="toasts" class="toasts" role="status" aria-live="polite"></div>
    <div id="tip" class="tip" role="tooltip" hidden></div>`;
  }

  const NAV = [['nodes', 'Machines'], ['problems', 'Problems'], ['deployments', 'Deployments'], ['repository', 'Repository'], ['models', 'Models'], ['enrollment', 'Enrollment'], ['audit', 'Audit']];
  Fleet.renderNav = () => {
    const nav = el('nav'), me = el('me');
    if (!nav) return;
    nav.hidden = me.hidden = !signedIn;
    if (!signedIn) return;
    const active = Fleet.nav.current?.name === 'add' ? 'nodes' : Fleet.nav.current?.name;
    const errs = model.summary.errors;
    nav.innerHTML = NAV.map(([k, l]) => {
      const badge = k === 'problems' && errs ? `<span class="nav-badge" aria-label="${errs} open errors">${errs}</span>` : k === 'models' && model.summary.modelsBad ? `<span class="nav-g" aria-label="A catalog is failing">${glyph('warning', 'bang')}</span>` : '';
      return `<a href="#/${k}" ${k === active ? 'aria-current="page"' : ''}>${l}${badge}</a>`;
    }).join('');
    const scope = api.scopeLabel();
    me.innerHTML = `<span class="scope-chip" data-tip="${esc(`Scope: ${scope}|${scope === 'admin' ? 'Can change anything.' : scope === 'operate' ? 'Can retry, sync, refresh and acknowledge or snooze problems. Cannot enroll or revoke.' : 'Can view everything. Cannot change anything.'}`)}">${ic(scope === 'read' ? 'lock' : 'shield')}${esc(scope)}</span>
      ${u.avatar(api.session.actor, 'av-me')}<span class="me-name">${esc(api.session.actor)}</span>
      <button type="button" class="btn btn-ghost btn-sm" data-act="logout">${ic('logout')}Sign out</button>`;
  };

  /* ---------------------------------------------------------------- sign in */
  function showLogin(notice) {
    signedIn = false; renderToken++;
    ui.closeModal(true);
    Fleet.nav.current = null;
    Fleet.renderNav();
    ui.setHtml(el('view'), `<div class="login-wrap"><section class="login-card" aria-labelledby="login-title">
      <span class="login-logo">${BRAND}</span>
      <h1 id="login-title" tabindex="-1">Sign in</h1>
      <p class="login-sub">Use your Operator token to manage this Fleet Server.</p>
      <form class="form" data-form="login" novalidate>
        <label for="operator-token">Operator token</label>
        <input id="operator-token" class="input" type="password" required autocomplete="off" spellcheck="false" maxlength="1024" data-autofocus aria-describedby="login-msg">
        <p class="field-msg ${notice && notice.err ? 'is-err' : ''}" id="login-msg" role="alert">${esc(notice?.text || '')}</p>
        <button class="btn btn-primary" type="submit">${ic('key')}Sign in</button>
      </form>
      <p class="muted small">The token is sent once to start a session. It is never stored in this browser.</p>
    </section></div>`);
    document.title = 'Sign in · Fleet Manager';
    setTimeout(() => el('operator-token')?.focus(), 0);
  }
  api.onUnauthorized = () => {
    if (!signedIn) return;
    showLogin({ text: 'Your session ended. Sign in again.', err: false });
  };
  Fleet.on.submit.login = async form => {
    const input = form.querySelector('#operator-token'), token = input.value, msg = el('login-msg'), btn = form.querySelector('button[type=submit]');
    input.value = '';
    if (!token) { msg.textContent = 'Enter your Operator token.'; msg.className = 'field-msg is-err'; input.focus(); return; }
    btn.disabled = true; msg.textContent = 'Signing in…'; msg.className = 'field-msg';
    try {
      await api.login(token);
      signedIn = true; Fleet.catalog.reset();
      Fleet.renderNav();
      if (!location.hash || location.hash === '#/' || location.hash === '#') location.hash = '#/nodes';
      model.summary.at = 0;
      lastRendered = null;
      render();
    } catch (e) { btn.disabled = false; msg.textContent = e.message; msg.className = 'field-msg is-err'; input.focus(); }
  };
  Fleet.actions.logout = async () => {
    try { await api.logout(); } catch (e) { ui.fail(e, 'Could not sign out'); return; }
    Fleet.galleryReset?.();
    showLogin({ text: 'Signed out.', err: false });
  };

  /* ---------------------------------------------------------------- router */
  const parse = hash => String(hash || '').replace(/^#/, '').split('?')[0].split('/').filter(Boolean).map(x => { try { return decodeURIComponent(x); } catch { return x; } });
  const ROUTES = {
    nodes: p => p[1] ? { view: Fleet.views.node, params: p.slice(1) } : { view: Fleet.views.gallery, params: [] },
    add: () => ({ view: Fleet.views.gallery, params: [] }),
    problems: () => ({ view: Fleet.views.problems, params: [] }),
    /* #/deployments/<revisionId> opens one revision; #/deployments/<short SHA> still scrolls the list to that revision. */
    deployments: p => ({ view: u.isUuid(p[1]) ? Fleet.views.revision : Fleet.views.deployments, params: p.slice(1) }),
    repository: () => ({ view: Fleet.views.repository, params: [] }),
    models: () => ({ view: Fleet.views.models, params: [] }),
    enrollment: () => ({ view: Fleet.views.enrollment, params: [] }),
    audit: () => ({ view: Fleet.views.audit, params: [] }),
  };
  Fleet.go = hash => {
    if (location.hash === hash) { render(); return; }
    location.hash = hash;
  };

  const describeFocus = () => {
    const a = document.activeElement, view = el('view');
    if (!a || a === document.body || !view.contains(a)) return null;
    if (a.id) return '#' + CSS.escape(a.id);
    const keys = ['data-act', 'data-v', 'data-i', 'data-flag', 'data-fam', 'data-sel-model', 'data-id', 'data-op', 'data-hours', 'data-target'].filter(k => a.hasAttribute(k));
    return keys.length ? keys.map(k => `[${k}="${CSS.escape(a.getAttribute(k))}"]`).join('') : null;
  };
  const place = (html, keepPosition) => {
    const view = el('view'), focus = keepPosition ? describeFocus() : null, y = window.scrollY;
    ui.hideTip();
    ui.setHtml(view, html);
    if (keepPosition) {
      window.scrollTo(0, y);
      if (focus) { try { view.querySelector(focus)?.focus({ preventScroll: true }); } catch { /* selector no longer valid */ } }
    }
  };

  async function render({ quiet = false, force = false } = {}) {
    if (!signedIn) return;
    const token = ++renderToken;
    const route = location.hash || '#/nodes';
    const p = parse(route), name = p[0] || 'nodes';
    const spec = (ROUTES[name] || (() => null))(p);
    const changed = route !== lastRendered;
    const prev = Fleet.nav.current;
    if (!spec || !spec.view) {
      Fleet.nav.current = { name: '', params: [] };
      Fleet.renderNav();
      place(`<div class="wrap">${ui.empty({ icon: 'search', h: 'h1', title: 'That page does not exist', text: 'Check the address, or go back to your machines.', action: '<a class="btn btn-secondary" href="#/nodes">Back to all machines</a>' })}</div>`);
      lastRendered = route; document.title = 'Not found · Fleet Manager';
      return;
    }
    Fleet.nav.current = { name, params: spec.params, view: spec.view };
    if (prev?.view && prev.view !== spec.view) prev.view.unmount?.();
    Fleet.renderNav();
    const keep = quiet && !changed;
    if (!keep) {
      if (changed) { ui.closeModal(true); }
      ui.setHtml(el('view'), spec.view.paintLoading ? spec.view.paintLoading() : ui.skeleton());
    }
    let html;
    try { html = await spec.view.load(spec.params, { force }); }
    catch (e) {
      if (token !== renderToken || e.silent) return;
      html = `<div class="wrap">${ui.errorState(e, { what: (typeof spec.view.title === 'function' ? spec.view.title(spec.params) : spec.view.title) || 'this page' })}</div>`;
    }
    if (token !== renderToken) return;
    place(html, keep);
    const title = typeof spec.view.title === 'function' ? spec.view.title(spec.params) : spec.view.title;
    document.title = `${title || 'Fleet'} · Fleet Manager`;
    el('foot-note').textContent = `Loaded ${u.fmtTime(new Date().toISOString())} UTC`;
    if (!keep) {
      const sameNode = prev && changed && name === 'nodes' && spec.params[0] && prev.name === 'nodes' && prev.params[0] === spec.params[0];
      if (sameNode) el('view').querySelector('.tabs a[aria-current]')?.focus({ preventScroll: true });
      else { window.scrollTo(0, 0); if (lastRendered !== null || name !== 'nodes') el('view').querySelector('h1')?.focus({ preventScroll: true }); }
    }
    spec.view.mount?.();
    if (name === 'add' && !ui.modalOpen()) Fleet.openWizard();
    lastRendered = route;
  }
  Fleet.reload = opts => render({ quiet: false, force: true, ...opts });
  Fleet.repaint = () => {
    const cur = Fleet.nav.current;
    if (!signedIn || !cur?.view?.paint) return;
    place(cur.view.paint(), true);
    cur.view.mount?.();
  };

  /* ---------------------------------------------------------------- events */
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    if (act !== 'locked' && t.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; }
    const fn = Fleet.actions[act];
    if (!fn) return;
    if (t.tagName === 'A' && act !== 'wz-view' && act !== 'skip') e.preventDefault();
    fn(t, e);
  });
  Fleet.actions.locked = t => ui.toast('Not available', { tone: 'warning', text: api.denied(t.dataset.need || 'admin') });
  Fleet.actions.reload = () => Fleet.reload();
  Fleet.actions['modal-close'] = () => ui.closeModal();
  Fleet.actions['toast-close'] = t => t.closest('.toast')?.remove();
  Fleet.actions.copy = t => ui.copy(t.dataset.copy, t);
  Fleet.actions.skip = () => { (el('view').querySelector('h1') || el('main')).focus(); };

  const dispatch = (table, t) => (table[t.dataset.on] || table[t.id] || table[t.name]);
  document.addEventListener('input', e => { const f = dispatch(Fleet.on.input, e.target); if (f) f(e.target, e); });
  document.addEventListener('change', e => { const f = dispatch(Fleet.on.change, e.target); if (f) f(e.target, e); });
  document.addEventListener('submit', e => {
    const f = e.target.closest('form[data-form]');
    if (!f) return;
    e.preventDefault();
    const h = Fleet.on.submit[f.dataset.form];
    if (h) h(f, e);
  });
  document.addEventListener('toggle', e => {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement)) return;
    if (d.dataset.openKey) Fleet.openState.set(d.dataset.openKey, d.open);
    for (const attr of Object.keys(Fleet.on.toggle)) if (d.hasAttribute(attr)) Fleet.on.toggle[attr](d);
  }, true);
  document.addEventListener('keydown', e => {
    if (ui.modalOpen()) {
      if (e.key === 'Escape') { e.preventDefault(); ui.closeModal(); return; }
      if (e.key === 'Tab') ui.trapTab(e);
      Fleet.wizardKeydown?.(e);
    }
  });
  document.addEventListener('pointerover', e => { const t = e.target.closest?.('[data-tip]'); if (t) ui.tipFor(t); });
  document.addEventListener('pointerout', e => { const t = e.target.closest?.('[data-tip]'); if (t && !t.contains(e.relatedTarget)) ui.hideTip(); });
  document.addEventListener('focusin', e => { const t = e.target.closest?.('[data-tip]'); if (t) ui.tipFor(t); });
  document.addEventListener('focusout', e => { if (e.target.closest?.('[data-tip]')) ui.hideTip(); });
  window.addEventListener('scroll', ui.hideTip, { passive: true });
  window.addEventListener('hashchange', () => { if (signedIn) render(); });
  window.addEventListener('pagehide', () => { const i = el('operator-token'); if (i) i.value = ''; ui.closeModal(true); });

  /* Countdowns and elapsed timers. */
  setInterval(() => {
    const now = u.now();
    document.querySelectorAll('[data-countdown]').forEach(t => {
      const left = u.ms(t.dataset.countdown) - now;
      t.textContent = left <= 0 ? 'expired' : t.dataset.fmt === 'clock' ? u.clock(left) : left < u.MIN ? `in ${Math.ceil(left / 1000)} s` : `in ${Math.ceil(left / u.MIN)} min`;
    });
    document.querySelectorAll('[data-countdown-bar]').forEach(t => { t.style.width = Math.max(0, (u.ms(t.dataset.countdownBar) - now) / +t.dataset.total * 100).toFixed(2) + '%'; });
    document.querySelectorAll('[data-elapsed]').forEach(t => { t.textContent = u.clock(now - +t.dataset.elapsed); });
  }, 1000);

  /* ---------------------------------------------------------------- boot */
  async function boot() {
    buildShell();
    if (!booted) { Fleet.charts.bind(); booted = true; }
    ui.setHtml(el('view'), ui.skeleton());
    try {
      await api.renewCsrf();
      await api.loadSession();
      signedIn = true;
      if (!location.hash || location.hash === '#') history.replaceState(null, '', '#/nodes');
      Fleet.renderNav();
      render();
    } catch (e) {
      if (e.status === 401 || e.code === 'unauthorized') showLogin();
      else ui.setHtml(el('view'), `<div class="wrap">${ui.errorState(e, { what: 'the dashboard', retry: false })}<div class="empty-retry"><button type="button" class="btn btn-secondary" data-act="boot-retry">${ic('retry')}Try again</button></div></div>`);
    }
  }
  Fleet.actions['boot-retry'] = () => boot();
  boot();
})();
