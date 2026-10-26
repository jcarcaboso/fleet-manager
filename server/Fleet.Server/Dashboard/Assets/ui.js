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
  /* Phase 2 attempt detail. src is { diagnostic, path, step }; t is the Target (for its base) when known.
     Every server string goes through esc(); the diagnostic is shown in a pre, so it keeps its line breaks. */
  ui.NO_DETAIL = 'No detail reported. Agents before 0.9.0 send only the error code.';
  ui.failureDetail = (src, t) => {
    const d = src?.diagnostic, path = src?.path ? Fleet.u.failPath(t, src.path) : '', step = src?.step;
    if (!d && !path && !step) return `<p class="fdetail-none">${esc(ui.NO_DETAIL)}</p>`;
    return `<div class="fdetail">
      ${step || path ? `<div class="fdetail-meta">${Fleet.u.stepChip(step)}${path ? `<span class="fdetail-path"><span class="fdetail-k">Failing path</span><code>${esc(path)}</code>${Fleet.u.copyBtn(path, '', 'Copy failing path')}</span>` : ''}</div>` : ''}
      ${d ? `<div class="fdetail-diag"><p class="kv-label">Diagnostic from the Agent</p><pre class="code code--diag">${esc(d)}</pre>${Fleet.u.copyBtn(d, 'Copy', 'Copy diagnostic')}</div>` : ''}
    </div>`;
  };
  /* One line of diagnostic. Short single-line text is plain; anything else is a details element that opens to the full text
     (the closed state is cut to one line by CSS). key keeps it open across repaints. */
  ui.diagLine = (text, key, cls = '') => {
    if (!text) return '';
    if (text.length <= 90 && !text.includes('\n')) return `<p class="diag-line diag-line--short ${cls}">${esc(text)}</p>`;
    const k = 'diag:' + key;
    return `<details class="diag-line ${cls}" data-open-key="${esc(k)}" ${Fleet.openState.get(k) ? 'open' : ''}><summary><span class="diag-text">${esc(text)}</span>${ic('chevD', 'sumchev')}</summary></details>`;
  };
  /* A collapsed list of file paths (drift events). Paths come from the Agent and are shown as text only. */
  ui.fileList = (files, key) => {
    const k = 'files:' + key;
    return `<details class="tl-files" data-open-key="${esc(k)}" ${Fleet.openState.get(k) ? 'open' : ''}><summary>${ic('file')}<span>${esc(Fleet.u.plural(files.length, 'file'))}</span>${ic('chevD', 'sumchev')}</summary><ul class="tl-filelist">${files.map(f => `<li><code>${esc(f)}</code></li>`).join('')}</ul></details>`;
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
    return days.map(d => `<div class="tl-day"><h3>${esc(d.label)}</h3><ol class="tl">${d.items.map(e => `<li class="tl-item"><span class="tl-dot">${glyph(e.level, e.kind)}</span><div class="tl-card"><div class="tl-top"><b>${esc(e.title)}</b><time datetime="${esc(e.at)}">${Fleet.u.fmtTime(e.at)}</time></div>${e.sub || e.step ? `<p class="tl-sub">${e.sub ? `<span>${esc(e.sub)}</span>` : ''}${Fleet.u.stepChip(e.step)}</p>` : ''}${e.text ? ui.diagLine(e.text, e.key || e.at + e.title, 'tl-text') : ''}${e.files?.length ? ui.fileList(e.files, e.key || e.at + e.title) : ''}</div></li>`).join('')}</ol></div>`).join('');
  };

  /* ---------------------------------------------------------------- phase 4: what changed, issue state */
  /* Skills added (+), changed (~) and removed (−) as chips, and the Target counts. d is a model.revisionDetail. The sign is part of the chip, so colour is never the only signal. */
  ui.changeChips = d => {
    const chip = (cls, sign, label, name) => `<span class="chg chg--${cls}"><span class="chg-s" aria-label="${label}">${sign}</span>${esc(name)}</span>`;
    const chips = [...d.skills.added.map(x => chip('add', '+', 'added', x)), ...d.skills.changed.map(x => chip('mod', '~', 'changed', x)), ...d.skills.removed.map(x => chip('rm', '−', 'removed', x))];
    const t = d.targets, any = t.added + t.changed + t.removed > 0;
    return `<div class="changes-block">${chips.length ? `<div class="changes">${chips.join('')}</div>` : '<p class="muted small">No Skill changes.</p>'}
      <p class="chg-targets small">${any ? `<span class="muted">Targets:</span> <b>${Fleet.u.num(t.added)}</b> added · <b>${Fleet.u.num(t.changed)}</b> changed · <b>${Fleet.u.num(t.removed)}</b> removed, on ${Fleet.u.plural(t.nodes, 'machine')}` : '<span class="muted">No Target changes.</span>'}</p></div>`;
  };
  /* The line under a problem that is acknowledged or snoozed: who did it, and until when. */
  ui.issueBanner = i => {
    const st = Fleet.model.issueState(i), u = Fleet.u;
    if (st.key === 'open') return '';
    const who = st.by ? ` by <b>${esc(st.by)}</b>` : '', when = st.at ? `, ${esc(u.rel(st.at))}` : '';
    return st.key === 'snoozed'
      ? `<p class="prob-state prob-state--snoozed">${ic('snooze')}<span>Snoozed${who}${when}. Back in Open ${st.until ? `at <b>${esc(u.fmtFull(st.until))} UTC</b> (${esc(u.until(st.until))})` : 'later'}. It stays listed here until then.</span></p>`
      : `<p class="prob-state prob-state--ack">${ic('ack')}<span>Acknowledged${who}${when}. It stays listed here and comes back to Open if it starts over.</span></p>`;
  };
  /* Acknowledge and Snooze for an open problem, Reopen for the others. Gated by the operate scope. busy disables them while the request runs. */
  ui.issueActions = (i, busy) => {
    const st = Fleet.model.issueState(i).key, id = esc(i.id), off = busy ? 'disabled' : '';
    if (!Fleet.api.can('operate')) {
      return st === 'open' ? ui.locked('operate', 'btn-sm btn-secondary', `${ic('ack')}Acknowledge`) + ui.locked('operate', 'btn-sm btn-secondary', `${ic('snooze')}Snooze`)
        : ui.locked('operate', 'btn-sm btn-secondary', `${ic('retry')}Reopen`);
    }
    if (st !== 'open') return `<button type="button" class="btn btn-sm btn-secondary" data-act="issue-state" data-op="reopen" data-id="${id}" ${off}>${ic('retry')}Reopen</button>`;
    return `<button type="button" class="btn btn-sm btn-secondary" data-act="issue-state" data-op="acknowledge" data-id="${id}" ${off}>${ic('ack')}Acknowledge</button>
      <span class="snooze" role="group" aria-label="Snooze this problem"><span class="snooze-l">${ic('snooze')}Snooze</span>${Fleet.model.SNOOZE.map(([h, label, long]) =>
        `<button type="button" class="btn btn-sm btn-ghost" data-act="issue-state" data-op="snooze" data-hours="${h}" data-id="${id}" aria-label="Snooze for ${long}" ${off}>${label}</button>`).join('')}</span>`;
  };
})();
