import { sum } from './format';
import type { AssignmentState, AttemptStep, NodeTarget, StateCounts, TargetFile } from '@/api/types';
import type { GlyphKind, GlyphLevel, StatusMeta } from './status';

const cap = (s: unknown): string => String(s ?? '').replace(/^./, c => c.toUpperCase());

/* ------------------------------------------------------------------ Targets */

const CLIENT: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };
const CLIENT_SHORT: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };
export const clientName = (c: string | null | undefined): string => CLIENT[c ?? ''] || cap(c) || 'AI client';
export const clientShort = (c: string | null | undefined): string => CLIENT_SHORT[c ?? ''] || cap(c) || 'AI client';

/** What the helpers need of a Target: a full `NodeTarget`, or a name alone. */
export interface TargetLike {
  name: string;
  file?: TargetFile | null;
  aiClient?: { client: string } | null;
  base?: string;
  path?: string | null;
}

export const targetKind = (name: string): string => (String(name).includes('/') ? String(name).split('/')[0]! : 'skills');
export const targetClient = (t: TargetLike): string | null => {
  if (t.aiClient?.client) return t.aiClient.client;
  const part = String(t.name).includes('/') ? String(t.name).split('/')[1] : null;
  return part && !part.includes('.') ? part : null;
};
export const targetLabel = (t: TargetLike): string => {
  const kind = targetKind(t.name);
  const client = targetClient(t);
  if (kind === 'skills') return 'Skills';
  if (kind === 'agent-file') return t.file?.name ? (client ? `${t.file.name} for ${clientName(client)}` : t.file.name) : `${client ? clientName(client) : 'AI client'} agent file`;
  if (kind === 'ai-client') return `${clientName(client)} connection`;
  return String(t.name);
};
export const targetShort = (t: TargetLike): string => {
  const kind = targetKind(t.name);
  const client = targetClient(t);
  if (kind === 'skills') return 'Skills';
  if (kind === 'agent-file') return t.file?.name || `${client ? clientShort(client) : 'Agent'} file`;
  if (kind === 'ai-client') return clientShort(client);
  return String(t.name);
};
export const targetIcon = (t: TargetLike): 'layers' | 'file' | 'spark' =>
  (({ skills: 'layers', 'agent-file': 'file', 'ai-client': 'spark' }) as const)[targetKind(t.name) as 'skills'] ?? 'file';
/** "~/.claude" for a `home` Target, `base:path` for another base, "" when the path is unknown. */
export const targetWhere = (t: Pick<NodeTarget, 'base' | 'path'> | TargetLike): string => {
  if (t.path === undefined || t.path === null) return '';
  return !t.base || t.base === 'home' ? `~/${t.path}` : `${t.base}:${t.path}`;
};

/* ------------------------------------------------------------------ Attempt detail (phase 2) */

const STEP: Record<string, string> = {
  lock: 'Taking the lock',
  download: 'Downloading',
  verify: 'Verifying',
  stage: 'Staging',
  activate: 'Activating',
  recover: 'Recovering',
  receipt: 'Writing the receipt',
  configure: 'Configuring',
  validate: 'Validating',
};
/** An unknown step (from a newer Agent) is shown as written, with underscores turned into spaces. */
export const stepLabel = (s: AttemptStep | string): string => (Object.hasOwn(STEP, s) ? STEP[s] : '') || cap(String(s).replace(/_/g, ' '));
/** The failing path is relative to the Target base. With the Target at hand it reads like the Target path (~/.claude/settings.json). */
export const failPath = (t: { base?: string; path?: string | null } | null | undefined, rel: string | null | undefined): string => {
  if (rel === undefined || rel === null || rel === '') return '';
  if (!t || t.path === undefined || t.path === null) return String(rel);
  return !t.base || t.base === 'home' ? `~/${rel}` : `${t.base}:${rel}`;
};
/** What `FailureDetail` says when an Attempt carries no phase 2 detail. */
export const NO_DETAIL = 'No detail reported. Agents before 0.9.0 send only the error code.';
export const hasDetail = (a: { diagnostic?: string | null; path?: string | null; step?: string | null } | null | undefined): boolean =>
  !!(a && (a.diagnostic || a.path || a.step));

/* ------------------------------------------------------------------ Assignment states */

const TSTATE: Record<AssignmentState, StatusMeta> = {
  succeeded: { level: 'good', kind: 'check', label: 'In sync' },
  applying: { level: 'info', kind: 'sync', label: 'Applying' },
  pending: { level: 'pending', kind: 'clock', label: 'Waiting' },
  failed: { level: 'critical', kind: 'x', label: 'Failed' },
  superseded: { level: 'neutral', kind: 'minus', label: 'Superseded' },
};
/** An Assignment state from the API (snake_case) mapped to display. Unknown states read as neutral. */
export const tstate = (s: string | null | undefined): StatusMeta =>
  (s && Object.hasOwn(TSTATE, s) ? TSTATE[s as AssignmentState] : undefined) ?? {
    level: 'neutral' as GlyphLevel,
    kind: 'minus' as GlyphKind,
    label: s ? cap(String(s).replace(/_/g, ' ')) : 'Unknown',
  };
/** Attempt states use the same set, but read as events: "studio-mini … failed". */
export const attemptVerb = (s: string): string =>
  (({ failed: 'failed', applying: 'is applying', succeeded: 'applied', superseded: 'was superseded by a newer revision', pending: 'is queued' }) as Record<string, string>)[s] || String(s);

export interface StateDef extends StatusMeta {
  key: AssignmentState;
}
export const STATES: readonly StateDef[] = [
  { key: 'succeeded', label: 'Succeeded', level: 'good', kind: 'check' },
  { key: 'applying', label: 'Applying', level: 'info', kind: 'sync' },
  { key: 'pending', label: 'Pending', level: 'pending', kind: 'clock' },
  { key: 'failed', label: 'Failed', level: 'critical', kind: 'x' },
  { key: 'superseded', label: 'Superseded', level: 'neutral', kind: 'minus' },
];
export const emptyCounts = (): StateCounts => ({ pending: 0, applying: 0, succeeded: 0, failed: 0, superseded: 0 });
/** Adds `b` into `a` (and returns `a`). */
export const addCounts = (a: StateCounts, b: Partial<StateCounts> | null | undefined): StateCounts => {
  for (const k of Object.keys(a) as AssignmentState[]) a[k] += Number(b?.[k]) || 0;
  return a;
};
export const countTotal = (c: Partial<StateCounts> | null | undefined): number => sum(Object.values(c ?? {}).map(Number));

/** A part of a segmented bar or its legend. */
export interface StatePart extends StateDef {
  value: number;
  unit: string;
}
export const stateParts = (counts: Partial<StateCounts> | null | undefined, unit?: string): StatePart[] =>
  STATES.map(s => {
    const value = Number(counts?.[s.key]) || 0;
    return { ...s, value, unit: unit || (value === 1 ? 'assignment' : 'assignments') };
  });
