import type { ModelClient, ModelRoutingGroup, SelectionPolicy } from './types';

export const modelClients = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', antigravity: 'Antigravity' } satisfies Record<ModelClient, string>;
export const allModelClients = Object.keys(modelClients) as ModelClient[];
export const routingGroups = { claude: 'Claude models', gpt: 'GPT models', gemini: 'Gemini models', other: 'Other models' } satisfies Record<ModelRoutingGroup, string>;
export const allRoutingGroups = Object.keys(routingGroups) as ModelRoutingGroup[];
const defaults: Record<ModelRoutingGroup, ModelClient[]> = { claude: ['claude'], gpt: ['codex', 'opencode'], gemini: ['antigravity'], other: ['opencode'] };

export const routingGroup = (id: string): ModelRoutingGroup =>
  /^claude-/i.test(id) ? 'claude' : /^gpt-/i.test(id) ? 'gpt' : /^gemini-/i.test(id) ? 'gemini' : 'other';

export const routedClients = (policy: SelectionPolicy, group: ModelRoutingGroup): readonly ModelClient[] =>
  policy.clientRouting?.[group] ?? (group === 'claude' && policy.skipClaudeModelsForOtherClients === false ? allModelClients : defaults[group]);
