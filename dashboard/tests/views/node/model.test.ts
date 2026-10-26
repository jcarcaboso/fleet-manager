/** The pure derivations of the machine page (nodeModel.ts): problems, health checks, Activity events and the small texts. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue, NodeAttempt, NodeDetail, ErrorCatalogEntry } from '@/api/types';
import { fromDetail } from '@/lib/model';
import { activityEvents, agentFact, failedTargets, failuresOf, healthChecks, heroSub, problemsOf, rowTime, targetContent } from '@/views/Node/nodeModel';

const NOW = Date.parse('2026-10-26T12:00:00Z');
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

const iso = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60e3).toISOString();
const target = (name: string, over: Record<string, unknown> = {}) => ({
  name, kind: name.split('/')[0], base: 'home', path: '.claude', assignmentId: 'a-' + name, state: 'succeeded', assignedAt: iso(60),
  desiredRevision: { desiredRevisionId: 'd', sourceRevision: 'a3f9c21aaaa', acceptedAt: iso(30) }, lastSucceededRevision: 'a3f9c21aaaa', latestAttempt: null,
  failedAttempts: 0, firstFailedAt: null, skills: [], file: null, aiClient: null, ...over,
});
const detail = (over: Partial<NodeDetail> = {}): NodeDetail => ({
  nodeId: 'n1', name: 'box', platform: 'linux', enrolledAt: iso(5000), lastContactAt: iso(1), freshness: 'fresh', revoked: false, revokedAt: null,
  credential: { credentialId: 'c1', notBefore: iso(1000), notAfter: new Date(NOW + 3 * 864e5).toISOString(), revokedAt: null, revokedBy: null, renewals: 1 },
  targets: [target('skills', { path: '.agents/skills', skills: [{ name: 's', bundleDigest: 'x' }] })] as never, summary: { pending: 0, applying: 0, succeeded: 1, failed: 0, superseded: 0 },
  ...over,
});
const issue = (over: Partial<Issue> = {}): Issue => ({
  id: 'assignment_failed:n1:ai-client/claude', code: 'assignment_failed', severity: 'error', title: 'box: failed', detail: 'It failed.', action: '', section: 'machines',
  errorCode: 'boom', nodeId: 'n1', nodeName: 'box', target: 'ai-client/claude', since: iso(10), commands: [], ...over,
});
const cat = (code: string, title: string): ErrorCatalogEntry => ({ code, source: 'agent', title, explanation: 'x', fix: [] });
const catalog = (entries: ErrorCatalogEntry[]) => ({ get: (c: string | null | undefined) => entries.find(e => e.code === c) ?? null, title: (c: string | null | undefined) => entries.find(e => e.code === c)?.title || c || 'Unknown problem' });

describe('problemsOf', () => {
  const failing = fromDetail(detail({
    targets: [target('ai-client/claude', { state: 'failed', firstFailedAt: iso(50), failedAttempts: 2, latestAttempt: { attemptId: 'at', state: 'failed', errorCode: 'boom', diagnostic: null, updatedAt: iso(5) } }), target('skills')] as never,
    summary: { pending: 0, applying: 0, succeeded: 1, failed: 1, superseded: 0 },
  }));

  it('a failed Target is an error, matched with its issue, titled from the catalog, and the issue is not listed twice', () => {
    const list = problemsOf(failing, [issue()], catalog([cat('boom', 'Boom happened')]));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'target', level: 'critical', glyph: 'x', badge: 'Error', code: 'boom', title: 'Boom happened', id: 'target:ai-client/claude' });
    expect(list[0]!.issue?.id).toBe('assignment_failed:n1:ai-client/claude');
    expect(list[0]!.since).toBe(failing.targets[0]!.firstFailedAt);
  });

  it('without a catalog entry the code is the title, and without a code the Target label says it failed', () => {
    expect(problemsOf(failing, [], catalog([]))[0]!.title).toBe('boom');
    const nocode = fromDetail(detail({ targets: [target('ai-client/claude', { state: 'failed', latestAttempt: null })] as never, summary: { pending: 0, applying: 0, succeeded: 0, failed: 1, superseded: 0 } }));
    expect(problemsOf(nocode, [], catalog([]))[0]).toMatchObject({ title: 'Claude Code connection failed', code: null });
  });

  it('other issues of the machine follow, worst first; issues of other machines and revoked machines are ignored', () => {
    const list = problemsOf(failing, [
      issue({ id: 'w', code: 'disk_space_low', severity: 'warning', target: null, errorCode: null, title: 'low' }),
      issue({ id: 'o', code: 'node_not_contacting', severity: 'warning', target: null, errorCode: null, title: 'offline' }),
      issue({ id: 'x', nodeId: 'other', target: null, title: 'other machine' }),
    ], catalog([]));
    expect(list.map(p => `${p.kind}:${p.level}:${p.title}`)).toEqual(['target:critical:boom', 'issue:serious:offline', 'issue:warning:low']);
    expect(list[1]).toMatchObject({ badge: 'Offline', glyph: 'moon' });
    expect(problemsOf(fromDetail(detail({ revoked: true, revokedAt: iso(1) })), [issue()], catalog([]))).toEqual([]);
  });

  it('failedTargets and failuresOf read the machine record', () => {
    expect(failedTargets(failing).map(t => t.name)).toEqual(['ai-client/claude']);
    expect(failuresOf(failing)).toEqual([{ target: failing.targets[0], errorCode: 'boom' }]);
  });
});

describe('healthChecks', () => {
  const titles = (d: NodeDetail) => healthChecks(fromDetail(d)).map(c => c.title);

  it('a healthy machine: checking in, all in sync, certificate valid, renewals', () => {
    expect(titles(detail())).toEqual(['Checking in', 'All 1 Targets in sync', 'Certificate valid', '1 renewal since enrollment']);
  });
  it('stale and never contacted', () => {
    expect(titles(detail({ freshness: 'stale', lastContactAt: iso(600) }))[0]).toBe('Not checking in');
    expect(healthChecks(fromDetail(detail({ freshness: 'never_contacted', lastContactAt: null })))[0]).toMatchObject({ title: 'Never checked in', level: 'serious', kind: 'clock' });
  });
  it('revoked machines say so and skip certificate, disk, Agent and drift', () => {
    const list = healthChecks(fromDetail(detail({ revoked: true, revokedAt: iso(30), credential: { credentialId: 'c', notBefore: iso(100), notAfter: iso(-100), revokedAt: iso(30), revokedBy: 'joan', renewals: 0 } })));
    expect(list.map(c => c.title)).toEqual(['Access revoked', 'Targets frozen', '0 renewals since enrollment']);
    expect(list[0]!.text).toBe('Revoked 30 min ago by joan. Its certificates no longer work.');
  });
  it('the disk check uses the fullest volume', () => {
    const d = detail({ disk: { measuredAt: iso(1), refreshRequestedAt: null, volumes: [
      { label: 'home', totalBytes: 100 * 2 ** 30, usedBytes: 50 * 2 ** 30, availableBytes: 50 * 2 ** 30, usedPercent: 50 },
      { label: 'state', totalBytes: 100 * 2 ** 30, usedBytes: 96 * 2 ** 30, availableBytes: 4 * 2 ** 30, usedPercent: 96 },
    ] } });
    const c = healthChecks(fromDetail(d)).find(x => /^Disk/.test(x.title))!;
    expect(c).toMatchObject({ title: 'Disk is nearly full', level: 'critical', text: '96.0% used · 4.0 GiB available of 100.0 GiB' });
  });
  it('an outdated Agent warns, a current one is up to date, and recent drift is mentioned with its count', () => {
    const agent = { version: '0.9.0-rc.1', latestVersion: '0.9.0', outdated: true, os: { name: null, version: null, kernel: null }, arch: null, hostname: null, user: null, installMethod: null, serviceManager: null, stateDirectory: null, reportedAt: iso(1) };
    expect(healthChecks(fromDetail(detail({ agent: agent as never }))).find(c => /Agent/.test(c.title))).toMatchObject({ title: 'Agent update available', text: 'Running 0.9.0-rc.1; 0.9.0 is the latest' });
    expect(healthChecks(fromDetail(detail({ agent: { ...agent, outdated: false } as never }))).find(c => /Agent/.test(c.title))!.title).toBe('Agent is up to date');
    const drift = [{ target: 'skills', files: ['a', 'b'], detectedAt: iso(30) }, { target: 'skills', files: ['c'], detectedAt: iso(60) }, { target: 'skills', files: ['d'], detectedAt: iso(48 * 60) }];
    const c = healthChecks(fromDetail(detail({ drift }))).find(x => /Local changes/.test(x.title))!;
    expect(c.text).toBe('2 times in the last 24 hours. Latest 30 min ago: skills, 2 files. Make permanent changes in Git instead.');
  });
  it('certificate: expired, expiring within a day, and offline', () => {
    const cert = (ms: number) => ({ credentialId: 'c', notBefore: iso(1000), notAfter: new Date(NOW + ms).toISOString(), revokedAt: null, revokedBy: null, renewals: 0 });
    expect(healthChecks(fromDetail(detail({ credential: cert(-1000) }))).find(c => /Certificate/.test(c.title))).toMatchObject({ title: 'Certificate expired', text: 'It renews at the next poll.' });
    expect(healthChecks(fromDetail(detail({ credential: cert(3 * 36e5), freshness: 'stale' }))).find(c => /Certificate/.test(c.title))).toMatchObject({ title: 'Certificate expires soon', text: '3 h left · cannot renew while offline' });
  });
});

describe('small texts', () => {
  it('rowTime reads by state', () => {
    const t = (state: string, over = {}) => target('skills', { state, ...over }) as never;
    expect(rowTime(t('succeeded'))).toBe('in sync');
    expect(rowTime(t('succeeded', { latestAttempt: { attemptId: 'a', state: 'succeeded', errorCode: null, diagnostic: null, updatedAt: iso(5) } }))).toBe('applied 5 min ago');
    expect(rowTime(t('failed', { firstFailedAt: iso(90) }))).toBe('since 1 h 30 min ago');
    expect(rowTime(t('pending'))).toBe('not started');
    expect(rowTime(t('superseded'))).toBe('replaced');
    expect(rowTime(t('applying', { latestAttempt: { attemptId: 'a', state: 'applying', errorCode: null, diagnostic: null, updatedAt: iso(2) } }))).toBe('started 2 min ago');
  });
  it('targetContent', () => {
    expect(targetContent(target('skills', { skills: [{ name: 'a', bundleDigest: 'd' }, { name: 'b', bundleDigest: 'd' }] }) as never)).toBe('2 Skills');
    expect(targetContent(target('skills') as never)).toBe('0 Skills');
    expect(targetContent(target('agent-file/claude', { file: { name: 'CLAUDE.md', bundleDigest: 'x' } }) as never)).toBe('CLAUDE.md');
    expect(targetContent(target('agent-file/claude', { file: { name: 'CLAUDE.md', bundleDigest: null } }) as never)).toBe('CLAUDE.md (removal)');
    expect(targetContent(target('ai-client/claude', { aiClient: { client: 'claude', mode: 'cliproxy', baseUrl: null, model: null } }) as never)).toBe('CLIProxy · default model');
    expect(targetContent(target('ai-client/claude', { aiClient: { client: 'claude', mode: 'native', baseUrl: null, model: null } }) as never)).toBe('Native login');
    expect(targetContent(target('custom/x') as never)).toBe('—');
  });
  it('heroSub and agentFact fall back when the Agent reported nothing', () => {
    const none = fromDetail(detail({ agent: null }));
    expect(heroSub(none, null)).toEqual({ host: null, text: 'Linux machine · enrolled Oct 23' });
    expect(agentFact(none)).toBeNull();
    const some = fromDetail(detail({ agent: { version: '0.9.0', latestVersion: '0.9.0', outdated: false, os: { name: null, version: null, kernel: null }, arch: 'x86_64', hostname: 'box.lan', user: null, installMethod: 'binary', serviceManager: null, stateDirectory: null, reportedAt: iso(1) } as never }));
    expect(heroSub(some, null)).toEqual({ host: 'box.lan', text: ' · Linux machine · x86_64' });
    expect(agentFact(some)).toEqual({ version: '0.9.0', warn: false, sub: 'Release archive · up to date' });
  });
});

describe('activityEvents', () => {
  const n = fromDetail(detail({ drift: [{ target: 'skills', files: ['a'], detectedAt: iso(20) }] }));
  const attempt = (over: Partial<NodeAttempt> = {}): NodeAttempt => ({ attemptId: 'at1', assignmentId: 'as', rolloutId: 'r', targetName: 'skills', sourceRevision: 'a3f9c21aaaa', state: 'failed', errorCode: 'boom', diagnostic: 'it broke', step: 'verify', updatedAt: iso(10), ...over });
  const audit = (action: string, minutes: number) => ({ recordedAt: iso(minutes), action, actor: 'joan', nodeId: 'n1', credentialId: null, nodeName: 'box' });

  it('merges attempts, audit events, drift and the enrollment, newest first', () => {
    const ev = activityEvents(n, [attempt()], [audit('node_credential_renewed', 30), audit('node_revoked', 40)], null, catalog([cat('boom', 'Boom happened')]));
    expect(ev.map(e => `${e.cat}:${e.title}`)).toEqual(['attempt:Skills failed', 'drift:Repaired local changes in skills: 1 file', 'security:Certificate renewed', 'change:Revoked a machine', 'change:Enrolled as box']);
    expect(ev[0]).toMatchObject({ sub: 'a3f9c21 · Boom happened · boom', text: 'it broke', step: 'verify', key: 'at1', level: 'critical' });
    expect(ev[2]).toMatchObject({ level: 'good', sub: 'by joan' });
    expect(ev[3]).toMatchObject({ level: 'neutral', kind: 'minus' });
    expect(ev[1]!.files).toEqual(['a']);
  });
  it('does not claim the enrollment when older pages exist or the audit log has it', () => {
    expect(activityEvents(n, [], [], 'cursor', catalog([])).some(e => /Enrolled as/.test(e.title))).toBe(false);
    expect(activityEvents(n, [], [audit('node_enrolled', 5000)], null, catalog([])).filter(e => /Enrolled|enrolled/.test(e.title))).toHaveLength(1);
  });
  it('drops events with an invalid time', () => {
    expect(activityEvents(n, [attempt({ updatedAt: 'nonsense' })], [], 'c', catalog([])).map(e => e.cat)).toEqual(['drift']);
  });
  it('names a Target the machine no longer has by its raw name', () => {
    expect(activityEvents(n, [attempt({ targetName: 'agent-file/claude', state: 'succeeded', errorCode: null })], [], 'c', catalog([]))[0]!.title).toBe('Claude Code agent file applied');
  });
});
