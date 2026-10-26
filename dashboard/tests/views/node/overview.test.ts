/**
 * The header, Overview, Installed, Security and Settings tabs, and scope gating across the page. Ports of the Dev/drive.js scenarios
 * range, scopeRead, scan (the machine page), plus health checks, certificate states, check-in charts, old-Agent and empty variants.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tooltip } from '@/composables/tooltip';
import { FAKE_TIMERS, openNode, patchNodeResponse, stray, type NodeTest } from './helpers';
import { textOf } from '../../helpers/app';

let t: NodeTest | undefined;
afterEach(() => { t?.unmount(); t = undefined; vi.useRealTimers(); });

const check = (title: string) => t!.findAll('.hchecks li').find(l => l.find('b').text() === title);
const checkTitles = () => t!.findAll('.hchecks b').map(b => b.text());
const heroFact = (label: string) => t!.findAll('.nhero .facts > div').find(d => d.find('dt').text() === label);
const node = (alias: string) => t!.app.mock.nodes.find(n => n.alias === alias)!;
const HOUR = 36e5;

describe('the header', () => {
  it('shows the name, the health pill, the reason (a link to the tab that explains it), the facts and the actions', async () => {
    t = await openNode('/machines/studio-mini');
    expect(t.exists('.nhero--failing')).toBe(true);
    expect(t.text('.nhero-top .pill')).toBe('Action needed');
    const reason = t.find('.nhero a.reason');
    expect(reason.text()).toBe('AI client configuration could not be updated');
    expect(reason.attributes('href'), 'a failing machine points at Problems').toBe('/machines/studio-mini/problems');
    expect(reason.classes()).toEqual(expect.arrayContaining(['reason--lg', 'reason--critical']));
    expect(heroFact('Last check-in')!.text()).toMatch(/^Last check-in.* ago.* UTC$/);
    expect(heroFact('Revision')!.text()).toBe('Revisiona3f9c214 of 5 Targets in sync');
    expect(heroFact('Certificate')!.text()).toMatch(/^Certificate\d+ d \d+ h leftuntil .* UTC$/);
    expect(heroFact('Certificate')!.find('.meter.m-good').attributes('role')).toBe('img');
    expect(heroFact('Certificate')!.find('.meter').attributes('aria-label')).toMatch(/^Certificate: \d+ d \d+ h left$/);
    expect((heroFact('Certificate')!.find('.meter span').element as HTMLElement).style.width).toMatch(/^\d+\.\d%$/);
    expect(heroFact('Targets')!.text()).toBe('Targets54 succeeded and 1 failed');
    expect(heroFact('Enrolled')!.text()).toMatch(/^EnrolledSep 18\d+ days ago$/);
    const actions = t.findAll('.nhero-actions > *');
    expect(actions.map(a => a.text())).toEqual(['Fix 1 problem', 'Rename', 'Revoke', 'Remove']);
    expect(actions[0]!.attributes('href')).toBe('/machines/studio-mini/problems');
    expect(actions[1]!.attributes('href')).toBe('/machines/studio-mini/settings');
    expect(t.text('.nhero-model')).toBe('macOS');
    expect(t.find('.nhero-stage svg.dev').attributes('role')).toBe('img');
  });

  it('a healthy machine points its reason at Overview and offers no Fix button', async () => {
    t = await openNode('/machines/build-runner-01');
    expect(t.exists('.nhero--ok')).toBe(true);
    expect(t.find('.nhero a.reason').attributes('href')).toBe('/machines/build-runner-01');
    expect(t.text('.nhero a.reason')).toMatch(/^In sync at revision [0-9a-f]{7}$/);
    expect(t.exists('.nhero-actions .btn-primary')).toBe(false);
    expect(t.text('.nhero-top .pill')).toBe('Up to date');
    await t.go('/machines/gpu-box');
    await t.ready('gpu-box');
    expect(t.exists('.nhero--updating')).toBe(true);
    expect(t.text('.nhero-top .pill')).toBe('Updating');
    expect(check('2 of 3 Targets in sync')!.text()).toMatch(/still to apply$/);
  });

  it('an offline machine, a machine that never checked in, and one that is updating each read their own reason', async () => {
    t = await openNode('/machines/mba-travel');
    expect(t.exists('.nhero--offline')).toBe(true);
    expect(t.text('.nhero-top .pill')).toBe('Offline');
    expect(t.text('.nhero a.reason')).toMatch(/^No check-in for /);
    expect(t.find('.nhero a.reason').attributes('href')).toBe('/machines/mba-travel/problems');
    expect(check('Not checking in')!.text()).toMatch(/No poll for .*, since .* UTC/);
    await t.go('/machines/lab-vm-07');
    await t.ready('lab-vm-07');
    expect(t.exists('.nhero--never')).toBe(true);
    expect(t.text('.nhero-top .pill')).toBe('Not checked in');
    expect(heroFact('Last check-in')!.text()).toMatch(/^Last check-inNeverenrolled .* ago$/);
    expect(check('Never checked in')!.text()).toMatch(/Enrolled .* ago; no poll yet/);
    expect(check('0 of 1 Targets in sync')).toBeDefined();
    expect(heroFact('Targets')!.text()).toBe('Targets11 pending');
  });

  it('shows a different illustration and platform badge for a Linux machine', async () => {
    t = await openNode('/machines/fedora-ws');
    expect(t.text('.nhero-model')).toBe('Linux');
    expect(t.find('.nhero-model svg').exists()).toBe(true);
    expect(t.text('.nhero-sub')).toMatch(/Linux/);
  });

  it('the tab bar counts open problems with the tone of the worst one', async () => {
    t = await openNode('/machines/studio-mini');
    expect(t.find('nav.tabs a[href$="/problems"] .tab-cnt').text()).toBe('1');
    expect(t.find('nav.tabs a[href$="/problems"] .tab-cnt').classes()).toContain('t-critical');
    await t.go('/machines/mba-travel');
    await t.ready('mba-travel');
    expect(t.find('nav.tabs a[href$="/problems"] .tab-cnt').text()).toBe('2');
    expect(t.find('nav.tabs a[href$="/problems"] .tab-cnt').classes()).toContain('t-serious');
    expect(t.findAll('nav.tabs .tab-cnt')).toHaveLength(1);
  });
});

describe('Overview', () => {
  it('lists the health checks, the Targets at the newest revision, and the table of last in sync against desired', async () => {
    t = await openNode('/machines/studio-mini');
    expect(checkTitles()).toEqual(['Checking in', '1 of 5 Targets failing', 'Certificate valid', 'Disk has room', 'Agent is up to date', 'Local changes were repaired', '7 renewals since enrollment']);
    expect(check('Checking in')!.text()).toMatch(/^Checking inLast poll .* ago$/);
    expect(check('1 of 5 Targets failing')!.text()).toContain('Claude Code connection');
    expect(check('Certificate valid')!.text()).toMatch(/left · renews automatically/);
    expect(check('Disk has room')!.text()).toMatch(/^Disk has room78\.2% used · 393\.9 GiB available of 1\.8 TiB$/);
    expect(t.text('.cols .panel:nth-child(2) h2')).toBe('Targets at revision a3f9c21');
    expect(t.text('.cols .panel:nth-child(2) .panel-head p')).toMatch(/^Newest desired revision for this machine, published .* ago\.$/);
    const rows = t.findAll('.trows li');
    expect(rows.map(r => r.find('.trow-name').text())).toEqual(['CLAUDE.md for Claude Code', 'AGENTS.md for Codex', 'Claude Code connection', 'Codex connection', 'Skills']);
    expect(rows[0]!.find('.trow-t').text()).toMatch(/^applied .* ago$/);
    expect(rows[2]!.find('.trow-t').text()).toMatch(/^since .* ago$/);
    expect(rows[2]!.find('.stag').text()).toBe('Failed');
    expect(t.find('a.more').attributes('href')).toBe('/deployments');
    const table = t.findAll('table.tbl')[0]!;
    expect(table.findAll('thead th').map(th => th.text())).toEqual(['Target', 'Content', 'Last in sync', '', 'Desired', 'State', 'Updated']);
    expect(table.find('thead th[aria-label="changes to"]').exists()).toBe(true);
    const failing = table.findAll('tbody tr').find(r => /Claude Code connection/.test(r.text()))!;
    expect(failing.text()).toMatch(/~\/\.claudeCLIProxy · claude-opus-4-1/);
    expect(failing.findAll('.rev').map(r => r.text()), 'last in sync differs from desired').toEqual(['51c0d8a', '9b14e07']);
    expect(failing.find('td:nth-child(4) svg').exists(), 'an arrow, not "="').toBe(true);
    const ok = table.findAll('tbody tr').find(r => /^CLAUDE\.md/.test(r.find('b').text()))!;
    expect(ok.find('td:nth-child(4)').text(), 'same revision reads "="').toBe('=');
    expect(ok.find('td:nth-child(4) [aria-label=same]').exists()).toBe(true);
    expect(failing.find('.rev').attributes('data-tip')).toMatch(/^51c0d8a[0-9a-f]{33}$/);
  });

  it('a machine with no Targets says so in the list, in the table and in the health checks', async () => {
    t = await openNode('/machines/design-imac');
    patchNodeResponse(t, 'build-runner-01', d => { d.targets = []; d.summary = { pending: 0, applying: 0, succeeded: 0, failed: 0, superseded: 0 }; });
    await t.go('/machines/build-runner-01');
    await t.ready('build-runner-01');
    expect(t.text('.cols .panel:nth-child(2)')).toContain('Nothing is assigned yet.');
    expect(t.text('.cols .panel:nth-child(2) h2')).toBe('Targets');
    expect(t.text('.cols .panel:nth-child(2) .panel-head p')).toBe('The current assignment of each Target.');
    expect(t.panel()).toContain('No Targets are assigned to this machine yet.');
    expect(t.exists('table.tbl')).toBe(false);
    expect(check('No Targets assigned')!.text()).toContain('Add this machine to fleet.yml, then sync the repository.');
    expect(heroFact('Revision')!.text()).toBe('Revision—no Targets assigned');
    expect(heroFact('Targets')!.text()).toBe('Targets0none yet');
    expect(t.text('.nhero a.reason')).toBe('No Targets are assigned yet');
    await t.go('/machines/build-runner-01/problems');
    expect(t.text('#tabpanel h2')).toBe('Nothing to fix on build-runner-01');
    expect(t.panel()).toContain('Nothing is assigned to this machine yet.');
  });

  it('certificate states: expired, expiring soon, valid, and what an offline Agent cannot do', async () => {
    t = await openNode('/machines/studio-mini');
    node('design-imac').credential.notAfter = new Date(Date.now() - 2 * HOUR).toISOString();
    node('mbp-joan').credential.notAfter = new Date(Date.now() + 5 * HOUR).toISOString();
    node('mba-travel').credential.notAfter = new Date(Date.now() + 5 * HOUR).toISOString();
    await t.go('/machines/design-imac');
    await t.ready('design-imac');
    expect(check('Certificate expired')!.text()).toBe('Certificate expiredIt renews at the next poll.');
    expect(heroFact('Certificate')!.text()).toMatch(/^CertificateExpired/);
    expect(heroFact('Certificate')!.find('.meter.m-critical').exists()).toBe(true);
    await t.go('/machines/design-imac/security');
    expect(t.text('.note')).toBe('An expired certificate renews by itself when the Agent next reconnects.');
    expect(t.exists('.vb-left.v-critical')).toBe(true);
    await t.go('/machines/mbp-joan');
    await t.ready('mbp-joan');
    expect(check('Certificate expires soon')!.text()).toMatch(/\d h left · renews at the next poll/);
    expect(heroFact('Certificate')!.find('.meter.m-warning').exists()).toBe(true);
    await t.go('/machines/mba-travel');
    await t.ready('mba-travel');
    expect(check('Certificate expires soon')!.text()).toMatch(/\d h left · cannot renew while offline/);
  });
});

describe('the check-in chart (range)', () => {
  it('shows seven days with a total and a gap summary; its accessible name states the total and the gaps', async () => {
    t = await openNode('/machines/studio-mini');
    const chart = t.find('svg.chart');
    expect(chart.exists()).toBe(true);
    expect(chart.attributes('role')).toBe('img');
    expect(chart.attributes('tabindex')).toBe('0');
    expect(chart.attributes('aria-label')).toMatch(/^Check-ins in the last 7 days: [\d,]+\. .* Use the arrow keys to read each hour\.$/);
    expect(t.text('.stat-v')).toMatch(/^[\d,]+$/);
    expect(t.findAll('.seg-ctl button').map(b => `${b.text()}:${b.attributes('aria-pressed')}`)).toEqual(['7 days:true', '24 hours:false']);
    expect(t.find('.seg-ctl').attributes('role')).toBe('group');
    expect(t.find('.seg-ctl').attributes('aria-label')).toBe('Range');
    expect(t.text('.gaps-none, .gaps')).toBeTruthy();
    expect(t.gets(/\/checkins$/)[0]!.query).toEqual({ hours: '168' });
  });

  it('switching to 24 hours reads that range once, redraws, and switching back uses what was read', async () => {
    t = await openNode('/machines/studio-mini');
    const total7 = t.text('.stat-v');
    await t.findAll('.seg-ctl button')[1]!.trigger('click');
    await t.until(() => /24 hours/.test(t!.find('svg.chart').attributes('aria-label') ?? ''), '24h chart');
    expect(t.findAll('.seg-ctl button').map(b => b.attributes('aria-pressed'))).toEqual(['false', 'true']);
    expect(t.gets(/\/checkins$/).at(-1)!.query).toEqual({ hours: '24' });
    expect(t.text('.stat-v')).not.toBe(total7);
    expect(t.findAll('svg.chart .cb, svg.chart .cb0')).toHaveLength(24);
    await t.findAll('.seg-ctl button')[0]!.trigger('click');
    await t.app.settle();
    expect(t.text('.stat-v')).toBe(total7);
    await t.findAll('.seg-ctl button')[1]!.trigger('click');
    await t.app.settle();
    expect(t.gets(/\/checkins$/), 'each range is read once').toHaveLength(2);
  });

  it('the chart reads each hour with the arrow keys, Home and End', async () => {
    t = await openNode('/machines/studio-mini');
    const chart = t.find('svg.chart');
    await chart.trigger('focus');
    expect(tooltip.visible).toBe(true);
    const last = tooltip.head;
    expect(last).toMatch(/check-in/);
    await chart.trigger('keydown', { key: 'ArrowLeft' });
    expect(tooltip.visible).toBe(true);
    const bars = chart.findAll('.cb, .cb0');
    expect(bars.filter(b => b.classes().includes('on'))).toHaveLength(1);
    await chart.trigger('keydown', { key: 'Home' });
    expect(chart.findAll('.cb, .cb0')[0]!.classes()).toContain('on');
    await chart.trigger('keydown', { key: 'End' });
    expect(chart.findAll('.cb, .cb0').at(-1)!.classes()).toContain('on');
    await chart.trigger('blur');
    expect(tooltip.visible).toBe(false);
  });

  it('a failing read shows the error where the chart would be, and the other range still works', async () => {
    t = await openNode('/machines/studio-mini');
    t.app.mock.options.fail = 'nodes/';
    await t.findAll('.seg-ctl button')[1]!.trigger('click');
    await t.until(() => t!.exists('.panel [role=alert]'), 'error');
    expect(t.text('.panel [role=alert]')).toContain('Could not load check-ins');
    expect(t.exists('svg.chart')).toBe(false);
    expect(t.text('.stat-v')).toBe('—');
    t.app.mock.options.fail = null;
    await t.findAll('.seg-ctl button')[0]!.trigger('click');
    await t.app.settle();
    expect(t.exists('svg.chart')).toBe(true);
  });

  it('a slow read shows a skeleton first', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    t = await openNode('/machines/studio-mini');
    t.app.mock.options.slow = 500;
    await t.findAll('.seg-ctl button')[1]!.trigger('click');
    await t.app.settle();
    expect(t.exists('.panel .skel-block')).toBe(true);
    await vi.advanceTimersByTimeAsync(800);
    await t.app.settle();
    expect(t.exists('.panel .skel-block')).toBe(false);
    expect(t.exists('svg.chart')).toBe(true);
  });

  it('a machine that never polled has a chart of empty hours and says there was no check-in', async () => {
    t = await openNode('/machines/lab-vm-07');
    expect(t.text('.stat-v')).toBe('0');
    expect(t.find('svg.chart').attributes('aria-label')).toMatch(/No check-ins in this window/);
  });

  it('with no buckets at all it says "No check-in data yet."', async () => {
    t = await openNode('/machines/design-imac');
    const real = t.app.ctx.api.get.bind(t.app.ctx.api) as (...a: unknown[]) => Promise<unknown>;
    vi.spyOn(t.app.ctx.api, 'get').mockImplementation(((path: string, ...rest: unknown[]) => /\/checkins$/.test(path) ? Promise.resolve({ hours: 168, buckets: [] }) : real(path, ...rest)) as typeof t.app.ctx.api.get);
    await t.go('/machines/studio-mini');
    await t.ready('studio-mini');
    expect(t.text('.panel .empty-mini')).toContain('No check-in data yet.');
    expect(t.text('.stat-v')).toBe('0');
  });
});

describe('Installed', () => {
  it('lists the Skills with digests and copy buttons, the agent files and the AI client connections', async () => {
    t = await openNode('/machines/studio-mini/installed');
    expect(t.text('.panel-head h2')).toBe('Skills 6');
    expect(t.find('.panel-head .mono').text()).toBe('~/.agents/skills');
    const rows = t.findAll('table.tbl tbody tr');
    expect(rows).toHaveLength(6);
    expect(rows[0]!.find('b').text()).toBe('code-review');
    expect(rows[0]!.find('code').text()).toMatch(/^[0-9a-f]{8}…[0-9a-f]{4}$/);
    expect(rows[0]!.find('code').attributes('data-tip')).toMatch(/^sha256:[0-9a-f]{64}$|^[0-9a-f]{64}$/);
    const copy = rows[0]!.find('button.copy');
    expect(copy.attributes('aria-label')).toBe('Copy digest of code-review');
    expect(copy.attributes('data-copy')).toBe(rows[0]!.find('code').attributes('data-tip'));
    expect(rows[0]!.find('.stag').text()).toBe('In sync');
    const files = t.findAll('.icards')[0]!.findAll('.icard');
    expect(files.map(f => f.find('h3').text())).toEqual(['CLAUDE.md for Claude Code', 'AGENTS.md for Codex']);
    expect(files[0]!.find('.mono').text()).toBe('~/.claude/CLAUDE.md');
    expect(files[0]!.findAll('p')[1]!.text()).toMatch(/^digest [0-9a-f]{8}…[0-9a-f]{4} · last applied at a3f9c21$/);
    const clients = t.findAll('.icards')[1]!.findAll('.icard');
    expect(clients.map(c => c.find('h3').text())).toEqual(['Claude Code', 'Codex']);
    expect(clients[0]!.find('.mono-ic').text()).toBe('C');
    expect(clients[0]!.find('.mono-ic').classes()).toContain('m-claude');
    expect(clients[0]!.find('.mono-ic').attributes('aria-hidden')).toBe('true');
    expect(clients[0]!.text()).toContain('ConnectionCLIProxyEndpointproxy.lab.internalModelclaude-opus-4-1');
    expect(clients[0]!.find('.stag').text()).toBe('Failed');
  });

  it('says what is missing: no Skills Target, no agent files, no AI clients', async () => {
    t = await openNode('/machines/design-imac');
    patchNodeResponse(t, 'studio-mini', d => { d.targets = []; });
    await t.go('/machines/studio-mini/installed');
    await t.until(() => t!.exists('.empty-note'));
    expect(t.text('.panel-head h2')).toBe('Skills 0');
    expect(t.panel()).toContain('No Skills Target is assigned to this machine.');
    expect(t.panel()).toContain('No Skills assigned.');
    expect(t.panel()).toContain('No agent files on this machine.');
    expect(t.panel()).toContain('Fleet does not manage any AI client here.');
    expect(t.exists('.panel-head .stag')).toBe(false);
  });

  it('a file assigned for removal, a native login and an unknown target are described honestly', async () => {
    t = await openNode('/machines/design-imac');
    patchNodeResponse(t, 'studio-mini', d => {
      const file = d.targets.find((x: any) => x.name === 'agent-file/claude');
      file.file = { name: 'CLAUDE.md', bundleDigest: null };
      file.lastSucceededRevision = null;
      const ai = d.targets.find((x: any) => x.name === 'ai-client/claude');
      ai.aiClient = { client: 'claude', mode: 'native', baseUrl: null, model: null };
      d.targets.push({ ...file, name: 'custom/thing', kind: 'custom', file: null, aiClient: null, path: 'x/y', base: 'home' });
    });
    await t.go('/machines/studio-mini/installed');
    await t.until(() => t!.exists('.icards'));
    expect(t.panel()).toContain('Assigned for removal · not applied yet');
    const claude = t.findAll('.icards')[1]!.findAll('.icard')[0]!;
    expect(claude.text()).toContain('ConnectionNative login');
    expect(claude.text()).not.toContain('Endpoint');
    expect(claude.text()).not.toContain('Model');
    expect(t.panel()).toContain('Other Targets');
    expect(t.panel()).toContain('custom/thing');
    await t.go('/machines/studio-mini');
    await t.until(() => t!.exists('table.tbl'));
    expect(t.panel()).toContain('(removal)');
    expect(t.panel()).toContain('Native login');
    expect(stray(textOf(t.find('#view').element))).toEqual([]);
  });
});

describe('Security', () => {
  it('shows the validity bar with its position, the credential facts with copy buttons, and Revoke', async () => {
    t = await openNode('/machines/studio-mini/security');
    const v = t.find('.validity');
    expect(v.attributes('role')).toBe('img');
    expect(v.attributes('aria-label')).toMatch(/^Certificate validity: issued .*, expires .* UTC, \d+ d \d+ h left\.$/);
    const used = (v.find('.vb-used').element as HTMLElement).style.width;
    const left = v.find('.vb-left').element as HTMLElement;
    expect(parseFloat(used) + parseFloat(left.style.width)).toBeCloseTo(100, 0);
    expect(left.style.left).toBe(used);
    expect((v.find('.vb-now').element as HTMLElement).style.left).toBe(used);
    expect(v.find('.vb-left').classes()).toContain('v-good');
    expect(v.find('.vb-now-l').text()).toMatch(/^Now · \d+ d \d+ h left$/);
    expect(v.find('.vb-labels').text()).toMatch(/^Issued .* UTC.*Expires .* UTC$/);
    const kvs = Object.fromEntries(t.findAll('.kv--grid > div').map(d => [d.find('dt').text(), d.find('dd').text()]));
    expect(kvs['Renewals']).toBe('7 since enrollment');
    expect(kvs['Credential ID']).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.find('.kv--grid button.copy[aria-label="Copy credential ID"]').attributes('data-copy')).toBe(kvs['Credential ID']);
    expect(t.find('.kv--grid button.copy[aria-label="Copy Node ID"]').attributes('data-copy')).toBe(node('studio-mini').id);
    expect(t.text('.panel--danger h3')).toBe('Revoke access');
    expect(t.text('.panel--danger .danger-row p')).toBe('Blocks all of this machine\'s certificates right away. Its record, history and alias stay.');
    expect(t.find('.panel--danger [data-act=revoke-node]').text()).toBe('Revoke…');
  });

  it('a machine without a credential says so', async () => {
    t = await openNode('/machines/design-imac');
    patchNodeResponse(t, 'studio-mini', d => { d.credential = null; });
    await t.go('/machines/studio-mini/security');
    await t.until(() => t!.exists('.empty-mini'));
    expect(t.panel()).toContain('This machine has no credential on record.');
    expect(t.exists('.validity')).toBe(false);
  });
});

describe('Settings', () => {
  it('shows the alias form, the read-only identity and the removal panel', async () => {
    t = await openNode('/machines/studio-mini/settings');
    expect((t.find('#rename-alias').element as HTMLInputElement).value).toBe('studio-mini');
    expect(t.find('label[for=rename-alias]').text()).toBe('Alias');
    expect(t.find('#rename-alias').attributes('aria-describedby')).toBe('rename-msg');
    expect(t.find('#rename-alias').attributes('spellcheck')).toBe('false');
    expect(t.find('form[data-form=rename]').attributes('novalidate')).toBeDefined();
    expect(t.find('form button[type=submit]').text()).toBe('Save alias');
    const identity = Object.fromEntries(t.findAll('.cols .panel:nth-child(2) dl > div').map(d => [d.find('dt').text(), d.find('dd').text()]));
    expect(identity['Platform']).toBe('macOS');
    expect(identity['Node ID']).toBe(node('studio-mini').id);
    expect(identity['Enrolled']).toMatch(/UTC · \d+ days ago$/);
    expect(t.text('.panel--danger h3')).toBe('Remove studio-mini');
    expect(t.find('.panel--danger [data-act=remove-node]').text()).toBe('Remove…');
    expect(t.find('.panel--danger [data-act=remove-node]').classes()).toContain('btn-danger');
  });
});

describe('scope gating across the page (scopeRead)', () => {
  it('with the read scope every control that needs more is locked, aria-disabled, explained, and sends nothing', async () => {
    t = await openNode('/machines/studio-mini', { scope: 'read' });
    for (const tab of ['', '/problems', '/security', '/settings']) {
      await t.go(`/machines/studio-mini${tab}`);
      await t.ready('studio-mini');
      const locked = t.findAll('#view .is-locked');
      expect(locked.length, `locked controls on ${tab || 'overview'}`).toBeGreaterThan(0);
      expect(locked.every(b => b.attributes('aria-disabled') === 'true' && !!b.attributes('data-tip')), 'locked controls explain why (tooltip) and are aria-disabled').toBe(true);
      expect(locked.every(b => b.element.tagName === 'BUTTON' && b.attributes('disabled') === undefined), 'and stay focusable').toBe(true);
    }
    await t.go('/machines/studio-mini');
    const first = t.find('#view .is-locked');
    await first.trigger('click');
    expect(t.toasts(), 'clicking a locked control explains').toMatch(/Needs the/);
    expect(t.posts()).toHaveLength(0);
    expect(t.exists('.modal')).toBe(false);
    expect(t.exists('.nhero [data-act=revoke-node]') || t.exists('.nhero [data-act=remove-node]'), 'no live destructive buttons').toBe(false);
    expect(t.exists('#disk-panel .lock-note')).toBe(true);
  });

  it('the operate scope can refresh the disk and retry, but not revoke, remove or rename', async () => {
    t = await openNode('/machines/studio-mini', { scope: 'operate' });
    expect(t.exists('#disk-panel [data-act=disk-refresh]')).toBe(true);
    expect(t.findAll('.nhero-actions .is-locked').map(b => b.text())).toEqual(['Revoke', 'Remove']);
    expect(t.findAll('.nhero-actions .is-locked').every(b => /Needs the admin scope/.test(b.attributes('data-tip')!))).toBe(true);
    await t.go('/machines/studio-mini/problems');
    expect(t.exists('[data-act=retry]')).toBe(true);
    expect(t.exists('article.prob [data-op=acknowledge]')).toBe(true);
    expect(t.exists('article.prob .lock-note')).toBe(false);
  });

  it('the admin scope shows no lock anywhere', async () => {
    t = await openNode('/machines/studio-mini', { scope: 'admin' });
    for (const tab of ['', '/installed', '/problems', '/activity', '/security', '/settings']) {
      await t.go(`/machines/studio-mini${tab}`);
      expect(t.exists('#view .is-locked') || t.exists('#view .lock-note'), tab || 'overview').toBe(false);
    }
  });

  it('a session that is lost while the page is open returns to sign-in (401)', async () => {
    t = await openNode('/machines/studio-mini');
    t.app.mock.state.signedIn = false;
    await t.go('/machines/studio-mini/activity');
    await t.until(() => t!.app.router.currentRoute.value.name === 'login', 'login');
    expect(t.app.router.currentRoute.value.query.redirect).toBe('/machines/studio-mini/activity');
    expect(t.exists('.nhero')).toBe(false);
  });
});

describe('every machine on every tab', () => {
  it('renders without a Vue warning, a console error or a stray value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    t = await openNode('/machines/studio-mini', { xss: true });
    for (const n of t.app.mock.nodes) {
      for (const tab of ['', '/installed', '/problems', '/activity', '/security', '/settings']) {
        await t.go(`/machines/${encodeURIComponent(n.alias)}${tab}`);
        await t.ready(n.alias);
        expect(stray(textOf(t.find('#view').element)), `${n.alias}${tab}`).toEqual([]);
      }
    }
    expect(warn.mock.calls.map(c => String(c[0]).slice(0, 200))).toEqual([]);
    expect(error.mock.calls.map(c => String(c[0]).slice(0, 200))).toEqual([]);
  }, 60_000);
});
