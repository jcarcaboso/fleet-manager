'use strict';
/* Fleet dashboard: shared helpers (escaping, time formatting, icons, status glyphs).
   Classic script. Every dashboard file attaches to window.Fleet so no module loader is needed. */
(function () {
  const Fleet = window.Fleet = window.Fleet || {};
  const u = Fleet.u = {};

  /* ---------------------------------------------------------------- escaping and small helpers */
  u.esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  u.enc = encodeURIComponent;
  /* Thrown by a view after an await when a newer load has started. app.js ignores silent errors, so the stale result is dropped. */
  Fleet.superseded = () => Object.assign(new Error('Superseded by a newer request'), { silent: true });
  u.$ = (selector, root = document) => root.querySelector(selector);
  u.$$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  u.num = n => Number(n).toLocaleString('en-US');
  u.plural = (n, one, many) => `${u.num(n)} ${n === 1 ? one : (many || one + 's')}`;
  u.sum = list => list.reduce((a, b) => a + b, 0);
  u.slug = s => String(s).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  u.listText = arr => arr.length <= 1 ? (arr[0] || '') : arr.length === 2 ? `${arr[0]} and ${arr[1]}` : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`;
  /* Backticks mark code in catalog text. Everything is escaped first, so only <code> is ever produced. */
  u.md = s => u.esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
  u.shortSha = s => String(s || '').slice(0, 7);
  u.shortId = s => String(s || '').slice(0, 8);
  u.hostOf = url => String(url || '').replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  u.isUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s));
  u.platformLabel = p => ({ macos: 'macOS', linux: 'Linux' }[p] || (p ? String(p) : 'Unknown platform'));
  u.cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  u.byTimeDesc = key => (a, b) => (Date.parse(b[key]) || 0) - (Date.parse(a[key]) || 0);
  u.initial = name => (String(name || '?').trim()[0] || '?').toUpperCase();
  u.hash = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
  u.avatarClass = name => 'av-c' + (u.hash(name) % 8);

  /* ---------------------------------------------------------------- time */
  const SEC = 1e3, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;
  u.SEC = SEC; u.MIN = MIN; u.HOUR = HOUR; u.DAY = DAY;
  u.now = () => Date.now();
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const pad = n => String(n).padStart(2, '0');
  u.pad = pad;
  u.ms = iso => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };
  u.valid = iso => u.ms(iso) !== null;
  u.span = (d, precise) => {
    d = Math.max(0, d);
    const s = Math.round(d / SEC);
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60), mm = m % 60;
    if (h < 24) return mm && (precise || h < 6) ? `${h} h ${mm} min` : `${h} h`;
    const dd = Math.floor(h / 24), hh = h % 24;
    if (dd < 7) return hh ? `${dd} d ${hh} h` : `${dd} d`;
    return `${dd} days`;
  };
  u.fmtTime = iso => { const t = u.ms(iso); if (t === null) return '—'; const d = new Date(t); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  u.fmtDay = iso => { const t = u.ms(iso); if (t === null) return '—'; const d = new Date(t); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };
  u.fmtFull = iso => u.ms(iso) === null ? '—' : `${u.fmtDay(iso)}, ${u.fmtTime(iso)}`;
  u.fmtYearFull = iso => u.ms(iso) === null ? '—' : `${u.fmtDay(iso)} ${new Date(u.ms(iso)).getUTCFullYear()}, ${u.fmtTime(iso)}`;
  u.rel = iso => {
    const t = u.ms(iso);
    if (t === null) return 'never';
    const d = u.now() - t;
    if (d < 10 * SEC) return 'just now';
    if (d > 60 * DAY) return 'on ' + u.fmtDay(iso);
    return u.span(d) + ' ago';
  };
  u.until = iso => { const t = u.ms(iso); return t === null ? '—' : t <= u.now() ? 'now' : 'in ' + u.span(t - u.now()); };
  u.dayKey = iso => new Date(u.ms(iso)).toISOString().slice(0, 10);
  u.dayLabel = iso => {
    const k = u.dayKey(iso);
    if (k === new Date(u.now()).toISOString().slice(0, 10)) return 'Today';
    if (k === new Date(u.now() - DAY).toISOString().slice(0, 10)) return 'Yesterday';
    const d = new Date(u.ms(iso));
    return `${WDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  };
  u.clock = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };

  /* ---------------------------------------------------------------- icons */
  const P = {
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    sync: '<path d="M20 11a8 8 0 0 0-14.6-4.4L4 8.5"/><path d="M4 3.5v5h5"/><path d="M4 13a8 8 0 0 0 14.6 4.4l1.4-1.9"/><path d="M20 20.5v-5h-5"/>',
    chevR: '<path d="M9 6l6 6-6 6"/>', chevL: '<path d="M15 6l-6 6 6 6"/>', chevD: '<path d="M6 9l6 6 6-6"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9l3 3-3 3M13 15h4"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>',
    shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    alert: '<path d="M10.3 4.2L2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    commit: '<circle cx="12" cy="12" r="3.5"/><path d="M3 12h5.5M15.5 12H21"/>',
    branch: '<circle cx="6" cy="5.5" r="2.5"/><circle cx="6" cy="18.5" r="2.5"/><circle cx="18" cy="7.5" r="2.5"/><path d="M6 8v8M18 10c0 4-5 4.5-10.5 7"/>',
    layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
    link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
    pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
    ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
    activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
    arrowR: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    rocket: '<path d="M12 15l-3-3c1.5-5 5-8.5 11-9-0.5 6-4 9.5-8 12z"/><path d="M9 12H5l2.5-3.5H11M12 15v4l3.5-2.5V13"/><path d="M6.5 16.5c-1.5.5-2.5 2-2.5 3.5 1.5 0 3-1 3.5-2.5"/>',
    retry: '<path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5"/><path d="M4 3.5v5h5"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    grid: '<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/>',
    logout: '<path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3"/><path d="M16 8l4 4-4 4M20 12H9"/>',
    apple: '<path d="M15.5 3.5c-1 .1-2.2.8-2.8 1.7-.6.7-1 1.8-.9 2.8 1.1 0 2.2-.7 2.8-1.6.6-.8 1-1.9.9-2.9z"/><path d="M12 8.5c-1 0-2.3-.8-3.5-.8C6.3 7.7 4.5 9.6 4.5 12.6c0 3.6 2.6 7.9 4.6 7.9 1 0 1.6-.6 2.9-.6s1.8.6 2.9.6c2.1 0 4.1-4 4.6-5.5-2.4-1-2.9-4.9-.3-6.3-1-1.3-2.4-1.9-3.7-1.9-1.4 0-2.4.7-3.5.7z"/>',
    tux: '<path d="M12 3c-2.3 0-3.5 1.9-3.5 4.4 0 1.6-.6 2.8-1.7 4.4-1.3 1.9-2.3 3.9-2 6 .2 1.2 1.6 1.9 3.2 2.2h8c1.6-.3 3-1 3.2-2.2.3-2.1-.7-4.1-2-6-1.1-1.6-1.7-2.8-1.7-4.4C15.5 4.9 14.3 3 12 3z"/><path d="M10.5 8h.01M13.5 8h.01M11 10.2c.6.4 1.4.4 2 0"/>',
  };
  u.ic = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${P[name] || ''}</svg>`;

  /* Status glyph: a filled shape carries the colour, the inner mark carries the meaning, so colour is never the only signal. */
  const SC = { good: '#0ca30c', info: '#3577e6', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b', neutral: '#9a958c', pending: '#a9a397' };
  const DEFAULT_KIND = { good: 'check', info: 'sync', warning: 'bang', serious: 'moon', critical: 'bang', neutral: 'minus', pending: 'clock' };
  u.glyph = (level, kind, cls = '') => {
    const color = SC[level] || SC.neutral;
    const k = kind || DEFAULT_KIND[level] || 'minus';
    const fg = level === 'warning' ? '#3d2c00' : level === 'pending' ? '#6f695f' : '#fff';
    const shape = level === 'warning'
      ? `<path d="M8 1.3l7 12.6a1.2 1.2 0 0 1-1.05 1.8H2.05A1.2 1.2 0 0 1 1 13.9z" fill="${color}"/>`
      : level === 'pending'
        ? '<circle cx="8" cy="8" r="6.6" fill="#fff" stroke="#a9a397" stroke-width="1.5"/>'
        : `<circle cx="8" cy="8" r="7.5" fill="${color}"/>`;
    const marks = {
      check: '<path d="M4.7 8.3l2.2 2.2 4.5-4.6"/>',
      x: '<path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8"/>',
      bang: level === 'warning' ? '<path d="M8 6.2v3.9M8 12.4v.1"/>' : '<path d="M8 4.4v4.5M8 11.4v.1"/>',
      info: '<path d="M8 7.4v4.2M8 4.8v.1"/>',
      moon: `<path d="M10.9 9.7A3.7 3.7 0 0 1 6.3 5.1a3.7 3.7 0 1 0 4.6 4.6z" fill="${fg}" stroke="none"/>`,
      clock: '<path d="M8 4.9v3.3l2.1 1.3"/>',
      sync: '<path d="M4.9 7a3.2 3.2 0 0 1 5.8-1.2M11.1 9a3.2 3.2 0 0 1-5.8 1.2"/><path d="M10.9 3.9v2.1H8.8M5.1 12.1V10h2.1"/>',
      minus: '<path d="M5 8h6"/>',
      down: '<path d="M8 4.3v5.6M5.8 7.8L8 10l2.2-2.2M5 12h6"/>',
      ban: '<path d="M5.3 10.7l5.4-5.4"/><circle cx="8" cy="8" r="3.8"/>',
    };
    return `<svg class="g ${cls}" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${shape}<g fill="none" stroke="${fg}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${marks[k] || ''}</g></svg>`;
  };
  u.pill = (level, kind, label, cls = '') => `<span class="pill t-${level} ${cls}">${u.glyph(level, kind)}<span>${u.esc(label)}</span></span>`;

  /* ---------------------------------------------------------------- Targets */
  const CLIENT = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };
  const CLIENT_SHORT = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };
  const cap = s => String(s || '').replace(/^./, c => c.toUpperCase());
  u.clientName = c => CLIENT[c] || cap(c) || 'AI client';
  u.clientShort = c => CLIENT_SHORT[c] || cap(c) || 'AI client';
  u.targetKind = name => String(name).includes('/') ? String(name).split('/')[0] : 'skills';
  u.targetClient = t => { if (t.aiClient?.client) return t.aiClient.client; const part = String(t.name).includes('/') ? String(t.name).split('/')[1] : null; return part && !part.includes('.') ? part : null; };
  /* t is a Target from GET nodes/{node} ({name, file, aiClient}) or {name} alone. */
  u.targetLabel = t => {
    const kind = u.targetKind(t.name), client = u.targetClient(t);
    if (kind === 'skills') return 'Skills';
    if (kind === 'agent-file') return t.file?.name ? (client ? `${t.file.name} for ${u.clientName(client)}` : t.file.name) : `${client ? u.clientName(client) : 'AI client'} agent file`;
    if (kind === 'ai-client') return `${u.clientName(client)} connection`;
    return String(t.name);
  };
  u.targetShort = t => {
    const kind = u.targetKind(t.name), client = u.targetClient(t);
    if (kind === 'skills') return 'Skills';
    if (kind === 'agent-file') return t.file?.name || `${client ? u.clientShort(client) : 'Agent'} file`;
    if (kind === 'ai-client') return u.clientShort(client);
    return String(t.name);
  };
  u.targetIcon = t => ({ skills: 'layers', 'agent-file': 'file', 'ai-client': 'spark' }[u.targetKind(t.name)] || 'file');
  u.targetWhere = t => {
    if (t.path === undefined || t.path === null) return '';
    return !t.base || t.base === 'home' ? `~/${t.path}` : `${t.base}:${t.path}`;
  };

  /* Assignment states from the API (snake_case) mapped to display. */
  const TSTATE = {
    succeeded: { level: 'good', kind: 'check', label: 'In sync' },
    applying: { level: 'info', kind: 'sync', label: 'Applying' },
    pending: { level: 'pending', kind: 'clock', label: 'Waiting' },
    failed: { level: 'critical', kind: 'x', label: 'Failed' },
    superseded: { level: 'neutral', kind: 'minus', label: 'Superseded' },
  };
  u.tstate = s => TSTATE[s] || { level: 'neutral', kind: 'minus', label: s ? cap(String(s).replace(/_/g, ' ')) : 'Unknown' };
  u.stateTag = s => { const m = u.tstate(s); return `<span class="stag">${u.glyph(m.level, m.kind)}<span>${u.esc(m.label)}</span></span>`; };
  /* Attempt states use the same set, but read as events. */
  u.attemptVerb = s => ({ failed: 'failed', applying: 'is applying', succeeded: 'applied', superseded: 'was superseded by a newer revision', pending: 'is queued' }[s] || String(s));
  u.STATES = [
    { key: 'succeeded', label: 'Succeeded', level: 'good', kind: 'check' },
    { key: 'applying', label: 'Applying', level: 'info', kind: 'sync' },
    { key: 'pending', label: 'Pending', level: 'pending', kind: 'clock' },
    { key: 'failed', label: 'Failed', level: 'critical', kind: 'x' },
    { key: 'superseded', label: 'Superseded', level: 'neutral', kind: 'minus' },
  ];
  u.emptyCounts = () => ({ pending: 0, applying: 0, succeeded: 0, failed: 0, superseded: 0 });
  u.addCounts = (a, b) => { for (const k of Object.keys(a)) a[k] += Number(b?.[k]) || 0; return a; };
  u.countTotal = c => u.sum(Object.values(c || {}).map(Number));

  /* Segmented bar and legend. Widths are applied from data-grow after insertion (the CSP forbids style attributes). */
  u.segbar = (parts, label, cls = '') => {
    const shown = parts.filter(p => p.value > 0);
    return `<div class="segbar ${cls}" role="img" aria-label="${u.esc(label + ': ' + (shown.length ? shown.map(p => `${p.value} ${p.label}`).join(', ') : 'none'))}">${shown.map(p => `<span class="seg s-${p.level}" data-grow="${p.value}" data-tip="${u.esc(`${p.value} ${p.unit || ''}|${p.label}${p.tip ? '\n' + p.tip : ''}`)}"></span>`).join('')}</div>`;
  };
  u.legend = (parts, act) => `<ul class="legend">${parts.map(p => `<li>${act && p.value ? `<button type="button" class="lg-btn" data-act="${act}" data-v="${u.esc(p.key)}">` : '<span class="lg-item">'}${u.glyph(p.level, p.kind)}<span>${u.esc(p.label)}</span><b>${u.num(p.value)}</b>${act && p.value ? '</button>' : '</span>'}</li>`).join('')}</ul>`;
  u.stateParts = (counts, unit) => u.STATES.map(s => ({ ...s, value: Number(counts?.[s.key]) || 0, unit: unit || ((Number(counts?.[s.key]) || 0) === 1 ? 'assignment' : 'assignments') }));

  /* Revision chip: full SHA in the tooltip. */
  u.revChip = (sha, tip) => sha
    ? `<span class="rev"${tip ? ` data-tip="${u.esc(tip)}"` : ''}>${u.ic('commit')}${u.esc(u.shortSha(sha))}</span>`
    : '<span class="muted">Nothing yet</span>';
  u.digestShort = d => { const h = String(d || '').replace(/^sha256:/, ''); return h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h; };
  u.copyBtn = (text, label, aria) => `<button type="button" class="copy copy--icon" data-act="copy" data-copy="${u.esc(text)}" aria-label="${u.esc(aria || 'Copy to clipboard')}">${u.ic('copy')}${label ? `<span>${u.esc(label)}</span>` : ''}</button>`;
  u.cmdBlock = (cmd, label = 'Copy', cls = '') => `<div class="cmd ${cls}"><pre><code>${u.esc(cmd)}</code></pre><button type="button" class="copy" data-act="copy" data-copy="${u.esc(cmd)}" aria-label="Copy to clipboard">${u.ic('copy')}<span>${u.esc(label)}</span></button></div>`;
  u.avatar = (name, cls = '') => `<span class="av ${u.avatarClass(name)} ${cls}" aria-hidden="true">${u.esc(u.initial(name))}</span>`;
})();
