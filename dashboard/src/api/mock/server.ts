/**
 * A contract-faithful, in-memory implementation of every `/dashboard/api` route (ported from `Dev/fixture.js`).
 * It answers like the Server: same order of checks, same error codes and statuses, same audit events, ordering and paging
 * (`order=newest`, cursors valid only for the order they came from), CSRF and Origin checks, scope checks and validation
 * errors. It never touches the network: `createMockServer().fetch` is a `fetch` replacement that the API client takes
 * through its `fetch` option (no global is patched).
 *
 * Mutations change the in-memory state. Creating an enrollment link simulates the machine enrolling a few seconds later,
 * and a disk refresh is answered by the simulated Agent after `diskDelay`.
 */
import type {
  AssignmentState, CatalogSelection, CliProxyStatus, CommitInfo, DiskVolume, Issue, NodeAgent, NodeAttempt, NodeDetail, NodeDisk, NodeListItem, NodeTarget,
  RolloutDetail, Scope, SelectionPolicy,
} from '../types';
import { ANCHOR, buildDataset, type DataAttempt, type DataCatalog, type DataCatalogModel, type DataLink, type DataNode, type DataRevision, type DataRollout, type DataTarget, type Dataset } from './dataset';
import { defaultMockOptions, type MockOptions } from './options';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export interface MockCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Json;
  headers: Record<string, string>;
  at: number;
  /** The response was delivered, or the call was aborted. Calls with `settled === false` are in flight. */
  settled: boolean;
  /** The caller's `AbortSignal` fired. */
  aborted: boolean;
}

export interface MockState {
  signedIn: boolean;
  scope: Scope;
  actor: string;
  csrf: string;
}

interface MNode extends DataNode {
  _disk: { measuredAt: string; volumes: Array<{ label: string; totalBytes: number; usedBytes: number; availableBytes: number }> } | null;
  _diskReq: string | null;
  _diskTimer?: ReturnType<typeof setTimeout> | null;
  _agent: MockAgent | null;
  _drift: Array<{ target: string; files: string[]; detectedAt: string }>;
}
interface MockAgent {
  version: string;
  os: { name: string | null; version: string | null; kernel: string | null };
  arch: string; hostname: string; user: string; installMethod: string; serviceManager: string; stateDirectory: string; reportedAt: string;
}
interface MLink extends DataLink {
  nodeId?: string | null;
  _platform?: string;
}
interface MAudit {
  recordedAt: string;
  action: string;
  actor: string;
  subject: string;
  nodeId: string | null;
  credentialId: string | null;
}
interface IssueStateRec {
  kind: 'acknowledged' | 'snoozed';
  since: string | null;
  by: string;
  at: string;
  until?: string;
}

export interface MockServer {
  /** Pass it to `createApiClient({ fetch })`. */
  fetch: typeof fetch;
  options: MockOptions;
  state: MockState;
  /** The dataset the mock started from (times are in the anchor's frame; the live records are in `nodes`, `links`, `audit`). */
  data: Dataset;
  nodes: MNode[];
  links: MLink[];
  audit: MAudit[];
  /** Every call, with its JSON body, whether it settled and whether the caller aborted it. */
  calls: MockCall[];
  issueStates: Map<string, IssueStateRec>;
  /** Stops the timers of the simulated Agents (enrollment, disk refresh). Call it when a test ends. */
  dispose(): void;
}

const HOUR = 36e5;
const DAY = 24 * HOUR;
const GIB = 1024 ** 3;

export function createMockServer(overrides: Partial<MockOptions> = {}): MockServer {
  const cfg: MockOptions = { ...defaultMockOptions(), ...overrides };
  const F = buildDataset();
  const shift = Date.now() - Date.parse(F.now);
  const T = (iso: string | null | undefined): string | null => (iso ? new Date(Date.parse(iso) + shift).toISOString() : null);
  const nowIso = (): string => new Date().toISOString();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number): void => {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
  };

  /* deterministic hex from a seed string */
  const hex = (seed: unknown, n: number): string => {
    let h = 2166136261;
    let out = '';
    const s = String(seed);
    while (out.length < n) {
      for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
      h = (h + out.length + 1) >>> 0;
      out += h.toString(16).padStart(8, '0');
    }
    return out.slice(0, n);
  };
  const guid = (seed: unknown): string => {
    const h = hex(seed, 32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  const revBySha = (sha: string | null): DataRevision | undefined => F.revisions.find(r => r.shortSha === sha);

  /* ---------------------------------------------------------------- mutable state */
  const state: MockState = { signedIn: !cfg.signedOut, scope: cfg.scope, actor: cfg.actor, csrf: 'mock-csrf-' + hex(Date.now(), 12) };
  const nodes = (cfg.empty ? [] : JSON.parse(JSON.stringify(F.nodes))) as MNode[];
  if (cfg.weirdAlias && nodes.length) nodes[0]!.alias = 'rack/A 100%';
  const links = (cfg.empty ? [] : JSON.parse(JSON.stringify(F.enrollmentLinks))) as MLink[];
  const audit: MAudit[] = (cfg.empty ? [] : (JSON.parse(JSON.stringify(F.audit)) as Array<{ recordedAt: string; action: string; actor: string; subject: string }>)).map(e => ({ nodeId: null, credentialId: null, ...e }));
  const scans = JSON.parse(JSON.stringify(F.source.scans)) as typeof F.source.scans;
  const catalogs = JSON.parse(JSON.stringify(F.cliproxy.catalogs)) as Array<DataCatalog & { _failureSince?: string | null }>;
  catalogs.forEach(c => { c._failureSince = c.errorCode ? T(c.lastAttemptAt) : null; });
  const policies = new Map<string, SelectionPolicy>();
  const targetAttempts = new Map<string, Json[]>();

  const skillDigest = (name: string): string => 'sha256:' + hex('skill:' + name, 64);
  /* The dataset is anchored at a fixed "now". Shift every record so relative times ("5 min ago") hold today. */
  nodes.forEach(n => {
    n.enrolledAt = T(n.enrolledAt)!;
    n.lastContactAt = T(n.lastContactAt);
    n.revokedAt = T(n.revokedAt);
    (['notBefore', 'notAfter', 'revokedAt'] as const).forEach(k => { (n.credential as Json)[k] = T(n.credential[k]); });
    n.targets.forEach(t => {
      t.updatedAt = T(t.updatedAt)!;
      if (t.failure) t.failure.firstSeenAt = T(t.failure.firstSeenAt)!;
      t.attempts.forEach(a => { a.startedAt = T(a.startedAt)!; a.finishedAt = T(a.finishedAt); });
    });
  });
  links.forEach(l => { (['expiresAt', 'consumedAt', 'revokedAt'] as const).forEach(k => { (l as Json)[k] = T(l[k]); }); });
  audit.forEach(e => { e.recordedAt = T(e.recordedAt)!; });
  scans.forEach(s => { s.observedAt = T(s.observedAt)!; });
  const counts = (n: MNode): Record<AssignmentState, number> => {
    const c = { pending: 0, applying: 0, succeeded: 0, failed: 0, superseded: 0 };
    n.targets.forEach(t => { c[t.state] = (c[t.state] || 0) + 1; });
    return c;
  };
  const desiredOf = (_n: MNode, t: DataTarget): { desiredRevisionId: string; sourceRevision: string; acceptedAt: string } | null => {
    const r = revBySha(t.desiredRevision);
    return r ? { desiredRevisionId: r.id, sourceRevision: r.sourceRevision, acceptedAt: T(r.acceptedAt)! } : null;
  };
  const currentRevision = (n: MNode): string | null =>
    n.revokedAt ? null : n.targets.map(t => desiredOf(n, t)).filter((d): d is NonNullable<typeof d> => !!d).sort((a, b) => Date.parse(b.acceptedAt) - Date.parse(a.acceptedAt))[0]?.sourceRevision || null;
  const credNotAfter = (n: MNode): string | null => (n.revokedAt ? null : n.credential.notAfter);

  /* Disk usage (operator-api.md, "Disk usage"). Each Node keeps the latest report only: n._disk = { measuredAt, volumes } or null (never reported),
     n._diskReq = pending refresh request time or null. Percentages are used / (used + available), like df; the filesystem keeps 3% back. */
  const XSS_LABEL = '<img src=x onerror=alert(1)>"><script>alert(5)</script>';
  const vol = (label: string, totalGiB: number, pct: number): { label: string; totalBytes: number; usedBytes: number; availableBytes: number } => {
    const fit = Math.round(totalGiB * GIB * 0.97);
    const used = Math.round((fit * pct) / 100);
    return { label, totalBytes: Math.round(totalGiB * GIB), usedBytes: used, availableBytes: fit - used };
  };
  /* alias -> [measured ago in minutes, volumes]. Missing aliases never reported. kitchen-mini is an Agent before 0.9.0: it never reports and never answers a refresh. */
  const DISK: Record<string, [number, ReturnType<typeof vol>[]]> = {
    'mbp-joan': [130, [vol('home', 926, 62.4)]],
    'studio-mini': [60, [vol('home', 1863, 78.2)]],
    'homelab-nuc': [52, [vol(cfg.xss ? XSS_LABEL : 'home', 954, 96.4), vol('state', 476, 41.3)]],
    'fedora-ws': [185, [vol('home', 476, 88.7)]],
    'build-runner-01': [90, [vol('home', 233, 34.9)]],
    'build-runner-03': [192, [vol('home', 233, 72.0)]],
    'mba-travel': [3000, [vol('home', 233, 55.1)]],
    'design-imac': [40, [vol('home', 1863, 83.9)]],
    'gpu-box': [15, [vol('home', 1863, 85.0)]],
    'laptop-ana': [200, [vol('home', 466, 29.6)]],
  };
  const NO_DISK_AGENT = new Set(['kitchen-mini']);
  nodes.forEach(n => {
    const d = !cfg.empty && !n.revokedAt && DISK[n.alias];
    n._disk = d ? { measuredAt: new Date(Date.now() - d[0] * 60e3).toISOString(), volumes: d[1].map(v => ({ ...v })) } : null;
    n._diskReq = null;
  });
  const pctOf = (v: { usedBytes: number; availableBytes: number }): number => Math.round((v.usedBytes / (v.usedBytes + v.availableBytes)) * 1000) / 10;
  const volOut = (v: { label: string; totalBytes: number; usedBytes: number; availableBytes: number }): DiskVolume => ({ label: v.label, totalBytes: v.totalBytes, usedBytes: v.usedBytes, availableBytes: v.availableBytes, usedPercent: pctOf(v) });
  const fullest = (n: MNode) => n._disk && n._disk.volumes.slice().sort((a, b) => pctOf(b) - pctOf(a))[0];
  const listDisk = (n: MNode): NodeListItem['disk'] => { const v = n._disk && fullest(n); return v ? { ...volOut(v), measuredAt: n._disk!.measuredAt } : null; };
  const detailDisk = (n: MNode): NodeDisk | null => (n._disk || n._diskReq ? { measuredAt: n._disk ? n._disk.measuredAt : null, refreshRequestedAt: n._diskReq, volumes: n._disk ? n._disk.volumes.map(volOut) : [] } : null);
  const GIBTXT = (b: number): string => (b / GIB).toFixed(1) + ' GiB';

  /* Agent and machine information (operator-api.md, "Phase 3"). Each Node keeps the latest report only. latestVersion is the Server's own
     version and outdated compares versions under semantic versioning, where a prerelease sorts below its release. Only Agents from 0.9.0 report,
     so a reporting Agent is 0.9.0 or a prerelease of it, never 0.8.x: kitchen-mini (an Agent before 0.9.0) and lab-vm-07 (never polled) report nothing. */
  const LATEST = '0.9.0';
  const semver = (v: string): { n: number[]; pre: string[] | null } => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v)!;
    return { n: [+m[1]!, +m[2]!, +m[3]!], pre: m[4] ? m[4].split('.') : null };
  };
  const semverLess = (a: string, b: string): boolean => {
    const x = semver(a);
    const y = semver(b);
    for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i]! < y.n[i]!;
    if (!x.pre || !y.pre) return !!x.pre && !y.pre; // a prerelease sorts below its release
    for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
      const p = x.pre[i];
      const q = y.pre[i];
      if (p === undefined || q === undefined) return p === undefined && q !== undefined;
      if (p === q) continue;
      const pn = /^\d+$/.test(p);
      const qn = /^\d+$/.test(q);
      return pn && qn ? +p < +q : pn ? true : qn ? false : p < q;
    }
    return false;
  };
  const XSS_AGENT = { hostname: '<img src=x onerror=alert(1)>.lab', user: '"><script>alert(6)</script>', osName: '<svg onload=alert(7)> Linux', stateDirectory: '~/<img src=x onerror=alert(8)>' };
  const STATE_DIR = '~/.local/state/fleet-agent';
  /* alias -> [os name, os version, kernel, arch, hostname, user, Agent version, install method, service manager, reported minutes ago]. Missing aliases never reported. */
  type AgentSpec = [string, string | null, string, string, string, string, string, string, string, number];
  const AGENTS: Record<string, AgentSpec> = {
    'mbp-joan': ['macOS', '15.1', '24.1.0', 'aarch64', 'Joans-MacBook-Pro', 'joan', '0.9.0', 'homebrew', 'launchd', 130],
    'studio-mini': ['macOS', '15.0', '24.0.0', 'aarch64', 'studio-mini.lan', 'joan', '0.9.0', 'homebrew', 'launchd', 60],
    'homelab-nuc': ['Fedora Linux', '44', '7.2.11-200.fc44.x86_64', 'x86_64', 'nuc.lab.internal', 'ops', '0.9.0', 'homebrew', 'systemd', 52],
    'fedora-ws': ['Fedora Linux', '44', '7.2.11-200.fc44.x86_64', 'x86_64', 'fedora-ws', 'joan', '0.9.0-rc.2', 'binary', 'systemd', 185],
    'build-runner-01': ['Ubuntu', '24.04', '6.8.0-48-generic', 'x86_64', 'runner-01', 'ci', '0.9.0', 'binary', 'systemd', 90],
    'build-runner-02': ['Ubuntu', '24.04', '6.8.0-48-generic', 'x86_64', 'runner-02', 'ci', '0.9.0', 'binary', 'systemd', 45],
    'build-runner-03': ['Ubuntu', '24.04', '6.8.0-48-generic', 'x86_64', 'runner-03', 'ci', '0.9.0-rc.1', 'binary', 'none', 192],
    'mba-travel': ['macOS', '14.6', '23.6.0', 'x86_64', 'Joans-MacBook-Air', 'joan', '0.9.0-rc.1', 'homebrew', 'launchd', 3000],
    'design-imac': ['macOS', '15.1', '24.1.0', 'aarch64', 'design-imac', 'mika', '0.9.0', 'homebrew', 'launchd', 40],
    /* Arch Linux has no VERSION_ID in os-release, so the version is null. */
    'gpu-box': ['Arch Linux', null, '6.17.4-arch2-1', 'x86_64', 'gpu-box', 'joan', '0.9.0', 'binary', 'none', 15],
    'laptop-ana': ['macOS', '15.1', '24.1.0', 'aarch64', 'Anas-MacBook-Pro', 'ana', '0.9.0-beta.4', 'cargo', 'launchd', 200],
    /* A revoked Node keeps its last report; it is outdated but gets no issue. */
    'old-laptop': ['macOS', '14.2', '23.2.0', 'x86_64', 'old-laptop', 'joan', '0.9.0-beta.2', 'homebrew', 'launchd', 21600],
  };
  const agentOfSpec = (a: AgentSpec, ago: number): MockAgent => ({
    version: a[6], os: { name: a[0], version: a[1], kernel: a[2] }, arch: a[3], hostname: a[4], user: a[5], installMethod: a[7], serviceManager: a[8], stateDirectory: STATE_DIR,
    reportedAt: new Date(Date.now() - ago * 60e3).toISOString(),
  });
  nodes.forEach(n => {
    const a = !cfg.empty && AGENTS[n.alias];
    n._agent = a ? agentOfSpec(a, a[9]) : null;
    if (n._agent && cfg.xss && n.alias === 'homelab-nuc') {
      n._agent.hostname = XSS_AGENT.hostname; n._agent.user = XSS_AGENT.user; n._agent.os.name = XSS_AGENT.osName; n._agent.stateDirectory = XSS_AGENT.stateDirectory;
    }
  });
  const outdatedOf = (n: MNode): boolean => !!n._agent && semverLess(n._agent.version, LATEST);
  const listAgent = (n: MNode): Json => (n._agent ? { version: n._agent.version, outdated: outdatedOf(n), os: { name: n._agent.os.name, version: n._agent.os.version }, arch: n._agent.arch, hostname: n._agent.hostname } : null);
  const detailAgent = (n: MNode): NodeAgent | null => (n._agent ? {
    version: n._agent.version, latestVersion: LATEST, outdated: outdatedOf(n), os: { ...n._agent.os }, arch: n._agent.arch, hostname: n._agent.hostname, user: n._agent.user,
    installMethod: n._agent.installMethod as NodeAgent['installMethod'], serviceManager: n._agent.serviceManager as NodeAgent['serviceManager'], stateDirectory: n._agent.stateDirectory, reportedAt: n._agent.reportedAt,
  } : null);
  /* The action names the upgrade command for the install method, like OperatorIssues. */
  const upgradeAction = (n: MNode): string => n._agent!.installMethod === 'homebrew' ? 'Upgrade with `brew upgrade fleet-agent`, then restart the service with `brew services restart fleet-agent`.'
    : n._agent!.installMethod === 'cargo' ? `Reinstall with Cargo from the release tag v${LATEST}: \`cargo install --locked --force --git https://github.com/jcarcaboso/fleet-manager --tag v${LATEST} fleet fleet-agent\`, then restart the service (see cli-installation.md).`
      : 'Replace the binary with the one from the release archive, then restart the Agent service (see cli-installation.md).';

  const freshnessOfAbs = (n: MNode): 'never_contacted' | 'stale' | 'fresh' => (!n.lastContactAt ? 'never_contacted' : Date.now() - Date.parse(n.lastContactAt) > 300e3 ? 'stale' : 'fresh');
  const listItem = (n: MNode): NodeListItem => ({
    nodeId: n.id, name: n.alias, revoked: !!n.revokedAt, lastContactAt: n.lastContactAt, freshness: freshnessOfAbs(n),
    platform: n.platform, enrolledAt: n.enrolledAt, revokedAt: n.revokedAt, credentialNotAfter: credNotAfter(n), targets: counts(n), currentRevision: currentRevision(n),
    disk: listDisk(n), ...(cfg.agent ? { agent: listAgent(n) } : {}),
  });

  /* Phase 2 attempt detail: diagnostic, path (relative to the Target base, never starting with "/"), step. Only a failed Attempt reported by an Agent that
     sends detail has any; everything else is null. The diagnostics come from the dataset. The dataset predates phase 2, so the mock picks path and step by
     error code and Target, and treats the Nodes in OLD_AGENT as Agents that send only the error code. */
  const OLD_AGENT = new Set(['kitchen-mini', 'fedora-ws']);
  const XSS = { diagnostic: 'bad <img src=x onerror=alert(1)> and "><script>alert(2)</script> \'x\' & done', path: '"><script>alert(3)</script>/<img src=x onerror=alert(4)>.md', step: 'verify' };
  const detailOf = (n: MNode, t: DataTarget, a: DataAttempt): { diagnostic: string | null; path: string | null; step: string | null } => {
    const none = { diagnostic: null, path: null, step: null };
    if (!cfg.diag || a.state !== 'failed' || !a.diagnostic || OLD_AGENT.has(n.alias)) return none;
    if (cfg.xss) return { ...XSS };
    const dir = t.path || '';
    const byCode = ({
      ai_client_reconcile_failed: { path: `${dir}/settings.json`, step: 'configure' },
      ownership_conflict: { path: '.agents/skills/postgres-migrations', step: 'stage' },
      bundle_digest_mismatch: { path: '.agents/skills/postgres-migrations', step: 'verify' },
      /* The lock file is outside the Target base, so there is no path; the agent-file Target also reports the file it was about to write. */
      lock_failed: { path: t.kind === 'agent-file' ? `${dir}/${t.file}` : null, step: 'lock' },
    } as Record<string, { path: string | null; step: string }>)[a.errorCode ?? ''] || { path: null, step: null };
    return { diagnostic: a.diagnostic, ...byCode };
  };
  const attemptOf = (n: MNode, t: DataTarget, a: DataAttempt): NodeAttempt => ({
    attemptId: a.id, assignmentId: guid(n.id + t.name), rolloutId: F.rollouts.find(r => r.shortSha === a.revision)?.id || F.rollouts[0]!.id, targetName: t.name,
    sourceRevision: revBySha(a.revision)?.sourceRevision || a.revision, state: a.state, errorCode: a.errorCode, ...detailOf(n, t, a), updatedAt: a.finishedAt || a.startedAt,
  });
  const allAttempts = (n: MNode): NodeAttempt[] =>
    n.targets.flatMap(t => [...((targetAttempts.get(n.id + ':' + t.name) as NodeAttempt[]) || []), ...t.attempts.map(a => attemptOf(n, t, a))]).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  const targetDetail = (n: MNode, t: DataTarget): NodeTarget => {
    const latest = allAttempts(n).find(a => a.targetName === t.name) || null;
    const applied = revBySha(t.appliedRevision);
    const kind = t.kind;
    return {
      name: t.name, kind, base: t.base, path: t.path, assignmentId: guid(n.id + t.name), state: t.state, assignedAt: t.updatedAt || nowIso(),
      desiredRevision: desiredOf(n, t), lastSucceededRevision: applied ? applied.sourceRevision : null,
      latestAttempt: latest && { attemptId: latest.attemptId, state: latest.state, errorCode: latest.errorCode, diagnostic: latest.diagnostic ?? null, path: latest.path ?? null, step: latest.step ?? null, updatedAt: latest.updatedAt },
      failedAttempts: t.state === 'failed' ? (t.failure?.retries || 1) : 0, firstFailedAt: t.state === 'failed' && t.failure ? t.failure.firstSeenAt : null,
      skills: kind === 'skills' ? (t.skills || []).map(name => ({ name, bundleDigest: skillDigest(name) })) : [],
      file: kind === 'agent-file' ? { name: t.file!, bundleDigest: 'sha256:' + hex('file:' + n.id + t.name, 64) } : null,
      aiClient: kind === 'ai-client' ? { client: t.aiClient!.client, mode: t.aiClient!.mode, baseUrl: t.aiClient!.baseUrl, model: t.aiClient!.model } : null,
    };
  };
  const detail = (n: MNode): NodeDetail => {
    const targets = n.targets.map(t => targetDetail(n, t)).sort((a, b) => a.name.localeCompare(b.name));
    return {
      nodeId: n.id, name: n.alias, platform: n.platform, enrolledAt: n.enrolledAt, lastContactAt: n.lastContactAt, freshness: listItem(n).freshness, revoked: !!n.revokedAt, revokedAt: n.revokedAt,
      credential: { credentialId: guid('cred:' + n.id), notBefore: n.credential.notBefore, notAfter: n.credential.notAfter, revokedAt: n.credential.revokedAt, revokedBy: n.revokedAt ? n.revokedBy : null, renewals: n.credential.renewals },
      targets, summary: counts(n), disk: detailDisk(n), ...(cfg.agent ? { agent: detailAgent(n) } : {}),
      ...(cfg.drift ? { drift: (n._drift || []).map(d => ({ target: d.target, files: d.files.slice(), detectedAt: d.detectedAt })) } : {}),
    };
  };
  const findNode = (key: string): MNode | undefined => nodes.find(n => n.id === key) || nodes.find(n => n.alias === key);

  /* ---------------------------------------------------------------- Phase 4: deployments, drift and issue state
     Commit metadata comes from the dataset (message, author); committedAt is a few minutes before acceptance. The oldest revision predates phase 4 and has commit: null.
     The revision diffs and drift events are the mock's own: the dataset has no contract-shaped equivalent. */
  const revsNewest = (): DataRevision[] => F.revisions.slice().sort((a, b) => Date.parse(b.acceptedAt) - Date.parse(a.acceptedAt));
  const XSS_COMMIT = { subject: '<img src=x onerror=alert(1)> "quoted" & <script>alert(9)</script>', author: '"><svg onload=alert(10)>' };
  const commitOf = (r: DataRevision): CommitInfo | null => {
    if (!cfg.commit || r === revsNewest().at(-1)) return null;
    const c = cfg.xss && r === revsNewest()[0] ? XSS_COMMIT : { subject: r.message, author: r.author };
    return { subject: c.subject, author: c.author, committedAt: new Date(Date.parse(T(r.acceptedAt)!) - 4 * 60e3).toISOString() };
  };
  /* sha -> what the revision changed against the one before it. The oldest has no predecessor, so it only adds. */
  const DIFFS: Record<string, { skills: { added: string[]; changed: string[]; removed: string[] }; targets: { added: number; changed: number; removed: number; nodes: number } }> = {
    a3f9c21: { skills: { added: ['postgres-migrations'], changed: ['code-review'], removed: [] }, targets: { added: 2, changed: 5, removed: 0, nodes: 4 } },
    '9b14e07': { skills: { added: [], changed: [], removed: [] }, targets: { added: 0, changed: 3, removed: 0, nodes: 3 } },
    '51c0d8a': { skills: { added: ['browser-smoke', 'release-notes'], changed: [], removed: [] }, targets: { added: 0, changed: 12, removed: 0, nodes: 12 } },
    e2277fb: { skills: { added: [], changed: ['commit-message'], removed: ['jira-triage'] }, targets: { added: 0, changed: 6, removed: 0, nodes: 6 } },
    c08d4be: { skills: { added: ['api-design', 'code-review', 'commit-message', 'dotnet-testing', 'writing-docs'], changed: [], removed: [] }, targets: { added: 6, changed: 0, removed: 0, nodes: 3 } },
  };
  const rolloutOf = (r: DataRevision): DataRollout | undefined => F.rollouts.find(x => x.revisionId === r.id);
  const revisionOut = (r: DataRevision): Json => {
    const sorted = revsNewest();
    const i = sorted.indexOf(r);
    const prev = sorted[i + 1];
    const d = DIFFS[r.shortSha] || { skills: { added: [], changed: [], removed: [] }, targets: { added: 0, changed: 0, removed: 0, nodes: 0 } };
    const skills = { added: d.skills.added.slice(), changed: d.skills.changed.slice(), removed: d.skills.removed.slice() };
    if (cfg.xss && i === 0) skills.changed.push('<img src=x onerror=alert(11)>');
    return {
      desiredRevisionId: r.id, sourceRevision: r.sourceRevision, acceptedAt: T(r.acceptedAt), commit: commitOf(r),
      previous: prev ? { desiredRevisionId: prev.id, sourceRevision: prev.sourceRevision } : null, rolloutId: !cfg.rollout ? null : rolloutOf(r)?.id || null,
      skills: { added: skills.added.sort(), changed: skills.changed.sort(), removed: skills.removed.sort() }, targets: { ...d.targets },
    };
  };
  /* The per-machine view of a rollout. The newest rollout covers every live Node and Target in its current state. The second is derived from the Attempts
     each Target made for it (a succeeded Attempt of a revision that is no longer desired reads as superseded). The older ones have no Attempts in the dataset,
     so their Assignments are spread over the Nodes from the rollout's counts. */
  const STATE_ORDER: AssignmentState[] = ['failed', 'applying', 'pending', 'succeeded', 'superseded'];
  const worstState = (states: string[]): AssignmentState => STATE_ORDER.find(x => states.includes(x)) || 'succeeded';
  const TARGET_POOL = ['skills', 'agent-file/claude', 'agent-file/codex', 'ai-client/claude', 'ai-client/codex', 'agent-file/opencode', 'ai-client/opencode'];
  const rolloutOut = (r: DataRollout, idx: number): RolloutDetail => {
    const rev = F.revisions.find(x => x.id === r.revisionId)!;
    const live = nodes.filter(n => !n.revokedAt);
    type Row = { n: MNode; targets: Array<{ name: string; state: AssignmentState; errorCode: string | null; updatedAt: string }>; times: number[] };
    let rows: Row[];
    if (idx < 2) {
      rows = live.map((n): Row => {
        const mine = allAttempts(n).filter(a => a.rolloutId === r.id);
        const targets = n.targets.map(t => {
          const ta = allAttempts(n).filter(a => a.targetName === t.name);
          const last = mine.find(a => a.targetName === t.name);
          if (idx === 0) return { name: t.name, state: t.state, errorCode: t.state === 'failed' ? (ta.find(a => a.errorCode) || { errorCode: null }).errorCode ?? null : null, updatedAt: ta[0]?.updatedAt || t.updatedAt || nowIso() };
          if (!last) return null;
          const state: AssignmentState = last.state === 'succeeded' && t.desiredRevision !== rev.shortSha ? 'superseded' : last.state;
          return { name: t.name, state, errorCode: last.errorCode || null, updatedAt: last.updatedAt };
        }).filter((x): x is NonNullable<typeof x> => !!x);
        return { n, targets, times: mine.map(a => Date.parse(a.updatedAt)).filter(Number.isFinite) };
      }).filter(x => x.targets.length);
    } else {
      const names = r.nodeCount === 3 ? ['build-runner-01', 'build-runner-02', 'build-runner-03'] : live.map(n => n.alias).sort().slice(0, r.nodeCount);
      const list: Row[] = names.map(name => ({ n: nodes.find(x => x.alias === name)!, targets: [], times: [] }));
      STATE_ORDER.flatMap(k => Array<AssignmentState>(r.assignments[k] || 0).fill(k)).forEach((state, i) => {
        const row = list[i % list.length]!;
        row.targets.push({ name: TARGET_POOL[Math.floor(i / list.length) % TARGET_POOL.length]!, state, errorCode: null, updatedAt: T(r.createdAt)! });
      });
      list.forEach((row, k) => { if (row.targets.some(t => t.state !== 'pending')) row.times = [Date.parse(T(r.createdAt)!) + (k + 1) * 60e3, Date.parse(T(r.createdAt)!) + (k + 6) * 120e3]; });
      rows = list.filter(x => x.n && x.targets.length);
    }
    rows.sort((a, b) => a.n.alias.localeCompare(b.n.alias));
    const summary = { pending: 0, applying: 0, succeeded: 0, failed: 0, superseded: 0 };
    rows.forEach(x => x.targets.forEach(t => { summary[t.state]++; }));
    return {
      rolloutId: r.id, desiredRevisionId: r.revisionId, sourceRevision: rev.sourceRevision, createdAt: T(r.createdAt)!, summary,
      nodes: rows.slice(0, 500).map(x => ({
        nodeId: x.n.id, nodeName: x.n.alias, state: worstState(x.targets.map(t => t.state)),
        firstAttemptAt: x.times.length ? new Date(Math.min(...x.times)).toISOString() : null, lastAttemptAt: x.times.length ? new Date(Math.max(...x.times)).toISOString() : null, targets: x.targets,
      })),
    };
  };

  /* Drift: the Agent repaired files changed outside Fleet. node alias -> [[minutes ago, target, files]], newest first. The Server keeps the 20 newest per Node. */
  const XSS_DRIFT_FILE = '"><script>alert(12)</script>/<img src=x onerror=alert(13)>.md';
  const DRIFT: Record<string, Array<[number, string, string[]]>> = {
    'homelab-nuc': [[47, 'skills', ['.agents/skills/incident-runbook/SKILL.md']], [30 * 60, 'skills', ['.agents/skills/incident-runbook/SKILL.md', '.agents/skills/homelab-ops/compose.md']]],
    'studio-mini': [[6 * 60, 'skills', ['.agents/skills/code-review/checklist.md']]],
  };
  nodes.forEach(n => {
    const d = !cfg.empty && !n.revokedAt && DRIFT[n.alias];
    n._drift = d ? d.map(([ago, target, files], i) => ({ target, files: cfg.xss && n.alias === 'homelab-nuc' && i === 0 ? [XSS_DRIFT_FILE] : files.slice(), detectedAt: new Date(Date.now() - ago * 60e3).toISOString() })) : [];
  });

  /* Issue state: Operators acknowledge or snooze an issue. An acknowledgement stores the issue's since and stops applying once since differs; a snooze applies until its time passes. */
  const issueStates = new Map<string, IssueStateRec>();
  const applyState = (i: Issue): Issue => {
    const st = issueStates.get(i.id);
    const out: Issue = { ...i, state: 'open', stateBy: null, stateAt: null, snoozedUntil: null };
    if (st && st.kind === 'acknowledged' && st.since === (i.since ?? null)) return { ...out, state: 'acknowledged', stateBy: st.by, stateAt: st.at };
    if (st && st.kind === 'snoozed' && Date.parse(st.until!) > Date.now()) return { ...out, state: 'snoozed', stateBy: st.by, stateAt: st.at, snoozedUntil: st.until! };
    return out;
  };

  /* ---------------------------------------------------------------- check-ins */
  const ASLEEP = new Set(['mbp-joan', 'laptop-ana']);
  const checkins = (n: MNode, hours: number): Array<{ hour: string; polls: number }> => {
    const out: Array<{ hour: string; polls: number }> = [];
    const now = Date.now();
    const cur = Math.floor(now / HOUR) * HOUR;
    const contact = n.lastContactAt ? Date.parse(n.lastContactAt) : null;
    const enrolled = Date.parse(n.enrolledAt);
    const revoked = n.revokedAt ? Date.parse(n.revokedAt) : null;
    for (let k = hours - 1; k >= 0; k--) {
      const start = cur - k * HOUR;
      const end = Math.min(start + HOUR, now);
      let polls = 0;
      const alive = contact !== null && end > enrolled && (!revoked || start < revoked) && start < contact + 60e3;
      if (alive) {
        const h = new Date(start).getUTCHours();
        if (!(ASLEEP.has(n.alias) && (h >= 22 || h < 6))) {
          const span = Math.min(end, contact!) - Math.max(start, enrolled);
          polls = Math.max(0, Math.round(span / 60e3 - (hex(n.id + start, 2).charCodeAt(0) % 3)));
        }
      }
      out.push({ hour: new Date(start).toISOString().replace('.000Z', 'Z'), polls });
    }
    return out;
  };

  /* ---------------------------------------------------------------- errors catalog and issues */
  type CatEntry = { code: string; source: string; title: string; explanation: string; fix: string[] };
  const cat = (code: string, source: string, title: string, explanation: string, fix: string[]): CatEntry => ({ code, source, title, explanation, fix });
  /* Agent codes come from the dataset; the others use the codes that the Server's ErrorCatalog and OperatorIssues define. */
  const catalogItems = (): CatEntry[] => [
    ...Object.entries(F.errorCatalog).map(([code, e]) => cat(code, 'agent', e.title, e.explanation, e.fix)),
    cat('assignment_superseded', 'agent', 'Assignment was replaced', 'A newer assignment replaced this one before it finished.', ['No action needed.']),
    cat('node_not_found', 'server', 'No Node matches', 'No Node in this Workspace has that ID or alias.', ['Run `fleet nodes list` to see the aliases.']),
    cat('target_not_found', 'server', 'Target not found', 'The Node has no current Assignment for that Target.', ['Run `fleet nodes show <node>` to list its Targets.']),
    cat('target_not_failed', 'server', 'Target is not failed', 'Only a failed current Assignment can be retried.', ['Run `fleet nodes show <node>` to see the Target state.']),
    cat('node_revoked', 'server', 'Node is revoked', 'A revoked Node receives no new Assignments, so it cannot be retried.', ['Enroll the machine again under a new alias.']),
    cat('insufficient_scope', 'server', 'Scope too narrow', 'The Operator credential does not have the scope this action needs.', ['Use a credential with a broader scope.']),
    cat('invalid_request', 'server', 'Invalid request', 'The Server rejected the request parameters.', ['Check the parameters of the call.']),
    cat('assignment_failed', 'issue', 'A Target failed on a Node', 'The Agent reported a failure for the Node’s current Assignment of a Target. The error code on the issue says why.', ['Run `fleet explain <code>` for the reported error code and follow its fix steps.', 'When the cause is fixed, run `fleet retry <node> <target>`.']),
    cat('more_failed_assignments', 'issue', 'More failed assignments than listed', 'Only the first failures are listed.', ['Run `fleet nodes list` to see the failed counts for every Node.']),
    cat('node_not_contacting', 'issue', 'Node is not checking in', 'The Server has not received an authenticated poll from this Agent for several minutes, or it has never received one since the Node enrolled. Freshness only says when Fleet last heard from the machine; it cannot tell whether the machine is powered on.', ['Wake the machine and connect it to the network. The Agent catches up at its next poll.', 'Check that the Agent service is running (`brew services info jcarcaboso/fleet/fleet-agent`).', 'On Linux, enable lingering so the service starts at boot: `sudo loginctl enable-linger "$USER"`.']),
    cat('cliproxy_key_missing', 'issue', 'CLIProxy API key is missing', 'Nodes are assigned to CLIProxy, but the Server cannot retrieve or distribute their models.', ['Set `Fleet:CliProxyApiKey` in the Server’s private configuration, recreate the Server, then refresh models.']),
    cat('cliproxy_discovery_pending', 'issue', 'Model discovery has not completed', 'The Server has not fetched the model catalog of a CLIProxy endpoint yet.', ['Refresh models or wait for the next discovery check.']),
    cat('cliproxy_refresh_failed', 'issue', 'CLIProxy model refresh failed', 'The Server could not fetch the model catalog from a CLIProxy endpoint. Agents keep the last valid catalog, so AI clients keep working, but new models will not arrive.', ['Check that CLIProxy accepts the dedicated Fleet key.', 'Rotate the Fleet CLIProxy key on the Server if it changed.', 'Refresh models to confirm the fix.']),
    cat('disk_space_low', 'issue', 'Disk is filling up', 'The disk that holds the user’s home directory on this machine is 85% full or more. Git worktrees, caches and build output are the usual cause. When a disk is full, the Agent can no longer write Skills, agent files or AI-client settings.',
      ['Run `fleet nodes disk <node>` to see how much space is used and available.', 'Ask the person who uses the machine to remove Git worktrees, caches and build output they no longer need. Fleet never deletes files for you.', 'Run `fleet nodes disk <node> --refresh` to measure again.']),
    cat('disk_space_critical', 'issue', 'Disk is nearly full', 'The disk that holds the user’s home directory on this machine is 95% full or more. Writes can start failing at any moment, including the Agent’s own.',
      ['Run `fleet nodes disk <node>` to see how much space is left.', 'Ask the person who uses the machine to free space now: remove Git worktrees (`git worktree list`, `git worktree remove`), caches and build output. Fleet never deletes files for you.', 'Run `fleet nodes disk <node> --refresh` to measure again.']),
    cat('agent_outdated', 'issue', 'A Node runs an older Agent', 'The Agent on the Node reported a version lower than the Server’s. Server and Agent releases share version numbers, so the Agent is older than the release the Server runs.',
      ['Run `fleet nodes show <node>` to see the running and the latest version and how the Agent was installed.', 'Homebrew: run `brew upgrade fleet-agent` on the Node and restart the service with `brew services restart fleet-agent`.',
        'Cargo: reinstall from the release tag with `cargo install --locked --force --git https://github.com/jcarcaboso/fleet-manager --tag <tag> fleet fleet-agent`, then restart the service. See docs/technical-design/cli-installation.md.',
        'Binary: download and verify the release archive, replace the binary at the same path and restart the service. See docs/technical-design/cli-installation.md.',
        'docs/technical-design/client-updates.md describes staged updates and rollback. The issue clears when the Agent reports the new version, which it does shortly after it restarts.']),
    cat('source_not_configured', 'issue', 'No repository is configured', 'The Server cannot publish new assignments from Git.', ['Set `Source:Remote`, then sync the repository.']),
    cat('source_sync_failed', 'issue', 'Repository sync failed', 'The last repository scan was rejected or failed. Existing assignments remain active.', ['Check repository access and fleet.yml validation in the Server logs, then sync the repository again.']),
    cat('source_not_scanned', 'issue', 'Repository has not been synced', 'No source scan has been recorded.', ['Sync the repository to validate configuration and publish assignments.']),
  ];
  /* Quotes a value for a POSIX shell command line unless it only has plain characters, like OperatorIssues.Quote. */
  const quote = (v: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(v) ? v : "'" + String(v).replace(/'/g, "'\\''") + "'");
  const stamp = (iso: string): string => new Date(iso).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  const cmpNull = (a: string | null, b: string | null): number => (a === null ? (b === null ? 0 : -1) : b === null ? 1 : a < b ? -1 : a > b ? 1 : 0);
  const rawIssues = (): Issue[] => {
    const out: Issue[] = [];
    for (const n of nodes) {
      if (n.revokedAt) continue;
      const alias = quote(n.alias);
      /* Never-contacted Nodes get the same issue code as stale ones. Their since is the enrollment time. */
      const f = listItem(n).freshness;
      const last = n.lastContactAt;
      const enrolled = n.enrolledAt;
      const quiet = f === 'stale' || (f === 'never_contacted' && Date.now() - Date.parse(enrolled) > 300e3);
      if (quiet) {
        out.push({
          id: `node_not_contacting:${n.id}`, code: 'node_not_contacting', severity: 'warning', title: `${n.alias} is not checking in`,
          detail: last ? `The last contact was at ${stamp(last)}.` : `The Node has not contacted the Server since it enrolled at ${stamp(enrolled)}.`,
          action: 'Check the Agent service, its running version, network connection and certificate. Restart the service after upgrading the binary.',
          section: 'nodes', errorCode: null, nodeId: n.id, nodeName: n.alias, target: null, since: last || enrolled, commands: [`fleet nodes show ${alias}`, `fleet nodes checkins ${alias}`],
        });
      }
      const worst = fullest(n);
      if (worst && pctOf(worst) >= 85) {
        const crit = pctOf(worst) >= 95;
        const code = crit ? 'disk_space_critical' : 'disk_space_low';
        out.push({
          id: `${code}:${n.id}`, code, severity: crit ? 'error' : 'warning', title: `${n.alias}: disk is ${pctOf(worst)}% full`,
          detail: `The ${worst.label} volume is ${pctOf(worst)}% used: ${GIBTXT(worst.availableBytes)} available of ${GIBTXT(worst.totalBytes)}.`,
          action: 'Free space by removing Git worktrees, caches and build output that are no longer needed, then refresh the disk usage.',
          section: 'nodes', errorCode: null, nodeId: n.id, nodeName: n.alias, target: null, since: n._disk!.measuredAt, commands: [`fleet nodes disk ${alias}`, `fleet nodes disk ${alias} --refresh`],
        });
      }
      if (outdatedOf(n) && cfg.agent) {
        out.push({
          id: `agent_outdated:${n.id}`, code: 'agent_outdated', severity: 'warning', title: `${n.alias}: Agent is outdated`,
          detail: `The Agent runs version ${n._agent!.version}; the latest version is ${LATEST}. Reported at ${stamp(n._agent!.reportedAt)}.`, action: upgradeAction(n),
          section: 'nodes', errorCode: null, nodeId: n.id, nodeName: n.alias, target: null, since: n._agent!.reportedAt, commands: [`fleet nodes show ${alias}`],
        });
      }
      for (const t of n.targets) {
        if (t.state !== 'failed') continue;
        const code = (allAttempts(n).find(a => a.targetName === t.name && a.errorCode) || { errorCode: null }).errorCode || t.failure?.code || null;
        const failedAttempt = allAttempts(n).find(a => a.targetName === t.name && a.state === 'failed');
        const known = code ? catalogItems().find(x => x.code === code) : undefined;
        out.push({
          id: `assignment_failed:${n.id}:${t.name}`, code: 'assignment_failed', severity: 'error', title: `${n.alias}: ${t.name} failed`,
          detail: code ? `The Agent reported ${code}${known ? ` (${known.title})` : ''} for this current assignment.` : 'The Agent reported a failure for this current assignment.',
          action: known ? known.fix[0]! : 'Check Agent logs for permissions, ownership conflicts or download failures.',
          section: 'nodes', errorCode: code, nodeId: n.id, nodeName: n.alias, target: t.name, since: t.failure ? t.failure.firstSeenAt : null,
          diagnostic: failedAttempt?.diagnostic ?? null, path: failedAttempt?.path ?? null, step: failedAttempt?.step ?? null,
          commands: [`fleet nodes show ${alias}`, ...(code ? [`fleet explain ${quote(code)}`] : []), `fleet retry ${alias} ${quote(t.name)}`],
        });
      }
    }
    for (const c of catalogs) {
      if (c.status === 'ok') continue;
      const cached = c.models.length > 0;
      out.push({
        id: 'cliproxy_refresh_failed:' + c.baseUrl, code: 'cliproxy_refresh_failed', severity: cached ? 'warning' : 'error', title: 'CLIProxy model refresh failed',
        detail: `${c.baseUrl}: ${c.errorCode}. ` + (cached ? 'Agents can use the last valid catalog.' : 'No model catalog is available.'),
        action: 'Check that CLIProxy accepts the dedicated Fleet key, then refresh models.', section: 'models', errorCode: null, nodeId: null, nodeName: null, target: null, since: c._failureSince ?? null, commands: ['fleet models refresh'],
      });
    }
    const last = cfg.empty ? null : scans[0];
    if (last && (last.outcome === 'failed' || last.outcome === 'invalid')) {
      out.push({
        id: 'source_sync_failed', code: 'source_sync_failed', severity: 'error', title: 'Repository sync failed',
        detail: `The last scan at ${stamp(last.observedAt)} was ${last.outcome}. Existing assignments remain active.`, action: 'Check repository access and fleet.yml validation in the Server logs, then sync the repository again.',
        section: 'repository', errorCode: null, nodeId: null, nodeName: null, target: null, since: last.observedAt, commands: ['fleet source rescan'],
      });
    }
    /* Errors first, then Node name (issues without a Node first), Target, code and ID. */
    return out.map(i => ({ diagnostic: null, path: null, step: null, ...i }))
      .sort((a, b) => (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1) || cmpNull(a.nodeName, b.nodeName) || cmpNull(a.target, b.target) || cmpNull(a.code, b.code) || cmpNull(a.id, b.id)).slice(0, 200);
  };
  const issues = (): Issue[] => rawIssues().map(applyState);

  /* ---------------------------------------------------------------- CLIProxy */
  const fam = (m: DataCatalogModel): { key: string; label: string } => ({ key: m.family.toLowerCase().replace(/[^a-z0-9]+/g, '-'), label: m.family });
  const policyFor = (c: DataCatalog): SelectionPolicy => {
    const existing = policies.get(c.baseUrl);
    if (existing) return existing;
    const enabled: string[] = [];
    const disabled: string[] = [];
    const overrides: Record<string, boolean> = {};
    const groups = new Map<string, DataCatalogModel[]>();
    c.models.forEach(m => { const k = fam(m).key; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(m); });
    for (const [k, ms] of groups) {
      const on = ms.filter(m => m.selected).length;
      (on * 2 >= ms.length ? enabled : disabled).push(k);
      ms.forEach(m => { if (m.selected !== (on * 2 >= ms.length)) overrides[m.id] = m.selected; });
    }
    const p: SelectionPolicy = { includeNew: c.newFamiliesEnabled, disabledFamilies: disabled, modelOverrides: overrides, enabledFamilies: enabled, skipClaudeModelsForOtherClients: c.restrictClaude };
    policies.set(c.baseUrl, p);
    return p;
  };
  const selected = (p: SelectionPolicy, m: DataCatalogModel): boolean => {
    const k = fam(m).key;
    return typeof p.modelOverrides[m.id] === 'boolean' ? p.modelOverrides[m.id]! : p.disabledFamilies.includes(k) ? false : p.enabledFamilies.includes(k) ? true : p.includeNew;
  };
  const selectionEntry = (c: DataCatalog): CatalogSelection => {
    const p = policyFor(c);
    return { baseUrl: c.baseUrl, models: c.models.map(m => ({ id: m.id, reasoningLevels: m.reasoning, familyKey: fam(m).key, familyLabel: fam(m).label, selected: selected(p, m) })), policy: p, version: c.version };
  };
  const proxyStatus = (): CliProxyStatus => ({
    enabled: true, intervalSeconds: F.cliproxy.refreshIntervalHours * 3600, errorCode: null,
    catalogs: catalogs.map(c => ({ baseUrl: c.baseUrl, modelCount: c.models.length, lastSuccess: T(c.lastSuccessAt), nextRefresh: T(c.nextRefreshAt), outcome: c.status === 'ok' ? 'succeeded' : 'failed', errorCode: c.errorCode })),
  });

  /* ---------------------------------------------------------------- responses */
  const json = (body: unknown, status = 200): Response => new Response(body === null ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  /* Every error is { code, message }. */
  const MESSAGES: Record<string, string> = {
    unauthorized: 'Sign in with a valid Operator token.', invalid_csrf: 'The CSRF token is missing or no longer valid.', invalid_origin: 'The Origin header must be the configured dashboard origin.',
    invalid_request: 'The request is not valid.', node_not_found: 'No Node matches that ID or alias.',
    insufficient_scope: 'This credential does not have the scope required for this action.', target_not_found: 'The Node has no such Target.', target_not_failed: 'The current Assignment for that Target is not failed.',
    node_revoked: 'The Node is revoked.', enrollment_link_not_found: 'No enrollment link has that ID.', issue_not_found: 'No current issue has that ID.',
    revision_not_found: 'No desired revision has that ID.', rollout_not_found: 'No rollout has that ID.',
  };
  const err = (status: number, code: string, message?: string): Response => json({ code, message: message || MESSAGES[code] || code }, status);
  const seg = (value: string): string => decodeURIComponent(value); // one path segment, decoded once
  /* Lists: limit is 1 to 100 (else 400). Cursors are only valid with the order they came from. */
  const orderOf = (q: URLSearchParams): 'id' | 'newest' | null => { const o = q.get('order'); return o === null ? 'id' : o === 'newest' ? 'newest' : null; };
  const paged = (items: unknown[], q: URLSearchParams, order = 'id'): Response => {
    let limit = 100;
    if (q.get('limit') !== null) {
      limit = +q.get('limit')!;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return err(400, 'invalid_request', 'limit must be from 1 to 100.');
    }
    limit = Math.min(limit, cfg.pageSize);
    let start = 0;
    if (q.get('after')) {
      const m = /^(id|newest):(\d+)$/.exec(q.get('after')!);
      if (!m || m[1] !== order) return err(400, 'invalid_request', 'The cursor is not valid for this request.');
      start = +m[2]!;
    }
    return json({ items: items.slice(start, start + limit), nextCursor: start + limit < items.length ? `${order}:${start + limit}` : null });
  };
  /* ID order by default; order=newest sorts by the timestamp, newest first, ties by ID. */
  const sortFor = (items: Json[], q: URLSearchParams, idKey: string, timeKey: string): { order: string; items: Json[] } | null => {
    const order = orderOf(q);
    if (order === null) return null;
    const byId = (a: Json, b: Json): number => (a[idKey] < b[idKey] ? -1 : a[idKey] > b[idKey] ? 1 : 0);
    return { order, items: items.slice().sort(order === 'newest' ? (a, b) => Date.parse(b[timeKey]) - Date.parse(a[timeKey]) || -byId(a, b) : byId) };
  };
  const listOf = (items: Json[], q: URLSearchParams, idKey: string, timeKey: string): Response => {
    const sorted = sortFor(items, q, idKey, timeKey);
    return sorted ? paged(sorted.items, q, sorted.order) : err(400, 'invalid_request', 'order must be newest.');
  };
  const RANK: Record<Scope, number> = { read: 0, operate: 1, admin: 2 };
  const need = (level: Scope): boolean => RANK[state.scope] >= RANK[level];
  const addAudit = (action: string, extra: Partial<MAudit> = {}): void => { audit.unshift({ recordedAt: nowIso(), action, actor: state.actor, subject: '', nodeId: null, credentialId: null, ...extra }); };

  const pickCounts = (c: Partial<Record<AssignmentState, number>>): Record<AssignmentState, number> => ({ pending: c.pending || 0, applying: c.applying || 0, succeeded: c.succeeded || 0, failed: c.failed || 0, superseded: c.superseded || 0 });
  const auditOut = (): Json[] => audit.map(e => {
    const node = e.nodeId ? nodes.find(n => n.id === e.nodeId) : (['node_enrolled', 'node_credential_renewed', 'node_alias_changed', 'node_revoked', 'node_removed'].includes(e.action) ? findNode(String(e.subject).split('→').pop()!.trim()) : null);
    const nodeId = e.nodeId || node?.id || null;
    return { recordedAt: e.recordedAt, action: e.action, actor: e.action === 'node_credential_renewed' && nodeId ? nodeId : e.actor, nodeId, credentialId: e.action.startsWith('node_credential') && nodeId ? guid('cred:' + nodeId) : null, nodeName: node ? node.alias : null };
  }).concat(cfg.empty ? [] : [{ recordedAt: T(F.audit[F.audit.length - 1]!.recordedAt)!, action: 'node_removed', actor: 'ana', nodeId: guid('removed-node'), credentialId: null, nodeName: null }]);

  /* The state follows the Server's ToLink: consumed wins over revoked, revoked over expired, expired over active. */
  const linkOut = (l: MLink): Json => {
    const exp = l.expiresAt;
    const st = l.state === 'consumed' || l.consumedAt ? 'consumed' : l.state === 'revoked' || l.revokedAt ? 'revoked' : l.state === 'expired' || Date.parse(exp) <= Date.now() ? 'expired' : 'active';
    return { id: l.id, alias: l.alias, expiresAt: exp, consumedAt: l.consumedAt || null, revokedAt: l.revokedAt || null, revokedBy: l.revokedBy || null, nodeId: l.nodeId || (st === 'consumed' ? nodes.find(n => n.alias === l.alias)?.id || null : null), state: st };
  };

  const b64url = (s: string): string => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  /* The Agent enrolls with the link some seconds later. As on the Server, a link that was revoked or has expired by then is refused, and
     so is an alias that a Node already has (node_alias_in_use at enrollment time, the link stays unused). */
  const usable = (link: MLink): boolean => !link.revokedAt && Date.parse(link.expiresAt) > Date.now() && !nodes.some(n => n.alias === link.alias);
  const simulateEnrollment = (link: MLink): void => {
    if (!cfg.enroll) return;
    later(() => { if (!usable(link)) return; link.state = 'consumed'; link.consumedAt = nowIso(); addAudit('node_enrolled', { actor: 'enrollment', subject: link.alias }); }, 5000);
    later(() => {
      if (link.state !== 'consumed' || nodes.some(n => n.alias === link.alias)) return;
      const now = nowIso();
      const mac = link._platform !== 'linux';
      const n = {
        id: guid('new:' + link.alias + Date.now()), alias: link.alias, platform: mac ? 'macos' : 'linux', arch: '', enrolledAt: now, lastContactAt: cfg.enrollLinkOnly ? null : now, freshness: cfg.enrollLinkOnly ? 'never_contacted' : 'fresh',
        revokedAt: null, revokedBy: null,
        credential: { id: '', certificateSha256: '', notBefore: now, notAfter: new Date(Date.now() + 7 * DAY).toISOString(), renewals: 0, revokedAt: null }, targets: [],
        groups: [], agentSource: null, os: null, hostname: null, user: null, agentVersion: null, installMethod: null, pollIntervalSeconds: 60, stateDir: null, lastPollLatencyMs: null, note: null, checkins: [],
        _disk: null, _diskReq: null, _agent: null, _drift: [],
      } as unknown as MNode;
      n._agent = cfg.enrollLinkOnly ? null : agentOfSpec(mac ? AGENTS['mbp-joan']! : AGENTS['build-runner-01']!, 0);
      if (n._agent) { n._agent.hostname = link.alias; n._agent.version = LATEST; }
      nodes.unshift(n);
      link.nodeId = n.id;
    }, 9000);
  };

  const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let cookieSent = true;

  async function handle(method: string, path: string, q: URLSearchParams, body: Json, headers: Record<string, string>): Promise<Response> {
    if (cfg.slow) await new Promise(r => setTimeout(r, cfg.slow));
    if (method === 'GET') {
      const d = /^nodes\/([^/]+)/.exec(path);
      const wait = d && cfg.delay[seg(d[1]!)];
      if (wait) await new Promise(r => setTimeout(r, wait));
    }
    if (cfg.fail && path.startsWith(cfg.fail) && method === 'GET') return err(500, 'mock_failure', 'The mock was told to fail ' + cfg.fail);
    if (path === 'csrf') return json({ token: state.csrf });
    /* Like the Server: the Origin check comes first for every non-GET request, then the CSRF token. */
    const originOk = (): boolean => (headers.origin ?? '').toLowerCase() === (cfg.dashboardOrigin || cfg.origin).toLowerCase();
    if (path === 'login' && method === 'POST') {
      if (!originOk()) return err(400, 'invalid_origin');
      if (!cfg.csrfCookie || headers['x-fleet-csrf'] !== state.csrf) return err(400, 'invalid_csrf');
      /* The Server rejects tokens shorter than 32 characters before it compares them. */
      if (!body || typeof body.token !== 'string' || body.token.length < 32 || body.token.length > 1024 || body.token.startsWith('bad')) return err(401, 'unauthorized', 'The Operator token was not accepted.');
      state.signedIn = true;
      cookieSent = cfg.cookie;
      return json({ actor: state.actor, scope: state.scope });
    }
    if (!state.signedIn || !cookieSent) return err(401, 'unauthorized');
    if (path === 'session') return json({ actor: state.actor, scope: state.scope });
    if (method !== 'GET') {
      if (!originOk()) return err(400, 'invalid_origin');
      if (!cfg.csrfCookie || headers['x-fleet-csrf'] !== state.csrf) return err(400, 'invalid_csrf');
      if (path === 'logout') { state.signedIn = false; return json({ signedOut: true }); }
      if (cfg.forbid) return err(403, 'insufficient_scope', 'This credential cannot do that.');
    }
    let m: RegExpExecArray | null;
    if (method === 'GET') {
      if (path === 'nodes') return paged(nodes.map(listItem).sort((a, b) => a.nodeId.localeCompare(b.nodeId)), q);
      /* {node} is a Node ID or an exact alias, one percent-encoded path segment. A UUID-shaped value is an ID first. */
      if ((m = /^nodes\/([^/]+)(?:\/(attempts|checkins))?$/.exec(path))) {
        const n = findNode(seg(m[1]!));
        if (!n) return err(404, 'node_not_found');
        if (!m[2]) return json(detail(n));
        if (m[2] === 'attempts') {
          let list = allAttempts(n);
          if (q.get('target')) list = list.filter(a => a.targetName === q.get('target'));
          return paged(list, q);
        }
        const hours = q.get('hours') === null ? 168 : +q.get('hours')!;
        if (!Number.isInteger(hours) || hours < 1 || hours > 168) return err(400, 'invalid_request', 'hours must be from 1 to 168.');
        return json({ hours, buckets: checkins(n, hours) });
      }
      if (path === 'issues') return json({ items: issues() });
      if (path === 'errors') return json({ items: catalogItems() });
      if ((m = /^errors\/([^/]+)$/.exec(path))) {
        const e = catalogItems().find(x => x.code === seg(m![1]!));
        return e ? json(e) : err(404, 'invalid_request', 'No error catalog entry exists for that code.');
      }
      if (path === 'source/status') return json(cfg.empty ? null : { sourceRevision: scans[0]!.sourceRevision, outcome: scans[0]!.outcome, code: scans[0]!.code, diagnostic: scans[0]!.diagnostic, observedAt: scans[0]!.observedAt, requestedBy: scans[0]!.requestedBy });
      if (path === 'source/scans') return paged(cfg.empty ? [] : scans.map(s => ({ scanId: s.id, sourceRevision: s.sourceRevision, outcome: s.outcome, code: s.code, diagnostic: s.diagnostic, observedAt: s.observedAt, requestedBy: s.requestedBy })), q);
      if (path === 'desired-revisions') return listOf(cfg.empty ? [] : F.revisions.map(r => ({ desiredRevisionId: r.id, sourceRevision: r.sourceRevision, acceptedAt: T(r.acceptedAt), commit: commitOf(r) })), q, 'desiredRevisionId', 'acceptedAt');
      if ((m = /^desired-revisions\/([^/]+)$/.exec(path))) {
        const r = cfg.empty ? null : F.revisions.find(x => x.id === seg(m![1]!));
        return r ? json(revisionOut(r)) : err(404, 'revision_not_found');
      }
      if ((m = /^rollouts\/([^/]+)$/.exec(path))) {
        const i = cfg.empty ? -1 : F.rollouts.findIndex(x => x.id === seg(m![1]!));
        return i >= 0 ? json(rolloutOut(F.rollouts[i]!, i)) : err(404, 'rollout_not_found');
      }
      if (path === 'rollouts') return listOf(cfg.empty ? [] : F.rollouts.map(r => ({ rolloutId: r.id, desiredRevisionId: r.revisionId, createdAt: T(r.createdAt), ...pickCounts(r.assignments) })), q, 'rolloutId', 'createdAt');
      if ((m = /^rollouts\/([^/]+)\/attempts$/.exec(path))) {
        const r = F.rollouts.find(x => x.id === seg(m![1]!));
        if (!r) return err(404, 'invalid_request', 'No rollout has that ID.');
        /* AttemptStatus: exactly these eight fields. */
        return paged(nodes.flatMap(n => allAttempts(n)).filter(a => a.rolloutId === r.id)
          .map(a => ({ attemptId: a.attemptId, assignmentId: a.assignmentId, state: a.state, errorCode: a.errorCode, diagnostic: a.diagnostic ?? null, path: a.path ?? null, step: a.step ?? null, updatedAt: a.updatedAt })), q);
      }
      if (path === 'warnings') return paged(cfg.empty ? [] : F.revisions.flatMap(r => r.warnings.map(w => ({ desiredRevisionId: r.id, code: w.code, message: w.message, sourceLocations: w.sourceLocations }))), q);
      if (path === 'audit') {
        let list = auditOut().map((e, i) => ({ ...e, _i: i }));
        if (q.get('node')) {
          const n = findNode(q.get('node')!);
          if (!n) return err(404, 'node_not_found');
          list = list.filter(e => e.nodeId === n.id);
        }
        const order = orderOf(q);
        if (order === null) return err(400, 'invalid_request', 'order must be newest.');
        /* Without order the Server keeps ID order, which is oldest first. */
        list.sort(order === 'newest' ? (a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt) || b._i - a._i : (a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt) || a._i - b._i);
        return paged(list.map(({ _i, ...e }) => e), q, order);
      }
      if (path === 'enrollment-links') return paged(links.map(linkOut).sort((a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt)), q);
      if ((m = /^enrollment-links\/([^/]+)$/.exec(path))) {
        const l = links.find(x => x.id === seg(m![1]!));
        return l ? json(linkOut(l)) : err(404, 'enrollment_link_not_found');
      }
      if (path === 'cliproxy/status') return json(proxyStatus());
      if (path === 'cliproxy/selection') return json({ catalogs: catalogs.map(selectionEntry) });
      return err(404, 'invalid_request', 'Unknown route ' + path);
    }
    /* POST routes and their scopes */
    const scopeFor: Record<string, Scope> = { 'issues/state': 'operate', 'nodes/rename': 'admin', 'enrollment-links': 'admin', 'source/rescan': 'operate', 'cliproxy/refresh': 'operate', 'cliproxy/selection': 'operate' };
    const level: Scope = scopeFor[path] || (/^nodes\/[^/]+\/(retry|disk-usage\/refresh)$/.test(path) ? 'operate' : 'admin');
    if (!need(level)) return err(403, 'insufficient_scope', `This operation needs the ${level} scope.`);
    if (path === 'issues/state') {
      /* scope operate, then the request (400 invalid_request), then the issue (404 issue_not_found). Each change is audited as issue.acknowledged, issue.snoozed or issue.reopened. */
      const action = body?.action;
      if (typeof body?.id !== 'string' || !body.id.length || body.id.length > 300 || !['acknowledge', 'snooze', 'reopen'].includes(action)) return err(400, 'invalid_request', 'id and an action (acknowledge, snooze or reopen) are required.');
      if (action === 'snooze' ? !Number.isInteger(body.hours) || body.hours < 1 || body.hours > 168 : body.hours != null) return err(400, 'invalid_request', 'hours is required for snooze (1 to 168) and not allowed otherwise.');
      const cur = rawIssues().find(x => x.id === body.id);
      if (!cur) return err(404, 'issue_not_found');
      const at = nowIso();
      const base = { since: cur.since ?? null, by: state.actor, at };
      if (action === 'reopen') issueStates.delete(cur.id);
      else issueStates.set(cur.id, action === 'acknowledge' ? { kind: 'acknowledged', ...base } : { kind: 'snoozed', ...base, until: new Date(Date.now() + body.hours * HOUR).toISOString() });
      addAudit(({ acknowledge: 'issue.acknowledged', snooze: 'issue.snoozed', reopen: 'issue.reopened' } as Record<string, string>)[action]!, { nodeId: cur.nodeId, subject: cur.id });
      return json(applyState(cur));
    }
    if ((m = /^nodes\/([^/]+)\/retry$/.exec(path))) {
      /* OperatorApi rejects a blank target before it looks for the Node; the coordinator bounds it at 100 characters. */
      if (typeof body?.target !== 'string' || !body.target.trim()) return err(400, 'invalid_request', 'target is required.');
      const n = findNode(seg(m[1]!));
      if (!n) return err(404, 'node_not_found');
      if (body.target.length > 100) return err(400, 'invalid_request', 'target is required and bounded.');
      if (n.revokedAt) return err(409, 'node_revoked');
      const t = n.targets.find(x => x.name === body.target);
      if (!t) return err(404, 'target_not_found');
      if (t.state !== 'failed') return err(409, 'target_not_failed');
      t.state = 'pending';
      t.failure = null;
      const a = { attemptId: guid('retry' + Date.now() + Math.random()), state: 'pending', errorCode: null, diagnostic: null, path: null, step: null, updatedAt: nowIso() };
      targetAttempts.set(n.id + ':' + t.name, [{ ...a, assignmentId: guid(n.id + t.name), rolloutId: F.rollouts[0]!.id, targetName: t.name, sourceRevision: F.revisions[0]!.sourceRevision }, ...(targetAttempts.get(n.id + ':' + t.name) || [])]);
      addAudit('assignment.retry_requested', { nodeId: n.id, subject: n.alias });
      return json({ assignmentId: guid(n.id + t.name), attemptId: a.attemptId, state: 'pending' });
    }
    if ((m = /^nodes\/([^/]+)\/disk-usage\/refresh$/.exec(path))) {
      /* Scope operate, then the Node (404 node_not_found), then a revoked Node (409 node_revoked). A repeated request keeps the original time until the Agent answers.
         An Agent before 0.9.0, or a machine that is not checking in, never answers. */
      const n = findNode(seg(m[1]!));
      if (!n) return err(404, 'node_not_found');
      if (n.revokedAt) return err(409, 'node_revoked');
      /* Only a new request is audited (node.disk_refresh_requested, with the Node ID); a repeat keeps the time and records nothing, like the Server. */
      if (!n._diskReq) {
        n._diskReq = nowIso();
        addAudit('node.disk_refresh_requested', { nodeId: n.id, subject: n.alias });
      }
      if (!NO_DISK_AGENT.has(n.alias) && freshnessOfAbs(n) === 'fresh' && !n._diskTimer) {
        n._diskTimer = setTimeout(() => {
          n._diskTimer = null;
          const old = n._disk;
          n._disk = { measuredAt: nowIso(), volumes: old ? old.volumes.map(v => { const step = Math.round((v.usedBytes + v.availableBytes) * 0.003); return { ...v, usedBytes: v.usedBytes + step, availableBytes: v.availableBytes - step }; }) : [vol('home', 464, 38.2)] };
          n._diskReq = null;
        }, cfg.diskDelay);
        timers.add(n._diskTimer);
      }
      return json({ refreshRequestedAt: n._diskReq }, 202);
    }
    if (path === 'nodes/rename') {
      /* RenameNodeAliasAsOperatorAsync: both aliases are validated first (invalid_node_alias), then the Node is looked up by its exact
         current alias, then a revoked Node is refused. Renaming to the alias it already has succeeds and records nothing. */
      const bad = (a: unknown): boolean => typeof a !== 'string' || !a.trim() || a.length > 200;
      if (bad(body?.currentAlias) || bad(body?.alias)) return err(400, 'invalid_node_alias', 'node_alias is required and bounded.');
      const n = nodes.find(x => x.alias === body.currentAlias);
      if (!n) return err(404, 'node_not_found', 'The Node alias is not registered in this Workspace.');
      if (n.revokedAt) return err(409, 'node_revoked', 'A revoked Node cannot change its alias.');
      if (n.alias !== body.alias) {
        if (nodes.some(x => x.alias === body.alias && x.id !== n.id)) return err(409, 'node_alias_in_use', 'The Node alias is already registered in this Workspace.');
        const old = n.alias;
        n.alias = body.alias;
        addAudit('node_alias_changed', { nodeId: n.id, subject: `${old} → ${n.alias}` });
      }
      return json({ nodeId: n.id, alias: n.alias });
    }
    /* These routes take {id:guid}: anything else does not match a route. */
    if ((m = /^(?:nodes|enrollment-links)\/([^/]+)\/(?:revoke|remove)$/.exec(path)) && !GUID.test(seg(m[1]!))) return err(404, 'invalid_request', 'Unknown route ' + path);
    if ((m = /^nodes\/([^/]+)\/revoke$/.exec(path))) {
      /* RevokeNodeAsync: idempotent for the Node (the first revocation time stays) but every call writes an audit event. Assignments are untouched. */
      const n = nodes.find(x => x.id === m![1]);
      if (!n) return err(404, 'node_not_found', 'Node was not found.');
      if (!n.revokedAt) { n.revokedAt = nowIso(); n.revokedBy = state.actor; }
      if (!n.credential.revokedAt) n.credential.revokedAt = n.revokedAt;
      addAudit('node_revoked', { nodeId: n.id, subject: n.alias });
      return json({ revoked: true });
    }
    if ((m = /^nodes\/([^/]+)\/remove$/.exec(path))) {
      /* RemoveNodeAsync: the confirmation alias is validated first, then the Node is found, then its exact alias is compared.
         The enrollment links that created the Node are deleted with it. */
      if (typeof body?.alias !== 'string' || !body.alias.trim() || body.alias.length > 200) return err(400, 'invalid_node_alias', 'node_alias is required and bounded.');
      const i = nodes.findIndex(x => x.id === m![1]);
      if (i < 0) return err(404, 'node_not_found', 'Node was not found.');
      if (nodes[i]!.alias !== body.alias) return err(409, 'node_alias_changed', 'Node alias changed; refresh before removing it.');
      const gone = nodes[i]!;
      for (let k = links.length - 1; k >= 0; k--) if (links[k]!.nodeId === gone.id || (links[k]!.state === 'consumed' && !links[k]!.nodeId && links[k]!.alias === gone.alias)) links.splice(k, 1);
      addAudit('node_removed', { nodeId: gone.id, subject: gone.alias });
      nodes.splice(i, 1);
      return json({ removed: true });
    }
    if (path === 'enrollment-links') {
      /* OperatorApi: expiresInSeconds defaults to 900 and must be 60 to 3600, then the alias is checked. The alias is only bound to the link:
         whether a Node already has it is decided when the Agent enrolls, not here. */
      const expires = body?.expiresInSeconds === undefined ? 900 : body.expiresInSeconds;
      if (!Number.isInteger(expires)) return err(400, 'invalid_request', 'The request is malformed or a parameter is invalid.');
      if (expires < 60 || expires > 3600) return err(400, 'invalid_expiry', 'expiresInSeconds must be between 60 and 3600.');
      if (typeof body?.alias !== 'string' || !body.alias.trim() || body.alias.length > 200) return err(400, 'invalid_alias', 'alias must not be blank and may be at most 200 characters.');
      const id = guid('link' + Date.now() + Math.random());
      const expiresAt = new Date(Date.now() + (cfg.expiry || expires) * 1000).toISOString();
      const link: MLink = { id, alias: body.alias, state: 'active', expiresAt, createdBy: state.actor, createdAt: nowIso(), _platform: cfg.platform };
      links.unshift(link);
      addAudit('enrollment_authorization_created', { subject: body.alias });
      simulateEnrollment(link);
      const payload = b64url(JSON.stringify({ version: 1, serverUrl: 'https://fleet.lab.internal:8443', token: hex(id, 43), alias: body.alias, caPem: '-----BEGIN CERTIFICATE-----\nMOCK\n-----END CERTIFICATE-----', expiresAt }));
      return json({ id, expiresAt, link: 'https://fleet.lab.internal:8443/enroll#fleet-v1=' + payload });
    }
    if ((m = /^enrollment-links\/([^/]+)\/revoke$/.exec(path))) {
      /* RevokeEnrollmentAuthorizationAsync: an unknown link is the legacy code enrollment_not_found (400, it is not in the 404 list).
         Revoking is idempotent and only the first revocation is recorded. A link that was used still reads as consumed. */
      const l = links.find(x => x.id === m![1]);
      if (!l) return err(400, 'enrollment_not_found', 'Enrollment authorization was not found.');
      if (!l.revokedAt) {
        l.revokedAt = nowIso();
        l.revokedBy = state.actor;
        addAudit('enrollment_authorization_revoked', { subject: l.alias });
      }
      return json({ revoked: true });
    }
    if (path === 'source/rescan') {
      await new Promise(r => setTimeout(r, cfg.slow ? 0 : 400));
      scans.unshift({ id: guid('scan' + Date.now() + Math.random()), outcome: 'unchanged', sourceRevision: F.revisions[0]!.sourceRevision, code: null, diagnostic: null, observedAt: nowIso(), requestedBy: state.actor, durationMs: 0 });
      return json({ outcome: 'unchanged', sourceRevision: F.revisions[0]!.sourceRevision });
    }
    if (path === 'cliproxy/refresh') {
      const now = nowIso();
      catalogs.forEach(c => {
        c.lastAttemptAt = now;
        if (c.status === 'ok') { c.lastSuccessAt = now; c._failureSince = null; } else if (!c._failureSince) c._failureSince = now;
      });
      await new Promise(r => setTimeout(r, 300));
      return json(proxyStatus());
    }
    if (path === 'cliproxy/selection') {
      /* CliProxySelectionStore.SaveAsync checks, in this order: the shape (400 invalid_selection), the catalog (404 catalog_unavailable),
         pinned models (409 pinned_model_excluded), an empty selection (400 invalid_selection) and, last, the version (409 stale_selection).
         Families that appear in the catalog but in neither list are frozen to the submitted includeNew default before anything is stored. */
      const id = (x: unknown): boolean => typeof x === 'string' && x.length > 0 && x.length <= 200 && /^[!-~]+$/.test(x);
      const p = body?.policy;
      const invalid = (): Response => err(400, 'invalid_selection', 'The selection is malformed or leaves no model selected.');
      if (typeof body?.baseUrl !== 'string' || !body.baseUrl.trim() || body.baseUrl.length > 2048 || !p || typeof body.version !== 'number' || body.version < 0
        || !Array.isArray(p.disabledFamilies) || !Array.isArray(p.enabledFamilies) || !p.modelOverrides || typeof p.modelOverrides !== 'object'
        || !p.disabledFamilies.every(id) || !p.enabledFamilies.every(id) || p.disabledFamilies.some((k: string) => p.enabledFamilies.includes(k))
        || !Object.keys(p.modelOverrides).every(id)) return invalid();
      const c = catalogs.find(x => x.baseUrl === body.baseUrl);
      if (!c) return err(404, 'catalog_unavailable', 'No model catalog is available for that proxy yet.');
      const en = new Set<string>(p.enabledFamilies);
      const dis = new Set<string>(p.disabledFamilies);
      for (const mm of c.models) {
        const k = fam(mm).key;
        if (!en.has(k) && !dis.has(k)) (p.includeNew ? en : dis).add(k);
      }
      const saved: SelectionPolicy = { ...p, enabledFamilies: [...en].sort(), disabledFamilies: [...dis].sort(), skipClaudeModelsForOtherClients: p.skipClaudeModelsForOtherClients !== false };
      const pinned = nodes.flatMap(n => n.targets).filter(t => t.aiClient?.mode === 'cliproxy' && t.aiClient.baseUrl === c.baseUrl && t.aiClient.model)
        .filter(t => (saved.skipClaudeModelsForOtherClients && t.aiClient!.client !== 'claude' && /^claude-/i.test(t.aiClient!.model!))
          || c.models.some(mm => mm.id === t.aiClient!.model && !selected(saved, mm))).map(t => t.aiClient!.model);
      if (pinned.length) return json({ code: 'pinned_model_excluded', message: 'The selection excludes a model that a Node is assigned.', models: [...new Set(pinned)] }, 409);
      if (!c.models.some(mm => selected(saved, mm))) return invalid();
      if (body.version !== c.version) return err(409, 'stale_selection', 'The selection changed since it was loaded. Reload it and try again.');
      policies.set(c.baseUrl, saved);
      c.version += 1;
      c.models.forEach(mm => { mm.selected = selected(saved, mm); });
      return json({ catalog: selectionEntry(c) });
    }
    return err(404, 'invalid_request', 'Unknown route ' + path);
  }

  /* states=1: an acknowledged and a snoozed issue, so the Problems tabs have content. */
  if (cfg.states && !cfg.empty) {
    const find = (code: string, alias: string): Issue | undefined => rawIssues().find(i => i.code === code && i.nodeName === alias);
    const ack = find('agent_outdated', 'laptop-ana');
    const snooze = find('disk_space_low', 'fedora-ws');
    if (ack) issueStates.set(ack.id, { kind: 'acknowledged', since: ack.since ?? null, by: cfg.xss ? XSS_COMMIT.author : 'ana', at: new Date(Date.now() - 2 * HOUR).toISOString() });
    if (snooze) issueStates.set(snooze.id, { kind: 'snoozed', since: snooze.since ?? null, by: 'joan', at: new Date(Date.now() - 20 * 60e3).toISOString(), until: new Date(Date.now() + 190 * 60e3).toISOString() });
  }

  const calls: MockCall[] = [];
  const mockFetch = (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    if (cfg.offline) throw new TypeError('Failed to fetch');
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url, cfg.origin);
    if (!u.pathname.startsWith('/dashboard/api/')) throw new TypeError('Failed to fetch');
    const path = u.pathname.slice('/dashboard/api/'.length);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k.toLowerCase()] = v; });
    /* A browser adds the page's Origin to every cross-origin request; the page cannot set it. */
    headers.origin = cfg.origin;
    let body: Json = null;
    try { body = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : null; } catch { body = null; }
    const method = (init.method || 'GET').toUpperCase();
    const call: MockCall = { method, path, query: Object.fromEntries(u.searchParams), body, headers, at: Date.now(), settled: false, aborted: false };
    calls.push(call);
    let run: Promise<Response> = cfg.hang && method === 'GET' && path.startsWith(cfg.hang) ? new Promise<Response>(() => {}) : handle(method, path, u.searchParams, body, headers).catch((e: unknown) => {
      if (e instanceof URIError) return err(400, 'invalid_request', 'The path is not correctly percent-encoded.');
      console.error('mock error', e);
      return err(500, 'mock_error', String((e as Error)?.message || e));
    });
    const lag = method !== 'GET' && Object.entries(cfg.lag).find(([text]) => path.includes(text));
    if (lag) run = run.then(r => new Promise<Response>(resolve => setTimeout(() => resolve(r), lag[1])));
    const signal = init.signal;
    if (!signal) return run.finally(() => { call.settled = true; });
    return new Promise<Response>((resolve, reject) => {
      const abort = (): void => { call.aborted = true; call.settled = true; reject(new DOMException('The operation was aborted.', 'AbortError')); };
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
      run.then(resolve, reject).finally(() => { call.settled = true; signal.removeEventListener('abort', abort); });
    });
  }) as typeof fetch;

  return {
    fetch: mockFetch, options: cfg, state, data: F, nodes, links, audit, calls, issueStates,
    dispose() {
      for (const id of timers) clearTimeout(id);
      timers.clear();
    },
  };
}

export { ANCHOR };
