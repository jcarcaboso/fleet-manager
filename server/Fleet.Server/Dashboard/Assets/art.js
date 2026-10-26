'use strict';
/* Fleet dashboard: machine illustrations for the gallery.
   The Server reports only a Node's platform, so there is one illustration per platform (a laptop for macOS,
   a desktop for Linux). The art never claims a model, hostname or operating system version. */
(function () {
  const Fleet = window.Fleet = window.Fleet || {};
  const { esc } = Fleet.u;

  /* Shared gradient definitions, inserted once into the page shell. */
  Fleet.art = {
    defs: `<svg class="defs" width="0" height="0" aria-hidden="true" focusable="false"><defs>
      <radialGradient id="gShadow"><stop offset="0" stop-color="#3b2f1e" stop-opacity=".30"/><stop offset="1" stop-color="#3b2f1e" stop-opacity="0"/></radialGradient>
      <linearGradient id="gAlu" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbfbfc"/><stop offset="1" stop-color="#d6d8dd"/></linearGradient>
      <linearGradient id="gAluB" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e3e4e8"/><stop offset="1" stop-color="#a7aab2"/></linearGradient>
      <linearGradient id="gDark" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4b4f57"/><stop offset="1" stop-color="#23252a"/></linearGradient>
      <linearGradient id="wpMac" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1e2d6b"/><stop offset=".55" stop-color="#5b4fd0"/><stop offset="1" stop-color="#ef9fc3"/></linearGradient>
      <linearGradient id="wpLinux" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1f3766"/><stop offset=".6" stop-color="#3c6eb4"/><stop offset="1" stop-color="#93b9ec"/></linearGradient>
      <linearGradient id="wpOther" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b4350"/><stop offset="1" stop-color="#8d97a8"/></linearGradient>
      <linearGradient id="wpOff" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2c2e35"/><stop offset="1" stop-color="#15161a"/></linearGradient>
      <linearGradient id="gLogo" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffb168"/><stop offset="1" stop-color="#ff6f7d"/></linearGradient>
    </defs></svg>`,
  };

  /* Device state from the Node record alone. */
  const devState = n => n.revoked ? 'off' : n.freshness === 'never_contacted' ? 'ghost' : n.freshness === 'stale' ? 'sleep' : 'on';
  Fleet.art.state = devState;

  Fleet.art.device = (n, health, cls = '') => {
    const st = devState(n);
    const wp = st === 'on' ? `url(#${n.platform === 'macos' ? 'wpMac' : n.platform === 'linux' ? 'wpLinux' : 'wpOther'})` : 'url(#wpOff)';
    const led = st === 'on' ? (health?.level === 'critical' ? '#ff6b5b' : health?.level === 'info' ? '#7fb2ff' : '#5be37d') : st === 'sleep' ? '#f6c25b' : '#5d6168';
    const ui = st === 'on';
    const zz = (x, y) => st === 'sleep' ? `<g class="zz" fill="#c9cdd6" font-family="system-ui,sans-serif" font-weight="700"><text x="${x}" y="${y}" font-size="13">z</text><text x="${x + 9}" y="${y - 9}" font-size="9">z</text></g>` : '';
    const shadow = (cx, cy, rx, ry) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#gShadow)"/>`;
    let body;
    if (n.platform === 'linux') {
      body = shadow(104, 140, 92, 5) +
        '<path d="M78 103h18l4 29H74z" fill="url(#gAluB)"/><rect x="61" y="130" width="52" height="6" rx="3" fill="url(#gAlu)"/>' +
        '<rect x="12" y="8" width="150" height="96" rx="6" fill="#16171b"/>' +
        `<rect x="16" y="12" width="142" height="86" rx="2" fill="${wp}"/>` +
        (ui ? '<rect x="16" y="12" width="142" height="4.5" fill="#000" opacity=".38"/><rect x="34" y="28" width="71" height="43" rx="2" fill="#fff" opacity=".14"/><rect x="80" y="40" width="60" height="39" rx="2" fill="#fff" opacity=".1"/>' : '') +
        zz(132, 40) + '<path d="M16 12h70l-30 86H16z" fill="#fff" opacity=".05"/>' +
        '<rect x="170" y="44" width="38" height="94" rx="5" fill="url(#gDark)"/>' +
        `<circle cx="189" cy="57" r="3.2" fill="none" stroke="${led}" stroke-width="1.6"/>` +
        Array.from({ length: 6 }, (_, i) => `<rect x="178" y="${72 + i * 9}" width="22" height="2" rx="1" fill="#000" opacity=".28"/>`).join('');
    } else {
      body = shadow(110, 132, 96, 6) +
        '<rect x="37" y="10" width="146" height="104" rx="9" fill="url(#gAlu)"/>' +
        '<rect x="39.5" y="12.5" width="141" height="99" rx="7" fill="#0f1013"/>' +
        `<rect x="44" y="17" width="132" height="89" rx="2.5" fill="${wp}"/>` +
        (ui ? '<rect x="44" y="17" width="132" height="3.5" fill="#fff" opacity=".28"/><rect x="88" y="98" width="44" height="5" rx="2.5" fill="#fff" opacity=".38"/><rect x="58" y="31" width="55" height="37" rx="2.5" fill="#fff" opacity=".16"/>' : '') +
        '<path d="M44 17h66l-36 89H44z" fill="#fff" opacity=".06"/>' + zz(150, 46) +
        '<path d="M16 114h188v3.6a5.4 5.4 0 0 1-5.4 5.4H21.4a5.4 5.4 0 0 1-5.4-5.4z" fill="url(#gAluB)"/>' +
        '<rect x="16" y="112.6" width="188" height="3.2" rx="1.6" fill="url(#gAlu)"/>' +
        '<path d="M93 113h34v1.4a2 2 0 0 1-2 2H95a2 2 0 0 1-2-2z" fill="#000" opacity=".16"/>';
    }
    const label = `${Fleet.u.platformLabel(n.platform)} machine${st === 'sleep' ? ', not checking in' : st === 'ghost' ? ', has not checked in yet' : st === 'off' ? ', revoked' : ''}`;
    return `<svg class="dev dev--${st} ${cls}" viewBox="0 0 220 150" role="img" aria-label="${esc(label)}">${body}</svg>`;
  };
})();
