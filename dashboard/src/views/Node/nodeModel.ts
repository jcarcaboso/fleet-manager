/**
 * Pure derivations for the machine page (ported from view-node.js): the problems list, the health checks, the Activity events,
 * and the small texts of the hero and the tables. Nothing here touches the DOM or the network.
 */
import type { AuditEvent, ErrorCatalogEntry, Issue, NodeAttempt, NodeTarget } from '@/api/types';
import type { ErrorCatalog } from '@/composables/catalog';
import { actorName, auditLabel } from '@/lib/audit';
import { DAY, bytes, fmtDay, fmtFull, listText, ms, now, platformLabel, plural, rel, shortSha, span, valid } from '@/lib/format';
import {
  agentOutdated, certLeft, diskLevel, issueBadge, issueKind, issueLevel, issueState, LRANK, recentDrift, total,
  INSTALL, type Failure, type IssueLevel, type IssueStateView, type NodeDetailView,
} from '@/lib/model';
import type { GlyphKind, GlyphLevel } from '@/lib/status';
import { attemptVerb, targetIcon, targetKind, targetLabel, targetShort, tstate } from '@/lib/targets';
import type { TimelineEvent } from '@/components/Timeline.vue';

/* ------------------------------------------------------------------ problems of one machine */

export interface ProblemEntry {
  kind: 'target' | 'issue';
  id: string;
  level: IssueLevel;
  glyph: GlyphKind;
  badge: string;
  target: NodeTarget | null;
  issue: Issue | null;
  code: string | null;
  cat: ErrorCatalogEntry | null;
  st: IssueStateView;
  title: string;
  since: string | null;
}

export const failedTargets = (n: Pick<NodeDetailView, 'targets'>): NodeTarget[] => (n.targets || []).filter(t => t.state === 'failed');
export const failuresOf = (n: Pick<NodeDetailView, 'targets'>): Failure[] =>
  failedTargets(n).map(t => ({ target: t, errorCode: t.latestAttempt?.errorCode || null }));

/**
 * Failed Targets (matched with their issue when there is one) and the other issues of the machine, worst first. A revoked machine has none.
 * A failed Target is always an error; an issue that a failed Target already covers is not listed twice.
 */
export function problemsOf(n: NodeDetailView, allIssues: readonly Issue[], catalog: Pick<ErrorCatalog, 'get'>): ProblemEntry[] {
  const out: ProblemEntry[] = [];
  if (n.revoked) return out;
  const issues = allIssues.filter(i => i.nodeId === n.id);
  const used = new Set<string>();
  for (const t of failedTargets(n)) {
    const match = issues.find(i => i.target === t.name) ?? null;
    if (match) used.add(match.id);
    const code = t.latestAttempt?.errorCode || match?.errorCode || null;
    const cat = catalog.get(code);
    out.push({
      kind: 'target', id: `target:${t.name}`, level: 'critical', glyph: 'x', badge: 'Error', target: t, issue: match, code, cat, st: issueState(match),
      title: cat?.title || code || `${targetLabel(t)} failed`, since: t.firstFailedAt,
    });
  }
  for (const i of issues) {
    if (used.has(i.id)) continue;
    const level = issueLevel(i);
    out.push({
      kind: 'issue', id: i.id, level, glyph: issueKind(level), badge: issueBadge(level), target: null, issue: i, code: i.errorCode || i.code, st: issueState(i),
      cat: catalog.get(i.errorCode) || catalog.get(i.code), title: i.title, since: i.since,
    });
  }
  return out.sort((a, b) => LRANK[a.level] - LRANK[b.level]);
}

/* ------------------------------------------------------------------ health checks (Overview) */

export interface HealthCheck {
  level: GlyphLevel;
  kind: GlyphKind;
  title: string;
  text: string;
}

export function healthChecks(n: NodeDetailView): HealthCheck[] {
  const out: HealthCheck[] = [];
  const count = total(n);
  const left = certLeft(n);
  if (n.revoked) out.push({ level: 'neutral', kind: 'minus', title: 'Access revoked', text: `Revoked ${rel(n.revokedAt)}${n.credential?.revokedBy ? ` by ${n.credential.revokedBy}` : ''}. Its certificates no longer work.` });
  else if (n.freshness === 'fresh') out.push({ level: 'good', kind: 'check', title: 'Checking in', text: `Last poll ${rel(n.lastContactAt)}` });
  else if (n.freshness === 'stale') out.push({ level: 'serious', kind: 'moon', title: 'Not checking in', text: `No poll for ${span(now() - (ms(n.lastContactAt) ?? now()), true)}, since ${fmtFull(n.lastContactAt)} UTC` });
  else out.push({ level: 'serious', kind: 'clock', title: 'Never checked in', text: `Enrolled ${rel(n.enrolledAt)}; no poll yet` });

  const fail = failedTargets(n);
  const ok = n.counts.succeeded;
  if (n.revoked) out.push({ level: 'neutral', kind: 'minus', title: 'Targets frozen', text: 'Revoked machines receive no further assignments.' });
  else if (count === 0) out.push({ level: 'pending', kind: 'clock', title: 'No Targets assigned', text: 'Add this machine to fleet.yml, then sync the repository.' });
  else if (fail.length) out.push({ level: 'critical', kind: 'x', title: `${fail.length} of ${count} Targets failing`, text: listText(fail.map(t => targetLabel(t))) });
  else if (ok === count) out.push({ level: 'good', kind: 'check', title: `All ${count} Targets in sync`, text: n.currentRevision ? `At revision ${shortSha(n.currentRevision)}` : '' });
  else out.push({ level: 'info', kind: 'sync', title: `${ok} of ${count} Targets in sync`, text: `${listText(n.targets.filter(t => t.state !== 'succeeded').map(t => targetShort(t)))} still to apply` });

  if (!n.revoked && left !== null) {
    out.push(left <= 0
      ? { level: 'warning', kind: 'bang', title: 'Certificate expired', text: n.freshness === 'fresh' ? 'It renews at the next poll.' : 'The Agent renews it when it reconnects.' }
      : left < DAY
        ? { level: 'warning', kind: 'bang', title: 'Certificate expires soon', text: `${span(left)} left${n.freshness === 'fresh' ? ' · renews at the next poll' : ' · cannot renew while offline'}` }
        : { level: 'good', kind: 'check', title: 'Certificate valid', text: `${span(left)} left · renews automatically` });
  }

  const worst = n.disk?.volumes.slice().sort((a, b) => b.usedPercent - a.usedPercent)[0];
  if (!n.revoked && worst) {
    const lv = diskLevel(worst.usedPercent);
    out.push({
      level: lv.level, kind: lv.kind, title: lv.key === 'good' ? 'Disk has room' : lv.key === 'warning' ? 'Disk is filling up' : 'Disk is nearly full',
      text: `${worst.usedPercent.toFixed(1)}% used · ${bytes(worst.availableBytes)} available of ${bytes(worst.totalBytes)}`,
    });
  }

  if (!n.revoked && n.agent?.version) {
    const a = n.agent;
    out.push(a.outdated
      ? { level: 'warning', kind: 'bang', title: 'Agent update available', text: `Running ${a.version}${a.latestVersion ? `; ${a.latestVersion} is the latest` : ''}` }
      : { level: 'good', kind: 'check', title: 'Agent is up to date', text: `Running ${a.version}` });
  }

  const drift = recentDrift(n);
  if (!n.revoked && drift.length) {
    const last = drift[0]!;
    out.push({
      level: 'info', kind: 'info', title: 'Local changes were repaired',
      text: `${drift.length === 1 ? 'Once' : `${drift.length} times`} in the last 24 hours. Latest ${rel(last.detectedAt)}: ${last.target}, ${plural(last.files.length, 'file')}. Make permanent changes in Git instead.`,
    });
  }

  if (n.credential) out.push({ level: 'neutral', kind: 'info', title: `${plural(n.credential.renewals, 'renewal')} since enrollment`, text: `Issued ${fmtFull(n.credential.notBefore)} UTC` });
  return out;
}

/* ------------------------------------------------------------------ Targets */

/** What a Target carries, in one cell of the Targets table. */
export function targetContent(t: NodeTarget): string {
  if (t.skills?.length || targetKind(t.name) === 'skills') return plural((t.skills || []).length, 'Skill');
  if (t.file) return t.file.bundleDigest ? t.file.name : `${t.file.name} (removal)`;
  if (t.aiClient) return t.aiClient.mode === 'cliproxy' ? `CLIProxy · ${t.aiClient.model || 'default model'}` : 'Native login';
  return '—';
}

/** The right-hand text of a Target row on Overview. */
export const rowTime = (t: NodeTarget): string =>
  t.state === 'succeeded' ? (t.latestAttempt ? 'applied ' + rel(t.latestAttempt.updatedAt) : 'in sync')
    : t.state === 'failed' ? `since ${rel(t.firstFailedAt)}`
      : t.state === 'applying' ? `started ${rel(t.latestAttempt?.updatedAt || t.assignedAt)}`
        : t.state === 'superseded' ? 'replaced' : 'not started';

export const targetIconOf = targetIcon;

/* ------------------------------------------------------------------ hero */

export interface HeroSub {
  /** The Agent's hostname, shown in the monospace face. */
  host: string | null;
  /** The rest of the line, as one piece of text (it starts with " · " after a host). */
  text: string;
}
/** Under the name: host, user, OS and architecture as the Agent reported them; the enrollment platform when it reported nothing. */
export function heroSub(n: NodeDetailView, osText: string | null): HeroSub {
  const a = n.agent;
  if (!a) return { host: null, text: `${platformLabel(n.platform)} machine · enrolled ${n.enrolledAt ? fmtDay(n.enrolledAt) : '—'}` };
  const rest = [a.user && `signed in as ${a.user}`, osText || `${platformLabel(n.platform)} machine`, a.arch].filter(Boolean).join(' · ');
  return { host: a.hostname, text: a.hostname ? ` · ${rest}` : rest };
}

/** The Agent card of the hero: its version, a warning when it is outdated, and how it was installed. */
export function agentFact(n: NodeDetailView): { version: string; warn: boolean; sub: string } | null {
  const a = n.agent;
  if (!a?.version) return null;
  const old = agentOutdated(n);
  const method = a.installMethod ? (INSTALL as Record<string, string>)[a.installMethod] || a.installMethod : 'install method not reported';
  return { version: a.version, warn: old, sub: `${method} · ${old ? `${a.latestVersion || 'a newer version'} available` : n.revoked ? 'revoked' : 'up to date'}` };
}

/* ------------------------------------------------------------------ Activity */

export type ActivityCategory = 'attempt' | 'drift' | 'change' | 'security';
export interface ActivityEvent extends TimelineEvent {
  cat: ActivityCategory;
}
export const ACTIVITY_FILTERS: ReadonlyArray<readonly [string, string]> = [['all', 'Everything'], ['attempt', 'Attempts'], ['drift', 'Local changes'], ['change', 'Changes'], ['security', 'Certificates']];

/** Attempts, audit events, drift repairs and the enrollment, merged and newest first. */
export function activityEvents(
  n: NodeDetailView,
  attempts: readonly NodeAttempt[],
  audit: readonly AuditEvent[],
  auditNext: string | null,
  catalog: Pick<ErrorCatalog, 'title'>,
): ActivityEvent[] {
  const ev: ActivityEvent[] = [];
  const byName = (name: string): NodeTarget | { name: string } => n.targets.find(t => t.name === name) || { name };
  for (const a of attempts) {
    const m = tstate(a.state);
    ev.push({
      at: a.updatedAt, level: m.level, kind: m.kind, cat: 'attempt', title: `${targetLabel(byName(a.targetName))} ${attemptVerb(a.state)}`,
      sub: [shortSha(a.sourceRevision), a.errorCode ? catalog.title(a.errorCode) : null, a.errorCode].filter(Boolean).join(' · '), text: a.diagnostic, step: a.step, key: a.attemptId,
    });
  }
  for (const e of audit) {
    const sec = /credential/.test(e.action);
    const bad = /revoked|removed/.test(e.action);
    ev.push({ at: e.recordedAt, level: bad ? 'neutral' : 'good', kind: bad ? 'minus' : 'check', cat: sec ? 'security' : 'change', title: auditLabel(e.action), sub: `by ${actorName(e)}` });
  }
  for (const d of n.drift || []) {
    ev.push({
      at: d.detectedAt, level: 'info', kind: 'info', cat: 'drift', title: `Repaired local changes in ${d.target}: ${plural(d.files.length, 'file')}`,
      sub: 'Files changed outside Fleet were restored from the verified cache', files: d.files, key: 'drift:' + d.target + d.detectedAt,
    });
  }
  if (n.enrolledAt && !auditNext && !audit.some(e => e.action === 'node_enrolled')) {
    ev.push({ at: n.enrolledAt, level: 'good', kind: 'check', cat: 'change', title: `Enrolled as ${n.alias}`, sub: `${platformLabel(n.platform)} machine` });
  }
  return ev.filter(e => valid(e.at)).sort((a, b) => (ms(b.at) ?? 0) - (ms(a.at) ?? 0));
}
