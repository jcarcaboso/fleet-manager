/**
 * The Machines gallery's pure logic (ported from view-gallery.js): ranking, sorting, searching and grouping.
 * Nothing here touches the DOM or the API; `MachinesView.vue` feeds it the view models and the health of each machine.
 */
import type { DesiredRevisionItem } from '@/api/types';
import { listText, ms, platformLabel, plural, shortSha } from '@/lib/format';
import type { IconName } from '@/lib/icons';
import { DISK_WARN, agentOutdated, commit, diskHot, diskOf, isAttention, osText, type Health, type NodeView } from '@/lib/model';

export type GroupKey = 'status' | 'platform' | 'os';
export type SortKey = 'attention' | 'disk' | 'name' | 'seen' | 'outdated';

export const GROUPS: ReadonlyArray<readonly [GroupKey, string]> = [['status', 'Status'], ['platform', 'Platform'], ['os', 'OS']];
export const SORTS: ReadonlyArray<readonly [SortKey, string]> = [
  ['attention', 'Attention first'], ['disk', 'Fullest disk first'], ['name', 'Name'], ['seen', 'Last seen'], ['outdated', 'Outdated Agents first'],
];

export type HealthOf = (n: NodeView) => Health;

export interface Section {
  key: string;
  title: string;
  icon?: IconName;
  sub: string;
  nodes: NodeView[];
}

/** A disk at 85% or more counts as needing attention: a critical disk ranks with failures, a warning one just below offline machines. */
export const attentionRank = (n: NodeView, healthOf: HealthOf): number => {
  const r = healthOf(n).rank;
  const d = diskOf(n);
  return !d || d.key === 'good' ? r : Math.min(r, d.key === 'critical' ? 0.5 : 1.5);
};
export const needsAttention = (n: NodeView, healthOf: HealthOf): boolean => isAttention(healthOf(n)) || diskHot(n);

const byName = (a: NodeView, b: NodeView): number => a.alias.localeCompare(b.alias);

export function comparator(sort: SortKey, healthOf: HealthOf): (a: NodeView, b: NodeView) => number {
  switch (sort) {
    case 'disk': return (a, b) => (b.disk?.usedPercent ?? -1) - (a.disk?.usedPercent ?? -1) || byName(a, b);
    case 'name': return byName;
    case 'seen': return (a, b) => (ms(b.lastContactAt) || 0) - (ms(a.lastContactAt) || 0) || byName(a, b);
    case 'outdated': return (a, b) => Number(agentOutdated(b)) - Number(agentOutdated(a)) || attentionRank(a, healthOf) - attentionRank(b, healthOf) || byName(a, b);
    default: return (a, b) => attentionRank(a, healthOf) - attentionRank(b, healthOf) || byName(a, b);
  }
}
export const sortByName = byName;

/** Everything a search can match, lower-cased: alias, platform, revision, status, and what the Agent reported. */
export function searchText(n: NodeView, healthOf: HealthOf): string {
  const a = n.agent;
  return [
    n.alias, n.platform, platformLabel(n.platform), n.currentRevision, healthOf(n).label,
    ...(a ? [a.hostname, osText(n), a.os.name, a.os.version, a.arch, a.version, a.version && `agent ${a.version}`, agentOutdated(n) && 'outdated update available'] : []),
  ].filter(Boolean).join(' ').toLowerCase();
}
/** Every word of the (trimmed, lower-cased) query must appear. */
export const matches = (n: NodeView, q: string, healthOf: HealthOf): boolean => !q || q.split(/\s+/).every(w => searchText(n, healthOf).includes(w));

export function sections(nodes: NodeView[], groupBy: GroupKey, sort: SortKey, healthOf: HealthOf, newest: DesiredRevisionItem | null): Section[] {
  if (groupBy === 'platform') {
    const known: Array<[string, string, IconName]> = [['macos', 'macOS', 'apple'], ['linux', 'Linux', 'tux']];
    const out: Section[] = known.map(([k, t, i]) => {
      const list = nodes.filter(n => n.platform === k);
      return { key: k, title: t, icon: i, sub: `${plural(list.length, 'machine')} running ${t}.`, nodes: list };
    });
    out.push({ key: 'other', title: 'Other', icon: 'server', sub: 'Platform not recognised by this dashboard.', nodes: nodes.filter(n => n.platform !== 'macos' && n.platform !== 'linux') });
    return out.filter(s => s.nodes.length);
  }
  if (groupBy === 'os') {
    /* The OS the Agent reported, by name. Machines whose Agent reported none (before 0.9.0) go last. */
    const by = new Map<string, NodeView[]>();
    const unknown: NodeView[] = [];
    for (const n of nodes) {
      const name = n.agent?.os.name;
      if (!name) unknown.push(n);
      else by.set(name, [...(by.get(name) || []), n]);
    }
    const out: Section[] = [...by].sort((a, b) => a[0].localeCompare(b[0])).map(([name, list]) => {
      const versions = [...new Set(list.map(n => n.agent?.os.version).filter((v): v is string => !!v))].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      const icon: IconName = /^mac/i.test(name) ? 'apple' : list[0]?.platform === 'linux' ? 'tux' : 'server';
      return { key: `os-${name}`, title: name, icon, sub: `${plural(list.length, 'machine')} running ${name}${versions.length ? ` ${listText(versions)}` : ''}.`, nodes: list };
    });
    if (unknown.length) out.push({ key: 'os-none', title: 'OS not reported', icon: 'server', sub: 'Agents before 0.9.0 do not send machine details.', nodes: unknown });
    return out;
  }
  /* "Outdated Agents first" lifts those machines into a section of their own, ahead of the health sections. */
  const lifted = sort === 'outdated' ? nodes.filter(agentOutdated) : [];
  const rest = nodes.filter(n => !lifted.includes(n));
  const subject = commit(newest?.commit)?.subject;
  return [
    { key: 'outdated', title: 'Agent update available', sub: 'These Agents are older than the Server. Upgrade them on the machine; Fleet never does it for you. Their health is still shown on each card.', nodes: lifted },
    { key: 'attention', title: 'Needs attention', sub: 'Fix these first. The most serious problems are at the top. A disk that is 85% full or more is listed here too.', nodes: rest.filter(n => needsAttention(n, healthOf)) },
    { key: 'updating', title: 'Updating', sub: 'Receiving new assignments right now. No action needed.', nodes: rest.filter(n => !needsAttention(n, healthOf) && healthOf(n).key === 'updating') },
    {
      key: 'ok', title: 'Up to date',
      sub: newest ? `Every assigned Target is in sync. Latest published revision: ${shortSha(newest.sourceRevision)}${subject ? `, “${subject}”` : ''}.` : 'Every assigned Target is in sync.',
      nodes: rest.filter(n => !needsAttention(n, healthOf) && healthOf(n).key === 'ok'),
    },
  ].filter(s => s.nodes.length);
}

export { DISK_WARN };
