'use strict';
/* Development driver: scripted clicks against the real dashboard code running over the fixture.
   Usage: harness.html?drive=<scenario>#/route . It writes PASS/FAIL lines into <pre id="drive-log"> and leaves the UI
   in the scenario's final state so it can be screenshotted. Not embedded and not served by the Server. */
(function () {
  const scenario = new URLSearchParams(location.search).get('drive');
  if (!scenario) return;
  const log = document.createElement('pre');
  log.id = 'drive-log'; log.setAttribute('aria-hidden', 'true');
  log.style.cssText = 'position:fixed;left:0;bottom:0;margin:0;font:11px monospace;background:#fff;color:#000;z-index:999;max-width:100vw;white-space:pre-wrap';
  /* Headless Chrome under --virtual-time-budget produces no frames after load, so IntersectionObserver stops reporting after the
     first layout. ?iostub=1 swaps in a polling stand-in that reports the same way (entry.isIntersecting, rootMargin ignored), so scrolling can be driven. */
  if (new URLSearchParams(location.search).has('iostub')) {
    window.IntersectionObserver = class {
      constructor(cb) { this.cb = cb; this.targets = new Map(); this.timer = setInterval(() => this.poll(), 100); }
      observe(el) { this.targets.set(el, null); }
      unobserve(el) { this.targets.delete(el); }
      disconnect() { this.targets.clear(); }
      poll() {
        const entries = [];
        for (const [el, was] of this.targets) {
          const r = el.getBoundingClientRect(), now = r.bottom > 0 && r.top < innerHeight && r.width > 0;
          if (now !== was) { this.targets.set(el, now); entries.push({ target: el, isIntersecting: now }); }
        }
        if (entries.length) this.cb(entries, this);
      }
    };
  }
  const out = (ok, msg) => { log.textContent += `${ok ? 'PASS' : 'FAIL'} ${msg}\n`; };
  window.addEventListener('error', e => out(false, 'uncaught: ' + e.message));
  window.addEventListener('unhandledrejection', e => out(false, 'unhandled rejection: ' + (e.reason && e.reason.message || e.reason)));
  const origErr = console.error; console.error = (...a) => { out(false, 'console.error: ' + a.join(' ')); origErr(...a); };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, label, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await wait(30); } out(false, 'timeout: ' + label); return null; };
  const $ = s => document.querySelector(s);
  const click = el => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); };
  const type = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
  const submit = f => f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  const expect = (cond, msg) => out(!!cond, msg);

  /* Opens the wizard, creates a link for the alias and starts waiting for the machine (step 3). */
  async function wizardStep3(alias) {
    await until(() => $('[data-act=add]'), 'add button'); click($('[data-act=add]'));
    await until(() => $('#wz-alias'), 'wizard step 1'); type($('#wz-alias'), alias); submit($('form[data-form=wz]'));
    await until(() => $('.wz-link'), 'wizard step 2'); click($('[data-act=wz-wait]'));
    await until(() => $('.wz-3'), 'step 3');
  }
  /* Submit a link for one alias, close the dialog, open another wizard before the POST answers, and check that the answer is dropped. */
  async function staleCreate(failing) {
    await until(() => $('[data-act=add]'), 'add button'); click($('[data-act=add]'));
    await until(() => $('#wz-alias'), 'wizard step 1'); type($('#wz-alias'), 'old-alias'); submit($('form[data-form=wz]'));
    await wait(300);
    click($('[data-act=modal-close]'));
    await until(() => !$('.modal'), 'dialog closed');
    click($('[data-act=add]'));
    await until(() => $('#wz-alias'), 'second wizard'); type($('#wz-alias'), 'new-alias');
    await wait(3600);
    expect($('#wz-alias') && !$('.wz-link'), 'the late answer for the closed wizard does not turn the new wizard into step 2');
    expect($('#wz-alias')?.value === 'new-alias', 'the new wizard keeps what the user typed');
    expect(!$('#wz-alias-msg')?.classList.contains('is-err') && !/scope does not allow/.test($('.modal')?.textContent || ''), 'the late error of the closed wizard is not shown in the new wizard');
    expect(!/Enrollment link created/.test($('#toasts').textContent), 'no "link created" toast for the discarded wizard');
    expect(!document.body.textContent.includes('old-alias'), 'nothing of the old alias is on the page');
    submit($('form[data-form=wz]'));
    if (failing) {
      await until(() => $('#wz-alias-msg')?.classList.contains('is-err'), 'its own error', 6000);
      expect(/scope does not allow/.test($('#wz-alias-msg')?.textContent || ''), 'the new wizard still reports its own failure');
    } else {
      await until(() => $('.wz-link'), 'its own link', 6000);
      expect(/new-alias/.test($('.wz-link-top')?.textContent || '') && !/old-alias/.test($('.modal').textContent), 'the new wizard shows its own link, for its own alias');
    }
  }

  /* Phase 3 helpers. */
  const $$ = s => [...document.querySelectorAll(s)];
  const cardOf = alias => $$('.card').find(c => c.querySelector('h3')?.textContent === alias);
  const names = () => $$('.card h3').map(h => h.textContent);
  const secTitles = () => $$('.gsec h2').map(h => { const c = h.cloneNode(true); c.querySelectorAll('.cnt,.gsec-ic').forEach(x => x.remove()); return c.textContent.trim() + ':' + h.querySelector('.cnt').textContent; });
  const kv = label => { const d = $$('#machine-panel dt').find(x => x.textContent === label); return d ? d.nextElementSibling.textContent.trim() : null; };

  const S = {
    async login() {
      await until(() => $('#operator-token'), 'login form');
      type($('#operator-token'), 'bad'); submit($('form[data-form=login]'));
      await until(() => /not accepted/.test($('#login-msg')?.textContent || ''), 'bad token message');
      expect(/not accepted/.test($('#login-msg').textContent), 'bad token shows error');
      type($('#operator-token'), 'a-valid-operator-token-0123456789abcdef'); submit($('form[data-form=login]'));
      await until(() => $('.health') || $('.empty'), 'gallery after login');
      expect($('#nav a[aria-current=page]')?.textContent.startsWith('Machines'), 'signed in lands on Machines');
      expect(!document.cookie && !localStorage.length && !sessionStorage.length, 'no token in storage');
    },
    async logout() {
      await until(() => $('[data-act=logout]'), 'logout button'); click($('[data-act=logout]'));
      await until(() => $('#operator-token'), 'login after logout');
      expect(/Signed out/.test($('#login-msg').textContent), 'sign out returns to login');
    },
    async retry() {
      await until(() => $('.prob'), 'problem card');
      const btn = $('[data-act=retry]'); expect(btn, 'retry button present'); click(btn);
      await until(() => !$('[data-act=retry]') || /Retry requested|pending/i.test(document.body.textContent), 'retry result');
      await wait(300);
      expect(/Retry requested/.test($('#toasts').textContent), 'retry toast shown');
      expect(!document.querySelector('[data-act=retry]'), 'Target no longer failed after retry');
    },
    async revoke() {
      await until(() => $('[data-act=revoke-node]'), 'revoke button'); click($('[data-act=revoke-node]'));
      await until(() => $('.modal'), 'revoke modal');
      expect($('#modal-title').textContent.includes('Revoke access'), 'revoke confirmation dialog opens');
      expect(document.activeElement && document.activeElement.closest('.modal'), 'focus moves into dialog');
    },
    async revokeConfirm() {
      await S.revoke(); click($('[data-act=confirm-revoke]'));
      await until(() => /revoked/i.test($('#toasts').textContent), 'revoked toast');
      await until(() => $('.nhero--retired'), 'retired hero');
      expect($('.nhero--retired'), 'machine shows as Retired after revoke');
    },
    async remove() {
      await until(() => $('[data-act=remove-node]'), 'remove button'); click($('[data-act=remove-node]'));
      await until(() => $('#rm-confirm'), 'remove modal');
      expect($('#rm-go').disabled, 'remove disabled until alias typed');
      type($('#rm-confirm'), 'studio-mi'); expect($('#rm-go').disabled, 'partial alias keeps remove disabled');
      type($('#rm-confirm'), 'studio-mini'); expect(!$('#rm-go').disabled, 'exact alias enables remove');
    },
    async removeConfirm() {
      await S.remove(); click($('#rm-go'));
      await until(() => location.hash === '#/nodes', 'back to gallery');
      await until(() => $('.health'), 'gallery');
      expect(!/studio-mini/.test($('#view').textContent), 'removed machine is gone from the gallery');
    },
    async rename() {
      await until(() => $('#rename-alias'), 'rename input');
      type($('#rename-alias'), 'studio-renamed'); submit($('form[data-form=rename]'));
      await until(() => /studio-renamed/.test(location.hash), 'route follows new alias');
      await until(() => $('#rename-msg') && /Renamed from/.test($('#rename-msg').textContent), 'rename message', 4000);
      expect(/Renamed from studio-mini/.test($('#rename-msg')?.textContent || ''), 'rename success message');
    },
    async wizard() {
      await until(() => $('[data-act=add]'), 'add button'); click($('[data-act=add]'));
      await until(() => $('#wz-alias'), 'wizard step 1');
      submit($('form[data-form=wz]'));
      expect(/nonblank/.test($('#wz-alias-msg').textContent), 'blank alias rejected inline');
      type($('#wz-alias'), 'office-mini'); submit($('form[data-form=wz]'));
      await until(() => $('.wz-link'), 'wizard step 2 with link');
      const link = $('.cmd--link code').textContent;
      expect(/\/enroll#fleet-v1=/.test(link), 'one-time link is shown');
      click($('[data-act=wz-wait]'));
      await until(() => $('.wz-3'), 'wizard step 3');
      await until(() => $('.wz-checks li.done:nth-child(2)'), 'link consumed detected', 9000);
      await until(() => /is online/.test($('#modal-title')?.textContent || ''), 'first check-in detected', 12000);
      expect(/is online/.test($('#modal-title')?.textContent || ''), 'wizard detects first check-in');
      click($('[data-act=modal-close]') || $('.icon-btn'));
      await wait(100);
      expect(!document.body.textContent.includes('fleet-v1='), 'link cleared from the page after the dialog closes');
    },
    async wizardStep2() {
      await until(() => $('[data-act=add]'), 'add button'); click($('[data-act=add]'));
      await until(() => $('#wz-alias'), 'step 1'); type($('#wz-alias'), 'office-mini'); submit($('form[data-form=wz]'));
      await until(() => $('.wz-link'), 'step 2');
    },
    async wizardStep3() { await S.wizardStep2(); click($('[data-act=wz-wait]')); await until(() => $('.wz-3'), 'step 3'); },
    async revokeLink() {
      await until(() => $('[data-act=revoke-link]'), 'revoke link'); click($('[data-act=revoke-link]'));
      await until(() => /revoked/i.test($('#toasts').textContent), 'link revoked toast');
      await wait(300); expect($('.link-row--revoked'), 'link now shows revoked');
    },
    async scopeRead() {
      await until(() => $('.is-locked') || $('.health'), 'page');
      const locked = [...document.querySelectorAll('.is-locked')];
      expect(locked.length > 0, 'locked controls rendered for read scope');
      expect(locked.every(b => b.getAttribute('aria-disabled') === 'true' && b.dataset.tip), 'locked controls explain why (tooltip) and are aria-disabled');
      click(locked[0]); await wait(100);
      expect(/Needs the/.test($('#toasts').textContent), 'clicking a locked control explains');
    },
    async models() {
      await until(() => $('[data-sel-model]'), 'model checkboxes');
      const box = [...document.querySelectorAll('[data-sel-model]')].find(b => !b.checked);
      box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(50);
      expect(!$('[data-act=sel-save]').disabled, 'save enabled after change');
      click($('[data-act=sel-save]'));
      await until(() => /Selection saved/.test($('#toasts').textContent), 'saved toast');
      expect(/Selection saved/.test($('#sel-msg').textContent), 'selection saved message');
    },
    async sync() { await until(() => $('[data-act=sync]'), 'sync'); click($('[data-act=sync]')); await until(() => /up to date/i.test($('#toasts').textContent), 'sync result'); await wait(600); },
    async range() { await until(() => $('[data-act=range]'), 'range'); click([...document.querySelectorAll('[data-act=range]')].find(b => b.dataset.v === '24')); await until(() => document.querySelector('[data-chart]')?.dataset.chart.endsWith(':24'), '24h chart'); },
    async search() { await until(() => $('#q'), 'search'); type($('#q'), 'linux'); await wait(100); expect(!/design-imac/.test($('#gallery-body').textContent), 'search filters machines'); type($('#q'), 'zzzz'); await wait(50); expect(/No machines match/.test($('#gallery-body').textContent), 'empty search state'); },
    async tooltip() { await until(() => $('[data-tip]'), 'tip target'); },
    async scan() {
      await wait(1500);
      const view = $('#view'); const text = view.textContent;
      const bad = text.match(/undefined|\bnull\b|NaN|Invalid Date|\[object/g);
      expect(!bad, 'no stray undefined/null/NaN/Invalid Date text' + (bad ? ' (' + [...new Set(bad)].join(',') + ')' : ''));
      const hrefs = [...view.querySelectorAll('[href],[data-v],[data-id]')].filter(e => /undefined|null/.test((e.getAttribute('href') || '') + (e.dataset.v || '') + (e.dataset.id || '')));
      expect(!hrefs.length, 'no undefined in links/data attributes');
      expect(view.querySelector('h1'), 'page has an h1');
      const over = document.documentElement.scrollWidth - innerWidth;
      expect(over <= 1, `no horizontal page overflow at ${innerWidth}px` + (over > 1 ? ` (${over}px wider)` : ''));
      out(true, 'text length ' + text.length);
    },
    async expire() {
      await until(() => $('.health'), 'gallery');
      window.__FIXTURE.state.signedIn = false;
      click(document.querySelector('[data-act=sync]'));
      await until(() => $('#operator-token'), 'login after 401');
      expect(/session ended/i.test($('#login-msg').textContent), 'a 401 sends you to login with a notice');
    },
    async forbid() {
      await until(() => $('[data-act=retry]'), 'retry'); click($('[data-act=retry]'));
      await until(() => /cannot do that|scope/i.test($('#toasts').textContent), '403 toast');
      expect(/scope|cannot do that/i.test($('#toasts').textContent), '403 insufficient_scope shows a clear message');
    },
    /* ---- Overlapping loads (finding 1). Use ?delay=design-imac:2500 and start at #/nodes/design-imac. */
    async raceNode() {
      const F = window.__FIXTURE, target = F.nodes.find(n => n.alias === 'studio-mini');
      await wait(250);
      location.hash = '#/nodes/studio-mini/problems';
      await until(() => $('.nhero h1')?.textContent === 'studio-mini', 'studio-mini page');
      await wait(3500); // the delayed design-imac response arrives now
      expect($('.nhero h1')?.textContent === 'studio-mini', 'late response for the first machine does not change the page');
      expect([...document.querySelectorAll('.tabs a')].every(a => a.getAttribute('href').startsWith('#/nodes/studio-mini/')), 'tabs still point at studio-mini');
      click($('[data-act=retry]'));
      await until(() => F.calls.some(c => c.method === 'POST' && /\/retry$/.test(c.path)), 'retry request');
      const post = F.calls.filter(c => c.method === 'POST' && /\/retry$/.test(c.path)).pop();
      expect(post.path === `nodes/${target.id}/retry`, 'Retry targets studio-mini, not the machine whose response arrived last (' + post.path + ')');
      await until(() => /Retry requested/.test($('#toasts').textContent), 'retry toast');
      expect(/studio-mini/.test($('#toasts').textContent), 'retry toast names studio-mini');
      click($('[data-act=revoke-node]'));
      await until(() => $('.modal'), 'revoke dialog');
      expect(/studio-mini/.test($('#modal-title').textContent), 'revoke dialog names studio-mini');
    },
    /* Same, but the user returns to the first machine while the second is still loading. */
    async raceBack() {
      const F = window.__FIXTURE;
      await wait(250);
      location.hash = '#/nodes/studio-mini';
      await wait(100);
      location.hash = '#/nodes/design-imac/settings';
      await until(() => $('.nhero h1')?.textContent === 'design-imac', 'design-imac page', 6000);
      await wait(1500);
      expect($('.nhero h1')?.textContent === 'design-imac', 'the machine opened last stays on screen');
      expect($('#rename-alias')?.value === 'design-imac', 'settings form belongs to design-imac');
    },
    /* ---- Add-machine wizard polling (finding 5). Start with ?enroll=0&expiry=8&pagesize=1 */
    async wizardExpiry() {
      const F = window.__FIXTURE;
      await until(() => $('[data-act=add]'), 'add button'); click($('[data-act=add]'));
      await until(() => $('#wz-alias'), 'wizard step 1'); type($('#wz-alias'), 'office-mini'); submit($('form[data-form=wz]'));
      await until(() => $('.wz-link'), 'wizard step 2');
      click($('[data-act=wz-wait]'));
      await until(() => $('.wz-3'), 'step 3');
      await wait(6000);
      const id = F.links[0].id;
      const byId = () => F.calls.filter(c => c.path === 'enrollment-links/' + id).length;
      expect(byId() >= 1, 'wizard asks for its own link by ID (' + byId() + ' requests)');
      expect(!F.calls.some(c => c.path === 'enrollment-links' && c.method === 'GET' && c.at > F.calls.find(x => x.path === 'enrollment-links/' + id).at - 1), 'wizard does not scan the link list');
      await until(() => /expired before/.test($('.wz-wait')?.textContent || ''), 'expired state', 9000);
      expect(/expired before/.test($('.wz-wait').textContent), 'wizard shows the expired state at the link expiry');
      expect($('[data-act=wz-new]'), 'expired state offers a new link');
      const n = byId(); await wait(12000);
      expect(byId() === n, 'polling stopped after expiry (' + n + ' requests, ' + byId() + ' after waiting)');
    },
    async wizardClose() {
      const F = window.__FIXTURE;
      await until(() => $('[data-act=add]'), 'add button'); click($('[data-act=add]'));
      await until(() => $('#wz-alias'), 'wizard step 1'); type($('#wz-alias'), 'office-mini'); submit($('form[data-form=wz]'));
      await until(() => $('.wz-link'), 'wizard step 2'); click($('[data-act=wz-wait]'));
      await until(() => F.calls.some(c => /^enrollment-links\/[^/]+$/.test(c.path)), 'first poll', 6000);
      click($('[data-act=modal-close]') || $('.icon-btn'));
      await wait(100);
      const polls = () => F.calls.filter(c => /^enrollment-links\/[^/]+$/.test(c.path)).length, n = polls();
      await wait(12000);
      expect(polls() === n, 'no polling after the wizard closes (' + n + ' before, ' + polls() + ' after)');
    },
    async wizardRoute() {
      const F = window.__FIXTURE;
      await until(() => $('[data-act=add]'), 'add button'); click($('[data-act=add]'));
      await until(() => $('#wz-alias'), 'wizard step 1'); type($('#wz-alias'), 'office-mini'); submit($('form[data-form=wz]'));
      await until(() => $('.wz-link'), 'wizard step 2'); click($('[data-act=wz-wait]'));
      await until(() => F.calls.some(c => /^enrollment-links\/[^/]+$/.test(c.path)), 'first poll', 6000);
      location.hash = '#/audit';
      await until(() => !$('.modal') && $('h1')?.textContent === 'Audit', 'audit page');
      const polls = () => F.calls.filter(c => /^enrollment-links\/[^/]+$/.test(c.path)).length, n = polls();
      await wait(12000);
      expect(polls() === n, 'no polling after leaving the page (' + n + ' before, ' + polls() + ' after)');
    },
    async wizardStalled() {
      const F = window.__FIXTURE;
      await until(() => $('[data-act=add]'), 'add button'); click($('[data-act=add]'));
      await until(() => $('#wz-alias'), 'wizard step 1'); type($('#wz-alias'), 'office-mini'); submit($('form[data-form=wz]'));
      await until(() => $('.wz-link'), 'wizard step 2'); click($('[data-act=wz-wait]'));
      await until(() => $('[data-act=wz-recheck]'), 'stalled state', 700000);
      expect(/has not checked in yet/.test($('.wz-wait').textContent), 'wizard gives up waiting for a machine that never checks in');
      const polls = () => F.calls.filter(c => /^enrollment-links\/[^/]+$/.test(c.path) || c.path.startsWith('nodes/')).length, n = polls();
      await wait(20000);
      expect(polls() === n, 'polling stops when it gives up (' + n + ' requests)');
    },
    async wizardDone() {
      const F = window.__FIXTURE;
      await S.wizard();
      const polls = () => F.calls.filter(c => /^enrollment-links\/[^/]+$/.test(c.path) || (c.path.startsWith('nodes/office-mini'))).length, n = polls();
      await wait(10000);
      expect(polls() === n, 'polling stopped once the Node was found');
    },
    /* ---- Gallery strips (findings 3 and 4). Use harness.html at 1440x900. */
    async strips() {
      const F = window.__FIXTURE;
      await until(() => $('.health'), 'gallery');
      await wait(1500);
      const strip = () => F.calls.filter(c => /\/checkins$/.test(c.path));
      const live = F.nodes.filter(n => !n.revokedAt).length, shownIds = () => [...document.querySelectorAll('[data-strip-slot]')].map(e => e.dataset.stripSlot);
      expect(strip().length > 0 && strip().length < live, `only cards near the viewport load strips (${strip().length} of ${live})`);
      const inView = [...document.querySelectorAll('[data-strip-slot]')].filter(e => e.getBoundingClientRect().top < innerHeight + 200).map(e => e.dataset.stripSlot);
      expect(strip().every(c => inView.some(id => c.path === `nodes/${id}/checkins`)), 'every fetched strip belongs to a card that is on screen');
      expect(document.querySelectorAll('svg.strip').length === strip().length, 'each fetched strip is drawn');
      const before = strip().length;
      type($('#q'), 'zzzz'); await wait(600);
      expect(strip().length === before, 'searching for nothing fetches nothing');
      type($('#q'), 'linux'); await wait(900);
      const names = F.nodes.filter(n => n.platform === 'linux' && !n.revokedAt).map(n => `nodes/${n.id}/checkins`);
      expect(names.filter(p => strip().some(c => c.path === p)).length > 0, 'cards found by search load their strips');
      expect(strip().every(c => { const id = c.path.split('/')[1]; return strip().filter(x => x.path === c.path).length === 1; }), 'no strip is requested twice while cached');
    },
    async stripsScroll() {
      const F = window.__FIXTURE;
      await until(() => $('.health'), 'gallery'); await wait(1000);
      const strip = () => F.calls.filter(c => /\/checkins$/.test(c.path));
      const live = F.nodes.filter(n => !n.revokedAt).length, first = strip().length;
      expect(first > 0 && first < live, `only cards near the viewport load strips (${first} of ${live})`);
      type($('#q'), 'zzzz'); await wait(300); type($('#q'), ''); await wait(600);
      expect(strip().length === first, 'a search that removes and restores cards does not refetch cached strips');
      const stepsBefore = strip().length;
      for (let y = 0; y <= document.documentElement.scrollHeight; y += innerHeight / 2) { window.scrollTo(0, y); await wait(400); }
      window.scrollTo(0, document.documentElement.scrollHeight); await wait(1500);
      expect(strip().length > stepsBefore, 'cards that were never on screen have not loaded until scrolled to');
      expect(new Set(strip().map(c => c.path)).size === live, `scrolling to the end loads the rest (${new Set(strip().map(c => c.path)).size} of ${live})`);
      expect(document.querySelectorAll('svg.strip').length === live, 'every card draws its strip');
      expect(strip().length === live, 'each strip was requested once');
      window.scrollTo(0, 0);
      const total = strip().length;
      location.hash = '#/audit'; await until(() => $('h1')?.textContent === 'Audit', 'audit'); location.hash = '#/nodes'; await until(() => $('.health'), 'gallery again');
      await wait(1500);
      expect(strip().length > total, `returning to the gallery fetches strips again (${total} -> ${strip().length})`);
    },
    async stripsDrop() {
      const F = window.__FIXTURE;
      await until(() => $('.health'), 'gallery', 8000); await wait(300);
      const seen = () => F.calls.filter(c => /\/checkins$/.test(c.path)).length;
      expect(seen() === 4, `at most 4 strip requests run at once (${seen()})`);
      type($('#q'), 'zzzz'); await wait(6000);
      expect(seen() === 4, `queued requests for cards removed by search are dropped (${seen()} requests in total)`);
    },
    async stripsDebug() {
      await until(() => $('.health'), 'gallery'); await wait(1000);
      window.scrollTo(0, document.documentElement.scrollHeight); await wait(1500);
      let frames = 0; const tick = () => { frames++; requestAnimationFrame(tick); }; requestAnimationFrame(tick); await wait(1500);
      out(true, `frames=${frames} scrollY=${scrollY} height=${document.documentElement.scrollHeight} inner=${innerHeight} slots=${document.querySelectorAll('[data-strip-slot]').length} inview=${[...document.querySelectorAll('[data-strip-slot]')].filter(e => { const r = e.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; }).length} calls=${window.__FIXTURE.calls.filter(c => /checkins/.test(c.path)).length}`);
    },
    async stripsRetry() {
      const F = window.__FIXTURE;
      await until(() => $('.health'), 'gallery'); await wait(1500);
      expect(document.querySelectorAll('.strip-slot .muted').length > 0 && /Unavailable/.test($('#gallery-body').textContent), 'failed strips show Unavailable');
      F.cfg.fail = null; await wait(11000);
      type($('#q'), 'a'); await wait(200); type($('#q'), ''); await wait(1500);
      expect(document.querySelectorAll('svg.strip').length > 0, 'failed strips are retried and drawn once the Server answers');
    },
    /* ---- Newest first (finding 2). Use ?pagesize=2 */
    async deployments() {
      const F = window.__FIXTURE;
      await until(() => $('.dep-hero'), 'deployments');
      const newest = window.FLEET.revisions[0].shortSha;
      expect($('.dep-title').textContent.includes(newest), 'hero shows the newest revision ' + newest);
      expect(F.calls.filter(c => c.path === 'desired-revisions').every(c => c.query.order === 'newest') && F.calls.some(c => c.path === 'desired-revisions'), 'desired-revisions is requested with order=newest');
      expect(F.calls.filter(c => c.path === 'rollouts').every(c => c.query.order === 'newest') && F.calls.some(c => c.path === 'rollouts'), 'rollouts is requested with order=newest');
      expect(document.querySelectorAll('.hist-item').length === 2, 'only the first page of revisions is shown');
      click($('[data-act=more-revisions]'));
      await until(() => document.querySelectorAll('.hist-item').length === 4, 'next page');
      const shas = [...document.querySelectorAll('.hist-item')].map(e => e.id.replace('rev-', ''));
      const expected = window.FLEET.revisions.slice(0, 4).map(r => r.shortSha);
      expect(shas.join() === expected.join(), 'revisions are newest first across pages (' + shas.join(' ') + ')');
      expect(document.querySelectorAll('.hist-item .hist-bar .segbar').length >= 3, 'rollouts match their revisions by desiredRevisionId');
      expect(!/not shown|first.*only/i.test($('.dep-hero').parentElement.textContent), 'no truncation notice for revisions');
    },
    async audit() {
      const F = window.__FIXTURE;
      await until(() => $('#audit-body tr'), 'audit rows');
      expect(F.calls.filter(c => c.path === 'audit').every(c => c.query.order === 'newest'), 'audit is requested with order=newest');
      const times = () => [...document.querySelectorAll('#audit-body time, #audit-body .when')].length;
      expect(document.querySelectorAll('#audit-body tr').length === 3, 'first page only (3 events)');
      click($('[data-act=more-audit]'));
      await until(() => document.querySelectorAll('#audit-body tr').length === 6, 'second page');
      const first = F.calls.filter(c => c.path === 'audit')[0];
      expect(first.query.limit === '50', 'asks for one screenful');
    },
    async weirdAlias() {
      const F = window.__FIXTURE;
      await until(() => $('.nhero h1'), 'machine page');
      expect($('.nhero h1').textContent === 'rack/A 100%', 'alias with slash and percent opens the machine');
      const first = F.calls.find(c => /^nodes\/[^/]+$/.test(c.path));
      expect(first.path === 'nodes/rack%2FA%20100%25', 'alias is sent as one percent-encoded segment (' + first.path + ')');
      expect(/^#\/nodes\/rack%2FA%20100%25\//.test($('.tabs a').getAttribute('href')), 'tab links keep the encoding');
    },
    /* ================= Review round 2: completions that outlive the screen, wizard deadlines, strip cancellation, fixture contract ================= */
    /* ---- Add-machine wizard deadlines. Start with ?enroll=0&expiry=8&fail=enrollment-links/ (or &hang=enrollment-links/) */
    async wizardFailReads() {
      const F = window.__FIXTURE;
      await wizardStep3('office-mini');
      await until(() => /expired before/.test($('.wz-wait')?.textContent || ''), 'expired state while every link read fails', 16000);
      expect(/expired before/.test($('.wz-wait')?.textContent || ''), 'the wizard shows the expired state at the link expiry although every link read fails');
      expect($('[data-act=wz-new]'), 'expired state offers a new link');
      expect(F.calls.some(c => /^enrollment-links\/[^/]+$/.test(c.path)), 'the link reads were attempted');
      const polls = () => F.calls.filter(c => /^enrollment-links\/[^/]+$/.test(c.path)).length, n = polls();
      await wait(10000);
      expect(polls() === n, `polling stopped after expiry (${n} requests, ${polls()} later)`);
    },
    async wizardHang() {
      const F = window.__FIXTURE;
      await wizardStep3('office-mini');
      await until(() => /expired before/.test($('.wz-wait')?.textContent || ''), 'expired state while a link read hangs', 20000);
      expect(/expired before/.test($('.wz-wait')?.textContent || ''), 'a link read that never answers does not keep the wizard from showing the expired state');
      const reads = F.calls.filter(c => /^enrollment-links\/[^/]+$/.test(c.path));
      expect(reads.length > 0 && reads.every(c => c.aborted), `every hung read was cancelled by its timeout (${reads.length} reads)`);
    },
    /* ?enroll=link&fail=nodes/ with a virtual time budget of about 15 minutes. The Node reads fail, so only the clock can end the wait. */
    async wizardStalledFail() {
      const F = window.__FIXTURE;
      await wizardStep3('office-mini');
      await until(() => $('[data-act=wz-recheck]'), 'stalled state while every Node read fails', 700000);
      expect(/has not checked in yet/.test($('.wz-wait')?.textContent || ''), 'the wizard stops waiting after the limit although every Node read fails');
      const polls = () => F.calls.filter(c => /^enrollment-links\/[^/]+$/.test(c.path) || c.path.startsWith('nodes/')).length, n = polls();
      await wait(20000);
      expect(polls() === n, `polling stops when it gives up (${n} requests)`);
    },
    /* ---- Link creation that answers after the wizard was closed and another opened. Start with ?enroll=0&lag=enrollment-links:3000 (+ &forbid=1 for the error case) */
    async wizardStaleCreate() { await staleCreate(false); },
    async wizardStaleCreateError() { await staleCreate(true); },
    /* ---- Mutations that answer after the user left. Start at #/nodes/studio-mini/settings with ?lag=<kind>:3000 */
    async renameStale() {
      await until(() => $('#rename-alias'), 'rename input');
      type($('#rename-alias'), 'studio-renamed'); submit($('form[data-form=rename]'));
      await wait(300);
      location.hash = '#/audit';
      await until(() => $('h1')?.textContent === 'Audit' && !$('.skel'), 'audit page');
      await wait(3600);
      expect(location.hash === '#/audit', 'a rename that answers later does not pull the user back to the machine (' + location.hash + ')');
      expect($('h1')?.textContent === 'Audit', 'the user is still on Audit');
      expect(/studio-renamed/.test($('#toasts').textContent), 'a toast says the machine was renamed');
      location.hash = '#/nodes/studio-renamed';
      await until(() => $('.nhero h1')?.textContent === 'studio-renamed', 'renamed machine opens (no stale cache)');
      expect($('.nhero h1')?.textContent === 'studio-renamed', 'the machine is found under its new alias afterwards');
    },
    async renameTab() {
      await until(() => $('#rename-alias'), 'rename input');
      type($('#rename-alias'), 'studio-renamed'); submit($('form[data-form=rename]'));
      await wait(300);
      location.hash = '#/nodes/studio-mini/overview';
      await until(() => $('.tabs a[aria-current]')?.textContent.startsWith('Overview'), 'overview tab');
      await until(() => /studio-renamed/.test(location.hash), 'rename follows the user to the new alias', 5000);
      expect(/^#\/nodes\/studio-renamed\//.test(location.hash), 'switching tabs on the same machine does not stop the rename from following (' + location.hash + ')');
      await until(() => $('.nhero h1')?.textContent === 'studio-renamed', 'renamed machine');
    },
    async removeStale() {
      const F = window.__FIXTURE;
      await until(() => $('[data-act=remove-node]'), 'remove button'); click($('[data-act=remove-node]'));
      await until(() => $('#rm-confirm'), 'remove modal');
      type($('#rm-confirm'), 'studio-mini'); click($('#rm-go'));
      await wait(300);
      location.hash = '#/audit';
      await until(() => $('h1')?.textContent === 'Audit' && !$('.skel'), 'audit page');
      await wait(3600);
      expect(location.hash === '#/audit', 'a removal that answers later does not send the user to the machine list (' + location.hash + ')');
      expect(/removed/.test($('#toasts').textContent), 'a toast says the machine was removed');
      expect(!F.nodes.some(n => n.alias === 'studio-mini'), 'the machine is gone on the Server');
      location.hash = '#/nodes';
      await until(() => $('.health'), 'gallery');
      expect(!/studio-mini/.test($('#view').textContent), 'the list no longer shows the removed machine');
    },
    async removeKeep() {
      await until(() => $('[data-act=remove-node]'), 'remove button'); click($('[data-act=remove-node]'));
      await until(() => $('#rm-confirm'), 'remove modal');
      type($('#rm-confirm'), 'studio-mini'); click($('#rm-go'));
      await wait(300);
      location.hash = '#/nodes/studio-mini/activity';
      await until(() => $('.tabs a[aria-current]')?.textContent.startsWith('Activity'), 'activity tab');
      await until(() => location.hash === '#/nodes', 'removal from the page it was started on goes to the list', 6000);
      expect(location.hash === '#/nodes', 'a removal started on this machine still returns to the list after a tab change');
    },
    async revokeStale() {
      await until(() => $('[data-act=revoke-node]'), 'revoke button'); click($('[data-act=revoke-node]'));
      await until(() => $('[data-act=confirm-revoke]'), 'revoke modal'); click($('[data-act=confirm-revoke]'));
      await wait(300);
      location.hash = '#/nodes';
      await until(() => $('.health'), 'gallery');
      click($('[data-act=add]'));
      await until(() => $('#wz-alias'), 'wizard');
      await wait(3600);
      expect($('#wz-alias'), 'a revoke that answers later does not close the dialog the user opened since');
      expect(/revoked/.test($('#toasts').textContent), 'a toast says the machine was revoked');
    },
    async modelsStale() {
      await until(() => $('[data-sel-model]'), 'model checkboxes');
      const box = [...document.querySelectorAll('[data-sel-model]')].find(b => !b.checked);
      box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(50); click($('[data-act=sel-save]'));
      await wait(300);
      location.hash = '#/audit';
      await until(() => $('h1')?.textContent === 'Audit' && !$('.skel'), 'audit page');
      const page = $('#view').firstElementChild;
      await wait(3600);
      expect(location.hash === '#/audit' && $('#view').firstElementChild === page, 'a selection save that answers later does not repaint the page the user is on');
      expect(/Selection saved/.test($('#toasts').textContent), 'a toast says the selection was saved');
      location.hash = '#/models';
      await until(() => $('[data-sel-model]'), 'models again');
      expect(/All changes saved/.test($('.sel-bar')?.textContent || ''), 'the saved selection is what the page shows afterwards');
    },
    async modelsRefreshStale() {
      await until(() => $('[data-act=refresh-models]'), 'refresh button'); click($('[data-act=refresh-models]'));
      await wait(300);
      location.hash = '#/audit';
      await until(() => $('h1')?.textContent === 'Audit' && !$('.skel'), 'audit page');
      const page = $('#view').firstElementChild;
      await wait(3600);
      expect($('#view').firstElementChild === page, 'a catalog refresh that answers later does not repaint the page the user is on');
      expect(/catalogs? refreshed|still failing/i.test($('#toasts').textContent), 'a toast reports the refresh');
    },
    async syncStale() {
      await until(() => $('[data-act=sync]'), 'sync button'); click($('[data-act=sync]'));
      await wait(300);
      location.hash = '#/audit';
      await until(() => $('h1')?.textContent === 'Audit' && !$('.skel'), 'audit page');
      const page = $('#view').firstElementChild, loads = window.__FIXTURE.calls.filter(c => c.path === 'audit').length;
      await wait(4200);
      expect($('#view').firstElementChild === page && window.__FIXTURE.calls.filter(c => c.path === 'audit').length === loads, 'a repository sync that answers later does not reload the page the user is on');
    },
    async linkRevokeStale() {
      await until(() => $('[data-act=revoke-link]'), 'revoke link'); click($('[data-act=revoke-link]'));
      await wait(300);
      location.hash = '#/audit';
      await until(() => $('h1')?.textContent === 'Audit' && !$('.skel'), 'audit page');
      const page = $('#view').firstElementChild;
      await wait(3600);
      expect($('#view').firstElementChild === page, 'a link revocation that answers later does not reload the page the user is on');
      expect(/revoked/i.test($('#toasts').textContent), 'a toast says the link was revoked');
    },
    /* ---- Strip requests follow their cards. Start with ?slow=1500&iostub=1 in a tall window (--window-size=1440,3000) */
    async stripsCancel() {
      const F = window.__FIXTURE;
      await until(() => $('.health'), 'gallery', 8000); await wait(300);
      const strip = () => F.calls.filter(c => /\/checkins$/.test(c.path));
      expect(strip().length === 4 && strip().every(c => !c.settled), `four strip requests are running (${strip().length})`);
      type($('#q'), 'zzzz'); await wait(200);
      expect(strip().every(c => c.aborted), 'hiding the cards by search cancels their running requests');
      type($('#q'), 'linux');
      let most = 0; const t = Date.now();
      while (Date.now() - t < 6000) { most = Math.max(most, strip().filter(c => !c.settled).length); await wait(50); }
      expect(most >= 1 && most <= 4, `the cards that remain load, never more than four at a time (${most})`);
      const linuxLive = F.nodes.filter(n => n.platform === 'linux' && !n.revokedAt).length;
      expect(document.querySelectorAll('svg.strip').length === linuxLive, `every remaining card draws its strip (${document.querySelectorAll('svg.strip').length} of ${linuxLive})`);
      expect(!/Unavailable/.test($('#gallery-body').textContent) && !document.querySelector('.toast--critical'), 'cancelled requests never show as errors');
    },
    /* Start with ?slow=1500&iostub=1 */
    async stripsAway() {
      const F = window.__FIXTURE;
      await until(() => $('.health'), 'gallery', 8000); await wait(500);
      const strip = () => F.calls.filter(c => /\/checkins$/.test(c.path));
      const running = strip().filter(c => !c.settled);
      expect(running.length > 0 && running.length <= 4, `strip requests are running (${running.length})`);
      const slotFor = c => document.querySelector(`[data-strip-slot="${c.path.split('/')[1]}"]`);
      const t0 = Date.now();
      window.scrollTo(0, document.documentElement.scrollHeight);
      await wait(500);
      const away = running.filter(c => { const r = slotFor(c).getBoundingClientRect(); return r.bottom <= 0 || r.top >= innerHeight; });
      expect(away.length > 0, `some running requests belong to cards that scrolled out of view (${away.length})`);
      expect(away.every(c => c.aborted), 'requests of cards scrolled out of view are cancelled');
      const fresh = strip().filter(c => c.at >= t0);
      expect(fresh.length > 0 && fresh.every(c => c.at - t0 < 900), `the freed slots go to the cards now in view without waiting for the slow Server (${fresh.length} new requests)`);
      expect(strip().filter(c => !c.settled).length <= 4, 'at most four requests run at once');
      await wait(3000);
      expect(!/Unavailable/.test($('#gallery-body').textContent) && !document.querySelector('.toast--critical'), 'cancelled requests never show as errors');
      window.scrollTo(0, 0); await wait(4000);
      const top = [...document.querySelectorAll('[data-strip-slot]')].filter(e => e.getBoundingClientRect().bottom > 0 && e.getBoundingClientRect().top < innerHeight);
      expect(top.length > 0 && top.every(e => e.querySelector('svg.strip')), 'cards that were cancelled load again when they come back into view');
    },
    /* ---- The fixture answers like the Server. Any URL. */
    async fixtureContract() {
      const F = window.__FIXTURE;
      await until(() => $('.health') || $('.empty'), 'app');
      const csrf = (await (await fetch('/dashboard/api/csrf')).json()).token;
      const call = async (method, path, body) => { const r = await fetch('/dashboard/api/' + path, { method, headers: { 'Content-Type': 'application/json', 'X-Fleet-CSRF': csrf }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) }); return { status: r.status, body: await r.json().catch(() => null) }; };
      const post = (path, body) => call('POST', path, body), get = path => call('GET', path);
      const is = (r, status, code, label) => expect(r.status === status && (code === null ? true : r.body?.code === code), `${label}: ${r.status} ${r.body?.code || ''}${r.status === status && (code === null || r.body?.code === code) ? '' : ` (wanted ${status} ${code})`}`);
      const revoked = F.nodes.find(n => n.revokedAt), live = F.nodes.filter(n => !n.revokedAt);
      const [a, b] = live;
      const guidNone = '00000000-0000-4000-8000-000000000000';
      /* disk usage: nothing is revoked or removed yet, so the machines named here exist. */
      const nuc = F.nodes.find(n => n.alias === 'homelab-nuc'), fresh = F.nodes.find(n => n.alias === 'build-runner-02'), olda = F.nodes.find(n => n.alias === 'kitchen-mini');
      const detailOf = async n => (await get('nodes/' + n.id)).body, listOf = async n => (await get('nodes')).body.items.find(i => i.nodeId === n.id);
      const dn = (await detailOf(nuc)).disk, ln = (await listOf(nuc)).disk;
      expect(dn.volumes.length === 2 && dn.volumes.every(v => Math.abs(v.usedPercent - Math.round(v.usedBytes / (v.usedBytes + v.availableBytes) * 1000) / 10) < 0.05 && v.usedBytes + v.availableBytes <= v.totalBytes), 'GET nodes/{node}: usedPercent is used / (used + available) and used + available fit the total');
      expect(ln.label === 'home' && ln.usedPercent === Math.max(...dn.volumes.map(v => v.usedPercent)) && Object.keys(ln).sort().join() === 'availableBytes,label,measuredAt,totalBytes,usedBytes,usedPercent', 'GET nodes: the fullest volume with exactly the six contract fields');
      expect((await detailOf(fresh)).disk === null && (await listOf(fresh)).disk === null, 'a machine that never reported has disk: null');
      expect(Object.keys(dn).sort().join() === 'measuredAt,refreshRequestedAt,volumes' && dn.refreshRequestedAt === null, 'disk has measuredAt, refreshRequestedAt (null unless pending) and volumes');
      is(await post('nodes/nobody-here/disk-usage/refresh'), 404, 'node_not_found', 'refreshing an unknown machine');
      const r1 = await post('nodes/' + olda.id + '/disk-usage/refresh');
      is(r1, 202, null, 'refreshing a machine'); expect(Object.keys(r1.body).join() === 'refreshRequestedAt' && !isNaN(Date.parse(r1.body.refreshRequestedAt)), 'the 202 body is { refreshRequestedAt }');
      const r2 = await post('nodes/' + olda.id + '/disk-usage/refresh');
      expect(r2.body.refreshRequestedAt === r1.body.refreshRequestedAt, 'a repeated request keeps the original time until the Agent answers');
      is(await post('nodes/' + revoked.id + '/disk-usage/refresh'), 409, 'node_revoked', 'refreshing a revoked machine');
      const diskAudit = () => F.audit.filter(e => e.action === 'node.disk_refresh_requested' && e.nodeId === olda.id);
      expect(diskAudit().length === 1 && diskAudit()[0].actor === F.state.actor, 'a new refresh request is audited once as node.disk_refresh_requested with the Node ID and the actor; the repeat and the refused requests add nothing (' + diskAudit().length + ')');
      expect(F.audit.filter(e => e.action === 'node.disk_refresh_requested').length === 1, 'no audit event for the unknown or revoked machine');
      expect((await get('audit?node=' + olda.id + '&order=newest')).body.items.some(e => e.action === 'node.disk_refresh_requested' && e.nodeId === olda.id), 'GET audit lists it for the machine');
      const pending = (await detailOf(olda)).disk;
      expect(pending && pending.measuredAt === null && pending.refreshRequestedAt === r1.body.refreshRequestedAt && pending.volumes.length === 0, 'a pending refresh on a machine that never reported: disk with no volumes and the request time');
      const issuesNow = (await get('issues')).body.items.filter(i => /^disk_space_/.test(i.code));
      expect(issuesNow.length === 3 && issuesNow.find(i => i.nodeName === 'homelab-nuc')?.code === 'disk_space_critical' && issuesNow.find(i => i.nodeName === 'homelab-nuc').severity === 'error' && issuesNow.filter(i => i.code === 'disk_space_low').every(i => i.severity === 'warning'), 'issues: one per machine, critical from 95% as error, low from 85% as warning');
      expect(issuesNow.every(i => i.since === F.nodes.find(n => n.id === i.nodeId)._disk.measuredAt && i.commands.length === 2 && i.commands[1].endsWith(' --refresh')), 'issue since is measuredAt and commands are `fleet nodes disk <alias>` and `... --refresh`');
      /* rename */
      is(await post('nodes/rename', { currentAlias: revoked.alias, alias: 'whatever' }), 409, 'node_revoked', 'renaming a revoked machine');
      const auditBefore = F.audit.length;
      const same = await post('nodes/rename', { currentAlias: a.alias, alias: a.alias });
      is(same, 200, null, 'renaming a machine to the alias it has'); expect(same.body?.alias === a.alias && same.body?.nodeId === a.id && F.audit.length === auditBefore, 'an unchanged alias is returned as is and records nothing');
      is(await post('nodes/rename', { currentAlias: a.alias, alias: b.alias }), 409, 'node_alias_in_use', 'renaming to another machine\'s alias');
      is(await post('nodes/rename', { currentAlias: 'nobody-here', alias: 'x' }), 404, 'node_not_found', 'renaming an unknown machine');
      is(await post('nodes/rename', { currentAlias: 'nobody-here', alias: '   ' }), 400, 'invalid_node_alias', 'a blank alias is refused before the machine is looked up');
      is(await post('nodes/rename', { currentAlias: a.alias, alias: 'x'.repeat(201) }), 400, 'invalid_node_alias', 'a 201 character alias');
      /* links */
      const aliasTaken = await post('enrollment-links', { alias: b.alias, expiresInSeconds: 900 });
      is(aliasTaken, 200, null, 'a link for an alias a machine already has is created (occupancy is checked at enrollment)');
      is(await post('enrollment-links', { alias: 'fresh-one' }), 200, null, 'expiresInSeconds defaults to 900');
      is(await post('enrollment-links', { alias: 'fresh-two', expiresInSeconds: 59 }), 400, 'invalid_expiry', 'expiry below 60 seconds');
      is(await post('enrollment-links', { alias: '  ', expiresInSeconds: 59 }), 400, 'invalid_expiry', 'expiry is checked before the alias');
      is(await post('enrollment-links', { alias: '  ', expiresInSeconds: 900 }), 400, 'invalid_alias', 'a blank link alias');
      const link = (await get('enrollment-links/' + aliasTaken.body.id)).body;
      expect(link?.state === 'active', 'the created link is active');
      is(await post('enrollment-links/' + guidNone + '/revoke'), 400, 'enrollment_not_found', 'revoking an unknown link (the Server answers 400, not 404)');
      const auditLinks = F.audit.length;
      is(await post('enrollment-links/' + link.id + '/revoke'), 200, null, 'revoking a link'); is(await post('enrollment-links/' + link.id + '/revoke'), 200, null, 'revoking it again');
      expect(F.audit.length === auditLinks + 1, 'only the first revocation is recorded');
      const used = F.links.find(l => l.state === 'consumed');
      is(await post('enrollment-links/' + used.id + '/revoke'), 200, null, 'revoking a used link');
      expect((await get('enrollment-links/' + used.id)).body?.state === 'consumed', 'a used link still reads as used after a revoke attempt');
      /* retry */
      is(await post('nodes/' + a.id + '/retry', { target: '  ' }), 400, 'invalid_request', 'retry without a target');
      /* revoke and remove */
      const failing = live.find(n => n.targets.some(t => t.state === 'failed')), statesBefore = failing.targets.map(t => t.state).join();
      is(await post('nodes/' + failing.id + '/revoke'), 200, null, 'revoking a machine');
      const firstAt = failing.revokedAt;
      await wait(20); const auditRevoke = F.audit.length;
      is(await post('nodes/' + failing.id + '/revoke'), 200, null, 'revoking it again');
      expect(failing.revokedAt === firstAt && F.audit.length === auditRevoke + 1, 'the first revocation time stays, and each call is audited');
      expect(failing.targets.map(t => t.state).join() === statesBefore, 'revoking leaves the Targets\' states alone');
      is(await post('nodes/' + guidNone + '/revoke'), 404, 'node_not_found', 'revoking an unknown machine');
      is(await post('nodes/' + a.id + '/remove', { alias: 'wrong' }), 409, 'node_alias_changed', 'removing with a different alias');
      is(await post('nodes/' + a.id + '/remove', { alias: ' ' }), 400, 'invalid_node_alias', 'removing with a blank alias');
      is(await post('nodes/' + guidNone + '/remove', { alias: 'x' }), 404, 'node_not_found', 'removing an unknown machine');
      const owner = F.nodes.find(n => n.alias === used.alias);
      if (owner) {
        is(await post('nodes/' + owner.id + '/remove', { alias: owner.alias }), 200, null, 'removing the machine a link created');
        is(await get('enrollment-links/' + used.id), 404, 'enrollment_link_not_found', 'the link that created a removed machine is deleted with it');
      }
      /* selection */
      const sel = (await get('cliproxy/selection')).body.catalogs[0];
      is(await post('cliproxy/selection', { baseUrl: 'https://nowhere/v1', version: 0, policy: null }), 400, 'invalid_selection', 'a malformed selection is refused before the catalog is looked up');
      is(await post('cliproxy/selection', { baseUrl: 'https://nowhere/v1', version: 0, policy: sel.policy }), 404, 'catalog_unavailable', 'an unknown proxy');
      const pinnedModel = F.nodes.flatMap(n => n.targets).map(t => t.aiClient).find(c => c && c.mode === 'cliproxy' && c.baseUrl === sel.baseUrl && /^gpt-/.test(c.model))?.model;
      if (pinnedModel) is(await post('cliproxy/selection', { baseUrl: sel.baseUrl, version: sel.version - 1, policy: { ...sel.policy, modelOverrides: { ...sel.policy.modelOverrides, [pinnedModel]: false } } }), 409, 'pinned_model_excluded', 'excluding a pinned model is reported before a stale version');
      is(await post('cliproxy/selection', { baseUrl: sel.baseUrl, version: sel.version - 1, policy: sel.policy }), 409, 'stale_selection', 'a stale version');
      const auditSel = F.audit.length;
      const ok = await post('cliproxy/selection', { baseUrl: sel.baseUrl, version: sel.version, policy: sel.policy });
      is(ok, 200, null, 'saving the current version'); expect(ok.body?.catalog?.version === sel.version + 1, 'the version moves up by one');
      expect(F.audit.length === auditSel, 'saving a selection adds no audit event (the Server records none)');
      const auditScan = F.audit.length; await post('source/rescan'); expect(F.audit.length === auditScan, 'a rescan adds no audit event (the Server records none)');
    },
    /* ---- Phase 2 attempt detail (diagnostic, path, step). */
    /* Node Problems tab. Open: ?drive=detailNode#/nodes/studio-mini/problems */
    async detailNode() {
      const F = window.__FIXTURE;
      await until(() => $('.prob .fdetail'), 'failure detail on the Problems tab');
      const d = $('.prob .fdetail');
      expect(d.querySelector('.stepchip')?.textContent.includes('Configuring'), 'the step is a labelled chip with human wording (' + d.querySelector('.stepchip')?.textContent + ')');
      expect(d.querySelector('.fdetail-path code')?.textContent === '~/.claude/settings.json', 'the failing path is shown with the Target base (' + d.querySelector('.fdetail-path code')?.textContent + ')');
      expect(/trailing comma/.test(d.querySelector('pre.code--diag')?.textContent || ''), 'the diagnostic is shown preformatted');
      expect(!/excerpt|\|\s+\^/.test(d.textContent), 'no excerpt is shown');
      expect(!/No detail reported/.test($('.prob').textContent), 'no "No detail reported" line when detail exists');
      expect($('.prob .fix h4'), 'the catalog fix steps are still shown');
      expect(/Configuration file|configuration/i.test($('.prob-expl').textContent), 'the catalog explanation is still shown');
      const copy = d.querySelector('.fdetail-diag > [data-act=copy]');
      expect(copy && copy.dataset.copy === d.querySelector('pre.code--diag').textContent, 'the diagnostic has a copy button holding the exact text');
      click(copy); await until(() => copy.classList.contains('is-copied'), 'copy confirmation', 1500);
      expect(copy.classList.contains('is-copied'), 'the copy button confirms');
      expect(d.querySelector('.fdetail-path [data-act=copy]')?.dataset.copy === '~/.claude/settings.json', 'the path has a copy button');
      const la = F.calls.find(c => /^nodes\/[^/]+$/.test(c.path));
      expect(la, 'node detail was requested');
    },
    /* The same tab on a Node whose Agent sends no detail. Open: ?drive=detailOld#/nodes/kitchen-mini/problems */
    async detailOld() {
      await until(() => $('.prob'), 'problem card');
      expect(!$('.prob .fdetail') && !$('.prob .stepchip'), 'no detail block and no step chip');
      expect($('.prob .fdetail-none')?.textContent === 'No detail reported. Agents before 0.9.0 send only the error code.', 'one quiet line explains that nothing was reported');
      expect($('.prob .fix h4') && $('.prob-expl')?.textContent.length > 20, 'the catalog explanation and fix steps are still shown');
    },
    /* A detail with a step but no path: lock failures are outside the Target base. Open: ?drive=detailLock#/nodes/design-imac/problems */
    async detailLock() {
      await until(() => $('.prob .fdetail'), 'failure detail');
      const cards = [...document.querySelectorAll('.prob')];
      const withPath = cards.filter(c => c.querySelector('.fdetail-path')), without = cards.filter(c => c.querySelector('.stepchip') && !c.querySelector('.fdetail-path'));
      expect(cards.length === 2 && withPath.length === 1 && without.length === 1, 'one failure shows a path and a step, the other a step without a path');
      expect(cards.every(c => /Taking the lock/.test(c.querySelector('.stepchip')?.textContent || '')), 'the lock step reads "Taking the lock"');
      expect(withPath[0].querySelector('.fdetail-path code').textContent === '~/.claude/CLAUDE.md', 'the agent-file path is under the Target base');
      expect(/held by pid 4127/.test(document.body.textContent), 'the diagnostics are shown');
    },
    /* Activity tab. Open: ?drive=detailActivity#/nodes/studio-mini/activity */
    async detailActivity() {
      await until(() => $('.tl-item .stepchip'), 'step chip on an attempt row');
      const item = [...document.querySelectorAll('.tl-item')].find(i => i.querySelector('.stepchip'));
      expect(/Configuring/.test(item.querySelector('.stepchip').textContent), 'the attempt row shows its step');
      const line = item.querySelector('details.diag-line');
      expect(line && !line.open, 'the diagnostic is one line that can expand');
      const cs = getComputedStyle(line.querySelector('.diag-text'));
      expect(cs.whiteSpace === 'nowrap' && cs.textOverflow === 'ellipsis' && line.querySelector('.diag-text').clientHeight < 24, 'the closed diagnostic is cut to one line (' + cs.whiteSpace + ', ' + cs.textOverflow + ')');
      click(line.querySelector('summary')); await wait(100);
      expect(line.open && line.querySelector('.diag-text').clientHeight > 0, 'expanding shows the diagnostic');
      expect(getComputedStyle(line.querySelector('.diag-text')).whiteSpace === 'pre-wrap', 'the expanded diagnostic wraps');
      expect(!document.querySelector('.tl-item .fdetail-none'), 'no "No detail reported" line in Activity');
    },
    /* Problems page. Open: ?drive=detailProblems#/problems */
    async detailProblems() {
      await until(() => $('.prow'), 'problem rows');
      document.querySelectorAll('.prow').forEach(d => { d.open = true; });
      await wait(100);
      const cards = [...document.querySelectorAll('.prow')];
      const studio = cards.find(c => /studio-mini/.test(c.querySelector('summary').textContent) && /claude/.test(c.querySelector('summary').textContent));
      expect(studio?.querySelector('.stepchip')?.textContent.includes('Configuring'), 'the step chip is on the Problems page');
      expect(studio?.querySelector('.fdetail-path code')?.textContent === '.claude/settings.json', 'the path is shown as sent here (no Target base on this page: ' + studio?.querySelector('.fdetail-path code')?.textContent + ')');
      expect(/trailing comma/.test(studio?.querySelector('pre.code--diag')?.textContent || ''), 'the diagnostic is shown');
      expect(studio?.querySelector('.fdetail-diag > [data-act=copy]'), 'the diagnostic has a copy button');
      const old = cards.find(c => /kitchen-mini/.test(c.querySelector('summary').textContent));
      expect(old?.querySelector('.fdetail-none')?.textContent.startsWith('No detail reported.'), 'an old Agent gets the quiet line');
      expect(!old?.querySelector('.stepchip'), 'and no chip');
      expect(studio?.querySelector('.prob-expl')?.textContent.length > 20 && studio.querySelector('.fix h4'), 'rows still render the catalog explanation and fix steps');
    },
    /* Deployments rollout attempts. Open: ?drive=detailDeployments#/deployments */
    async detailDeployments() {
      await until(() => $('.hist-item'), 'revisions');
      document.querySelectorAll('.hist-item details').forEach(d => { d.open = true; });
      for (const b of document.querySelectorAll('[data-act=load-attempts]')) click(b);
      await until(() => $('.attlist'), 'failed attempt list');
      const items = [...document.querySelectorAll('.attitem')];
      expect(items.length >= 2, 'failed attempts are listed (' + items.length + ')');
      expect(items.some(i => i.querySelector('.stepchip')), 'a failed attempt shows its step');
      expect(items.some(i => i.querySelector('details.diag-line')) , 'a long diagnostic is one line with an expander');
      expect(items.some(i => !i.querySelector('.stepchip') && !i.querySelector('.diag-line')), 'an attempt from an old Agent shows just its error code');
      const line = items.map(i => i.querySelector('details.diag-line')).find(Boolean);
      click(line.querySelector('summary')); await wait(100);
      expect(line.open, 'the diagnostic expands');
    },
    /* No detail at all (a Server or Agents before phase 2). Open: ?drive=detailNone&diag=0#/nodes/studio-mini/problems */
    async detailNone() {
      await until(() => $('.prob'), 'problem card');
      expect(!document.querySelector('.stepchip, .fdetail, pre.code--diag') && $('.fdetail-none'), 'only the quiet line is shown');
      location.hash = '#/problems'; await until(() => $('.prow'), 'problems page');
      expect(!document.querySelector('.stepchip, .fdetail') && document.querySelector('.fdetail-none'), 'same on the Problems page');
      location.hash = '#/nodes/studio-mini/activity'; await until(() => $('.tl-item'), 'activity');
      expect(!document.querySelector('.stepchip, .diag-line'), 'and in Activity');
    },
    /* Hostile text from the Agent renders as text everywhere. Open: ?drive=detailXss&xss=1#/nodes/studio-mini/problems */
    async detailXss() {
      let alerts = 0; window.alert = () => { alerts++; };
      const bad = () => document.querySelectorAll('#root img, #root script, #root [onerror], #root [onclick], #root [onload]').length;
      const hasText = () => document.body.textContent.includes('<img src=x onerror=alert(1)>') && document.body.textContent.includes('"><script>');
      await until(() => $('.prob .fdetail'), 'failure detail');
      expect(hasText(), 'node Problems tab: the hostile diagnostic is visible as text');
      expect($('.fdetail-path code').textContent.includes('"><script>alert(3)</script>') && $('.fdetail-path code').textContent.includes('<img src=x onerror=alert(4)>'), 'the hostile path is visible as text');
      expect(bad() === 0, 'no injected element on the Problems tab (' + bad() + ')');
      expect($('.fdetail-diag > [data-act=copy]').dataset.copy.includes('"><script>'), 'the copy attribute holds the text and did not break out of the attribute');
      for (const [hash, ready, label] of [['#/nodes/studio-mini/activity', '.tl-item .diag-line', 'Activity'], ['#/problems', '.prow', 'Problems page'], ['#/deployments', '.hist-item', 'Deployments']]) {
        location.hash = hash; await until(() => $(ready), label);
        if (label === 'Problems page') document.querySelectorAll('.prow').forEach(d => { d.open = true; });
        if (label === 'Deployments') { document.querySelectorAll('.hist-item details').forEach(d => { d.open = true; }); for (const b of document.querySelectorAll('[data-act=load-attempts]')) click(b); await until(() => $('.attlist'), 'attempt list'); }
        document.querySelectorAll('details.diag-line').forEach(d => { d.open = true; });
        await wait(150);
        expect(hasText(), label + ': hostile text is visible as text');
        expect(bad() === 0, label + ': no injected element (' + bad() + ')');
      }
      await wait(300);
      expect(alerts === 0, 'alert was never called');
    },

    /* ---- Node disk usage (operator-api.md, "Disk usage"). Fixture: homelab-nuc 96.4% (critical, plus a state volume), fedora-ws 88.7% and gpu-box 85.0% (warning),
       design-imac 83.9% (fine), build-runner-02 and lab-vm-07 never reported, kitchen-mini is an Agent before 0.9.0 (never reports, never answers a refresh). */
    /* Gallery cards. Open: ?drive=diskGallery#/nodes */
    async diskGallery() {
      await until(() => $('.card'), 'cards');
      const cardOf = alias => [...document.querySelectorAll('.card')].find(c => c.querySelector('h3')?.textContent === alias);
      const meterOf = alias => cardOf(alias)?.querySelector('.diskm');
      const nuc = meterOf('homelab-nuc'), fed = meterOf('fedora-ws'), mbp = meterOf('mbp-joan');
      expect(nuc?.classList.contains('diskm--critical') && /96\.4% used/.test(nuc.textContent) && /Nearly full/.test(nuc.textContent), 'homelab-nuc: critical meter with "96.4% used" and the word "Nearly full"');
      expect(nuc?.querySelector('.diskm-state svg.g') && nuc.querySelector('.meter.m-critical > span')?.style.width === '96.4%', 'critical: an icon next to the label, and a bar 96.4% wide in the critical colour');
      expect(/GiB free of .*GiB/.test(nuc?.textContent || '') && /33\.3 GiB free of 954\.0 GiB/.test(nuc.textContent), 'the card says "33.3 GiB free of 954.0 GiB" (binary units, one decimal) (' + nuc?.querySelector('.diskm-sub')?.textContent + ')');
      expect(fed?.classList.contains('diskm--warning') && /Filling up/.test(fed.textContent) && fed.querySelector('.meter.m-warning'), 'fedora-ws (88.7%): warning state, label and colour');
      expect(mbp?.classList.contains('diskm--good') && /Enough space/.test(mbp.textContent) && mbp.querySelector('.meter.m-good'), 'mbp-joan (62.4%): good state');
      expect(meterOf('gpu-box')?.classList.contains('diskm--warning'), 'exactly 85.0% is a warning');
      expect(meterOf('design-imac')?.classList.contains('diskm--good'), '83.9% is still fine');
      expect(meterOf('build-runner-02')?.textContent.includes('No disk data') && !meterOf('build-runner-02').querySelector('.meter'), 'a machine that never reported says "No disk data" and has no bar');
      expect(meterOf('kitchen-mini')?.textContent.includes('No disk data'), 'an Agent before 0.9.0 says "No disk data"');
      expect(!cardOf('old-laptop')?.querySelector('.diskm'), 'a revoked machine has no disk meter');
      expect([...document.querySelectorAll('.diskm')].every(m => m.querySelector('svg.g')), 'every meter has an icon, so colour is never the only signal');
      const section = id => document.getElementById(id);
      const inAttention = alias => section('sec-attention')?.contains(cardOf(alias));
      expect(inAttention('homelab-nuc') && inAttention('fedora-ws') && inAttention('gpu-box'), 'machines with a disk at 85% or more are in "Needs attention", even though their Targets are in sync');
      expect(!section('sec-ok')?.contains(cardOf('homelab-nuc')) && !inAttention('mbp-joan'), 'and a healthy disk does not move a machine there');
      expect(/3 have a disk that is 85% full or more/.test($('.health-sub')?.textContent || ''), 'the banner counts the full disks (' + $('.health-sub')?.textContent.trim().slice(0, 140) + ')');
      const order = [...section('sec-attention').querySelectorAll('.card h3')].map(h => h.textContent);
      expect(order.indexOf('homelab-nuc') < order.indexOf('build-runner-03') && order.indexOf('build-runner-03') < order.indexOf('gpu-box'), 'a critical disk ranks with the failures, a disk warning below the offline machines (' + order.join(', ') + ')');
      const sel = $('#sort'); expect([...sel.options].some(o => o.value === 'disk' && o.textContent === 'Fullest disk first'), 'the sort has "Fullest disk first"');
      type(sel, 'disk'); await wait(100);
      const att = [...section('sec-attention').querySelectorAll('.card')].map(c => ({ n: c.querySelector('h3').textContent, p: parseFloat(c.querySelector('.diskm-k b')?.textContent) }));
      expect(att[0].n === 'homelab-nuc' && att.filter(x => !isNaN(x.p)).every((x, i, a) => !i || a[i - 1].p >= x.p), 'sorted by the fullest disk first (' + att.map(x => x.n + ':' + x.p).join(', ') + ')');
      expect(isNaN(att[att.length - 1].p), 'machines without data come last');
    },
    /* Node page, Overview. Open: ?drive=diskNode#/nodes/homelab-nuc */
    async diskNode() {
      await until(() => $('#disk-panel .dvol'), 'disk panel');
      const rows = [...document.querySelectorAll('#disk-panel .dvol')];
      expect(rows.length === 2 && rows[0].dataset.volume === 'home' && rows[1].dataset.volume === 'state', 'two volumes, home first then state');
      const home = rows[0], state = rows[1];
      expect(home.classList.contains('dvol--critical') && /96\.4%/.test(home.textContent) && /Nearly full/.test(home.textContent) && home.querySelector('.dvol-state svg.g'), 'home is critical: percent, word and icon');
      expect(home.querySelector('.meter.m-critical > span')?.style.width === '96.4%', 'the bar is 96.4% wide');
      const nums = Object.fromEntries([...home.querySelectorAll('.dvol-nums > div')].map(d => [d.querySelector('dt').textContent, d.querySelector('dd').textContent]));
      expect(nums.Total === '954.0 GiB' && /^\d+\.\d GiB$/.test(nums.Used) && nums.Available === '33.3 GiB', 'used, available and total are in GiB with one decimal (' + JSON.stringify(nums) + ')');
      expect(state.classList.contains('dvol--good') && /41\.3%/.test(state.textContent) && /476\.0 GiB/.test(state.textContent), 'the state volume is fine');
      expect(/Measured .* ago/.test($('#disk-panel .disk-measured')?.textContent || ''), 'measuredAt is shown as relative time (' + $('#disk-panel .disk-measured')?.textContent + ')');
      const btn = $('#disk-panel [data-act=disk-refresh]');
      expect(btn && !btn.disabled && btn.textContent.trim() === 'Refresh', 'a Refresh button for operators');
      expect([...document.querySelectorAll('.hchecks b')].some(b => b.textContent === 'Disk is nearly full'), 'Health checks mention the disk');
      expect($('.nhero-actions .btn-primary')?.textContent.includes('Fix 1 problem'), 'the disk issue counts as a problem to fix');
      const f = window.__FIXTURE;
      expect(f.calls.some(c => c.method === 'GET' && /^nodes\/[^/]+$/.test(c.path)), 'disk comes from GET nodes/{node}');
    },
    /* Refresh answered. Open: ?drive=diskRefreshAnswered#/nodes/build-runner-02 */
    async diskRefreshAnswered() {
      const F = window.__FIXTURE, node = F.nodes.find(n => n.alias === 'build-runner-02');
      await until(() => $('#disk-panel'), 'disk panel');
      expect(/No disk data yet/.test($('#disk-body').textContent) && !$('.dvol'), 'a machine that never reported shows an explanation, no volumes');
      click($('[data-act=disk-refresh]'));
      await until(() => /Refresh requested/.test($('#disk-status').textContent), 'status after the click', 2000);
      expect($('#disk-status').textContent.trim() === 'Refresh requested — the Agent answers on its next check-in.', 'status: "Refresh requested — the Agent answers on its next check-in." (' + $('#disk-status').textContent.trim() + ')');
      expect($('#disk-status').getAttribute('role') === 'status' && $('[data-act=disk-refresh]').disabled, 'the status is a live region and the button is disabled while waiting');
      const post = F.calls.find(c => c.method === 'POST' && c.path === `nodes/${node.id}/disk-usage/refresh`);
      expect(post, 'POST nodes/{id}/disk-usage/refresh was sent');
      const t0 = post.at;
      await until(() => $('#disk-panel .dvol'), 'the Agent answered', 40000);
      expect(/Disk usage updated/.test($('#disk-status').textContent) && $('#disk-panel .dvol'), 'the volume appears and the status says it was updated (' + $('#disk-status').textContent.trim() + ')');
      expect(!$('[data-act=disk-refresh]').disabled, 'the button is enabled again');
      const polls = F.calls.filter(c => c.method === 'GET' && c.path === `nodes/${node.id}` && c.at > t0).sort((a, b) => a.at - b.at);
      const gaps = polls.slice(0, 3).map((c, i, a) => i ? c.at - a[i - 1].at : c.at - t0);
      expect(polls.length >= 2 && gaps.slice(0, 2).every(g => g >= 4500 && g <= 7500), 'GET nodes/{node} every 5 s while waiting (gaps ' + gaps.join(', ') + ' ms)');
      const settled = F.calls.filter(c => c.method === 'GET' && c.path === `nodes/${node.id}`).length;
      await wait(30000);
      expect(F.calls.filter(c => c.method === 'GET' && c.path === `nodes/${node.id}`).length === settled, 'polling stops once the Agent answered');
      expect(!document.querySelector('.disk-status--warning, .disk-status--critical'), 'no error shown');
    },
    /* Refresh never answered (Agent before 0.9.0). Open: ?drive=diskRefreshUnanswered#/nodes/kitchen-mini with --virtual-time-budget=400000 */
    async diskRefreshUnanswered() {
      const F = window.__FIXTURE, node = F.nodes.find(n => n.alias === 'kitchen-mini');
      await until(() => $('#disk-panel'), 'disk panel');
      click($('[data-act=disk-refresh]'));
      await until(() => /Refresh requested/.test($('#disk-status').textContent), 'waiting status', 2000);
      const t0 = Date.now();
      await wait(60000);
      expect(/Refresh requested/.test($('#disk-status').textContent) && $('[data-act=disk-refresh]').disabled, 'after a minute it is still waiting');
      await until(() => /No answer yet/.test($('#disk-status').textContent), 'the time-out message', 140000);
      const waited = Date.now() - t0;
      expect($('#disk-status').textContent.trim() === 'No answer yet. Agents before 0.9.0 do not report disk usage.', 'status: "No answer yet. Agents before 0.9.0 do not report disk usage." (' + $('#disk-status').textContent.trim() + ')');
      expect(waited >= 140000 && waited <= 160000, 'it stops waiting after about 2.5 minutes (' + Math.round(waited / 1000) + ' s after the first minute started)');
      expect(!$('[data-act=disk-refresh]').disabled, 'the button is enabled again, so the user can try once more');
      const polls = F.calls.filter(c => c.method === 'GET' && c.path === `nodes/${node.id}` && c.at > t0 - 61000).length;
      expect(polls >= 25 && polls <= 32, 'the number of polls is bounded (' + polls + ')');
      await wait(30000);
      expect(F.calls.filter(c => c.method === 'GET' && c.path === `nodes/${node.id}` && c.at > t0 - 61000).length === polls, 'no polling after the time-out');
    },
    /* Leaving the machine stops the polling. Open: ?drive=diskNavAway#/nodes/kitchen-mini */
    async diskNavAway() {
      const F = window.__FIXTURE, node = F.nodes.find(n => n.alias === 'kitchen-mini');
      const reads = () => F.calls.filter(c => c.method === 'GET' && c.path === `nodes/${node.id}`).length;
      await until(() => $('#disk-panel'), 'disk panel');
      click($('[data-act=disk-refresh]'));
      await until(() => /Refresh requested/.test($('#disk-status').textContent), 'waiting status', 2000);
      await wait(12000);
      const during = reads(); expect(during >= 2, 'it polls every 5 s while the user stays (' + during + ')');
      location.hash = '#/nodes/studio-mini';
      await until(() => $('.nhero h1')?.textContent === 'studio-mini', 'another machine', 4000);
      const atLeave = reads();
      await wait(20000);
      expect(reads() <= atLeave + 1, 'no further reads of the first machine after navigating to another one (' + (reads() - atLeave) + ' extra)');
      expect(!/Refresh requested/.test($('#disk-status')?.textContent || '') && $('[data-act=disk-refresh]') && !$('[data-act=disk-refresh]').disabled, 'the other machine does not inherit the waiting state');
      location.hash = '#/nodes/kitchen-mini'; await until(() => $('.nhero h1')?.textContent === 'kitchen-mini', 'back to the first machine', 4000);
      const back = reads(); await wait(12000);
      expect(!$('[data-act=disk-refresh]').disabled && reads() === back, 'coming back does not resume the polling (the Server still lists the pending request)');
      expect(/A refresh was requested .* ago/.test($('#disk-status').textContent), 'the pending request from the Server is mentioned (' + $('#disk-status').textContent.trim() + ')');
    },
    /* A read that never answers cannot hold Refresh forever. Open: ?drive=diskRefreshHang#/nodes/kitchen-mini with --virtual-time-budget=400000
       The scenario switches the fixture's hang= on for this machine's detail once the refresh is waiting, so the page itself loaded normally. */
    async diskRefreshHang() {
      const F = window.__FIXTURE, node = F.nodes.find(n => n.alias === 'kitchen-mini');
      const reads = () => F.calls.filter(c => c.method === 'GET' && c.path === `nodes/${node.id}`);
      await until(() => $('#disk-panel'), 'disk panel');
      const base = reads().length;
      click($('[data-act=disk-refresh]'));
      await until(() => /Refresh requested/.test($('#disk-status').textContent), 'waiting status', 2000);
      const t0 = Date.now();
      F.cfg.hang = `nodes/${node.id}`;
      const hung = await until(() => reads().length > base && reads()[reads().length - 1], 'the first poll', 8000);
      expect(hung && !hung.settled && !hung.aborted, 'the poll is in flight and does not answer');
      await wait(60000);
      expect(/Refresh requested/.test($('#disk-status').textContent) && $('[data-act=disk-refresh]').disabled, 'after a minute it is still waiting');
      expect(reads().length === base + 1 && !hung.settled, 'only the one read is out (a new poll does not start before the last one ended)');
      await until(() => /No answer yet/.test($('#disk-status').textContent), 'the deadline ends the wait without the read answering', 120000);
      const waited = Date.now() - t0;
      expect(waited >= 150000 && waited <= 154000, 'the deadline is 2.5 minutes after the request was accepted (' + Math.round(waited / 1000) + ' s)');
      expect($('#disk-status').textContent.trim() === 'No answer yet. Agents before 0.9.0 do not report disk usage.', 'status: the no-answer text (' + $('#disk-status').textContent.trim() + ')');
      expect(hung.aborted && hung.settled, 'the read that hung was aborted');
      expect(!$('[data-act=disk-refresh]').disabled && !$('[data-act=disk-refresh]').hasAttribute('aria-busy'), 'Refresh is enabled again');
      expect(!document.querySelector('.toast') && !document.querySelector('.disk-status--critical'), 'the abort is not shown as an error');
      const count = F.calls.length;
      await wait(30000);
      expect(F.calls.length === count, 'no request after the deadline');
      /* Refresh works again once the Server answers. */
      F.cfg.hang = null;
      click($('[data-act=disk-refresh]'));
      await until(() => /Refresh requested/.test($('#disk-status').textContent), 'a new refresh waits again', 2000);
      expect($('[data-act=disk-refresh]').disabled, 'and the button is busy again');
    },
    /* Leaving the machine aborts a read that is in flight. Open: ?drive=diskNavHang#/nodes/kitchen-mini with --virtual-time-budget=200000 */
    async diskNavHang() {
      const F = window.__FIXTURE, node = F.nodes.find(n => n.alias === 'kitchen-mini');
      const reads = () => F.calls.filter(c => c.method === 'GET' && c.path === `nodes/${node.id}`);
      await until(() => $('#disk-panel'), 'disk panel');
      const base = reads().length;
      click($('[data-act=disk-refresh]'));
      await until(() => /Refresh requested/.test($('#disk-status').textContent), 'waiting status', 2000);
      F.cfg.hang = `nodes/${node.id}`;
      const hung = await until(() => reads().length > base && reads()[reads().length - 1], 'the first poll', 8000);
      expect(hung && !hung.settled && !hung.aborted, 'the poll is in flight and does not answer');
      location.hash = '#/nodes/studio-mini';
      await until(() => $('.nhero h1')?.textContent === 'studio-mini', 'another machine', 4000);
      expect(hung.aborted && hung.settled, 'navigating away aborted the read');
      const atLeave = reads().length;
      await wait(30000);
      expect(reads().length === atLeave, 'no further reads of the first machine');
      expect(!document.querySelector('.toast') && !document.querySelector('.disk-status--critical') && !document.querySelector('.disk-status--warning'), 'the abort is not shown as an error, and the other machine has no refresh state');
      expect($('[data-act=disk-refresh]') && !$('[data-act=disk-refresh]').disabled, 'the other machine can refresh');
      /* Coming back (the Server still lists the request) does not resume anything, and the page is not stuck. */
      F.cfg.hang = null;
      location.hash = '#/nodes/kitchen-mini'; await until(() => $('.nhero h1')?.textContent === 'kitchen-mini', 'back to the first machine', 4000);
      const back = reads().length; await wait(12000);
      expect(reads().length === back && !$('[data-act=disk-refresh]').disabled, 'coming back does not resume the polling');
    },
    /* A read token cannot refresh. Open: ?drive=diskReadScope&scope=read#/nodes/homelab-nuc */
    async diskReadScope() {
      const F = window.__FIXTURE;
      await until(() => $('#disk-panel .dvol'), 'disk panel');
      const btn = $('#disk-panel [data-act=locked]');
      expect(btn && btn.getAttribute('aria-disabled') === 'true' && /operate scope/.test(btn.dataset.tip || ''), 'Refresh is locked, aria-disabled, with a tooltip that names the scope (' + btn?.dataset.tip + ')');
      expect(!$('#disk-panel [data-act=disk-refresh]'), 'there is no live Refresh button');
      expect(/operate scope/.test($('#disk-panel .lock-note')?.textContent || ''), 'a visible note explains why');
      expect($('#disk-panel .dvol'), 'the data is still shown');
      click(btn); await wait(100);
      expect(/Needs the operate scope/.test($('#toasts').textContent), 'clicking explains');
      expect(!F.calls.some(c => c.method === 'POST' && /disk-usage/.test(c.path)), 'no request was sent');
    },
    /* 403 and 409 answers. Open: ?drive=diskRefreshForbidden&forbid=1#/nodes/studio-mini */
    async diskRefreshForbidden() {
      await until(() => $('#disk-panel [data-act=disk-refresh]'), 'refresh button');
      click($('[data-act=disk-refresh]'));
      await until(() => $('.disk-status--warning'), 'the 403 message', 2000);
      expect(/scope does not allow/.test($('#disk-status').textContent) && !$('[data-act=disk-refresh]').disabled, '403 insufficient_scope is explained inline and the button is usable again (' + $('#disk-status').textContent.trim() + ')');
      await wait(15000);
      expect(window.__FIXTURE.calls.filter(c => c.method === 'GET' && /^nodes\/[^/]+$/.test(c.path)).length === 1, 'no polling after a refused request');
    },
    /* Open: ?drive=diskRefreshRevoked#/nodes/studio-mini */
    async diskRefreshRevoked() {
      const F = window.__FIXTURE, node = F.nodes.find(n => n.alias === 'studio-mini');
      await until(() => $('#disk-panel [data-act=disk-refresh]'), 'refresh button');
      const r = await fetch(`/dashboard/api/nodes/${node.id}/revoke`, { method: 'POST', headers: { 'X-Fleet-CSRF': F.state.csrf, 'Content-Type': 'application/json' }, body: '{}' });
      expect(r.status === 200, 'another operator revokes the machine meanwhile');
      click($('[data-act=disk-refresh]'));
      await until(() => $('.disk-status--critical'), 'the 409 message', 2000);
      expect(/revoked/.test($('#disk-status').textContent) && !$('[data-act=disk-refresh]').disabled, '409 node_revoked is explained inline (' + $('#disk-status').textContent.trim() + ')');
      await wait(15000);
      expect(F.calls.filter(c => c.method === 'GET' && /^nodes\/[^/]+$/.test(c.path)).length === 1, 'no polling after a refused request');
    },
    /* Disk issues on Problems and on the machine. Open: ?drive=diskProblems#/problems */
    async diskProblems() {
      await until(() => $('.prow'), 'problem rows');
      document.querySelectorAll('.prow').forEach(d => { d.open = true; });
      await wait(100);
      const rows = [...document.querySelectorAll('.prow')];
      const crit = rows.find(r => /homelab-nuc: disk is 96\.4% full/.test(r.textContent)), low = rows.find(r => /fedora-ws: disk is 88\.7% full/.test(r.textContent));
      expect(crit && low, 'one issue per machine with a full disk');
      expect(crit.classList.contains('prow--critical') && /Error/.test(crit.querySelector('summary').textContent) && low.classList.contains('prow--warning') && /Warning/.test(low.querySelector('summary').textContent), '96.4% is an error, 88.7% a warning');
      expect(/95% full or more/.test(crit.querySelector('.prob-expl').textContent) && /85% full or more/.test(low.querySelector('.prob-expl').textContent), 'each shows the catalog explanation');
      expect(crit.querySelectorAll('.fix li').length >= 3 && /Fleet never deletes files/.test(crit.querySelector('.fix').textContent), 'and the catalog fix steps');
      const cmds = [...crit.querySelectorAll('.cmd code')].map(c => c.textContent);
      expect(cmds.includes('fleet nodes disk homelab-nuc') && cmds.includes('fleet nodes disk homelab-nuc --refresh'), 'with the CLI commands (' + cmds.join(' | ') + ')');
      expect(crit.querySelector('a.btn')?.getAttribute('href') === '#/nodes/homelab-nuc/problems', 'linking to the machine');
      expect(![...rows].filter(r => /disk is/.test(r.textContent)).some(r => r.querySelector('[data-act=issue-retry]')), 'a disk issue has no Retry button');
      location.hash = '#/nodes/homelab-nuc/problems'; await until(() => $('.nhero .tabs, .tabs') && $('.nhero h1') && $('.prob'), 'machine problems');
      const card = [...document.querySelectorAll('.prob')].find(p => /Disk|disk/.test(p.querySelector('h3').textContent));
      expect(card && /95% full or more/.test(card.querySelector('.prob-expl').textContent) && [...card.querySelectorAll('.cmd code')].some(c => c.textContent === 'fleet nodes disk homelab-nuc --refresh'), 'the machine\'s Problems tab shows the same explanation and commands');
    },
    /* Hostile volume label. Open: ?drive=diskXss&xss=1#/nodes */
    async diskXss() {
      let alerts = 0; window.alert = () => { alerts++; };
      const bad = () => document.querySelectorAll('#root img, #root script, #root [onerror], #root [onclick], #root [onload]').length;
      const hostile = () => document.body.textContent.includes('<img src=x onerror=alert(1)>');
      await until(() => $('.diskm'), 'gallery meters');
      expect(hostile() && bad() === 0, 'gallery: the label shows as text, no injected element (' + bad() + ')');
      location.hash = '#/nodes/homelab-nuc'; await until(() => $('#disk-panel .dvol'), 'node page');
      expect(hostile() && bad() === 0, 'machine Overview: the label shows as text (' + bad() + ')');
      expect([...document.querySelectorAll('#disk-panel .dvol-name b')].some(b => b.textContent.includes('<img src=x onerror=alert(1)>')), 'in the volume title');
      location.hash = '#/problems'; await until(() => $('.prow'), 'problems');
      document.querySelectorAll('.prow').forEach(d => { d.open = true; }); await wait(100);
      expect(hostile() && bad() === 0, 'Problems: the label in the issue text shows as text (' + bad() + ')');
      location.hash = '#/nodes/homelab-nuc/problems'; await until(() => $('.prob'), 'machine problems'); await wait(100);
      expect(bad() === 0, 'machine Problems tab: no injected element (' + bad() + ')');
      await wait(300);
      expect(alerts === 0, 'alert was never called');
    },
    /* ---------------------------------------------------------------- phase 3: Agent and machine information */
    /* Cards: OS and version, Agent version, the update chip, the platform fallback. Open: ?drive=agentGallery#/nodes */
    async agentGallery() {
      await until(() => $('.card'), 'cards');
      const c = cardOf('studio-mini');
      expect(/macOS 15\.0 · aarch64/.test(c.querySelector('.card-sub').textContent), 'card shows OS name and version with the architecture: ' + c.querySelector('.card-sub').textContent);
      expect(/studio-mini\.lan/.test(c.querySelector('.card-host').textContent), 'card shows the hostname');
      expect(/Agent 0\.9\.0$/.test(c.querySelector('.agent-badge').textContent.trim()) && !c.querySelector('.chip--update'), 'an up-to-date Agent shows its version and no update chip');
      const o = cardOf('fedora-ws'), chip = o.querySelector('.chip--update');
      expect(chip && /Update available/.test(chip.textContent) && chip.querySelector('svg'), 'an outdated Agent has the Update available chip with an icon');
      expect(o.querySelector('.agent-badge.is-old') && /0\.9\.0-rc\.2/.test(o.querySelector('.agent-badge').textContent), 'its badge shows the old version in the warning style');
      expect(/Fedora Linux 44 · x86_64/.test(o.querySelector('.card-sub').textContent), 'Linux card shows Fedora Linux 44');
      expect(/Arch Linux · x86_64/.test(cardOf('gpu-box').querySelector('.card-sub').textContent), 'an OS without a version shows just its name: ' + cardOf('gpu-box').querySelector('.card-sub').textContent);
      const k = cardOf('kitchen-mini');
      expect(/^macOS · enrolled /.test(k.querySelector('.card-sub').textContent) && !k.querySelector('.card-host') && !k.querySelector('.chip--update'), 'no Agent report: falls back to the platform, no host line, no chip');
      expect(/macOS$/.test(k.querySelector('.agent-badge').textContent.trim()), 'no Agent report: badge shows the platform');
      document.querySelector('.retired').open = true; await wait(100);
      const r = cardOf('old-laptop');
      expect(r && !r.querySelector('.chip--update'), 'a revoked machine gets no update chip even though its Agent is outdated');
      expect($$('.chip--update').length === 4, 'four outdated Agents carry the chip: ' + $$('.chip--update').length);
    },
    /* Search matches OS, hostname and Agent version. Open: ?drive=agentSearch#/nodes */
    async agentSearch() {
      await until(() => $('#q'), 'search');
      type($('#q'), 'nuc.lab'); await wait(150);
      expect(names().join() === 'homelab-nuc', 'search by hostname finds homelab-nuc: ' + names());
      type($('#q'), 'Anas-MacBook'); await wait(150);
      expect(names().join() === 'laptop-ana', 'hostname search is case-insensitive: ' + names());
      type($('#q'), 'ubuntu 24.04'); await wait(150);
      expect(names().sort().join() === 'build-runner-01,build-runner-02,build-runner-03', 'search by OS name and version: ' + names());
      type($('#q'), 'rc.1'); await wait(150);
      expect(names().sort().join() === 'build-runner-03,mba-travel', 'search by Agent version: ' + names());
      type($('#q'), 'outdated'); await wait(150);
      expect(names().length === 4, 'search for "outdated" finds the four Agents with an update: ' + names());
      type($('#q'), 'x86_64 fedora'); await wait(150);
      expect(names().sort().join() === 'fedora-ws,homelab-nuc', 'several words must all match: ' + names());
      type($('#q'), 'nothing-like-this'); await wait(150);
      expect(/No machines match/.test($('#gallery-body').textContent) && /hostname/.test($('#gallery-body').textContent), 'empty result explains what can be searched');
      type($('#q'), 'studio-mini.lan'); await wait(150);
    },
    /* Group by OS and sort by outdated Agents. Open: ?drive=agentGroup#/nodes */
    async agentGroup() {
      await until(() => $('.card'), 'cards');
      click($('[data-act=group][data-v=os]')); await wait(150);
      const heads = secTitles();
      expect(heads.join('|') === 'Arch Linux:1|Fedora Linux:2|macOS:5|Ubuntu:3|OS not reported:2', 'groups by OS name, unreported last: ' + heads.join('|'));
      expect(/macOS 15\.1, 15\.0 and 14\.6/.test($('#sec-os-macos .gsec-head p')?.textContent || ''), 'a group lists its OS versions: ' + $('#sec-os-macos .gsec-head p')?.textContent);
      expect(/Agents before 0\.9\.0 do not send machine details/.test($('#sec-os-none')?.textContent || ''), 'the unreported group explains why');
      click($('[data-act=group][data-v=platform]')); await wait(150);
      expect(secTitles().join() === 'macOS:6,Linux:7', 'Platform grouping still works: ' + secTitles());
      click($('[data-act=group][data-v=status]')); await wait(100);
      expect([...$('#sort').options].some(o => o.value === 'outdated' && o.textContent === 'Outdated Agents first'), 'the sort is offered as "Outdated Agents first"');
      type($('#sort'), 'outdated'); await wait(150);
      const n = names();
      expect(n.slice(0, 4).sort().join() === 'build-runner-03,fedora-ws,laptop-ana,mba-travel', 'outdated Agents come first: ' + n.slice(0, 5));
      expect(/^Agent update available:4\|Needs attention:/.test(secTitles().join('|')), 'in their own section ahead of the health sections: ' + secTitles().join('|'));
      expect(!$$('#sec-attention .chip--update, #sec-ok .chip--update').length, 'and not repeated further down');
    },
    /* Header and Machine panel. Open: ?drive=agentNode#/nodes/studio-mini */
    async agentNode() {
      await until(() => $('#machine-panel .kv'), 'machine panel');
      const sub = $('.nhero-sub').textContent;
      expect(/studio-mini\.lan/.test(sub) && /signed in as joan/.test(sub) && /macOS 15\.0/.test(sub) && /aarch64/.test(sub), 'header line: host, user, OS, arch: ' + sub);
      const f = [...document.querySelectorAll('.facts > div')].find(d => d.querySelector('dt').textContent === 'Agent');
      expect(f && /0\.9\.0/.test(f.textContent) && /Homebrew/.test(f.textContent) && !f.querySelector('svg'), 'Agent fact shows version and install method, no warning: ' + f?.textContent);
      const want = { Hostname: 'studio-mini.lan', User: 'joan', 'Operating system': 'macOS 15.0', Kernel: '24.0.0', Architecture: 'aarch64', 'Install method': 'Homebrew', 'Service manager': 'launchd LaunchAgent', 'State directory': '~/.local/state/fleet-agent' };
      for (const [k, v] of Object.entries(want)) expect(kv(k) === v, `Machine panel ${k}: ${kv(k)}`);
      expect(/^0\.9\.0 latest release$/.test(kv('Agent version')), 'Agent version vs latest: ' + kv('Agent version'));
      expect(/UTC · /.test(kv('Reported')), 'reported time: ' + kv('Reported'));
      expect(!$('#agent-upgrade') && !$('#machine-panel .chip--update'), 'an up-to-date Agent has no callout and no chip');
      expect(/Agent is up to date/.test($('.hchecks').textContent), 'health check says the Agent is up to date');
      location.hash = '#/nodes/gpu-box'; await until(() => kv('Hostname') === 'gpu-box', 'gpu-box');
      expect(kv('Operating system') === 'Arch Linux' && kv('Service manager') === 'None (not run as a service)', 'null OS version and no service manager: ' + kv('Operating system') + ' / ' + kv('Service manager'));
      location.hash = '#/nodes/studio-mini'; await until(() => kv('Hostname') === 'studio-mini.lan', 'back');
    },
    /* Upgrade callout for each install method. Open: ?drive=agentUpgrade#/nodes/fedora-ws */
    async agentUpgrade() {
      const cmds = () => [...document.querySelectorAll('#agent-upgrade .cmd')].map(c => c.querySelector('button').dataset.copy);
      const t = () => $('#agent-upgrade').textContent;
      await until(() => $('#agent-upgrade'), 'callout');
      expect(/Update available: Agent 0\.9\.0-rc\.2 → 0\.9\.0/.test(t()), 'title names both versions: ' + t().slice(0, 60));
      expect(/Download the v0\.9\.0 archive, replace the binary at the same path and restart the service/.test(t()), 'binary: archive text');
      expect(cmds().join() === 'systemctl --user restart fleet-agent.service', 'binary on systemd: restart command ' + cmds());
      expect($('#agent-upgrade a')?.getAttribute('href') === 'https://github.com/jcarcaboso/fleet-manager/releases/tag/v0.9.0' && $('#agent-upgrade a').rel.includes('noopener'), 'binary: release link');
      expect(/Update available/.test($('#machine-panel .chip--update')?.textContent || '') && /latest 0\.9\.0/.test(kv('Agent version')), 'Agent version cell: chip and latest');
      const f = [...document.querySelectorAll('.facts > div')].find(d => d.querySelector('dt').textContent === 'Agent');
      expect(f.querySelector('svg') && /0\.9\.0 available/.test(f.textContent), 'header Agent fact warns: ' + f.textContent);
      expect(/Agent update available/.test($('.hchecks').textContent), 'health check warns');
      expect($('#agent-upgrade .cmd .copy')?.dataset.act === 'copy', 'the command has a copy button');
      location.hash = '#/nodes/mba-travel'; await until(() => $('#agent-upgrade[data-method=homebrew]'), 'homebrew callout');
      expect(cmds().join('|') === 'brew upgrade fleet-agent|brew services restart fleet-agent', 'Homebrew: brew upgrade, then restart: ' + cmds().join('|'));
      location.hash = '#/nodes/laptop-ana'; await until(() => $('#agent-upgrade[data-method=cargo]'), 'cargo callout');
      expect(cmds()[0] === 'cargo install --locked --force \\\n    --git https://github.com/jcarcaboso/fleet-manager \\\n    --tag v0.9.0 \\\n    fleet fleet-agent', 'Cargo: release-tag install command from cli-installation.md: ' + JSON.stringify(cmds()[0]));
      expect(cmds()[1] === 'launchctl kickstart -k "gui/$(id -u)/dev.fleet.agent"', 'Cargo on launchd: restart with the real label: ' + cmds()[1]);
      location.hash = '#/nodes/build-runner-03'; await until(() => $('#agent-upgrade[data-method=binary]') && kv('Hostname') === 'runner-03', 'binary without a service');
      expect(cmds().length === 0 && /restart the service/.test(t()), 'binary, no service manager: text only, no restart command');
      location.hash = '#/nodes/old-laptop'; await until(() => kv('Hostname') === 'old-laptop', 'revoked');
      expect(!$('#agent-upgrade') && !$('#machine-panel .chip--update'), 'a revoked machine gets no upgrade callout');
      location.hash = '#/nodes/fedora-ws'; await until(() => $('#agent-upgrade'), 'back to fedora-ws');
    },
    /* An Agent that never reported. Open: ?drive=agentNull#/nodes/kitchen-mini */
    async agentNull() {
      await until(() => $('#machine-panel'), 'machine panel');
      expect($('#machine-panel .machine-none')?.textContent === 'Not reported. Agents before 0.9.0 do not send machine details.', 'one quiet line: ' + $('#machine-panel').textContent);
      expect(!$('#machine-panel dl') && !$('#agent-upgrade'), 'no fields, no callout');
      expect(/macOS machine · enrolled/.test($('.nhero-sub').textContent), 'header falls back to the platform: ' + $('.nhero-sub').textContent);
      const f = [...document.querySelectorAll('.facts > div')].find(d => d.querySelector('dt').textContent === 'Agent');
      expect(f && /not reported/.test(f.textContent), 'Agent fact says not reported');
      expect(!/Agent (is up to date|update available)/.test($('.hchecks').textContent), 'no Agent health check');
      location.hash = '#/nodes/lab-vm-07'; await until(() => $('.machine-none') && /lab-vm-07/.test($('h1').textContent), 'lab-vm-07');
      expect($('.machine-none') && !$('#agent-upgrade'), 'a machine that never polled shows the same line');
    },
    /* A Server before phase 3 sends no agent property at all. Open: ?drive=agentOldServer&agent=0#/nodes */
    async agentOldServer() {
      await until(() => $('.card'), 'cards');
      expect(!$('.chip--update') && $$('.card-host').length === 0, 'cards: no chips, no host lines');
      expect(/^Linux · enrolled /.test(cardOf('fedora-ws').querySelector('.card-sub').textContent), 'cards fall back to the platform');
      click($('[data-act=group][data-v=os]')); await wait(100);
      expect(secTitles().join() === 'OS not reported:13', 'OS grouping puts everything under "not reported"');
      location.hash = '#/nodes/fedora-ws'; await until(() => $('.machine-none'), 'node page');
      expect(!$('#agent-upgrade'), 'node page: not reported line, no callout');
      location.hash = '#/problems'; await until(() => $('.prow'), 'problems');
      expect(![...document.querySelectorAll('.prow b')].some(b => /Agent is outdated/.test(b.textContent)), 'no agent_outdated issue');
    },
    /* agent_outdated on Problems and on the machine. Open: ?drive=agentProblems#/problems */
    async agentProblems() {
      await until(() => $('.prow'), 'problems');
      const rows = [...document.querySelectorAll('.prow')].filter(r => /Agent is outdated/.test(r.querySelector('b').textContent));
      expect(rows.length === 4, 'one issue per outdated, non-revoked machine: ' + rows.length);
      rows.forEach(r => { r.open = true; }); await wait(100);
      const r = rows.find(x => /fedora-ws/.test(x.textContent));
      expect(/Warning/.test(r.querySelector('summary').textContent) && /fedora-ws: Agent is outdated/.test(r.querySelector('b').textContent), 'warning with the title');
      expect(/lower than the Server/.test(r.querySelector('.prob-expl').textContent) && /runs version 0\.9\.0-rc\.2; the latest version is 0\.9\.0/.test(r.querySelector('.prob-expl').textContent), 'catalog text and the specific detail: ' + r.querySelector('.prob-expl').textContent);
      const steps = [...r.querySelectorAll('.fix li')].map(l => l.textContent);
      expect(/release archive/.test(steps[0]) && steps.length === 6, 'the action for the install method comes first, then the catalog steps: ' + steps.length);
      expect([...r.querySelectorAll('.cmd code')].map(c => c.textContent).join() === 'fleet nodes show fedora-ws', 'command: fleet nodes show');
      const h = rows.find(x => /mba-travel/.test(x.textContent));
      expect(/Upgrade with brew upgrade fleet-agent/.test(h.querySelector('.fix li').textContent), 'Homebrew machine: the action is the first step');
      const c = rows.find(x => /laptop-ana/.test(x.textContent));
      expect(/--tag v0\.9\.0/.test(c.querySelector('.fix li').textContent), 'Cargo machine: action has the release tag');
      expect(!document.body.textContent.includes('old-laptop: Agent is outdated'), 'revoked machine has no issue');
      location.hash = '#/nodes/fedora-ws/problems'; await until(() => $('.prob h3'), 'machine problems');
      const p = [...document.querySelectorAll('.prob')].find(x => /Agent is outdated/.test(x.querySelector('h3').textContent));
      expect(p && /release archive/.test(p.querySelector('.fix').textContent) && /fleet nodes show fedora-ws/.test(p.textContent), 'machine Problems tab shows it too');
      expect(/Problems\s*\d/.test($('.tabs').textContent), 'the Problems tab counts it');
    },
    /* Hostile hostname, OS name, user and state directory. Open: ?drive=agentXss&xss=1#/nodes */
    async agentXss() {
      let alerts = 0; window.alert = () => { alerts++; };
      const bad = () => document.querySelectorAll('#root img, #root script, #root svg[onload], #root [onerror], #root [onclick], #root [onload]').length;
      const shown = s => document.body.textContent.includes(s);
      await until(() => $('.card'), 'cards');
      expect(shown('<img src=x onerror=alert(1)>.lab') && bad() === 0, 'gallery card: hostname is text (' + bad() + ')');
      type($('#q'), 'onerror'); await wait(150);
      expect(names().join() === 'homelab-nuc', 'the hostile hostname is searchable as text: ' + names());
      type($('#q'), '');
      click($('[data-act=group][data-v=os]')); await wait(150);
      expect(shown('<svg onload=alert(7)> Linux') && bad() === 0, 'OS grouping: the hostile OS name is a title as text (' + bad() + ')');
      location.hash = '#/nodes/homelab-nuc'; await until(() => $('#machine-panel .kv'), 'node page');
      expect(bad() === 0 && kv('Hostname') === '<img src=x onerror=alert(1)>.lab' && kv('User').includes('<script>') && kv('Operating system').startsWith('<svg onload=alert(7)> Linux') && kv('State directory').includes('<img'), 'Machine panel shows every hostile value as text (' + bad() + ')');
      expect($('.nhero-sub').textContent.includes('<img src=x onerror=alert(1)>.lab') && bad() === 0, 'header line is text');
      await wait(300);
      expect(alerts === 0, 'alert was never called');
    },
    async none() {},
  };
  window.addEventListener('DOMContentLoaded', () => document.body.append(log));
  window.addEventListener('load', async () => {
    await wait(600);
    try { await (S[scenario] || S.none)(); out(true, `scenario ${scenario} finished`); } catch (e) { out(false, 'driver threw: ' + e.message); }
    log.dataset.done = '1';
  });
})();
