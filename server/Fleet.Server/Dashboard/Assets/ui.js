'use strict';
/* Fleet dashboard: shared UI behaviour (markup insertion, toasts, modals, tooltips, clipboard, states).
   The Server's CSP blocks style attributes, so markup carries data-* hints that hydrate() turns into
   CSSOM style writes, which the CSP allows. */
(function () {
  const Fleet = window.Fleet = window.Fleet || {};
  const { esc, ic, glyph } = Fleet.u;
  const ui = Fleet.ui = {};
  /* State shared by the buttons that appear on several pages. */
  Fleet.shared = { syncing: false, lastSync: null, refreshing: false, lastRefresh: null };
  /* Event registries: views register handlers by data-act name, element id or form name. */
  Fleet.actions = Fleet.actions || {};
  Fleet.on = Fleet.on || { input: {}, change: {}, submit: {}, toggle: {} };
  Fleet.nav = Fleet.nav || { current: null };
  Fleet.openState = Fleet.openState || new Map();
  Fleet.soft = error => { if (error && error.silent) throw error; return null; };

  /* ---------------------------------------------------------------- hydration */
  ui.hydrate = root => {
    root.querySelectorAll('[data-w]').forEach(el => { el.style.width = el.dataset.w + '%'; });
    root.querySelectorAll('[data-l]').forEach(el => { el.style.left = el.dataset.l + '%'; });
    root.querySelectorAll('[data-grow]').forEach(el => { el.style.flexGrow = el.dataset.grow; });
    return root;
  };
  ui.setHtml = (el, html) => { el.innerHTML = html; ui.hydrate(el); return el; };

  /* ---------------------------------------------------------------- loading, empty and error states */
  ui.skeleton = (kind = 'page') => kind === 'cards'
    ? `<div class="grid" aria-hidden="true">${'<div class="card skel-card"><div class="skel skel-stage"></div><div class="skel skel-line"></div><div class="skel skel-line skel-short"></div></div>'.repeat(6)}</div>`
    : `<div class="wrap" role="status" aria-live="polite"><span class="sr">Loading…</span><div aria-hidden="true"><div class="skel skel-title"></div><div class="skel skel-line skel-short"></div><div class="skel skel-block"></div><div class="skel skel-block"></div></div></div>`;
  ui.empty = ({ icon = 'search', title, text = '', action = '', good = false, h = 'h2' }) =>
    `<div class="empty${good ? ' empty--good' : ''}"><div class="empty-art${good ? ' good' : ''}">${good ? glyph('good', 'check') : ic(icon)}</div><${h} tabindex="-1">${esc(title)}</${h}>${text ? `<p>${esc(text)}</p>` : ''}${action}</div>`;
  ui.errorState = (error, { what = 'this page', retry = true } = {}) => {
    const forbidden = error?.status === 403;
    return `<div class="empty empty--error" role="alert"><div class="empty-art">${glyph(forbidden ? 'warning' : 'critical', forbidden ? 'bang' : 'x')}</div>
      <h1 tabindex="-1">${forbidden ? 'Your token cannot open this' : `Could not load ${esc(what)}`}</h1>
      <p>${esc(error?.message || 'Something went wrong.')}</p>
      ${retry && !forbidden ? `<button type="button" class="btn btn-secondary" data-act="reload">${ic('retry')}Try again</button>` : ''}</div>`;
  };
  ui.inlineError = (error, what) => `<div class="callout callout--critical" role="alert">${glyph('critical', 'x')}<div><b>Could not load ${esc(what)}</b><p>${esc(error?.message || 'Something went wrong.')}</p></div></div>`;

  /* ---------------------------------------------------------------- toasts */
  ui.toast = (title, o = {}) => {
    const root = document.getElementById('toasts');
    if (!root) return;
    const tone = o.tone || 'good';
    const el = document.createElement('div');
    el.className = `toast toast--${tone}`;
    el.setAttribute('role', tone === 'critical' ? 'alert' : 'status');
    el.innerHTML = `${glyph(tone, tone === 'good' ? 'check' : tone === 'info' ? 'info' : tone === 'critical' ? 'x' : 'bang')}<div class="toast-main"><b>${esc(title)}</b>${o.text ? `<span>${esc(o.text)}</span>` : ''}</div><button type="button" class="icon-btn" data-act="toast-close" aria-label="Dismiss">${ic('x')}</button>`;
    root.append(el);
    setTimeout(() => el.classList.add('out'), o.sticky ? 12000 : 6000);
    setTimeout(() => el.remove(), o.sticky ? 12400 : 6400);
  };
  ui.fail = (error, title = 'That did not work') => {
    if (error?.silent) return;
    ui.toast(title, { tone: error?.status === 403 ? 'warning' : 'critical', text: error?.message, sticky: true });
  };

  /* ---------------------------------------------------------------- locked actions */
  /* A control the session scope does not allow stays focusable and explains itself on hover, focus and click. */
  ui.locked = (level, cls, html, extra = '') =>
    `<button type="button" class="btn ${cls} is-locked" aria-disabled="true" data-act="locked" data-need="${level}" data-tip="${esc(`Not available|${Fleet.api.denied(level)}`)}" ${extra}>${html}</button>`;
  ui.gate = (level, cls, html, attrs = '') => Fleet.api.can(level)
    ? `<button type="button" class="btn ${cls}" ${attrs}>${html}</button>`
    : ui.locked(level, cls, html);
  ui.lockNote = level => Fleet.api.can(level) ? '' : `<p class="lock-note">${ic('lock')}<span>${esc(Fleet.api.denied(level))}</span></p>`;

  /* ---------------------------------------------------------------- clipboard */
  ui.copy = (text, btn) => {
    const done = ok => {
      if (!btn) return;
      const label = btn.querySelector('span');
      const prev = label ? label.textContent : null;
      btn.classList.add('is-copied');
      if (label) label.textContent = ok ? 'Copied' : 'Press Ctrl+C';
      setTimeout(() => { btn.classList.remove('is-copied'); if (label) label.textContent = prev; }, 1600);
    };
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.append(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove(); done(ok);
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(() => done(true), fallback);
    else fallback();
  };

  /* ---------------------------------------------------------------- tooltip */
  const tip = () => document.getElementById('tip');
  ui.showTip = (text, x, y) => {
    const el = tip(); if (!el) return;
    const [head, ...rest] = String(text).split('\n');
    const [v, l] = head.includes('|') ? head.split('|') : [head, ''];
    el.innerHTML = `<b>${esc(v)}</b>${l ? `<span>${esc(l)}</span>` : ''}${rest.map(r => `<span class="tip-row">${esc(r)}</span>`).join('')}`;
    el.hidden = false;
    const w = el.offsetWidth, h = el.offsetHeight;
    let top = y - h - 10;
    if (top < 8) top = y + 22;
    el.style.left = Math.max(8, Math.min(innerWidth - w - 8, x - w / 2)) + 'px';
    el.style.top = top + 'px';
  };
  ui.hideTip = () => { const el = tip(); if (el) el.hidden = true; };
  ui.tipFor = el => { const r = el.getBoundingClientRect(); ui.showTip(el.dataset.tip, r.left + r.width / 2, r.top); };

  /* ---------------------------------------------------------------- modal */
  let modalReturn = null;
  const root = () => document.getElementById('modal-root');
  ui.modalOpen = () => !root().hidden;
  ui.openModal = (html, { wide = false, onClose = null } = {}) => {
    ui.closeModal(true);
    modalReturn = document.activeElement;
    ui.modalOnClose = onClose;
    const el = root();
    ui.setHtml(el, `<div class="modal-back" data-act="modal-close"></div><div class="modal${wide ? ' modal--wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title">${html}</div>`);
    el.hidden = false;
    document.body.classList.add('has-modal');
    ui.focusModal();
  };
  ui.focusModal = () => {
    const el = root().querySelector('[data-autofocus]') || root().querySelector('.modal input:not([disabled]), .modal button:not(.icon-btn):not([disabled]), .modal a');
    el?.focus();
  };
  ui.renderModal = html => { const m = root().querySelector('.modal'); if (m) { ui.setHtml(m, html); ui.focusModal(); } };
  ui.closeModal = silent => {
    const el = root();
    if (el.hidden) return;
    const done = ui.modalOnClose; ui.modalOnClose = null;
    el.replaceChildren(); el.hidden = true;
    document.body.classList.remove('has-modal');
    if (done) done();
    if (!silent && modalReturn && document.contains(modalReturn)) modalReturn.focus();
  };
  /* Keep Tab inside the dialog. */
  ui.trapTab = e => {
    const f = [...root().querySelectorAll('.modal a[href], .modal button:not([disabled]), .modal input:not([disabled]), .modal select, .modal textarea, .modal [tabindex="0"]')].filter(x => x.offsetParent !== null);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  };

  /* ---------------------------------------------------------------- page building blocks */
  ui.pageHead = (title, sub, actions = '') => `<header class="page-head"><div><h1 tabindex="-1">${esc(title)}</h1><p>${esc(sub)}</p></div>${actions ? `<div class="btn-row">${actions}</div>` : ''}</header>`;
  ui.chips = (act, current, items, label) => `<div class="chips-filter" role="group" aria-label="${esc(label)}">${items.map(([k, l, c]) => `<button type="button" data-act="${act}" data-v="${esc(k)}" aria-pressed="${current === k}">${esc(l)}${c !== undefined ? `<span>${c}</span>` : ''}</button>`).join('')}</div>`;
  ui.stepsList = steps => {
    let k = 0;
    return `<ol class="steps">${steps.map(s => `<li class="${s.or ? 'is-or' : ''}"><span class="sn" aria-hidden="true">${s.or ? 'or' : ++k}</span><div class="sbody"><p>${Fleet.u.md(s.t)}</p>${s.cmd ? Fleet.u.cmdBlock(s.cmd) : ''}</div></li>`).join('')}</ol>`;
  };
  ui.timeline = events => {
    if (!events.length) return `<div class="empty-mini">${ic('activity')}<p>Nothing to show here.</p></div>`;
    const days = [];
    for (const e of events) {
      const k = Fleet.u.dayKey(e.at);
      let d = days[days.length - 1];
      if (!d || d.k !== k) days.push(d = { k, label: Fleet.u.dayLabel(e.at), items: [] });
      d.items.push(e);
    }
    return days.map(d => `<div class="tl-day"><h3>${esc(d.label)}</h3><ol class="tl">${d.items.map(e => `<li class="tl-item"><span class="tl-dot">${glyph(e.level, e.kind)}</span><div class="tl-card"><div class="tl-top"><b>${esc(e.title)}</b><time datetime="${esc(e.at)}">${Fleet.u.fmtTime(e.at)}</time></div>${e.sub ? `<p class="tl-sub">${esc(e.sub)}</p>` : ''}${e.text ? `<p class="tl-text">${esc(e.text)}</p>` : ''}</div></li>`).join('')}</ol></div>`).join('');
  };
})();
