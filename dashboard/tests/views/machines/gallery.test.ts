/**
 * The Machines gallery against the mock API. Ports of the scenarios of the old drive.js: diskGallery, agentGallery, agentSearch,
 * agentGroup, agentOldServer, agentXss, diskXss (gallery part), depGallery, depNull (gallery part), p4Xss (gallery tile), search,
 * scopeRead, sync, expire, plus the loading, empty, error and scope states.
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MachinesHero from '@/views/Machines/MachinesHero.vue';
import { componentHarness, mountApp, textOf, waitFor, type TestApp } from '../../helpers/app';
import { installIntersectionObserver } from './ioDouble';

let app: TestApp | undefined;
afterEach(() => { app?.unmount(); app = undefined; vi.useRealTimers(); });

const open = async (mock: Parameters<typeof mountApp>[0] extends infer O ? (O extends { mock?: infer M } ? M : never) : never = {}): Promise<TestApp> => {
  installIntersectionObserver(() => false); // strips have their own tests
  app = await mountApp({ path: '/machines', mock });
  await waitFor(() => app!.wrapper.find('.card') .exists() || app!.wrapper.find('.empty').exists());
  return app;
};
const $ = (sel: string): Element | null => document.querySelector(sel);
const $$ = (sel: string): Element[] => [...document.querySelectorAll(sel)];
const cardOf = (alias: string): Element | undefined => $$('.card').find(c => c.querySelector('h3')?.textContent === alias);
const names = (): string[] => $$('.card h3').map(h => h.textContent ?? '');
const secTitles = (): string[] => $$('.gsec h2').map(h => { const c = h.cloneNode(true) as Element; c.querySelectorAll('.cnt,.gsec-ic').forEach(x => x.remove()); return `${c.textContent?.trim()}:${h.querySelector('.cnt')?.textContent}`; });
const search = async (text: string): Promise<void> => { await app!.wrapper.find('#q').setValue(text); await flushPromises(); };
const group = async (key: string): Promise<void> => { await app!.wrapper.find(`[data-act=group][data-v=${key}]`).trigger('click'); await flushPromises(); };
const sort = async (key: string): Promise<void> => { await app!.wrapper.find('#sort').setValue(key); await flushPromises(); };
const injected = (): number => document.querySelectorAll('#root img, #root script, #root svg[onload], #root [onerror], #root [onclick], #root [onload]').length;

describe('states', () => {
  it('shows the loading skeleton until the machines arrive, then the gallery', async () => {
    installIntersectionObserver(() => false);
    app = await mountApp({ path: '/machines', mock: { slow: 150 } });
    expect(app.wrapper.find('#view .skel').exists()).toBe(true);
    expect(app.wrapper.find('.card').exists()).toBe(false);
    await waitFor(() => app!.wrapper.find('.card').exists(), { timeout: 4000 });
    expect(app.wrapper.find('#view .skel').exists()).toBe(false);
    expect(app.wrapper.find('h1').text()).toMatch(/of 13 machines are up to date/);
  });

  it('with no machines says so, offers Add machine, and has a single h1', async () => {
    await open({ empty: true });
    expect($('.empty h1')?.textContent).toBe('No machines yet');
    expect(textOf($('.empty'))).toContain('Create an enrollment link, then run the Agent on a machine to add it to Fleet.');
    expect($('.health')).toBeNull();
    expect($('#q')).toBeNull();
    expect($$('h1')).toHaveLength(1);
    await app!.wrapper.find('.empty .btn-primary').trigger('click');
    await flushPromises();
    expect(app!.ctx.wizard.open).toBe(true);
    expect($('.modal')).not.toBeNull();
  });

  it('a read scope sees a locked Add machine on the empty page, with the reason, and nothing opens', async () => {
    await open({ empty: true, scope: 'read' });
    const btn = $('.empty .btn-primary') as HTMLElement;
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.dataset.tip).toContain('Needs the admin scope. Your account has read access.');
    expect(textOf($('.empty .lock-note'))).toBe('Needs the admin scope. Your account has read access.');
    btn.click();
    await flushPromises();
    expect(app!.ctx.wizard.open).toBe(false);
    expect(textOf($('.toast'))).toContain('Not available');
  });

  it('a failing machine list is an error page with Try again, which loads again', async () => {
    await open({ fail: 'nodes' });
    expect($('.empty--error h1')?.textContent).toBe('Could not load Machines');
    expect($('.card')).toBeNull();
    app!.mock.options.fail = null;
    await app!.wrapper.find('.empty--error button').trigger('click');
    await waitFor(() => $('.card'));
    expect($('.empty--error')).toBeNull();
  });

  it('a failing extra read degrades the page instead of failing it', async () => {
    await open({ fail: 'cliproxy/status' });
    expect($$('.card').length).toBeGreaterThan(0);
    expect(textOf($$('.tile')[2])).toContain('Open to see CLIProxy catalogs');
    await app!.unmount();
    await open({ fail: 'enrollment-links' });
    expect(textOf($$('.tile')[3])).toContain('Open to see links');
  });
});

describe('cards', () => {
  it('disk meters: states, words, icons, bars and binary units (diskGallery)', async () => {
    await open();
    const meterOf = (alias: string): Element | null | undefined => cardOf(alias)?.querySelector('.diskm');
    const nuc = meterOf('homelab-nuc')!;
    expect(nuc.classList.contains('diskm--critical') && /96\.4% used/.test(nuc.textContent!) && /Nearly full/.test(nuc.textContent!)).toBe(true);
    expect(nuc.querySelector('.diskm-state svg.g')).not.toBeNull();
    expect((nuc.querySelector('.meter.m-critical > span') as HTMLElement).style.width).toBe('96.4%');
    expect(nuc.textContent).toMatch(/33\.3 GiB free of 954\.0 GiB/);
    const fed = meterOf('fedora-ws')!;
    expect(fed.classList.contains('diskm--warning') && /Filling up/.test(fed.textContent!) && !!fed.querySelector('.meter.m-warning')).toBe(true);
    const mbp = meterOf('mbp-joan')!;
    expect(mbp.classList.contains('diskm--good') && /Enough space/.test(mbp.textContent!) && !!mbp.querySelector('.meter.m-good')).toBe(true);
    expect(meterOf('gpu-box')!.classList.contains('diskm--warning')).toBe(true); // exactly 85.0%
    expect(meterOf('design-imac')!.classList.contains('diskm--good')).toBe(true); // 83.9%
    expect(meterOf('build-runner-02')!.textContent).toContain('No disk data');
    expect(meterOf('build-runner-02')!.querySelector('.meter')).toBeNull();
    expect(meterOf('kitchen-mini')!.textContent).toContain('No disk data');
    expect($$('.diskm').every(m => !!m.querySelector('svg.g'))).toBe(true);
    expect(meterOf('homelab-nuc')!.querySelector('.meter')!.getAttribute('aria-label')).toBe('Disk 96.4% used, Nearly full');
    expect(meterOf('homelab-nuc')!.querySelector('.diskm-sub')!.getAttribute('data-tip')).toMatch(/^Measured .*\|.* UTC$/);
  });

  it('a revoked machine has no disk meter, and its strip slot says Revoked', async () => {
    await open();
    await app!.wrapper.find('details.retired').element.setAttribute('open', '');
    const old = cardOf('old-laptop')!;
    expect(old.querySelector('.diskm')).toBeNull();
    expect(old.querySelector('.strip-slot')!.textContent).toBe('Revoked');
    expect(old.querySelector('[data-strip-slot]')).toBeNull();
    expect(old.querySelector('[data-strip-total]')!.textContent).toBe('—');
  });

  it('disk thresholds put machines in Needs attention, ranked critical with failures and warnings below offline (diskGallery)', async () => {
    await open();
    const section = (id: string): Element | null => document.getElementById(id);
    const inAttention = (alias: string): boolean => !!section('sec-attention')?.contains(cardOf(alias) ?? null);
    expect(inAttention('homelab-nuc') && inAttention('fedora-ws') && inAttention('gpu-box')).toBe(true);
    expect(section('sec-ok')?.contains(cardOf('homelab-nuc') ?? null)).toBe(false);
    expect(inAttention('mbp-joan')).toBe(false);
    expect($('.health-sub')!.textContent).toMatch(/3 have a disk that is 85% full or more/);
    const order = [...section('sec-attention')!.querySelectorAll('.card h3')].map(h => h.textContent);
    expect(order.indexOf('homelab-nuc')).toBeLessThan(order.indexOf('build-runner-03'));
    expect(order.indexOf('build-runner-03')).toBeLessThan(order.indexOf('gpu-box'));
  });

  it('"Fullest disk first" sorts by used percent, machines without data last (diskGallery)', async () => {
    await open();
    const opts = $$('#sort option');
    expect(opts.some(o => (o as HTMLOptionElement).value === 'disk' && o.textContent === 'Fullest disk first')).toBe(true);
    await sort('disk');
    const att = [...document.getElementById('sec-attention')!.querySelectorAll('.card')].map(c => ({ n: c.querySelector('h3')!.textContent, p: parseFloat(c.querySelector('.diskm-k b')?.textContent ?? '') }));
    expect(att[0]!.n).toBe('homelab-nuc');
    const nums = att.filter(x => !Number.isNaN(x.p));
    expect(nums.every((x, i, a) => !i || a[i - 1]!.p >= x.p)).toBe(true);
    expect(Number.isNaN(att[att.length - 1]!.p)).toBe(true);
  });

  it('shows the OS, architecture, hostname and Agent version, and the update chip only for outdated Agents (agentGallery)', async () => {
    await open();
    const c = cardOf('studio-mini')!;
    expect(c.querySelector('.card-sub')!.textContent).toMatch(/macOS 15\.0 · aarch64/);
    expect(c.querySelector('.card-host')!.textContent).toMatch(/studio-mini\.lan/);
    expect(c.querySelector('.agent-badge')!.textContent!.trim()).toMatch(/Agent 0\.9\.0$/);
    expect(c.querySelector('.chip--update')).toBeNull();
    const o = cardOf('fedora-ws')!;
    const chip = o.querySelector('.chip--update')!;
    expect(chip.textContent).toMatch(/Update available/);
    expect(chip.querySelector('svg')).not.toBeNull();
    expect(o.querySelector('.agent-badge.is-old')).not.toBeNull();
    expect(o.querySelector('.agent-badge')!.textContent).toMatch(/0\.9\.0-rc\.2/);
    expect(o.querySelector('.card-sub')!.textContent).toMatch(/Fedora Linux 44 · x86_64/);
    expect(cardOf('gpu-box')!.querySelector('.card-sub')!.textContent).toMatch(/Arch Linux · x86_64/);
    const k = cardOf('kitchen-mini')!;
    expect(k.querySelector('.card-sub')!.textContent).toMatch(/^macOS · enrolled /);
    expect(k.querySelector('.card-host')).toBeNull();
    expect(k.querySelector('.chip--update')).toBeNull();
    expect(k.querySelector('.agent-badge')!.textContent!.trim()).toMatch(/macOS$/);
    (document.querySelector('.retired') as HTMLDetailsElement).open = true;
    await flushPromises();
    expect(cardOf('old-laptop')!.querySelector('.chip--update')).toBeNull();
    expect($$('.chip--update'), 'build-runner-03 shows its failed update instead').toHaveLength(3);
    const failed = cardOf('build-runner-03')!;
    expect(failed.querySelector('.chip--update-failed')!.textContent).toBe('Update to 0.9.0 failed');
    expect(failed.querySelector('.agent-badge.is-failed')!.getAttribute('data-tip')).toBe('Agent 0.9.0-rc.1|Update to 0.9.0 failed');
    expect(o.querySelector('.agent-badge')!.getAttribute('data-tip')).toBe('Agent 0.9.0-rc.2|Update available');
  });

  it('a Server before phase 3 has no chips, no host lines, falls back to the platform and groups everything as not reported (agentOldServer)', async () => {
    await open({ agent: false });
    expect($('.chip--update')).toBeNull();
    expect($$('.card-host')).toHaveLength(0);
    expect(cardOf('fedora-ws')!.querySelector('.card-sub')!.textContent).toMatch(/^Linux · enrolled /);
    await group('os');
    expect(secTitles()).toEqual(['OS not reported:13']);
  });

  it('shows a state chip per Assignment state, with the word hidden for sighted users but present for screen readers', async () => {
    await open();
    const chips = [...cardOf('design-imac')!.querySelectorAll('.chips .chip')];
    expect(chips.map(c => textOf(c))).toEqual(['Failed: 2 failed', 'In sync: 1 in sync']);
    expect(chips[0]!.querySelector('.sr')!.textContent).toBe('Failed: ');
    expect(chips[0]!.querySelector('svg.g')).not.toBeNull();
  });

  it('card links go to the machine, and failing machines go to its Problems tab', async () => {
    await open();
    const nuc = cardOf('homelab-nuc')!;
    expect(nuc.querySelector('h3 a')!.getAttribute('href')).toBe('/machines/homelab-nuc');
    expect(nuc.querySelector('a.reason')!.getAttribute('href')).toBe('/machines/homelab-nuc');
    const design = cardOf('design-imac')!;
    expect(design.querySelector('a.reason')!.getAttribute('href')).toBe('/machines/design-imac/problems');
  });

  it('an alias with a slash and a percent sign is encoded as one path segment', async () => {
    await open({ weirdAlias: true });
    const href = cardOf('rack/A 100%')!.querySelector('h3 a')!.getAttribute('href');
    expect(href).toBe('/machines/rack%2FA%20100%25');
  });
});

describe('search, grouping and sorting', () => {
  it('filters machines and shows the empty search state, which Clear search resets and focuses (search)', async () => {
    await open();
    await search('linux');
    expect($('#gallery-body')!.textContent).not.toMatch(/design-imac/);
    await search('zzzz');
    expect($('#gallery-body')!.textContent).toMatch(/No machines match “zzzz”/);
    expect($('.empty h2')!.textContent).toBe('No machines match “zzzz”');
    await app!.wrapper.find('[data-act=clear-search]').trigger('click');
    await flushPromises();
    expect((app!.wrapper.find('#q').element as HTMLInputElement).value).toBe('');
    expect($$('.card').length).toBeGreaterThan(5);
  });

  it('searches hostname, OS and version, Agent version, "outdated", several words, and explains an empty result (agentSearch)', async () => {
    await open();
    await search('nuc.lab');
    expect(names().join()).toBe('homelab-nuc');
    await search('Anas-MacBook');
    expect(names().join()).toBe('laptop-ana');
    await search('ubuntu 24.04');
    expect(names().sort().join()).toBe('build-runner-01,build-runner-02,build-runner-03');
    await search('rc.1');
    expect(names().sort().join()).toBe('build-runner-03,mba-travel');
    await search('outdated');
    expect(names()).toHaveLength(4);
    await search('x86_64 fedora');
    expect(names().sort().join()).toBe('fedora-ws,homelab-nuc');
    await search('nothing-like-this');
    expect($('#gallery-body')!.textContent).toMatch(/No machines match/);
    expect($('#gallery-body')!.textContent).toMatch(/hostname/);
    await search('studio-mini.lan');
    expect(names()).toEqual(['studio-mini']);
  });

  it('searches the status label and the platform', async () => {
    await open();
    await search('offline');
    expect(names().sort()).toEqual(['build-runner-03', 'mba-travel']);
    await search('macos');
    expect(names().length).toBeGreaterThan(3);
  });

  it('groups by OS (versions, "OS not reported" last), by platform, and by status again; offers and applies "Outdated Agents first" (agentGroup)', async () => {
    await open();
    await group('os');
    expect(secTitles().join('|')).toBe('Arch Linux:1|Fedora Linux:2|macOS:5|Ubuntu:3|OS not reported:2');
    expect($('#sec-os-macos .gsec-head p')!.textContent).toMatch(/macOS 15\.1, 15\.0 and 14\.6/);
    expect($('#sec-os-none')!.textContent).toMatch(/Agents before 0\.9\.0 do not send machine details/);
    await group('platform');
    expect(secTitles().join()).toBe('macOS:6,Linux:7');
    await group('status');
    expect($$('#sort option').some(o => (o as HTMLOptionElement).value === 'outdated' && o.textContent === 'Outdated Agents first')).toBe(true);
    await sort('outdated');
    const n = names();
    expect(n.slice(0, 4).sort().join()).toBe('build-runner-03,fedora-ws,laptop-ana,mba-travel');
    expect(secTitles().join('|')).toMatch(/^Agent update available:4\|Needs attention:/);
    expect($$('#sec-attention .chip--update, #sec-ok .chip--update')).toHaveLength(0);
    expect(app!.wrapper.find('[data-act=group][data-v=status]').attributes('aria-pressed')).toBe('true');
  });

  it('sorts by name and by last seen', async () => {
    await open();
    await sort('name');
    const inSection = [...document.getElementById('sec-attention')!.querySelectorAll('.card h3')].map(h => h.textContent!);
    expect(inSection).toEqual([...inSection].sort((a, b) => a.localeCompare(b)));
    await sort('seen');
    const seen = [...document.getElementById('sec-attention')!.querySelectorAll('.card .seen')].map(s => s.textContent);
    expect(seen[0]).toMatch(/^Seen (just now|\d+ s ago)/);
  });

  it('keeps the grouping, the sort and the search when the page is visited again (as the old module-level state did)', async () => {
    await open();
    await group('platform');
    await sort('name');
    await search('mac');
    const shown = names();
    expect(shown.length).toBeGreaterThan(0);
    await app!.go('/audit');
    await app!.go('/machines');
    await waitFor(() => $('.card'));
    expect(secTitles().join()).toBe('macOS:6');
    expect((app!.wrapper.find('#sort').element as HTMLSelectElement).value).toBe('name');
    expect((app!.wrapper.find('#q').element as HTMLInputElement).value).toBe('mac');
    expect(names()).toEqual(shown);
  });

  it('a link that was created clears the search so the new machine is visible; a revoked link leaves it alone', async () => {
    await open();
    await search('mac');
    app!.ctx.enrollmentBus.revoked('00000000-0000-4000-8000-000000000001');
    await app!.settle();
    expect((app!.wrapper.find('#q').element as HTMLInputElement).value, 'a late revoke').toBe('mac');
    expect(app!.mock.calls.filter(c => c.path === 'nodes').length, 'but the lists reload').toBeGreaterThan(1);
    app!.ctx.enrollmentBus.linkCreated();
    await app!.settle();
    expect((app!.wrapper.find('#q').element as HTMLInputElement).value, 'a created link').toBe('');
    expect(app!.ctx.gallery.search).toBe('');
  });

  it('signing out forgets the search (and the grouping and sort stay: they are only a layout)', async () => {
    await open();
    await group('platform');
    await search('mac');
    await app!.ctx.session.logout();
    await waitFor(() => app!.router.currentRoute.value.name === 'login'); // the redirect loads the sign-in view lazily
    await app!.settle();
    expect(app!.ctx.gallery).toMatchObject({ search: '', groupBy: 'platform' });
    await app!.signIn();
    await app!.go('/machines');
    await waitFor(() => $('.card'));
    expect((app!.wrapper.find('#q').element as HTMLInputElement).value).toBe('');
  });

  it('the page /machines?add=1 (the old #/add bookmark) opens the Add machine wizard and cleans the address', async () => {
    installIntersectionObserver(() => false);
    app = await mountApp({ path: '/machines?add=1' });
    await waitFor(() => app!.ctx.wizard.open);
    await waitFor(() => $('.modal'));
    expect(app.router.currentRoute.value.fullPath).toBe('/machines');
    expect($('.modal h2')?.textContent).toBe('Name your new machine');
  });

  it('lists revoked machines in a Retired section that stays open across repaints', async () => {
    await open();
    const d = $('details.retired') as HTMLDetailsElement;
    expect(d.textContent).toContain('Retired');
    expect(d.textContent).toContain('Revoked machines keep their alias reserved. Remove one on its Settings tab to free the alias.');
    expect(d.open).toBe(false);
    d.open = true;
    d.dispatchEvent(new Event('toggle'));
    await search('old');
    expect((document.querySelector('details.retired') as HTMLDetailsElement).open).toBe(true);
  });

  it('shows a note when the list was cut off', async () => {
    await open({ pageSize: 2 });
    // five pages of two machines cannot hold 14 machines
    expect($('.note')!.textContent).toBe('Showing the first 10 machines. Narrow the list with search to find others.');
  });
});

describe('health summary and tiles', () => {
  it('summarises health, with machine names in the bar tooltips and a jump from the legend', async () => {
    await open();
    expect($('.eyebrow')!.textContent).toMatch(/^Good (morning|afternoon|evening), joan · Fleet health$/);
    expect($('h1')!.textContent).toBe('3 of 13 machines are up to date');
    expect($('.health-sub')!.textContent).toBe('3 are updating, 7 need your attention and 3 have a disk that is 85% full or more. 4 have problems Fleet cannot fix on its own.');
    expect($('.segbar')!.getAttribute('aria-label')).toBe('Machines by health: 3 Up to date, 3 Updating, 3 Offline, 4 Action needed');
    expect(($$('.segbar .seg')[0] as HTMLElement).dataset.tip).toBe('3 machines|Up to date\nhomelab-nuc, laptop-ana, build-runner-01');
    expect($$('.legend .lg-btn').map(b => textOf(b))).toEqual(['Up to date3', 'Updating3', 'Offline3', 'Action needed4']);
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    await group('platform');
    await app!.wrapper.findAll('.legend .lg-btn')[0]!.trigger('click');
    await flushPromises();
    expect(secTitles().join('|')).toMatch(/^Needs attention/);
    expect(scroll).toHaveBeenCalled();
  });

  it('shows the four tiles with their current state (depGallery, depNull)', async () => {
    await open();
    const tiles = $$('.tile');
    expect(tiles.map(t => t.getAttribute('href'))).toEqual(['/deployments', '/repository', '/models', '/enrollment']);
    expect(textOf(tiles[0])).toContain('Deploying a3f9c21');
    expect(textOf(tiles[0])).toContain('31 of 43 assignments done');
    expect($('.tile-meter')!.getAttribute('aria-label')).toBe('31 of 43 assignments succeeded');
    expect(textOf(tiles[1])).toMatch(/RepositoryUp to date · scanned 5 min ago/);
    expect(textOf(tiles[2])).toContain('1 of 2 catalogs failing');
    expect(tiles[2]!.querySelector('svg.g')).not.toBeNull();
    expect(textOf(tiles[3])).toMatch(/1 link active · lab-vm-08 expires in \d+ min/);
  });

  it('the deployment tile and the Up to date section name the commit subject, author in the tooltip (depGallery)', async () => {
    await open();
    const rev = app!.mock.data.revisions[0] as { message: string };
    expect($('.tile-commit')!.textContent).toBe(rev.message);
    expect($('.tile-txt b')!.textContent).toMatch(/Deploying a3f9c21|Latest revision a3f9c21/);
    expect(($('.tile-commit') as HTMLElement).dataset.tip).toContain('by joan');
    expect(document.body.textContent).toContain(`“${rev.message}”`);
  });

  it('without commit metadata the tile has no commit line (depNull)', async () => {
    await open({ commit: false });
    expect($('.tile-commit')).toBeNull();
    const rev = app!.mock.data.revisions[0] as { message: string };
    expect(document.body.textContent).not.toContain(rev.message);
  });

  it('the repository and models tiles warn when the last scan failed or a catalog fails, and say so when nothing is configured', async () => {
    const h = await componentHarness();
    const base = { live: [], healthOf: () => ({}) as never, rev: null, links: null, syncing: false };
    const scan = (outcome: string) => ({ sourceRevision: 'a3f9c21', outcome, code: null, diagnostic: null, observedAt: new Date(Date.now() - 300_000).toISOString(), requestedBy: null }) as never;
    const w = mount(MachinesHero, { global: h.global, props: { ...base, source: scan('failed'), proxy: { enabled: false, intervalSeconds: 60, errorCode: null, catalogs: [] } } });
    const tiles = w.findAll('.tile');
    expect(tiles[1]!.text()).toContain('Last scan failed · scanned 5 min ago');
    expect(tiles[1]!.find('.tile-g').exists()).toBe(true);
    expect(tiles[1]!.find('.tile-ic').classes()).toContain('t-warning');
    expect(tiles[2]!.text()).toContain('Model sync is not configured');
    await w.setProps({ source: scan('invalid'), proxy: { enabled: true, intervalSeconds: 60, errorCode: null, catalogs: [] } });
    expect(w.findAll('.tile')[1]!.text()).toContain('Last scan was rejected');
    expect(w.findAll('.tile')[2]!.text()).toContain('No CLIProxy catalogs in use');
    await w.setProps({ source: null });
    expect(w.findAll('.tile')[1]!.text()).toContain('No scans recorded yet');
    expect(w.find('.health-actions .muted').text()).toBe('No repository scan yet');
    expect(w.find('h1').text()).toBe('No machines yet');
    w.unmount();
    h.cleanup();
  });
});

describe('scope', () => {
  it('a read token sees locked Sync and Add machine, explained, and a click only explains (scopeRead)', async () => {
    await open({ scope: 'read' });
    const locked = $$('.is-locked');
    expect(locked.length).toBeGreaterThan(0);
    expect(locked.every(b => b.getAttribute('aria-disabled') === 'true' && !!(b as HTMLElement).dataset.tip)).toBe(true);
    expect(textOf($('.health-actions .lock-note'))).toBe('Read access: sync and add are unavailable.');
    (locked[0] as HTMLElement).click();
    await flushPromises();
    expect($('.toast')!.textContent).toMatch(/Needs the/);
    expect(app!.mock.calls.filter(c => c.method !== 'GET')).toHaveLength(0);
    expect(app!.ctx.wizard.open).toBe(false);
  });

  it('an operate token can sync but not add machines', async () => {
    await open({ scope: 'operate' });
    expect(textOf($('.health-actions .lock-note'))).toBe('Operate access: adding machines is unavailable.');
    const [syncBtn, addBtn] = $$('.health-actions .btn-row .btn');
    expect(syncBtn!.textContent).toContain('Sync repository');
    expect(syncBtn!.classList.contains('is-locked')).toBe(false);
    expect(addBtn!.textContent).toContain('Add machine');
    expect(addBtn!.classList.contains('is-locked')).toBe(true);
  });

  it('an admin sees no lock note', async () => {
    await open();
    expect($('.health-actions .lock-note')).toBeNull();
  });
});

describe('actions', () => {
  it('Sync repository runs once, shows Syncing…, reports in a toast and reloads the gallery quietly (sync)', async () => {
    await open();
    const before = app!.mock.calls.filter(c => c.path === 'nodes').length;
    await app!.wrapper.find('[data-act=sync]').trigger('click');
    expect($('[data-act=sync]')!.textContent).toContain('Syncing…');
    expect(($('[data-act=sync]') as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => /up to date/i.test($('.toast-host, .toasts')?.textContent ?? document.body.textContent ?? ''));
    await waitFor(() => !app!.ctx.shared.syncing);
    await waitFor(() => app!.mock.calls.filter(c => c.path === 'nodes').length > before);
    expect(app!.mock.calls.filter(c => c.method === 'POST' && c.path === 'source/rescan')).toHaveLength(1);
    expect($('[data-act=sync]')!.textContent).toContain('Sync repository');
    expect($$('.card').length).toBeGreaterThan(5); // the page stayed up during the quiet reload
  });

  it('a session that ended makes the next action go to the sign-in page with a notice (expire)', async () => {
    await open();
    app!.mock.state.signedIn = false;
    await app!.wrapper.find('[data-act=sync]').trigger('click');
    await waitFor(() => app!.router.currentRoute.value.name === 'login');
    await app!.settle();
    expect(document.body.textContent).toMatch(/session ended/i);
  });

  it('Add machine opens the wizard', async () => {
    await open();
    await app!.wrapper.find('.health-actions [data-act=add]').trigger('click');
    await flushPromises();
    expect($('.modal h2')!.textContent).toBe('Name your new machine');
  });
});

describe('hostile strings are text (agentXss, diskXss, p4Xss)', () => {
  it('shows the hostile hostname, OS name, volume label and commit subject as text, with no injected element', async () => {
    let alerts = 0;
    vi.stubGlobal('alert', () => { alerts++; });
    await open({ xss: true });
    expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>.lab');
    expect(injected()).toBe(0);
    expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>'); // the volume label
    await search('onerror');
    expect(names().join()).toBe('homelab-nuc'); // searchable as text
    await search('');
    await group('os');
    expect(document.body.textContent).toContain('<svg onload=alert(7)> Linux');
    expect(injected()).toBe(0);
    await group('status');
    const tile = $('.tile-commit') as HTMLElement;
    expect(tile.textContent).toContain('<img src=x onerror=alert(1)>');
    tile.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    await flushPromises();
    expect(document.querySelector('#tip img, .tip img')).toBeNull();
    expect(injected()).toBe(0);
    expect(alerts).toBe(0);
  });
});
