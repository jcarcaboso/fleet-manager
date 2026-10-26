'use strict';
/* Fleet dashboard: check-in charts. Data comes from GET nodes/{node}/checkins, which returns polls
   received per UTC hour, oldest first. Charts are inline SVG using presentation attributes and CSS classes only. */
(function () {
  const Fleet = window.Fleet = window.Fleet || {};
  const u = Fleet.u;
  const charts = Fleet.charts = { data: new Map() };
  const HOUR = u.HOUR;

  const barPath = (x, y, w, h, r) => {
    r = Math.min(r, w / 2, h);
    return `M${x.toFixed(2)},${(y + h).toFixed(2)}V${(y + r).toFixed(2)}Q${x.toFixed(2)},${y.toFixed(2)} ${(x + r).toFixed(2)},${y.toFixed(2)}H${(x + w - r).toFixed(2)}Q${(x + w).toFixed(2)},${y.toFixed(2)} ${(x + w).toFixed(2)},${(y + r).toFixed(2)}V${(y + h).toFixed(2)}Z`;
  };
  const niceMax = v => { if (v <= 5) return 5; const step = v <= 20 ? 5 : v <= 60 ? 10 : v <= 200 ? 20 : 50; return Math.ceil(v / step) * step; };
  const total = buckets => u.sum(buckets.map(b => b.polls));

  /* Zero-poll runs of two or more hours. Quiet time before the first poll is not a gap. */
  charts.gaps = buckets => {
    const out = [];
    const first = buckets.findIndex(b => b.polls > 0);
    if (first === -1) return buckets.length ? [{ from: buckets[0].hour, to: u.ms(buckets[buckets.length - 1].hour) + HOUR, open: true, hours: buckets.length, none: true }] : [];
    let start = null;
    for (let i = first; i < buckets.length; i++) {
      if (buckets[i].polls === 0) { if (start === null) start = i; }
      else if (start !== null) { if (i - start >= 2) out.push({ from: buckets[start].hour, to: u.ms(buckets[i].hour), open: false, hours: i - start }); start = null; }
    }
    if (start !== null && buckets.length - start >= 2) out.push({ from: buckets[start].hour, to: u.ms(buckets[buckets.length - 1].hour) + HOUR, open: true, hours: buckets.length - start });
    return out;
  };

  const label = (key, buckets, hours) => {
    const g = charts.gaps(buckets);
    const span = hours > 24 ? `the last ${Math.round(hours / 24)} days` : `the last ${hours} hours`;
    return `Check-ins in ${span}: ${u.num(total(buckets))}. ${g.length ? g.map(x => x.none ? 'No check-ins in this window' : x.open ? `none since ${u.fmtTime(x.from)} UTC` : `none from ${u.fmtTime(x.from)} to ${u.fmtTime(new Date(x.to).toISOString())} UTC`).join('; ') : 'No gaps.'}`;
  };
  charts.tip = (key, i) => {
    const d = charts.data.get(key); if (!d) return '';
    const b = d.buckets[i]; if (!b) return '';
    const start = u.ms(b.hour), end = new Date(start + HOUR).toISOString();
    const day = d.buckets.length > 30 ? `${u.fmtDay(b.hour)}, ` : '';
    return `${b.polls ? u.plural(b.polls, 'check-in') : 'No check-ins'}|${day}${u.fmtTime(b.hour)}–${u.fmtTime(end)} UTC`;
  };

  /* Small strip for gallery cards. */
  charts.strip = (key, buckets) => {
    charts.data.set(key, { buckets, kind: 'strip' });
    const n = buckets.length || 1, pitch = 240 / n, bw = Math.max(1.5, pitch - 2);
    const max = Math.max(1, ...buckets.map(b => b.polls));
    const bars = buckets.map((b, i) => {
      const x = i * pitch + 1;
      if (b.polls > 0) { const h = Math.max(3, b.polls / max * 20); return `<path data-i="${i}" class="sb" d="${barPath(x, 22 - h, bw, h, 1.4)}"/>`; }
      return `<rect data-i="${i}" class="sb0" x="${x.toFixed(2)}" y="20.4" width="${bw.toFixed(2)}" height="1.6" rx=".8"/>`;
    }).join('');
    return `<svg class="strip z" viewBox="0 0 240 24" data-strip="${u.esc(key)}" role="img" aria-label="${u.esc(label(key, buckets, buckets.length))}">${bars}<line class="base" x1="0" x2="240" y1="22.5" y2="22.5"/></svg>`;
  };

  /* Full chart for the Node page. */
  const CH = { W: 720, H: 152, L: 40, R: 10, T: 12, B: 122 };
  charts.chart = (key, buckets) => {
    charts.data.set(key, { buckets, kind: 'chart' });
    const n = buckets.length || 1, slot = (CH.W - CH.L - CH.R) / n, bw = Math.max(1.2, Math.min(24, slot - (slot > 8 ? 3 : 1)));
    const max = niceMax(Math.max(0, ...buckets.map(b => b.polls)));
    const y = v => CH.B - (v / max) * (CH.B - CH.T);
    let g = '';
    for (const v of [0, max / 2, max]) g += `<line class="${v ? 'gl' : 'axis'}" x1="${CH.L}" x2="${CH.W - CH.R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="tick" x="${CH.L - 8}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end">${Math.round(v)}</text>`;
    /* X ticks: every 6 h for a day, every day boundary for a week. */
    const ticks = [];
    buckets.forEach((b, i) => {
      const h = new Date(u.ms(b.hour)).getUTCHours();
      if (n <= 36 ? h % 6 === 0 : h === 0) ticks.push([i, n <= 36 ? u.fmtTime(b.hour) : u.fmtDay(b.hour)]);
    });
    for (const [i, text] of ticks) {
      const x = CH.L + (i + 0.5) * slot;
      if (x < CH.L + 14 || x > CH.W - CH.R - 44) continue;
      g += `<text class="tick" x="${x.toFixed(1)}" y="${CH.B + 20}" text-anchor="middle">${u.esc(text)}</text>`;
    }
    g += `<text class="tick" x="${CH.W - CH.R}" y="${CH.B + 20}" text-anchor="end">Now</text>`;
    const bars = buckets.map((b, i) => {
      const x = CH.L + i * slot + (slot - bw) / 2;
      return b.polls > 0 ? `<path data-i="${i}" class="cb" d="${barPath(x, y(b.polls), bw, CH.B - y(b.polls), Math.min(3, bw / 2))}"/>`
        : `<rect data-i="${i}" class="cb0" x="${x.toFixed(2)}" y="${CH.B - 2}" width="${bw.toFixed(2)}" height="2" rx="1"/>`;
    }).join('');
    return `<svg class="chart" viewBox="0 0 ${CH.W} ${CH.H}" data-chart="${u.esc(key)}" tabindex="0" role="img" aria-label="${u.esc(label(key, buckets, buckets.length))} Use the arrow keys to read each hour.">${g}${bars}<line class="xh" x1="0" x2="0" y1="${CH.T}" y2="${CH.B}" visibility="hidden"/><rect class="hit" x="${CH.L}" y="${CH.T}" width="${CH.W - CH.L - CH.R}" height="${CH.B - CH.T}"/></svg>`;
  };

  charts.gapList = (buckets, { revoked = false } = {}) => {
    const gl = charts.gaps(buckets);
    if (!buckets.length) return '';
    if (!gl.length) return '<p class="gaps-none">No gaps longer than an hour.</p>';
    return `<ul class="gaps">${gl.map(g => {
      const from = g.from, to = new Date(g.to).toISOString();
      const text = g.none ? (revoked ? 'No check-ins in this window. This machine is revoked.' : 'No check-ins in this window.')
        : g.open ? `No check-ins since ${u.fmtTime(from)} UTC (${u.span(g.hours * HOUR)} so far).`
          : `No check-ins ${u.fmtTime(from)}–${u.fmtTime(to)} UTC (${g.hours} h), ${u.fmtDay(from)}.`;
      return `<li>${u.glyph(g.open ? 'serious' : 'pending', g.open ? 'moon' : 'clock')}<span>${u.esc(text)}</span></li>`;
    }).join('')}</ul>`;
  };
  charts.total = total;

  /* ---------------------------------------------------------------- interaction */
  const clearMarks = svg => svg.querySelectorAll('.on').forEach(e => e.classList.remove('on'));
  const stripAt = (svg, i) => {
    const d = charts.data.get(svg.dataset.strip); if (!d) return;
    clearMarks(svg);
    svg.querySelector(`[data-i="${i}"]`)?.classList.add('on');
    const r = svg.getBoundingClientRect(), pitch = 240 / d.buckets.length;
    Fleet.ui.showTip(charts.tip(svg.dataset.strip, i), r.left + (i * pitch + pitch / 2) / 240 * r.width, r.top);
  };
  const chartAt = (svg, i) => {
    const key = svg.dataset.chart, d = charts.data.get(key); if (!d) return;
    const n = d.buckets.length, slot = (CH.W - CH.L - CH.R) / n;
    i = Math.max(0, Math.min(n - 1, i));
    svg.dataset.cur = i;
    clearMarks(svg);
    svg.querySelector(`[data-i="${i}"]`)?.classList.add('on');
    const cx = CH.L + (i + 0.5) * slot;
    const xh = svg.querySelector('.xh'); xh.setAttribute('x1', cx); xh.setAttribute('x2', cx); xh.setAttribute('visibility', 'visible');
    const r = svg.getBoundingClientRect();
    const max = niceMax(Math.max(0, ...d.buckets.map(b => b.polls)));
    const top = CH.B - (d.buckets[i].polls / max) * (CH.B - CH.T);
    Fleet.ui.showTip(charts.tip(key, i), r.left + cx / CH.W * r.width, r.top + top / CH.H * r.height);
  };
  const chartOff = svg => { clearMarks(svg); svg.querySelector('.xh')?.setAttribute('visibility', 'hidden'); Fleet.ui.hideTip(); };

  charts.bind = () => {
    document.addEventListener('pointermove', e => {
      const s = e.target.closest?.('svg[data-strip]');
      if (s) { const d = charts.data.get(s.dataset.strip); if (!d) return; const r = s.getBoundingClientRect(); stripAt(s, Math.max(0, Math.min(d.buckets.length - 1, Math.floor((e.clientX - r.left) / r.width * d.buckets.length)))); return; }
      const c = e.target.closest?.('svg[data-chart]');
      if (c) { const d = charts.data.get(c.dataset.chart); if (!d) return; const r = c.getBoundingClientRect(); const slot = (CH.W - CH.L - CH.R) / d.buckets.length; chartAt(c, Math.floor(((e.clientX - r.left) / r.width * CH.W - CH.L) / slot)); }
    });
    document.addEventListener('pointerleave', e => {
      const t = e.target;
      if (t instanceof Element && t.matches('svg[data-strip]')) { clearMarks(t); Fleet.ui.hideTip(); }
      if (t instanceof Element && t.matches('svg[data-chart]')) chartOff(t);
    }, true);
    document.addEventListener('keydown', e => {
      const svg = e.target.closest?.('svg[data-chart]');
      if (!svg || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      const d = charts.data.get(svg.dataset.chart); if (!d) return;
      e.preventDefault();
      const last = d.buckets.length - 1;
      let i = svg.dataset.cur === undefined ? last : +svg.dataset.cur;
      i = e.key === 'Home' ? 0 : e.key === 'End' ? last : i + (e.key === 'ArrowLeft' ? -1 : 1);
      chartAt(svg, i);
    });
    document.addEventListener('focusin', e => {
      const svg = e.target.closest?.('svg[data-chart]');
      if (svg) { const d = charts.data.get(svg.dataset.chart); if (d) chartAt(svg, svg.dataset.cur === undefined ? d.buckets.length - 1 : +svg.dataset.cur); }
    });
    document.addEventListener('focusout', e => { const svg = e.target.closest?.('svg[data-chart]'); if (svg) chartOff(svg); });
  };
})();
