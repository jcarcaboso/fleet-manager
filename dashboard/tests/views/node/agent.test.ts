/**
 * The Agent and machine information of the machine page (phase 3). Ports of the Dev/drive.js scenarios agentNode, agentUpgrade, agentNull,
 * agentOldServer (machine page), agentXss (machine page), plus the upgrade commands being built only from validated pieces.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { kv, openNode, type NodeTest } from './helpers';
import { textOf } from '../../helpers/app';

let t: NodeTest | undefined;
afterEach(() => { t?.unmount(); t = undefined; vi.useRealTimers(); });

const fact = (label: string) => t!.findAll('.facts > div').find(d => d.find('dt').text() === label);
const cmds = () => t!.findAll('#agent-upgrade .cmd').map(c => c.find('button').attributes('data-copy'));
const upgrade = () => t!.text('#agent-upgrade');

describe('the Machine panel (agentNode)', () => {
  it('shows the header line, the Agent fact and every field the Agent reported', async () => {
    t = await openNode('/machines/studio-mini');
    const sub = t.text('.nhero-sub');
    expect(sub, 'header line: host, user, OS, arch').toBe('studio-mini.lan · signed in as joan · macOS 15.0 · aarch64');
    expect(t.find('.nhero-sub .mono').text()).toBe('studio-mini.lan');
    const f = fact('Agent')!;
    expect(f.text()).toMatch(/0\.9\.0/);
    expect(f.text()).toMatch(/Homebrew/);
    expect(f.find('svg').exists(), 'no warning for an up-to-date Agent').toBe(false);
    expect(f.find('.sub').text()).toBe('Homebrew · up to date');
    const want: Record<string, string> = {
      Hostname: 'studio-mini.lan', User: 'joan', 'Operating system': 'macOS 15.0', Kernel: '24.0.0', Architecture: 'aarch64',
      'Install method': 'Homebrew', 'Service manager': 'launchd LaunchAgent', 'State directory': '~/.local/state/fleet-agent',
    };
    for (const [k, v] of Object.entries(want)) expect(kv(t, k), `Machine panel ${k}`).toBe(v);
    expect(kv(t, 'Agent version'), 'Agent version vs latest').toBe('0.9.0 latest release');
    expect(kv(t, 'Reported')).toMatch(/UTC · /);
    expect(t.text('#machine-panel .panel-head p')).toMatch(/^Reported by the Agent .* ago\. It sends this again whenever it changes\.$/);
    expect(t.exists('#agent-upgrade') || t.exists('#machine-panel .chip--update'), 'an up-to-date Agent has no callout and no chip').toBe(false);
    expect(t.text('.hchecks'), 'health check says the Agent is up to date').toMatch(/Agent is up to date/);
    expect(t.find('#machine-panel dl').classes()).toEqual(expect.arrayContaining(['kv', 'kv--grid', 'kv--3']));
    expect(t.find('#machine-panel').attributes('aria-labelledby')).toBe('machine-h');
  });

  it('null OS version and no service manager read as "Arch Linux" and "None (not run as a service)"', async () => {
    t = await openNode('/machines/gpu-box');
    expect(kv(t, 'Hostname')).toBe('gpu-box');
    expect(kv(t, 'Operating system')).toBe('Arch Linux');
    expect(kv(t, 'Service manager')).toBe('None (not run as a service)');
  });

  it('a field the Agent did not send reads "Not reported"', async () => {
    t = await openNode('/machines/design-imac');
    const node = t.app.mock.nodes.find(n => n.alias === 'studio-mini')!;
    node._agent!.user = null as unknown as string;
    node._agent!.os.kernel = null;
    await t.go('/machines/studio-mini');
    await t.ready('studio-mini');
    expect(kv(t, 'User')).toBe('Not reported');
    expect(kv(t, 'Kernel')).toBe('Not reported');
    expect(t.find('#machine-panel dl .muted').text()).toBe('Not reported');
    expect(t.text('.nhero-sub'), 'the header drops what was not reported').toBe('studio-mini.lan · macOS 15.0 · aarch64');
  });
});

describe('the upgrade callout (agentUpgrade)', () => {
  it('binary on systemd: both versions, the archive text, the restart command and a safe release link', async () => {
    t = await openNode('/machines/fedora-ws');
    expect(upgrade()).toMatch(/Update available: Agent 0\.9\.0-rc\.2 → 0\.9\.0/);
    expect(upgrade()).toMatch(/This Agent was installed from a release archive\./);
    expect(upgrade()).toMatch(/Upgrade it on fedora-ws\. Its identity and state stay in place\./);
    expect(upgrade()).toMatch(/Download the v0\.9\.0 archive, replace the binary at the same path and restart the service/);
    expect(cmds(), 'binary on systemd: restart command').toEqual(['systemctl --user restart fleet-agent.service']);
    const link = t.find('#agent-upgrade a');
    expect(link.attributes('href')).toBe('https://github.com/jcarcaboso/fleet-manager/releases/tag/v0.9.0');
    expect(link.attributes('rel')).toContain('noopener');
    expect(link.attributes('target')).toBe('_blank');
    expect(t.find('#agent-upgrade').attributes('data-method')).toBe('binary');
    expect(t.text('#machine-panel .chip--update')).toMatch(/Update available/);
    expect(kv(t, 'Agent version')).toMatch(/latest 0\.9\.0/);
    const f = fact('Agent')!;
    expect(f.find('svg').exists() && /0\.9\.0 available/.test(f.text()), 'header Agent fact warns').toBe(true);
    expect(t.text('.hchecks')).toMatch(/Agent update available/);
    expect(t.text('.hchecks')).toMatch(/Running 0\.9\.0-rc\.2; 0\.9\.0 is the latest/);
    expect(t.find('#agent-upgrade .cmd button.copy').attributes('aria-label')).toBe('Copy to clipboard');
    expect(t.find('#agent-upgrade .callout, #agent-upgrade').classes()).toEqual(expect.arrayContaining(['callout', 'callout--warning', 'upgrade']));
  });

  it('Homebrew: brew upgrade, then restart', async () => {
    t = await openNode('/machines/mba-travel');
    expect(t.find('#agent-upgrade').attributes('data-method')).toBe('homebrew');
    expect(cmds()).toEqual(['brew upgrade fleet-agent', 'brew services restart fleet-agent']);
    expect(t.exists('#agent-upgrade a'), 'no release link for Homebrew').toBe(false);
  });

  it('Cargo: the release-tag install command, then the restart with the real launchd label', async () => {
    t = await openNode('/machines/laptop-ana');
    expect(t.find('#agent-upgrade').attributes('data-method')).toBe('cargo');
    expect(cmds()[0], 'release-tag install command').toBe('cargo install --locked --force \\\n    --git https://github.com/jcarcaboso/fleet-manager \\\n    --tag v0.9.0 \\\n    fleet fleet-agent');
    expect(cmds()[1], 'restart with the real label').toBe('launchctl kickstart -k "gui/$(id -u)/dev.fleet.agent"');
    expect(upgrade()).toMatch(/Rebuild both commands from the v0\.9\.0 release tag\. This needs Rust 1\.95\.0\./);
    expect(upgrade()).toMatch(/This Agent was installed with Cargo from a release tag\./);
  });

  it('binary without a service manager: text only, no restart command', async () => {
    t = await openNode('/machines/build-runner-03');
    expect(t.find('#agent-upgrade').attributes('data-method')).toBe('binary');
    expect(kv(t, 'Hostname')).toBe('runner-03');
    expect(cmds()).toHaveLength(0);
    expect(upgrade()).toMatch(/restart the service/);
  });

  it('a revoked machine gets no upgrade callout and no chip', async () => {
    t = await openNode('/machines/old-laptop');
    expect(kv(t, 'Hostname')).toBe('old-laptop');
    expect(t.exists('#agent-upgrade') || t.exists('#machine-panel .chip--update')).toBe(false);
    expect(kv(t, 'Agent version')).toBe('0.9.0-beta.2');
    expect(t.text('.hchecks')).not.toMatch(/Agent update available/);
    expect(fact('Agent')!.text()).toMatch(/revoked/);
  });

  it.each([
    ['laptop-ana', 'cargo'],
    ['fedora-ws', 'binary'],
  ])('commands are built only from validated pieces: a latest version that is not plain semver never reaches a command or a link (%s)', async (alias, method) => {
    t = await openNode('/machines/design-imac');
    const hostile = '0.9.0"; rm -rf ~ #';
    const real = t.app.ctx.api.get.bind(t.app.ctx.api) as (...a: unknown[]) => Promise<unknown>;
    vi.spyOn(t.app.ctx.api, 'get').mockImplementation(((path: string, ...rest: unknown[]) => real(path, ...rest).then(r => {
      if (path === `nodes/${alias}`) (r as { agent: { latestVersion: string } }).agent.latestVersion = hostile;
      return r;
    })) as typeof t.app.ctx.api.get);
    await t.go(`/machines/${alias}`);
    await t.ready(alias);
    expect(t.find('#agent-upgrade').attributes('data-method')).toBe(method);
    expect(upgrade(), 'shown as text').toContain(hostile);
    expect(cmds().join('\n')).not.toContain('rm -rf');
    expect(cmds().join('\n')).not.toContain('--tag');
    expect(t.exists('#agent-upgrade a'), 'no release link without a validated tag').toBe(false);
    expect(t.findAll('#agent-upgrade [href]')).toHaveLength(0);
    expect(upgrade()).toMatch(method === 'cargo' ? /Rebuild both commands from the newest release tag with cargo install --locked --force\./ : /Download the latest archive, replace the binary/);
  });
});

describe('an Agent that never reported (agentNull)', () => {
  it('shows one quiet line, a platform header, and no Agent health check', async () => {
    t = await openNode('/machines/kitchen-mini');
    expect(t.text('#machine-panel .machine-none'), 'one quiet line').toBe('Not reported. Agents before 0.9.0 do not send machine details.');
    expect(t.exists('#machine-panel dl') || t.exists('#agent-upgrade'), 'no fields, no callout').toBe(false);
    expect(t.text('.nhero-sub')).toMatch(/^macOS machine · enrolled /);
    const f = fact('Agent')!;
    expect(f.text()).toMatch(/not reported/);
    expect(t.text('.hchecks')).not.toMatch(/Agent (is up to date|update available)/);
    expect(t.text('#machine-panel .panel-head p')).toBe('The operating system and Agent that run kitchen-mini.');
    await t.go('/machines/lab-vm-07');
    await t.until(() => t!.exists('.machine-none') && /lab-vm-07/.test(t!.text('h1')));
    expect(t.exists('.machine-none') && !t.exists('#agent-upgrade'), 'a machine that never polled shows the same line').toBe(true);
  });
});

describe('a Server before phase 3 (agentOldServer, agent=0)', () => {
  it('the machine page shows the not-reported line and no callout, with no agent property at all', async () => {
    t = await openNode('/machines/fedora-ws', { agent: false });
    expect(t.exists('.machine-none')).toBe(true);
    expect(t.exists('#agent-upgrade')).toBe(false);
    expect(t.text('.nhero-sub')).toMatch(/^Linux machine · enrolled /);
    expect(t.text('.hchecks')).not.toMatch(/Agent/);
    await t.go('/machines/fedora-ws/problems');
    expect(t.findAll('article.prob').some(p => /Agent is outdated/.test(p.find('h3').text())), 'no agent_outdated issue').toBe(false);
  });
});

describe('agentXss: hostile hostname, user, OS name and state directory', () => {
  it('render as text on the machine page', async () => {
    let alerts = 0;
    vi.stubGlobal('alert', () => { alerts++; });
    t = await openNode('/machines/homelab-nuc', { xss: true });
    const bad = () => t!.findAll('#root img, #root script, #root svg[onload], #root [onerror], #root [onclick], #root [onload]').length;
    expect(bad() === 0 && kv(t, 'Hostname') === '<img src=x onerror=alert(1)>.lab', 'hostname').toBe(true);
    expect(kv(t, 'User')).toContain('<script>');
    expect(kv(t, 'Operating system')!.startsWith('<svg onload=alert(7)> Linux')).toBe(true);
    expect(kv(t, 'State directory')).toContain('<img');
    expect(bad(), 'Machine panel shows every hostile value as text').toBe(0);
    expect(t.text('.nhero-sub')).toContain('<img src=x onerror=alert(1)>.lab');
    expect(textOf(t.find('.nhero-sub').element)).toContain('<svg onload=alert(7)> Linux');
    expect(t.find('.nhero-sub').findAll('img, svg, script')).toHaveLength(0);
    await t.go('/machines/homelab-nuc/installed');
    await t.go('/machines/homelab-nuc/settings');
    expect(bad()).toBe(0);
    expect(alerts).toBe(0);
  });
});
