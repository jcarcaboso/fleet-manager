/**
 * The mock answers like the Server (ports of the `fixtureContract` and `fixturePhase4` scenarios of the old Dev/drive.js,
 * plus the response shapes of contracts/operator/*.json). Every view test relies on this, so it is tested on its own.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AuditEvent, DesiredRevisionDetail, DesiredRevisionItem, Issue, NodeDetail, NodeListItem, Page, RolloutDetail, RolloutItem } from '@/api/types';
import { contract } from '../helpers/contracts';
import { loginClient, mockApi } from '../helpers/mock';
import { allowMalformedBodies } from '../helpers/strict';

const NONE = '00000000-0000-4000-8000-000000000000';
const NONE2 = '00000000-0000-4000-a000-000000000000';

function setup(options = {}) {
  const m = mockApi(options);
  /* Straight through the mock's fetch, like the old driver did, so that the real status (202, 409, …) is visible. */
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const r = await m.mock.fetch('https://mock.fleet.invalid/dashboard/api/' + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Fleet-CSRF': m.mock.state.csrf }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const is = (r: { status: number; body: any }, status: number, code: string | null = null): void => {
    expect(r.status).toBe(status);
    if (code !== null) expect(r.body?.code).toBe(code);
  };
  return { ...m, get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), is };
}
const keys = (o: object): string => Object.keys(o).sort().join();

describe('fixtureContract', () => {
  it('disk usage, rename, links, retry, revoke, remove and selection follow the Server', async () => {
    const { mock, get, post, is } = setup();
    const F = mock;
    const revoked = F.nodes.find(n => n.revokedAt)!;
    const live = F.nodes.filter(n => !n.revokedAt);
    const [a, b] = live as [typeof live[0], typeof live[0]];
    const nuc = F.nodes.find(n => n.alias === 'homelab-nuc')!;
    const fresh = F.nodes.find(n => n.alias === 'build-runner-02')!;
    const olda = F.nodes.find(n => n.alias === 'kitchen-mini')!;
    const detailOf = async (n: { id: string }) => (await get('nodes/' + n.id)).body as NodeDetail;
    const listOf = async (n: { id: string }) => ((await get('nodes')).body as Page<NodeListItem>).items.find(i => i.nodeId === n.id)!;

    /* disk usage */
    const dn = (await detailOf(nuc)).disk!;
    const ln = (await listOf(nuc)).disk!;
    expect(dn.volumes).toHaveLength(2);
    expect(dn.volumes.every(v => Math.abs(v.usedPercent - Math.round((v.usedBytes / (v.usedBytes + v.availableBytes)) * 1000) / 10) < 0.05 && v.usedBytes + v.availableBytes <= v.totalBytes)).toBe(true);
    expect(ln.label).toBe('home');
    expect(ln.usedPercent).toBe(Math.max(...dn.volumes.map(v => v.usedPercent)));
    expect(keys(ln)).toBe('availableBytes,label,measuredAt,totalBytes,usedBytes,usedPercent');
    expect((await detailOf(fresh)).disk).toBeNull();
    expect((await listOf(fresh)).disk).toBeNull();
    expect(keys(dn)).toBe('measuredAt,refreshRequestedAt,volumes');
    expect(dn.refreshRequestedAt).toBeNull();
    is(await post('nodes/nobody-here/disk-usage/refresh'), 404, 'node_not_found');
    const r1 = await post('nodes/' + olda.id + '/disk-usage/refresh');
    is(r1, 202);
    expect(keys(r1.body)).toBe('refreshRequestedAt');
    expect(Number.isNaN(Date.parse(r1.body.refreshRequestedAt))).toBe(false);
    const r2 = await post('nodes/' + olda.id + '/disk-usage/refresh');
    expect(r2.body.refreshRequestedAt).toBe(r1.body.refreshRequestedAt);
    is(await post('nodes/' + revoked.id + '/disk-usage/refresh'), 409, 'node_revoked');
    const diskAudit = F.audit.filter(e => e.action === 'node.disk_refresh_requested' && e.nodeId === olda.id);
    expect(diskAudit).toHaveLength(1);
    expect(diskAudit[0]!.actor).toBe(F.state.actor);
    expect(F.audit.filter(e => e.action === 'node.disk_refresh_requested')).toHaveLength(1);
    const events = ((await get('audit?node=' + olda.id + '&order=newest')).body as Page<AuditEvent>).items;
    expect(events.some(e => e.action === 'node.disk_refresh_requested' && e.nodeId === olda.id)).toBe(true);
    const pending = (await detailOf(olda)).disk!;
    expect(pending.measuredAt).toBeNull();
    expect(pending.refreshRequestedAt).toBe(r1.body.refreshRequestedAt);
    expect(pending.volumes).toEqual([]);
    const diskIssues = ((await get('issues')).body.items as Issue[]).filter(i => /^disk_space_/.test(i.code));
    expect(diskIssues).toHaveLength(3);
    const crit = diskIssues.find(i => i.nodeName === 'homelab-nuc')!;
    expect(crit).toMatchObject({ code: 'disk_space_critical', severity: 'error' });
    expect(diskIssues.filter(i => i.code === 'disk_space_low').every(i => i.severity === 'warning')).toBe(true);
    expect(diskIssues.every(i => i.since === F.nodes.find(n => n.id === i.nodeId)!._disk!.measuredAt && i.commands.length === 2 && i.commands[1]!.endsWith(' --refresh'))).toBe(true);

    /* rename */
    is(await post('nodes/rename', { currentAlias: revoked.alias, alias: 'whatever' }), 409, 'node_revoked');
    const auditBefore = F.audit.length;
    const same = await post('nodes/rename', { currentAlias: a!.alias, alias: a!.alias });
    is(same, 200);
    expect(same.body).toMatchObject({ alias: a!.alias, nodeId: a!.id });
    expect(F.audit.length).toBe(auditBefore);
    is(await post('nodes/rename', { currentAlias: a!.alias, alias: b!.alias }), 409, 'node_alias_in_use');
    is(await post('nodes/rename', { currentAlias: 'nobody-here', alias: 'x' }), 404, 'node_not_found');
    is(await post('nodes/rename', { currentAlias: 'nobody-here', alias: '   ' }), 400, 'invalid_node_alias');
    is(await post('nodes/rename', { currentAlias: a!.alias, alias: 'x'.repeat(201) }), 400, 'invalid_node_alias');

    /* links */
    const aliasTaken = await post('enrollment-links', { alias: b!.alias, expiresInSeconds: 900 });
    is(aliasTaken, 200);
    is(await post('enrollment-links', { alias: 'fresh-one' }), 200);
    is(await post('enrollment-links', { alias: 'fresh-two', expiresInSeconds: 59 }), 400, 'invalid_expiry');
    is(await post('enrollment-links', { alias: '  ', expiresInSeconds: 59 }), 400, 'invalid_expiry');
    is(await post('enrollment-links', { alias: '  ', expiresInSeconds: 900 }), 400, 'invalid_alias');
    const link = (await get('enrollment-links/' + aliasTaken.body.id)).body;
    expect(link.state).toBe('active');
    is(await post('enrollment-links/' + NONE + '/revoke'), 400, 'enrollment_not_found');
    const auditLinks = F.audit.length;
    is(await post('enrollment-links/' + link.id + '/revoke'), 200);
    is(await post('enrollment-links/' + link.id + '/revoke'), 200);
    expect(F.audit.length).toBe(auditLinks + 1);
    const used = F.links.find(l => l.state === 'consumed')!;
    is(await post('enrollment-links/' + used.id + '/revoke'), 200);
    expect((await get('enrollment-links/' + used.id)).body.state).toBe('consumed');

    /* retry */
    is(await post('nodes/' + a!.id + '/retry', { target: '  ' }), 400, 'invalid_request');

    /* revoke and remove */
    const failing = live.find(n => n!.targets.some(t => t.state === 'failed'))!;
    const statesBefore = failing.targets.map(t => t.state).join();
    is(await post('nodes/' + failing.id + '/revoke'), 200);
    const firstAt = failing.revokedAt;
    const auditRevoke = F.audit.length;
    is(await post('nodes/' + failing.id + '/revoke'), 200);
    expect(failing.revokedAt).toBe(firstAt);
    expect(F.audit.length).toBe(auditRevoke + 1);
    expect(failing.targets.map(t => t.state).join()).toBe(statesBefore);
    is(await post('nodes/' + NONE + '/revoke'), 404, 'node_not_found');
    is(await post('nodes/' + a!.id + '/remove', { alias: 'wrong' }), 409, 'node_alias_changed');
    is(await post('nodes/' + a!.id + '/remove', { alias: ' ' }), 400, 'invalid_node_alias');
    is(await post('nodes/' + NONE + '/remove', { alias: 'x' }), 404, 'node_not_found');
    is(await post('nodes/not-a-guid/remove', { alias: 'x' }), 404, 'invalid_request');
    const owner = F.nodes.find(n => n.alias === used.alias);
    if (owner) {
      is(await post('nodes/' + owner.id + '/remove', { alias: owner.alias }), 200);
      is(await get('enrollment-links/' + used.id), 404, 'enrollment_link_not_found');
    }

    /* selection */
    const sel = (await get('cliproxy/selection')).body.catalogs[0];
    is(await post('cliproxy/selection', { baseUrl: 'https://nowhere/v1', version: 0, policy: null }), 400, 'invalid_selection');
    is(await post('cliproxy/selection', { baseUrl: 'https://nowhere/v1', version: 0, policy: sel.policy }), 404, 'catalog_unavailable');
    const pinnedModel = F.nodes.flatMap(n => n.targets).map(t => t.aiClient).find(c => c && c.mode === 'cliproxy' && c.baseUrl === sel.baseUrl && /^gpt-/.test(c.model ?? ''))?.model;
    expect(pinnedModel).toBeTruthy();
    const pinned = await post('cliproxy/selection', { baseUrl: sel.baseUrl, version: sel.version - 1, policy: { ...sel.policy, modelOverrides: { ...sel.policy.modelOverrides, [pinnedModel!]: false } } });
    is(pinned, 409, 'pinned_model_excluded');
    expect(pinned.body.models).toContain(pinnedModel);
    is(await post('cliproxy/selection', { baseUrl: sel.baseUrl, version: sel.version - 1, policy: sel.policy }), 409, 'stale_selection');
    const auditSel = F.audit.length;
    const ok = await post('cliproxy/selection', { baseUrl: sel.baseUrl, version: sel.version, policy: sel.policy });
    is(ok, 200);
    expect(ok.body.catalog.version).toBe(sel.version + 1);
    expect(F.audit.length).toBe(auditSel);
    const auditScan = F.audit.length;
    await post('source/rescan');
    expect(F.audit.length).toBe(auditScan);
  });
});

describe('fixturePhase4', () => {
  it('commit, revision detail, rollout detail, drift and issue state follow the Server', async () => {
    allowMalformedBodies(); // the issue-state checks below send bodies that do not bind on purpose
    const { mock, get, post, is } = setup();
    const F = mock;
    const list = ((await get('desired-revisions?order=newest')).body as Page<DesiredRevisionItem>).items;
    expect(list.every(r => 'commit' in r)).toBe(true);
    expect(keys(list[0]!.commit!)).toBe('author,committedAt,subject');
    expect(list.at(-1)!.commit).toBeNull();
    expect(list.slice(0, -1).every(r => r.commit)).toBe(true);
    expect(JSON.stringify(list)).not.toContain('@');
    const d0 = (await get('desired-revisions/' + list[0]!.desiredRevisionId)).body as DesiredRevisionDetail;
    const dN = (await get('desired-revisions/' + list.at(-1)!.desiredRevisionId)).body as DesiredRevisionDetail;
    expect(keys(d0)).toBe('acceptedAt,commit,desiredRevisionId,previous,rolloutId,skills,sourceRevision,targets');
    expect(keys(d0.skills)).toBe('added,changed,removed');
    expect(keys(d0.targets)).toBe('added,changed,nodes,removed');
    expect(d0.previous!.desiredRevisionId).toBe(list[1]!.desiredRevisionId);
    expect(dN.previous).toBeNull();
    for (const l of [d0.skills.added, d0.skills.changed, d0.skills.removed, dN.skills.added]) expect(l).toEqual([...l].sort());
    expect(dN.skills.removed).toHaveLength(0);
    expect(d0.rolloutId).toBe(((await get('rollouts?order=newest')).body as Page<RolloutItem>).items[0]!.rolloutId);
    const details = await Promise.all(list.map(r => get('desired-revisions/' + r.desiredRevisionId)));
    expect(details.every(r => r.body.targets.removed === 0)).toBe(true);
    is(await get('desired-revisions/' + NONE2), 404, 'revision_not_found');
    is(await get('rollouts/' + NONE2), 404, 'rollout_not_found');

    const worst = ['failed', 'applying', 'pending', 'succeeded', 'superseded'];
    for (const idx of [0, 1, 2, 4]) {
      const rid = ((await get('rollouts?order=newest')).body as Page<RolloutItem>).items[idx]!.rolloutId;
      const ro = (await get('rollouts/' + rid)).body as RolloutDetail;
      const names = ro.nodes.map(n => n.nodeName);
      expect(keys(ro)).toBe('createdAt,desiredRevisionId,nodes,rolloutId,sourceRevision,summary');
      expect(keys(ro.summary)).toBe('applying,failed,pending,succeeded,superseded');
      expect(keys(ro.nodes[0]!)).toBe('firstAttemptAt,lastAttemptAt,nodeId,nodeName,state,targets');
      expect(keys(ro.nodes[0]!.targets[0]!)).toBe('errorCode,name,state,updatedAt');
      const sum: Record<string, number> = { pending: 0, applying: 0, succeeded: 0, failed: 0, superseded: 0 };
      ro.nodes.forEach(n => n.targets.forEach(t => { sum[t.state]!++; }));
      expect(sum).toEqual(ro.summary);
      expect(names).toEqual([...names].sort((x, y) => x.localeCompare(y)));
      expect(ro.nodes.every(n => n.state === worst.find(s => n.targets.some(t => t.state === s)))).toBe(true);
      expect(ro.nodes.every(n => (n.firstAttemptAt === null) === (n.lastAttemptAt === null) && (n.firstAttemptAt === null || n.firstAttemptAt <= n.lastAttemptAt!))).toBe(true);
      expect(ro.nodes.every(n => n.targets.every(t => t.state === 'failed' || t.errorCode === null))).toBe(true);
    }
    const nuc = (await get('nodes/' + F.nodes.find(n => n.alias === 'homelab-nuc')!.id)).body as NodeDetail;
    const other = (await get('nodes/' + F.nodes.find(n => n.alias === 'mbp-joan')!.id)).body as NodeDetail;
    expect(nuc.drift).toHaveLength(2);
    expect(keys(nuc.drift![0]!)).toBe('detectedAt,files,target');
    expect(nuc.drift![0]!.detectedAt > nuc.drift![1]!.detectedAt).toBe(true);
    expect(nuc.drift![1]!.files).toHaveLength(2);
    expect(other.drift).toEqual([]);

    /* issues/state */
    const issues0 = (await get('issues')).body.items as Issue[];
    const id = issues0.find(i => i.code === 'disk_space_critical')!.id;
    expect(issues0.every(i => i.state === 'open' && i.stateBy === null && i.stateAt === null && i.snoozedUntil === null)).toBe(true);
    F.state.scope = 'read';
    is(await post('issues/state', { id, action: 'acknowledge' }), 403, 'insufficient_scope');
    F.state.scope = 'operate';
    is(await post('issues/state', { id, action: 'acknowledge' }), 200);
    is(await post('issues/state', { id, action: 'acknowledge', hours: 4 }), 400, 'invalid_request');
    is(await post('issues/state', { id, action: 'reopen', hours: 1 }), 400, 'invalid_request');
    is(await post('issues/state', { id, action: 'snooze' }), 400, 'invalid_request');
    for (const hours of [0, 169, 1.5, '4']) is(await post('issues/state', { id, action: 'snooze', hours }), 400, 'invalid_request');
    is(await post('issues/state', { id, action: 'mute' }), 400, 'invalid_request');
    is(await post('issues/state', { action: 'acknowledge' }), 400, 'invalid_request');
    is(await post('issues/state', { id: 'x'.repeat(301), action: 'acknowledge' }), 400, 'invalid_request');
    is(await post('issues/state', { id: 'x'.repeat(300), action: 'acknowledge' }), 404, 'issue_not_found');
    is(await post('issues/state', { id: '   ', action: 'acknowledge' }), 404, 'issue_not_found');
    is(await post('issues/state', { id: 'nope:nothing', action: 'acknowledge', hours: null }), 404, 'issue_not_found');
    is(await post('issues/state', { id: 'nope:nothing', action: 'acknowledge' }), 404, 'issue_not_found');
    is(await post('issues/state', { id: 'nope:nothing', action: 'mute' }), 400, 'invalid_request');
    const ack = await post('issues/state', { id, action: 'acknowledge' });
    expect(ack.body).toMatchObject({ id, state: 'acknowledged', stateBy: 'joan', snoozedUntil: null, code: 'disk_space_critical' });
    expect(Number.isNaN(Date.parse(ack.body.stateAt))).toBe(false);
    const listed = (await get('issues')).body.items as Issue[];
    expect(listed.map(i => i.id)).toEqual(issues0.map(i => i.id));
    expect(listed.find(i => i.id === id)!.state).toBe('acknowledged');
    F.nodes.find(n => n.alias === 'homelab-nuc')!._disk!.measuredAt = new Date(Date.now() + 1000).toISOString();
    expect(((await get('issues')).body.items as Issue[]).find(i => i.id === id)!.state).toBe('open');
    const sn = await post('issues/state', { id, action: 'snooze', hours: 168 });
    expect(sn.body.state).toBe('snoozed');
    expect(Math.abs(Date.parse(sn.body.snoozedUntil) - Date.now() - 168 * 3600e3)).toBeLessThan(60e3);
    is(await post('issues/state', { id, action: 'snooze', hours: 1 }), 200);
    is(await post('issues/state', { id, action: 'reopen' }), 200);
    expect(((await get('issues')).body.items as Issue[]).find(i => i.id === id)!.state).toBe('open');
    expect(F.audit.slice(0, 5).map(e => e.action).reverse().join()).toBe('issue.acknowledged,issue.acknowledged,issue.snoozed,issue.snoozed,issue.reopened');
    expect(F.audit.find(e => e.action === 'issue.reopened')!.nodeId).toBe(F.nodes.find(n => n.alias === 'homelab-nuc')!.id);
  });
});

describe('conventions', () => {
  it('lists default to ID order and ask for order=newest; a cursor is only valid with its order', async () => {
    const { get, is, mock } = setup({ pageSize: 2 });
    const byId = await get('desired-revisions');
    const newest = await get('desired-revisions?order=newest');
    expect(byId.body.items.map((r: any) => r.desiredRevisionId)).not.toEqual(newest.body.items.map((r: any) => r.desiredRevisionId));
    expect(newest.body.items[0].desiredRevisionId).toBe([...mock.data.revisions].sort((a, b) => Date.parse(b.acceptedAt) - Date.parse(a.acceptedAt))[0]!.id);
    expect(newest.body.nextCursor).toBe('newest:2');
    is(await get('desired-revisions?order=newest&after=id:2'), 400, 'invalid_request');
    is(await get('desired-revisions?order=oldest'), 400, 'invalid_request');
    const next = await get('desired-revisions?order=newest&after=' + newest.body.nextCursor);
    expect(next.body.items).toHaveLength(2);
    const audit = await get('audit?order=newest&limit=100');
    const times = (audit.body.items as AuditEvent[]).map(e => Date.parse(e.recordedAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(audit.body.items.length).toBe(2);
  });
  it('audit items carry the node name, or null for a removed machine', async () => {
    const { get } = setup();
    const items = ((await get('audit?order=newest&limit=100')).body as Page<AuditEvent>).items;
    expect(items.every(e => keys(e) === 'account,action,actor,credentialId,detail,nodeId,nodeName,recordedAt')).toBe(true);
    const removed = items.find(e => e.action === 'node_removed')!;
    expect(removed.nodeName).toBeNull();
    expect(items.find(e => e.action === 'node_revoked')!.nodeName).toBe('old-laptop');
    expect(((await get('audit?node=studio-mini&order=newest')).body as Page<AuditEvent>).items.every(e => e.nodeName === 'studio-mini')).toBe(true);
  });
  it('requires a session, then scope, in the Server\'s order', async () => {
    const { get, post, is, mock, api } = setup({ signedOut: true });
    is(await get('nodes'), 401, 'unauthorized');
    is(await get('csrf'), 200);
    is(await post('login', { name: 'joan', password: 'bad' }), 401, 'unauthorized');
    await loginClient(api);
    mock.state.scope = 'read';
    is(await post('source/rescan'), 403, 'insufficient_scope');
    is(await post('nodes/rename', { currentAlias: 'a', alias: 'b' }), 403, 'insufficient_scope');
    mock.state.scope = 'operate';
    is(await post('nodes/rename', { currentAlias: 'a', alias: 'b' }), 403, 'insufficient_scope');
    is(await post('source/rescan'), 200);
    mock.state.scope = 'admin';
    mock.options.forbid = true;
    is(await post('source/rescan'), 403, 'insufficient_scope');
    is(await get('nodes'), 200);
  });
  it('an admin change to the signed-in account ends its session, like the Server\'s security stamp', async () => {
    const { get, post, is, mock } = setup();
    is(await post('accounts/joan/scope', { scope: 'admin' }), 200);
    is(await get('session'), 200);
    expect(mock.audit.some(e => e.action === 'account.scope_changed')).toBe(false);
    is(await post('accounts/ana/scope', { scope: 'read' }), 200);
    is(await get('session'), 200);
    is(await post('accounts/joan/scope', { scope: 'operate' }), 200);
    is(await get('session'), 401, 'unauthorized');

    const reset = setup();
    reset.is(await reset.post('accounts/joan/password', { password: 'temporary-pass-1' }), 200);
    reset.is(await reset.get('nodes'), 401, 'unauthorized');
    const own = setup();
    own.is(await own.post('account/password', { currentPassword: 'old-password', newPassword: 'a-new-passphrase' }), 200);
    own.is(await own.get('nodes'), 200);
  });
  it('account names start with a letter or digit, and account events name the account', async () => {
    const { get, post, is } = setup();
    for (const name of ['.', '..', '.hidden', '-x']) is(await post('accounts', { name, password: 'first-password-1', scope: 'read' }), 400, 'invalid_account_name');
    is(await post('accounts', { name: 'new.user', password: 'first-password-1', scope: 'read' }), 201);
    is(await post('accounts/ana/scope', { scope: 'read' }), 200);
    const items = ((await get('audit?order=newest&limit=100')).body as Page<AuditEvent>).items;
    expect(items.find(e => e.action === 'account.created')).toMatchObject({ actor: 'joan', account: 'new.user', detail: 'read' });
    expect(items.find(e => e.action === 'account.scope_changed')).toMatchObject({ actor: 'joan', account: 'ana', detail: 'operate -> read' });
  });
  it('fail=<prefix> fails GET routes under it; unknown routes and bad hours are 404 and 400', async () => {
    const failing = setup({ fail: 'nodes' });
    failing.is(await failing.get('nodes'), 500, 'mock_failure');
    failing.is(await failing.get('nodes/studio-mini'), 500, 'mock_failure');
    failing.is(await failing.get('issues'), 200);
    const { get, is } = setup();
    is(await get('no/such/route'), 404, 'invalid_request');
    is(await get('nodes/studio-mini/checkins?hours=0'), 400, 'invalid_request');
    is(await get('nodes/studio-mini/checkins?hours=169'), 400, 'invalid_request');
  });
  it('errors catalog entries and a missing code', async () => {
    const { get, is } = setup();
    const all = await get('errors');
    expect(all.body.items.map((e: any) => e.code)).toEqual(expect.arrayContaining(['lock_failed', 'agent_outdated', 'disk_space_critical', 'assignment_failed', 'ai_client_reconcile_failed']));
    expect(all.body.items.every((e: any) => keys(e) === 'code,explanation,fix,source,title')).toBe(true);
    is(await get('errors/lock_failed'), 200);
    is(await get('errors/does_not_exist'), 404, 'invalid_request');
  });
  it('check-ins are hourly buckets, oldest first, with hours of zero polls included', async () => {
    const { get, is } = setup();
    const r = await get('nodes/studio-mini/checkins?hours=24');
    is(r, 200);
    expect(r.body.hours).toBe(24);
    expect(r.body.buckets).toHaveLength(24);
    expect(keys(r.body.buckets[0])).toBe('hour,polls');
    const hours = r.body.buckets.map((b: any) => Date.parse(b.hour));
    expect(hours).toEqual([...hours].sort((a, b) => a - b));
    expect(r.body.buckets.slice(-2).some((b: any) => b.polls > 0)).toBe(true); // the current hour can be seconds old
    expect((await get('nodes/old-laptop/checkins?hours=24')).body.buckets.every((b: any) => b.polls === 0)).toBe(true);
    expect((await get('nodes/studio-mini/checkins')).body.buckets).toHaveLength(168);
  });
  it('retry re-queues a failed Target with a pending Attempt and audits it', async () => {
    const { get, post, is, mock } = setup();
    const n = mock.nodes.find(x => x.alias === 'studio-mini')!;
    is(await post(`nodes/studio-mini/retry`, { target: 'skills' }), 409, 'target_not_failed');
    is(await post(`nodes/studio-mini/retry`, { target: 'nope' }), 404, 'target_not_found');
    is(await post(`nodes/nobody/retry`, { target: 'skills' }), 404, 'node_not_found');
    is(await post(`nodes/old-laptop/retry`, { target: 'skills' }), 409, 'node_revoked');
    const r = await post(`nodes/studio-mini/retry`, { target: 'ai-client/claude' });
    is(r, 200);
    expect(r.body).toMatchObject({ state: 'pending' });
    expect(keys(r.body)).toBe('assignmentId,attemptId,state');
    const d = (await get('nodes/' + n.id)).body as NodeDetail;
    const t = d.targets.find(x => x.name === 'ai-client/claude')!;
    expect(t.state).toBe('pending');
    expect(t.latestAttempt).toMatchObject({ state: 'pending', attemptId: r.body.attemptId });
    expect(mock.audit[0]).toMatchObject({ action: 'assignment.retry_requested', nodeId: n.id });
    expect(((await get('issues')).body.items as Issue[]).some(i => i.id === `assignment_failed:${n.id}:ai-client/claude`)).toBe(false);
  });
  it('a disk refresh is answered by the Agent after the delay, and not by an old Agent', async () => {
    const { get, post, mock } = setup({ diskDelay: 20 });
    await post('nodes/build-runner-02/disk-usage/refresh');
    await new Promise(r => setTimeout(r, 60));
    const d = (await get('nodes/build-runner-02')).body as NodeDetail;
    expect(d.disk!.refreshRequestedAt).toBeNull();
    expect(d.disk!.volumes).toHaveLength(1);
    await post('nodes/kitchen-mini/disk-usage/refresh');
    await new Promise(r => setTimeout(r, 60));
    expect(((await get('nodes/kitchen-mini')).body as NodeDetail).disk!.refreshRequestedAt).not.toBeNull();
    mock.dispose();
  });
  it('creating a link simulates the machine enrolling', async () => {
    const { get, post, mock } = setup();
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    try {
      const created = await post('enrollment-links', { alias: 'new-box', expiresInSeconds: 600 });
      expect(created.body.link).toMatch(/^https:\/\/fleet\.lab\.internal:8443\/enroll#fleet-v1=/);
      expect((await get('enrollment-links/' + created.body.id)).body.state).toBe('active');
      await vi.advanceTimersByTimeAsync(5001);
      expect((await get('enrollment-links/' + created.body.id)).body.state).toBe('consumed');
      expect(mock.nodes.some(n => n.alias === 'new-box')).toBe(false);
      await vi.advanceTimersByTimeAsync(4000);
      const node = mock.nodes.find(n => n.alias === 'new-box')!;
      expect(node.platform).toBe('macos');
      expect(node.freshness).toBe('fresh');
      expect(mock.audit.some(e => e.action === 'node_enrolled' && e.subject === 'new-box')).toBe(true);
    } finally { vi.useRealTimers(); mock.dispose(); }
  });
});

describe('Agent self-update (agent-self-update.md, "Server")', () => {
  const UPDATE_KEYS = 'errorCode,finishedAt,fromVersion,requestedAt,requestedBy,state,targetVersion,updatedAt';
  const byAlias = (mock: { nodes: Array<{ alias: string; id: string }> }, alias: string) => mock.nodes.find(n => n.alias === alias)!;

  it('the list and the detail carry agent.selfUpdate and agentUpdate (null without an update); agent=0 has neither', async () => {
    const { get, mock } = setup({ releaseDelay: 0 });
    const list = ((await get('nodes')).body as Page<NodeListItem>).items;
    const item = (alias: string) => list.find(i => i.name === alias)!;
    expect(item('fedora-ws').agent!.selfUpdate).toBe(true);
    expect(item('laptop-ana').agent!.selfUpdate).toBe(false);
    expect(item('fedora-ws').agentUpdate).toBeNull();
    expect(item('kitchen-mini').agent).toBeNull();
    expect(item('kitchen-mini').agentUpdate).toBeNull();
    const failed = item('build-runner-03').agentUpdate!;
    expect(keys(failed)).toBe(UPDATE_KEYS);
    expect(failed).toMatchObject({ fromVersion: '0.9.0-rc.1', targetVersion: '0.9.0', state: 'failed', errorCode: 'agent_update_smoke_test', requestedBy: 'ana' });
    expect(failed.finishedAt).toBe(failed.updatedAt);
    const detail = (await get('nodes/' + byAlias(mock, 'build-runner-03').id)).body as NodeDetail;
    expect(detail.agentUpdate).toEqual(failed);
    expect(detail.agent!.selfUpdate).toBe(true);
    const old = setup({ agent: false });
    const oldItem = ((await old.get('nodes')).body as Page<NodeListItem>).items[0]!;
    expect('agentUpdate' in oldItem || 'agent' in oldItem).toBe(false);
  });

  it('requesting checks the Node first, in the Server\'s order, then returns the request (202) and repeats it unchanged', async () => {
    const { post, is, mock } = setup({ releaseDelay: 0 });
    is(await post('nodes/nobody-here/agent-update'), 404, 'node_not_found');
    is(await post('nodes/old-laptop/agent-update'), 409, 'node_revoked');
    const manual = await post('nodes/laptop-ana/agent-update');
    is(manual, 409, 'agent_update_unsupported');
    expect(manual.body.message).toContain('fleet-agent service install');
    is(await post('nodes/kitchen-mini/agent-update'), 409, 'agent_update_unsupported');
    const current = await post('nodes/studio-mini/agent-update');
    is(current, 409, 'agent_update_current');
    expect(current.body.message).toBe('The Agent already runs version 0.9.0.');
    const first = await post('nodes/fedora-ws/agent-update');
    is(first, 202);
    expect(keys(first.body)).toBe(UPDATE_KEYS);
    expect(first.body).toMatchObject({ fromVersion: '0.9.0-rc.2', targetVersion: '0.9.0', state: 'requested', errorCode: null, requestedBy: 'joan', finishedAt: null });
    const again = await post('nodes/fedora-ws/agent-update');
    is(again, 202);
    expect(again.body).toEqual(first.body);
    const fedora = byAlias(mock, 'fedora-ws');
    const audited = mock.audit.filter(e => e.action === 'agent.update_requested');
    expect(audited, 'only the first request is recorded').toHaveLength(1);
    expect(audited[0]).toMatchObject({ actor: 'joan', nodeId: fedora.id, detail: '0.9.0-rc.2 -> 0.9.0' });
    mock.dispose();
  });

  it('cancel works only while the Agent has not picked the request up', async () => {
    const { post, is, mock } = setup({ releaseDelay: 0 });
    is(await post('nodes/nobody-here/agent-update/cancel'), 404, 'node_not_found');
    is(await post('nodes/fedora-ws/agent-update/cancel'), 409, 'agent_update_not_cancellable');
    is(await post('nodes/build-runner-03/agent-update/cancel'), 409, 'agent_update_not_cancellable');
    is(await post('nodes/build-runner-03/agent-update'), 202);
    const cancelled = await post('nodes/build-runner-03/agent-update/cancel');
    is(cancelled, 200);
    expect(cancelled.body).toMatchObject({ state: 'cancelled', targetVersion: '0.9.0' });
    expect(cancelled.body.finishedAt).toBe(cancelled.body.updatedAt);
    is(await post('nodes/build-runner-03/agent-update/cancel'), 409, 'agent_update_not_cancellable');
    expect(mock.audit.find(e => e.action === 'agent.update_cancelled')).toMatchObject({ actor: 'joan', detail: '0.9.0' });
    is(await post('nodes/build-runner-03/agent-update'), 202);
    mock.dispose();
  });

  it('the simulated Agent goes requested, downloading, restarting, succeeded, and then runs the new version', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { get, post, is, mock } = setup({ releaseDelay: 0, updateDelay: 1000 });
    try {
      const fedora = byAlias(mock, 'fedora-ws');
      const state = async () => ((await get('nodes/fedora-ws')).body as NodeDetail).agentUpdate!.state;
      is(await post('nodes/fedora-ws/agent-update'), 202);
      expect(await state()).toBe('requested');
      await vi.advanceTimersByTimeAsync(1000);
      expect(await state()).toBe('downloading');
      is(await post('nodes/fedora-ws/agent-update'), 409, 'agent_update_in_progress');
      is(await post('nodes/fedora-ws/agent-update/cancel'), 409, 'agent_update_not_cancellable');
      await vi.advanceTimersByTimeAsync(1000);
      expect(await state()).toBe('restarting');
      await vi.advanceTimersByTimeAsync(1000);
      const done = (await get('nodes/fedora-ws')).body as NodeDetail;
      expect(done.agentUpdate).toMatchObject({ state: 'succeeded', errorCode: null });
      expect(done.agentUpdate!.finishedAt).not.toBeNull();
      expect(done.agent).toMatchObject({ version: '0.9.0', outdated: false });
      expect(mock.audit.find(e => e.action === 'agent.update_succeeded')).toMatchObject({ actor: fedora.id, nodeId: fedora.id, detail: '0.9.0' });
      const events = ((await get(`audit?node=${fedora.id}&order=newest`)).body as Page<AuditEvent>).items;
      expect(events.slice(0, 2).map(e => e.action)).toEqual(['agent.update_succeeded', 'agent.update_requested']);
      expect(((await get('issues')).body.items as Issue[]).some(i => i.nodeId === fedora.id && /^agent_/.test(i.code)), 'no Agent issue any more').toBe(false);
      is(await post('nodes/fedora-ws/agent-update'), 409, 'agent_update_current');
    } finally { vi.useRealTimers(); mock.dispose(); }
  });

  it('a machine in updateFail fails the smoke test; its issue becomes agent_update_failed; an offline machine never picks the request up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { get, post, is, mock } = setup({ releaseDelay: 0, updateDelay: 1000, updateFail: ['fedora-ws'] });
    try {
      const fedora = byAlias(mock, 'fedora-ws');
      const issue = async (alias: string) => ((await get('issues')).body.items as Issue[]).find(i => i.nodeName === alias && /^agent_/.test(i.code));
      expect((await issue('fedora-ws'))!.code).toBe('agent_outdated');
      is(await post('nodes/fedora-ws/agent-update'), 202);
      is(await post('nodes/build-runner-03/agent-update'), 202);
      expect((await issue('build-runner-03'))!.code, 'a requested update is not a failed one').toBe('agent_outdated');
      await vi.advanceTimersByTimeAsync(5000);
      expect(((await get('nodes/fedora-ws')).body as NodeDetail).agentUpdate).toMatchObject({ state: 'failed', errorCode: 'agent_update_smoke_test' });
      expect(((await get('nodes/fedora-ws')).body as NodeDetail).agent!.version).toBe('0.9.0-rc.2');
      expect(((await get('nodes/build-runner-03')).body as NodeDetail).agentUpdate!.state, 'offline: still waiting').toBe('requested');
      const failed = (await issue('fedora-ws'))!;
      expect(failed).toMatchObject({
        id: `agent_update_failed:${fedora.id}`, code: 'agent_update_failed', severity: 'warning', title: 'fedora-ws: Agent update failed', errorCode: 'agent_update_smoke_test',
        detail: 'The update to 0.9.0 failed with agent_update_smoke_test; the Agent still runs version 0.9.0-rc.2.',
        commands: ['fleet nodes show fedora-ws', 'fleet explain agent_update_smoke_test', 'fleet nodes update fedora-ws'],
      });
      expect(failed.action).toMatch(/fleet-agent --version/);
      expect(mock.audit.find(e => e.action === 'agent.update_failed')).toMatchObject({ actor: fedora.id, detail: 'agent_update_smoke_test' });
    } finally { vi.useRealTimers(); mock.dispose(); }
  });

  it('agent_outdated lists fleet nodes update only for an Agent that can update itself', async () => {
    const { get } = setup();
    const items = (await get('issues')).body.items as Issue[];
    const of = (alias: string) => items.find(i => i.nodeName === alias && /^agent_/.test(i.code))!;
    expect(of('fedora-ws').commands).toEqual(['fleet nodes show fedora-ws', 'fleet nodes update fedora-ws']);
    expect(of('fedora-ws').action).toMatch(/^Update it with Update Agent in the dashboard/);
    expect(of('laptop-ana').commands).toEqual(['fleet nodes show laptop-ana']);
    expect(of('mba-travel').action).toMatch(/brew upgrade fleet-agent/);
    expect(of('build-runner-03').code).toBe('agent_update_failed');
  });

  it('POST agent-updates: one result per Node, in the order asked; allOutdated takes every outdated live Node by alias', async () => {
    const { post, is, mock } = setup({ releaseDelay: 0 });
    for (const body of [{}, { nodes: [] }, { allOutdated: false }, { allOutdated: true, nodes: ['fedora-ws'] }, { nodes: ['fedora-ws', ' '] }, { nodes: Array(501).fill('x') }]) {
      is(await post('agent-updates', body), 400, 'invalid_request');
    }
    const picked = await post('agent-updates', { nodes: ['nobody', 'laptop-ana', 'fedora-ws', 'fedora-ws', byAlias(mock, 'studio-mini').id] });
    is(picked, 200);
    expect(keys(picked.body)).toBe('items,targetVersion');
    expect(picked.body.targetVersion).toBe('0.9.0');
    expect(picked.body.items.map((i: any) => [i.node, i.requested, i.code])).toEqual([
      ['nobody', false, 'node_not_found'], ['laptop-ana', false, 'agent_update_unsupported'], ['fedora-ws', true, null], [byAlias(mock, 'studio-mini').id, false, 'agent_update_current'],
    ]);
    expect(keys(picked.body.items[0])).toBe('agentUpdate,code,message,node,nodeId,requested');
    expect(picked.body.items[0]).toMatchObject({ nodeId: null, message: 'Node was not found.', agentUpdate: null });
    expect(picked.body.items[2].agentUpdate).toMatchObject({ state: 'requested', targetVersion: '0.9.0' });
    expect(picked.body.items[2].nodeId).toBe(byAlias(mock, 'fedora-ws').id);
    const all = await post('agent-updates', { allOutdated: true });
    is(all, 200);
    expect(all.body.items.map((i: any) => [i.node, i.requested, i.code])).toEqual([
      ['build-runner-03', true, null], ['fedora-ws', true, null], ['laptop-ana', false, 'agent_update_unsupported'], ['mba-travel', false, 'agent_update_unsupported'],
    ]);
    expect(all.body.items[1].agentUpdate, 'still requested: the same update').toEqual(picked.body.items[2].agentUpdate);
    mock.dispose();
  });

  it('a release that cannot be mirrored fails the request: 503 agent_release_unavailable, 502 agent_release_invalid; admin only', async () => {
    const unavailable = setup({ releaseDelay: 0, release: 'unavailable' });
    const r = await unavailable.post('nodes/fedora-ws/agent-update');
    unavailable.is(r, 503, 'agent_release_unavailable');
    expect(r.body.message).toMatch(/^Agent release 0\.9\.0 is not published yet/);
    unavailable.is(await unavailable.post('agent-updates', { allOutdated: true }), 503, 'agent_release_unavailable');
    unavailable.is(await unavailable.post('nodes/laptop-ana/agent-update'), 409, 'agent_update_unsupported');
    expect(unavailable.mock.nodes.every(n => n._update?.state !== 'requested')).toBe(true);
    const invalid = setup({ releaseDelay: 0, release: 'invalid' });
    invalid.is(await invalid.post('nodes/fedora-ws/agent-update'), 502, 'agent_release_invalid');
    const op = setup({ scope: 'operate' });
    op.is(await op.post('nodes/fedora-ws/agent-update'), 403, 'insufficient_scope');
    op.is(await op.post('nodes/fedora-ws/agent-update/cancel'), 403, 'insufficient_scope');
    op.is(await op.post('agent-updates', { allOutdated: true }), 403, 'insufficient_scope');
  });

  it('the error catalog has every Agent update code', async () => {
    const { get } = setup();
    const codes = ((await get('errors')).body.items as Array<{ code: string; source: string }>);
    const source = (code: string) => codes.find(c => c.code === code)?.source;
    for (const c of ['unmanaged', 'untrusted', 'invalid_manifest', 'downgrade', 'platform', 'download', 'too_large', 'digest', 'smoke_test', 'install', 'crash_loop', 'no_contact', 'rolled_back']) expect(source(`agent_update_${c}`), c).toBe('agent');
    for (const c of ['agent_update_unsupported', 'agent_update_current', 'agent_update_in_progress', 'agent_update_not_cancellable', 'agent_update_not_requested', 'agent_release_unavailable', 'agent_release_invalid', 'agent_release_not_found']) expect(source(c), c).toBe('server');
    expect(source('agent_update_failed')).toBe('issue');
    expect((await get('errors/agent_update_smoke_test')).body.title).toBe('The new binary did not start on this machine');
  });
});

describe('response shapes match contracts/operator/*.json', () => {
  /** Same property names at every level (arrays compare their first item; null or a different primitive stops the descent). */
  function sameShape(actual: unknown, expected: unknown, path = '$'): string[] {
    if (expected === null || actual === null || typeof expected !== 'object' || typeof actual !== 'object') return [];
    if (Array.isArray(expected) || Array.isArray(actual)) {
      if (!Array.isArray(expected) || !Array.isArray(actual)) return [`${path}: array mismatch`];
      return expected.length && actual.length ? sameShape(actual[0], expected[0], path + '[0]') : [];
    }
    const a = Object.keys(actual as object).sort();
    const e = Object.keys(expected as object).sort();
    const problems: string[] = [];
    if (a.join() !== e.join()) problems.push(`${path}: mock has [${a}] but the contract has [${e}]`);
    for (const k of e) if (a.includes(k)) problems.push(...sameShape((actual as any)[k], (expected as any)[k], `${path}.${k}`));
    return problems;
  }
  const idOf = (fixtureName: string): string => contract<any>(fixtureName).nodeId;

  it('nodes page', async () => {
    const { get } = setup();
    expect(sameShape((await get('nodes')).body, contract('nodes-page'))).toEqual([]);
  });
  it('node detail (a failed machine with every target kind)', async () => {
    const { get, mock } = setup();
    const n = mock.nodes.find(x => x.alias === 'studio-mini')!;
    const fixture = contract<NodeDetail>('node-detail');
    const actual = (await get('nodes/' + n.id)).body as NodeDetail;
    expect(idOf('node-detail')).toBeTruthy();
    expect(sameShape(actual, fixture)).toEqual([]);
    const kinds = new Set(fixture.targets.map(t => t.kind));
    for (const kind of kinds) {
      const fx = fixture.targets.find(t => t.kind === kind)!;
      const real = actual.targets.find(t => t.kind === kind);
      if (real) expect(sameShape(real, fx, `target(${kind})`)).toEqual([]);
    }
  });
  it('attempts page, check-ins, issues, errors, scans, links, revision, rollout and rollout attempts', async () => {
    const { get, mock } = setup();
    const studio = mock.nodes.find(x => x.alias === 'studio-mini')!.id;
    expect(sameShape((await get(`nodes/${studio}/attempts`)).body, contract('node-attempts-page'))).toEqual([]);
    expect(sameShape((await get(`nodes/${studio}/checkins?hours=3`)).body, contract('node-checkins'))).toEqual([]);
    expect(sameShape((await get('issues')).body, contract('issues'))).toEqual([]);
    expect(sameShape((await get('errors')).body, contract('errors'))).toEqual([]);
    expect(sameShape((await get('source/scans')).body, contract('source-scans-page'))).toEqual([]);
    expect(sameShape((await get('enrollment-links')).body, contract('enrollment-links-page'))).toEqual([]);
    const rev = ((await get('desired-revisions?order=newest')).body as Page<DesiredRevisionItem>).items[0]!;
    expect(sameShape((await get('desired-revisions/' + rev.desiredRevisionId)).body, contract('desired-revision'))).toEqual([]);
    const ro = ((await get('rollouts?order=newest')).body as Page<RolloutItem>).items[0]!;
    expect(sameShape((await get('rollouts/' + ro.rolloutId)).body, contract('rollout'))).toEqual([]);
    expect(sameShape((await get(`rollouts/${ro.rolloutId}/attempts`)).body, contract('rollout-attempts-page'))).toEqual([]);
    expect(sameShape((await get('enrollment-links/' + mock.links[0]!.id)).body, contract('enrollment-link'))).toEqual([]);
  });
});
