/**
 * Derived state (ported from model.js). Turns Operator API records into the health, reason and issue models the
 * views share. Nothing here invents data: it only reads fields the contract defines, and every field that a Server
 * from before a phase does not send has a safe fallback.
 */
import type {
  AssignmentState, CommitInfo, DesiredRevisionDetail, DriftEvent, Freshness, InstallMethod, Issue, IssueStateKey, NodeAgent, NodeCredential, NodeDetail,
  NodeDisk, NodeListAgent, NodeListDisk, NodeListItem, NodeTarget, RolloutDetail, ScanOutcome, ServiceManager, StateCounts,
} from '@/api/types';
import { DAY, listText, ms, now, plural, rel, shortSha, span, valid } from './format';
import type { GlyphKind, GlyphLevel, StatusMeta } from './status';
import { countTotal, emptyCounts, targetShort, type TargetLike } from './targets';

/* ------------------------------------------------------------------ Nodes */

export interface DiskVolumeView {
  label: string;
  usedPercent: number;
  usedBytes: number;
  availableBytes: number;
  totalBytes: number;
  measuredAt: string | null;
}
export interface DiskView {
  measuredAt: string | null;
  refreshRequestedAt: string | null;
  volumes: DiskVolumeView[];
}
export interface AgentView {
  version: string | null;
  latestVersion: string | null;
  outdated: boolean;
  os: { name: string | null; version: string | null; kernel: string | null };
  arch: string | null;
  hostname: string | null;
  user: string | null;
  installMethod: string | null;
  serviceManager: string | null;
  stateDirectory: string | null;
  reportedAt: string | null;
}
export interface NodeView {
  id: string;
  alias: string;
  platform: string | null;
  revoked: boolean;
  revokedAt: string | null;
  lastContactAt: string | null;
  freshness: Freshness;
  enrolledAt: string | null;
  notAfter: string | null;
  counts: StateCounts;
  currentRevision: string | null;
  /** The fullest volume (`GET nodes`), or `null`. */
  disk: DiskVolumeView | null;
  agent: AgentView | null;
}
export interface NodeDetailView extends Omit<NodeView, 'disk'> {
  credential: NodeCredential | null;
  targets: NodeTarget[];
  currentAcceptedAt: string | null;
  /** Detail disk: all volumes plus the pending refresh request. */
  disk: DiskView | null;
  drift: DriftView[];
}
export interface DriftView {
  target: string;
  files: string[];
  detectedAt: string;
}

const byteCount = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) && x >= 0 ? x : 0;
};
const round1 = (x: number): number => Math.round(x * 10) / 10;
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const names = (v: unknown): string[] => (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string');

/** One volume: `{ label, usedPercent, usedBytes, availableBytes, totalBytes, measuredAt? }`. `usedPercent` is recomputed when the Server omits it. */
export function diskVolume(raw: Partial<NodeListDisk & { usedPercent: number }> | null | undefined): DiskVolumeView | null {
  if (!raw || typeof raw !== 'object') return null;
  const used = byteCount(raw.usedBytes);
  const avail = byteCount(raw.availableBytes);
  const total = byteCount(raw.totalBytes);
  const given = Number(raw.usedPercent);
  const pct = Number.isFinite(given) ? given : used + avail > 0 ? round1((used / (used + avail)) * 100) : 0;
  return { label: String(raw.label ?? 'home'), usedPercent: Math.max(0, pct), usedBytes: used, availableBytes: avail, totalBytes: total, measuredAt: raw.measuredAt || null };
}
const VOLUME_ORDER: Record<string, number> = { home: 0, state: 1 };
/** `GET nodes/{node}`.disk. A pending refresh on a Node that never reported has no volumes. */
export function diskDetail(raw: NodeDisk | null | undefined): DiskView | null {
  if (!raw || typeof raw !== 'object') return null;
  const volumes = (Array.isArray(raw.volumes) ? raw.volumes : [])
    .map(v => diskVolume(v))
    .filter((v): v is DiskVolumeView => v !== null)
    .sort((a, b) => (VOLUME_ORDER[a.label] ?? 9) - (VOLUME_ORDER[b.label] ?? 9) || a.label.localeCompare(b.label));
  return { measuredAt: raw.measuredAt || null, refreshRequestedAt: raw.refreshRequestedAt || null, volumes };
}

/** Thresholds from the Server's issues: warning from 85% used, error from 95%. */
export const DISK_WARN = 85;
export const DISK_CRIT = 95;
export interface DiskLevel extends StatusMeta {
  key: 'critical' | 'warning' | 'good';
}
export const diskLevel = (pct: number): DiskLevel =>
  pct >= DISK_CRIT ? { key: 'critical', level: 'critical', kind: 'x', label: 'Nearly full' }
    : pct >= DISK_WARN ? { key: 'warning', level: 'warning', kind: 'bang', label: 'Filling up' }
      : { key: 'good', level: 'good', kind: 'check', label: 'Enough space' };
/** The state of a machine's disk for grouping and sorting; `null` when it never reported or is revoked. */
export const diskOf = (n: Pick<NodeView, 'disk' | 'revoked'>): DiskLevel | null => (n.disk && !n.revoked ? diskLevel(n.disk.usedPercent) : null);
export const diskHot = (n: Pick<NodeView, 'disk' | 'revoked'>): boolean => {
  const d = diskOf(n);
  return !!d && d.key !== 'good';
};
export const total = (n: Pick<NodeView, 'counts'>): number => countTotal(n.counts);

/**
 * `agent` of `GET nodes` / `GET nodes/{node}`. `null` (or a Server before phase 3, which has no `agent` property) means the Node
 * never reported: its Agent is older than 0.9.0.
 */
export function agentInfo(input: NodeAgent | NodeListAgent | null | undefined): AgentView | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Partial<Record<keyof NodeAgent, unknown>> & { reportedAt?: string };
  const os = raw.os && typeof raw.os === 'object' ? (raw.os as { name?: unknown; version?: unknown; kernel?: unknown }) : {};
  return {
    version: text(raw.version), latestVersion: text(raw.latestVersion), outdated: raw.outdated === true,
    os: { name: text(os.name), version: text(os.version), kernel: text(os.kernel) },
    arch: text(raw.arch), hostname: text(raw.hostname), user: text(raw.user), installMethod: text(raw.installMethod), serviceManager: text(raw.serviceManager),
    stateDirectory: text(raw.stateDirectory), reportedAt: raw.reportedAt || null,
  };
}
/** "Fedora Linux 44", "macOS", or `null` when the Agent reported neither. */
export const osText = (n: Pick<NodeView, 'agent'>): string | null => (n.agent ? [n.agent.os.name, n.agent.os.version].filter(Boolean).join(' ') || null : null);
/** An outdated Agent on a revoked machine is not worth a nudge: nothing can be upgraded through Fleet any more. */
export const agentOutdated = (n: Pick<NodeView, 'agent' | 'revoked'>): boolean => !!n.agent && n.agent.outdated && !n.revoked;

/** GET nodes item to view model. */
export function fromList(raw: NodeListItem): NodeView {
  return {
    id: raw.nodeId, alias: raw.name, platform: raw.platform || null, revoked: !!raw.revoked, revokedAt: raw.revokedAt || null,
    lastContactAt: raw.lastContactAt || null, freshness: raw.freshness, enrolledAt: raw.enrolledAt || null,
    notAfter: raw.credentialNotAfter || null, counts: { ...emptyCounts(), ...(raw.targets || {}) }, currentRevision: raw.currentRevision || null,
    disk: diskVolume(raw.disk), agent: agentInfo(raw.agent),
  };
}
/** Drift events of a Node (`GET nodes/{node}`.drift), newest first. A Server before phase 4 sends none. */
export const drift = (raw: unknown): DriftView[] =>
  (Array.isArray(raw) ? (raw as Partial<DriftEvent>[]) : [])
    .map(e => ({ target: String(e?.target ?? ''), files: names(e?.files), detectedAt: e?.detectedAt || '' }))
    .filter(e => valid(e.detectedAt))
    .sort((a, b) => (ms(b.detectedAt) ?? 0) - (ms(a.detectedAt) ?? 0));
export const recentDrift = (n: Pick<NodeDetailView, 'drift'>, within = DAY): DriftView[] => (n.drift || []).filter(e => now() - (ms(e.detectedAt) ?? 0) <= within);
/** GET nodes/{node} to view model with Targets and credential. */
export function fromDetail(raw: NodeDetail): NodeDetailView {
  const targets = raw.targets || [];
  const newest = targets
    .map(t => t.desiredRevision)
    .filter((d): d is NonNullable<typeof d> => !!d)
    .sort((a, b) => (ms(b.acceptedAt) || 0) - (ms(a.acceptedAt) || 0))[0];
  return {
    id: raw.nodeId, alias: raw.name, platform: raw.platform || null, revoked: !!raw.revoked, revokedAt: raw.revokedAt || null,
    lastContactAt: raw.lastContactAt || null, freshness: raw.freshness, enrolledAt: raw.enrolledAt || null,
    notAfter: raw.credential?.notAfter || null, credential: raw.credential || null, targets,
    counts: { ...emptyCounts(), ...(raw.summary || {}) }, currentRevision: newest?.sourceRevision || null, currentAcceptedAt: newest?.acceptedAt || null,
    disk: diskDetail(raw.disk), agent: agentInfo(raw.agent), drift: drift(raw.drift),
  };
}

/* ------------------------------------------------------------------ Agent upgrade */

/** A version is a tag in a command only when it is a plain semantic version. The Server sends its own version, but the command is copied into a shell. */
export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const INSTALL: Record<InstallMethod, string> = { managed: 'Fleet service install', homebrew: 'Homebrew', cargo: 'Cargo (release tag)', binary: 'Release archive' };
export const INSTALLED: Record<InstallMethod, string> = { managed: 'by fleet-agent service install', homebrew: 'with Homebrew', cargo: 'with Cargo from a release tag', binary: 'from a release archive' };
export const SERVICE: Record<ServiceManager, string> = { systemd: 'systemd user service', launchd: 'launchd LaunchAgent', none: 'None (not run as a service)' };
/** The real names come from the Agent's service command (clients/bins/fleet-agent/src/service.rs): the user unit fleet-agent.service and the label dev.fleet.agent. */
export const RESTART: Partial<Record<ServiceManager, string>> = {
  systemd: 'systemctl --user restart fleet-agent.service',
  launchd: 'launchctl kickstart -k "gui/$(id -u)/dev.fleet.agent"',
};
export const REPO = 'https://github.com/jcarcaboso/fleet-manager';

export interface UpgradeStep {
  text: string;
  cmd?: string;
}
export interface UpgradePlan {
  method: InstallMethod | null;
  steps: UpgradeStep[];
  releaseUrl?: string | null;
}
/**
 * The steps that upgrade this machine's Agent, from its install method and service manager. `null` when nothing is outdated.
 * Commands are built only from validated pieces: fixed strings, and a tag that passed `SEMVER`.
 */
export function upgradePlan(n: Pick<NodeView, 'agent'>): UpgradePlan | null {
  const a = n.agent;
  if (!a || !a.outdated) return null;
  const tag = a.latestVersion && SEMVER.test(a.latestVersion) ? `v${a.latestVersion}` : null;
  const restartCmd = a.serviceManager ? RESTART[a.serviceManager as ServiceManager] : undefined;
  const restart: UpgradeStep = a.installMethod === 'homebrew' ? { text: 'Restart the service so the new version starts polling.', cmd: 'brew services restart fleet-agent' }
    : restartCmd ? { text: 'Restart the service so the new version starts polling.', cmd: restartCmd }
      : { text: 'Restart the Agent the way you started it. It is not running as a service.' };
  if (a.installMethod === 'managed') {
    // The service runs its own copy, so the new binary is installed into it rather than restarted.
    return {
      method: 'managed', releaseUrl: tag ? `${REPO}/releases/tag/${tag}` : null,
      steps: [{ text: `Get the ${tag || 'latest'} fleet-agent the way it was first installed, for example with Homebrew.`, cmd: 'brew upgrade fleet-agent' },
        { text: 'Install it as the running Agent. The service switches to the new version and restarts.', cmd: 'fleet-agent service install' }],
    };
  }
  if (a.installMethod === 'homebrew') return { method: 'homebrew', steps: [{ text: 'Upgrade the Agent with Homebrew.', cmd: 'brew upgrade fleet-agent' }, restart] };
  if (a.installMethod === 'cargo') {
    return {
      method: 'cargo',
      steps: [tag
        ? { text: `Rebuild both commands from the ${tag} release tag. This needs Rust 1.95.0.`, cmd: `cargo install --locked --force \\\n    --git ${REPO} \\\n    --tag ${tag} \\\n    fleet fleet-agent` }
        : { text: 'Rebuild both commands from the newest release tag with cargo install --locked --force.' }, restart],
    };
  }
  if (a.installMethod === 'binary') {
    return {
      method: 'binary', releaseUrl: tag ? `${REPO}/releases/tag/${tag}` : null,
      steps: [{ text: `Download the ${tag || 'latest'} archive, replace the binary at the same path and restart the service.`, ...(restart.cmd ? { cmd: restart.cmd } : {}) }],
    };
  }
  return { method: null, steps: [{ text: 'Upgrade the Agent the way it was installed, then restart it. The install method was not reported.' }] };
}
/** Fix steps for an issue: the catalog's steps, or the issue's own action. An outdated Agent's action names the command for its install method, so it comes first. */
export function fixSteps(i: Pick<Issue, 'action' | 'code'> | null | undefined, cat: { fix?: string[] } | null | undefined): Array<{ t: string }> {
  const own = i?.action ? [{ t: i.action }] : [];
  const steps = cat?.fix?.length ? cat.fix.map(t => ({ t })) : null;
  if (!steps) return own;
  return i?.code === 'agent_outdated' ? [...own, ...steps.filter(s => s.t !== i.action)] : steps;
}

/* ------------------------------------------------------------------ Health */

export type HealthKey = 'failing' | 'offline' | 'never' | 'updating' | 'ok' | 'retired';
export interface HealthDef extends StatusMeta {
  rank: number;
}
export const HL: Record<HealthKey, HealthDef> = {
  failing: { level: 'critical', kind: 'bang', label: 'Action needed', rank: 0 },
  offline: { level: 'serious', kind: 'moon', label: 'Offline', rank: 1 },
  never: { level: 'serious', kind: 'clock', label: 'Not checked in', rank: 1 },
  updating: { level: 'info', kind: 'sync', label: 'Updating', rank: 2 },
  ok: { level: 'good', kind: 'check', label: 'Up to date', rank: 3 },
  retired: { level: 'neutral', kind: 'minus', label: 'Retired', rank: 4 },
};
export interface Health extends HealthDef {
  key: HealthKey;
  reason: string;
  extra?: string | null;
  target?: TargetLike | null;
}
export interface Failure {
  target: TargetLike;
  errorCode: string | null;
  issue?: Issue;
}
/** `titleOf` turns an error code into its catalog title (`catalog.title`); the default shows the code. */
export function health(
  n: Pick<NodeView, 'revoked' | 'revokedAt' | 'counts' | 'freshness' | 'enrolledAt' | 'lastContactAt' | 'currentRevision'>,
  failures: Failure[] = [],
  titleOf: (code: string | null) => string = c => c || 'Unknown problem',
): Health {
  if (n.revoked) return { key: 'retired', ...HL.retired, reason: `Revoked ${rel(n.revokedAt)}. Its alias stays reserved.` };
  const failed = n.counts.failed;
  if (failed > 0) {
    const first = failures[0];
    const reason = first ? titleOf(first.errorCode) : `${plural(failed, 'Target')} failing`;
    const same = !!first && failures.length > 1 && failures.every(f => f.errorCode === first.errorCode);
    const extra = failures.length > 1 ? (same ? `affects ${listText(failures.map(f => targetShort(f.target)))}` : `+${failures.length - 1} more`) : null;
    return { key: 'failing', ...HL.failing, reason, extra, target: first?.target || null };
  }
  if (n.freshness === 'never_contacted') return { key: 'never', ...HL.never, reason: `Enrolled ${rel(n.enrolledAt)}, but the Agent has not checked in yet` };
  if (n.freshness === 'stale') return { key: 'offline', ...HL.offline, reason: `No check-in for ${span(now() - (ms(n.lastContactAt) || now()), true)}` };
  const busy = n.counts.applying + n.counts.pending;
  if (busy > 0) {
    const revision = n.currentRevision ? ` revision ${shortSha(n.currentRevision)}` : '';
    return { key: 'updating', ...HL.updating, reason: n.counts.applying ? `Applying${revision} to ${plural(n.counts.applying, 'Target')}` : `${plural(n.counts.pending, 'Target')} waiting for the next check-in` };
  }
  const all = countTotal(n.counts);
  return { key: 'ok', ...HL.ok, reason: all === 0 ? 'No Targets are assigned yet' : `In sync${n.currentRevision ? ` at revision ${shortSha(n.currentRevision)}` : ''}` };
}
export const isAttention = (h: Pick<Health, 'key'>): boolean => ['failing', 'offline', 'never'].includes(h.key);
export const seenText = (n: Pick<NodeView, 'revoked' | 'lastContactAt'>): string => (n.revoked ? 'Revoked' : !n.lastContactAt ? 'Never seen' : 'Seen ' + rel(n.lastContactAt));

/* ------------------------------------------------------------------ Certificate */

export const certLeft = (n: Pick<NodeView, 'notAfter'>): number | null => (n.notAfter ? (ms(n.notAfter) ?? now()) - now() : null);
export const certText = (n: Pick<NodeView, 'notAfter' | 'revoked'>): string => {
  if (n.revoked) return 'Revoked';
  const left = certLeft(n);
  return left === null ? 'Unknown' : left <= 0 ? 'Expired' : `${span(left)} left`;
};
export interface CertFlag {
  level: GlyphLevel;
  kind: GlyphKind;
  text: string;
}
/** A certificate is only worth flagging when the Agent cannot renew it because it is not polling. */
export function certFlag(n: Pick<NodeView, 'notAfter' | 'revoked' | 'freshness'>): CertFlag | null {
  if (n.revoked || n.freshness === 'fresh') return null;
  const left = certLeft(n);
  if (left === null || left > DAY) return null;
  return left <= 0
    ? { level: 'warning', kind: 'bang', text: 'Certificate expired. It renews when the Agent reconnects.' }
    : { level: 'warning', kind: 'bang', text: `Certificate expires in ${span(left)}` };
}

/* ------------------------------------------------------------------ Issues (GET issues) */

export type IssueLevel = 'critical' | 'serious' | 'warning' | 'info';
export const issueLevel = (i: Pick<Issue, 'severity' | 'code'>): IssueLevel =>
  i.severity === 'error' ? 'critical' : i.code === 'node_not_contacting' ? 'serious' : i.severity === 'warning' ? 'warning' : 'info';
export const issueKind = (level: IssueLevel): GlyphKind => ({ critical: 'x', serious: 'moon', warning: 'bang', info: 'info' } as const)[level];
export const issueBadge = (level: IssueLevel): string => ({ critical: 'Error', serious: 'Offline', warning: 'Warning', info: 'Notice' })[level];
export const LRANK: Record<IssueLevel, number> = { critical: 0, serious: 1, warning: 2, info: 3 };
export const issuesByNode = (items: Issue[]): Map<string, Issue[]> => {
  const map = new Map<string, Issue[]>();
  for (const i of items) {
    if (!i.nodeId) continue;
    const list = map.get(i.nodeId) ?? [];
    list.push(i);
    map.set(i.nodeId, list);
  }
  return map;
};
/** Failed-Target descriptions for a Node, taken from the Node's issues. */
export const failuresFromIssues = (list: Issue[] | null | undefined): Failure[] =>
  (list || []).filter(i => i.target && i.errorCode).map(i => ({ target: { name: i.target as string }, errorCode: i.errorCode, issue: i }));
export const sortIssues = (items: Issue[]): Issue[] =>
  items.slice().sort((a, b) => LRANK[issueLevel(a)] - LRANK[issueLevel(b)] || String(a.nodeName || '').localeCompare(String(b.nodeName || '')) || String(a.target || '').localeCompare(String(b.target || '')));
export type IssueSection = 'machines' | 'repository' | 'models' | 'other';
export function issueSection(i: Pick<Issue, 'nodeId' | 'section' | 'code'>): IssueSection {
  if (i.nodeId) return 'machines';
  const s = String(i.section || '') + ' ' + i.code;
  if (/repo|source|scan|manifest|warning|skill/i.test(s)) return 'repository';
  if (/model|cliproxy|catalog/i.test(s)) return 'models';
  return 'other';
}

/* ------------------------------------------------------------------ Phase 4: commits, revisions, rollouts, issue state */

export interface CommitView {
  subject: string | null;
  author: string | null;
  committedAt: string | null;
}
/** Commit metadata, or `null` (a revision accepted before phase 4, or a Server before it). */
export function commit(raw: Partial<CommitInfo> | null | undefined): CommitView | null {
  if (!raw || typeof raw !== 'object') return null;
  const subject = text(raw.subject);
  const author = text(raw.author);
  return subject || author ? { subject, author, committedAt: raw.committedAt || null } : null;
}
/** The title of a revision: its commit subject, or its short SHA when the Server has no commit for it. */
export const revTitle = (rev: { commit?: Partial<CommitInfo> | null; sourceRevision: string } | null | undefined): string =>
  commit(rev?.commit)?.subject || (rev ? `Revision ${shortSha(rev.sourceRevision)}` : '');

export interface RevisionDetailView {
  id: string;
  sourceRevision: string;
  acceptedAt: string | null;
  commit: CommitView | null;
  previous: { id: string; sourceRevision: string } | null;
  rolloutId: string | null;
  skills: { added: string[]; changed: string[]; removed: string[] };
  targets: { added: number; changed: number; removed: number; nodes: number };
}
const int = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0;
};
/** `GET desired-revisions/{id}`. */
export const revisionDetail = (raw: DesiredRevisionDetail): RevisionDetailView => ({
  id: raw.desiredRevisionId, sourceRevision: raw.sourceRevision, acceptedAt: raw.acceptedAt || null, commit: commit(raw.commit),
  previous: raw.previous && raw.previous.desiredRevisionId ? { id: raw.previous.desiredRevisionId, sourceRevision: raw.previous.sourceRevision || '' } : null,
  rolloutId: raw.rolloutId || null,
  skills: { added: names(raw.skills?.added), changed: names(raw.skills?.changed), removed: names(raw.skills?.removed) },
  targets: { added: int(raw.targets?.added), changed: int(raw.targets?.changed), removed: int(raw.targets?.removed), nodes: int(raw.targets?.nodes) },
});

/** A Node's state is the worst of its Targets, in this order. */
export const NODE_RANK: Record<AssignmentState, number> = { failed: 0, applying: 1, pending: 2, succeeded: 3, superseded: 4 };
export const nodeRank = (state: string): number => NODE_RANK[state as AssignmentState] ?? 5;

export interface RolloutDetailView {
  id: string;
  revisionId: string;
  sourceRevision: string;
  createdAt: string | null;
  summary: StateCounts;
  nodes: Array<{
    id: string;
    name: string;
    state: AssignmentState;
    first: string | null;
    last: string | null;
    targets: Array<{ name: string; state: AssignmentState; errorCode: string | null; updatedAt: string | null }>;
  }>;
}
/** `GET rollouts/{id}`. */
export const rolloutDetail = (raw: RolloutDetail): RolloutDetailView => ({
  id: raw.rolloutId, revisionId: raw.desiredRevisionId, sourceRevision: raw.sourceRevision, createdAt: raw.createdAt || null,
  summary: { ...emptyCounts(), ...(raw.summary || {}) },
  nodes: (Array.isArray(raw.nodes) ? raw.nodes : []).map(n => ({
    id: n.nodeId, name: String(n.nodeName ?? ''), state: n.state, first: n.firstAttemptAt || null, last: n.lastAttemptAt || null,
    targets: (Array.isArray(n.targets) ? n.targets : []).map(t => ({ name: String(t.name ?? ''), state: t.state, errorCode: t.errorCode || null, updatedAt: t.updatedAt || null })),
  })),
});

export interface IssueStateView {
  key: IssueStateKey;
  by: string | null;
  at: string | null;
  until: string | null;
}
/**
 * Issue state: `GET issues` items carry `state` (open, acknowledged, snoozed), `stateBy`, `stateAt` and `snoozedUntil`. A Server before phase 4
 * sends none, so every issue is open. A snooze whose time has passed counts as open, even before the page is refreshed.
 */
export function issueState(i: Pick<Issue, 'state' | 'stateBy' | 'stateAt' | 'snoozedUntil'> | null | undefined): IssueStateView {
  const s = i?.state;
  if (i && s === 'snoozed' && !(ms(i.snoozedUntil) !== null && (ms(i.snoozedUntil) as number) <= now())) return { key: 'snoozed', by: text(i.stateBy), at: i.stateAt || null, until: i.snoozedUntil || null };
  if (i && s === 'acknowledged') return { key: 'acknowledged', by: text(i.stateBy), at: i.stateAt || null, until: null };
  return { key: 'open', by: null, at: null, until: null };
}
export const isOpen = (i: Parameters<typeof issueState>[0]): boolean => issueState(i).key === 'open';
export const STATE_LABEL: Record<IssueStateKey, string> = { open: 'Open', acknowledged: 'Acknowledged', snoozed: 'Snoozed' };
/** The navigation badge counts open errors only. */
export const errorCount = (items: Issue[] | null | undefined): number => (items || []).filter(i => i.severity === 'error' && isOpen(i)).length;
/** Snooze choices: hours, short label, long label. */
export const SNOOZE: ReadonlyArray<readonly [number, string, string]> = [[1, '1 h', '1 hour'], [4, '4 h', '4 hours'], [24, '24 h', '24 hours'], [168, '7 d', '7 days']];
/** Replaces an issue by its updated copy in a list. */
export const patchIssue = (items: Issue[] | null | undefined, item: Issue): Issue[] => (items || []).map(i => (i.id === item.id ? item : i));

/* ------------------------------------------------------------------ Source scans */

const SCAN_OUTCOME: Record<ScanOutcome, StatusMeta> = {
  accepted: { level: 'info', kind: 'down', label: 'Published' },
  unchanged: { level: 'good', kind: 'check', label: 'No changes' },
  invalid: { level: 'serious', kind: 'bang', label: 'Rejected' },
  failed: { level: 'critical', kind: 'x', label: 'Fetch failed' },
};
export const scanOutcome = (o: string | null | undefined): StatusMeta =>
  (o && Object.hasOwn(SCAN_OUTCOME, o) ? SCAN_OUTCOME[o as ScanOutcome] : undefined) ?? { level: 'neutral', kind: 'minus', label: o ? String(o).replace(/_/g, ' ') : 'Unknown' };
