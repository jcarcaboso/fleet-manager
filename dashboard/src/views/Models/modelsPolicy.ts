import type { CatalogSelection, SelectionModel, SelectionPolicy } from '@/api/types';
import { plural } from '@/lib/format';

/** Policy logic of the Models page: the same rules as the Server's selection (ported from view-models.js). */

export interface SelectionEntry extends Omit<CatalogSelection, 'policy'> {
  /** The policy being edited. */
  policy: SelectionPolicy;
  /** The saved policy as JSON, to tell what changed and to reset. */
  saved: string;
}

export interface ModelFamily {
  key: string;
  label: string;
  models: SelectionModel[];
}

export const familyKey = (m: Pick<SelectionModel, 'familyKey'>): string => m.familyKey || 'other';
export const familyBase = (policy: SelectionPolicy, key: string): boolean =>
  policy.disabledFamilies.includes(key) ? false : policy.enabledFamilies.includes(key) ? true : policy.includeNew;
export const effective = (policy: SelectionPolicy, model: Pick<SelectionModel, 'id' | 'familyKey'>): boolean =>
  typeof policy.modelOverrides[model.id] === 'boolean' ? policy.modelOverrides[model.id]! : familyBase(policy, familyKey(model));

export const snapshot = (p: SelectionPolicy): string => JSON.stringify({
  includeNew: p.includeNew,
  skip: p.skipClaudeModelsForOtherClients,
  en: [...p.enabledFamilies].sort(),
  dis: [...p.disabledFamilies].sort(),
  ov: Object.fromEntries(Object.entries(p.modelOverrides).sort(([a], [b]) => a.localeCompare(b))),
});

export const normPolicy = (p: Partial<SelectionPolicy>): SelectionPolicy => ({
  includeNew: !!p.includeNew,
  skipClaudeModelsForOtherClients: p.skipClaudeModelsForOtherClients ?? true,
  enabledFamilies: [...(p.enabledFamilies || [])],
  disabledFamilies: [...(p.disabledFamilies || [])],
  modelOverrides: { ...(p.modelOverrides || {}) },
});

export const makeEntry = (e: CatalogSelection): SelectionEntry => {
  const policy = normPolicy(e.policy || {});
  return { ...e, policy, saved: JSON.stringify(policy) };
};

export const isDirty = (e: SelectionEntry): boolean => snapshot(e.policy) !== snapshot(JSON.parse(e.saved) as SelectionPolicy);

export function families(e: Pick<SelectionEntry, 'models'>): ModelFamily[] {
  const groups = new Map<string, ModelFamily>();
  for (const m of e.models) {
    const k = familyKey(m);
    if (!groups.has(k)) groups.set(k, { key: k, label: m.familyLabel || 'Other models', models: [] });
    groups.get(k)!.models.push(m);
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Families that are in neither list are frozen to the current default before it changes, so what is shown stays what is shown. */
export function preserveVisible(e: SelectionEntry): void {
  const en = new Set(e.policy.enabledFamilies);
  const dis = new Set(e.policy.disabledFamilies);
  for (const f of families(e)) if (!en.has(f.key) && !dis.has(f.key)) (familyBase(e.policy, f.key) ? en : dis).add(f.key);
  e.policy.enabledFamilies = [...en];
  e.policy.disabledFamilies = [...dis];
}

/** How many settings differ from the saved policy: the two switches plus every model whose effective state changed. */
export function changedCount(e: SelectionEntry): number {
  const old = JSON.parse(e.saved) as SelectionPolicy;
  let d = Number(old.includeNew !== e.policy.includeNew) + Number(old.skipClaudeModelsForOtherClients !== e.policy.skipClaudeModelsForOtherClients);
  for (const m of e.models) if (effective(old, m) !== effective(e.policy, m)) d++;
  return d;
}

export const unsavedText = (e: SelectionEntry, host: string): string => `${plural(Math.max(1, changedCount(e)), 'unsaved change')} for ${host}`;

/** "6 hours", "1 day", "90 seconds": the refresh interval in the largest exact unit. */
export const interval = (s: number): string =>
  s % 86400 === 0 ? plural(s / 86400, 'day') : s % 3600 === 0 ? plural(s / 3600, 'hour') : s % 60 === 0 ? plural(s / 60, 'minute') : plural(s, 'second');
