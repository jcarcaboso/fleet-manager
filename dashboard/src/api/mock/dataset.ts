/**
 * The mock fleet: a deterministic dataset of 13 machines, 5 revisions, rollouts, CLIProxy catalogs, links and audit events.
 * Ported from `artifacts/dashboard-prototypes/data.js` (the shapes follow the Server's entities; the mock server restricts
 * itself to the fields the contract defines). The dataset is anchored at a fixed "now"; `server.ts` shifts every time so that
 * relative times ("5 min ago") hold today. The pseudo-random generator is the prototype's, so IDs match the old dashboard's fixture.
 */
import type { AssignmentState, Platform, StateCounts } from '../types';

export const ANCHOR = '2026-10-25T14:30:00Z';

export interface DataTarget {
  name: string;
  kind: 'skills' | 'agent-file' | 'ai-client';
  base: 'home';
  path: string;
  state: AssignmentState;
  desiredRevision: string | null;
  appliedRevision: string | null;
  updatedAt: string;
  failure: null | { code: string; diagnostic: string; firstSeenAt: string; retries: number; path: string | null; excerpt: string[] };
  attempts: DataAttempt[];
  skills?: string[];
  file?: string;
  agentSource?: string;
  aiClient?: { client: string; mode: string; baseUrl: string | null; model: string | null; clientVersion: string };
}
export interface DataAttempt {
  id: string;
  revision: string;
  state: AssignmentState;
  errorCode: string | null;
  diagnostic: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  retries?: number;
}
export interface DataNode {
  id: string;
  alias: string;
  platform: Platform;
  arch: string;
  enrolledAt: string;
  lastContactAt: string | null;
  freshness: string;
  revokedAt: string | null;
  revokedBy: string | null;
  groups: string[];
  agentSource: string | null;
  os: string | null;
  hostname: string | null;
  user: string | null;
  agentVersion: string | null;
  installMethod: string | null;
  pollIntervalSeconds: number;
  stateDir: string | null;
  lastPollLatencyMs: number | null;
  note: string | null;
  credential: { id: string; certificateSha256: string; notBefore: string; notAfter: string; renewals: number; revokedAt: string | null };
  checkins: number[];
  targets: DataTarget[];
}
export interface DataRevision {
  id: string;
  sourceRevision: string;
  shortSha: string;
  message: string;
  author: string;
  acceptedAt: string;
  changes: { added: string[]; modified: string[]; removed: string[]; agentSources: string[]; nodes: string[] };
  warnings: Array<{ code: string; message: string; sourceLocations: string[] }>;
}
export interface DataScan {
  id: string;
  outcome: 'accepted' | 'unchanged' | 'invalid' | 'failed';
  sourceRevision: string | null;
  code: string | null;
  diagnostic: string | null;
  observedAt: string;
  requestedBy: string | null;
  durationMs: number;
  changedAssignments?: number;
}
export interface DataRollout {
  id: string;
  revisionId: string;
  shortSha: string;
  createdAt: string;
  nodeCount: number;
  assignments: StateCounts;
}
export interface DataCatalogModel {
  id: string;
  family: string;
  reasoning: string[];
  selected: boolean;
}
export interface DataCatalog {
  baseUrl: string;
  status: 'ok' | 'error';
  errorCode: string | null;
  lastSuccessAt: string;
  lastAttemptAt: string;
  nextRefreshAt: string;
  latencyMs: number;
  assignedNodes: string[];
  newFamiliesEnabled: boolean;
  restrictClaude: boolean;
  version: number;
  models: DataCatalogModel[];
}
export interface DataLink {
  id: string;
  alias: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  state: 'active' | 'consumed' | 'expired' | 'revoked';
  consumedAt?: string;
  revokedAt?: string;
  revokedBy?: string;
}
export interface DataAudit {
  recordedAt: string;
  action: string;
  actor: string;
  subject: string;
}
export interface DataCatalogEntry {
  title: string;
  explanation: string;
  causes: string[];
  fix: string[];
  retryable: boolean;
}
export interface Dataset {
  now: string;
  revisions: DataRevision[];
  nodes: DataNode[];
  rollouts: DataRollout[];
  source: { remote: string; branch: string; scans: DataScan[] };
  errorCatalog: Record<string, DataCatalogEntry>;
  cliproxy: { refreshIntervalHours: number; keyConfigured: boolean; catalogs: DataCatalog[] };
  enrollmentLinks: DataLink[];
  audit: DataAudit[];
}

interface NodeSpec {
  alias: string;
  os: string | null;
  platform: Platform;
  arch: string;
  hostname: string | null;
  user: string | null;
  agent: string | null;
  install: string | null;
  contact: number | null;
  enrolled: number;
  groups: string[];
  agentSource: string | null;
  clients: Record<string, { mode: string; baseUrl?: string; model?: string; version: string }>;
  states: Record<string, AssignmentState>;
  failures?: Record<string, { code: string; since: number; tries: number; diagnostic: string; path: string | null; excerpt: string[] }>;
  retry?: Record<string, { code: string; ago: number; diagnostic: string }>;
  staleNote?: string;
  certExpiresIn?: number;
  revoked?: { at: number; by: string };
}

export function buildDataset(): Dataset {
  const NOW = Date.parse(ANCHOR);
  const min = 60e3;
  const hour = 60 * min;
  const day = 24 * hour;
  const at = (offsetMs: number): string => new Date(NOW - offsetMs).toISOString();

  // Deterministic PRNG so every run renders the same fleet.
  let seed = 7;
  const rand = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const hex = (n: number): string => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rand() * 16)]).join('');
  const uuid = (): string => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;

  const staleAfterSeconds = 300;
  const certificateLifetimeDays = 7;
  const defaultPollSeconds = 60;

  const skillGroups: Record<string, string[]> = {
    core: ['code-review', 'commit-message', 'writing-docs'],
    backend: ['postgres-migrations', 'dotnet-testing', 'api-design'],
    infra: ['incident-runbook', 'homelab-ops', 'terraform-plan'],
    experimental: ['release-notes', 'browser-smoke', 'code-review'],
  };
  /* The prototype draws one digest per Skill here, which keeps the sequence of random numbers identical. */
  Object.values(skillGroups).flat().forEach(() => hex(64));

  const revisions: DataRevision[] = [
    { id: uuid(), sourceRevision: 'a3f9c21' + hex(33), message: 'Add postgres-migrations skill; tighten code-review checklist', author: 'joan', acceptedAt: at(18 * min),
      changes: { added: ['postgres-migrations'], modified: ['code-review'], removed: [], agentSources: [], nodes: [] }, shortSha: '', warnings: [] },
    { id: uuid(), sourceRevision: '9b14e07' + hex(33), message: 'Route studio and design nodes through CLIProxy for Claude Code', author: 'ana', acceptedAt: at(19 * hour + 50 * min),
      changes: { added: [], modified: [], removed: [], agentSources: [], nodes: ['studio-mini', 'design-imac', 'kitchen-mini'] }, shortSha: '', warnings: [] },
    { id: uuid(), sourceRevision: '51c0d8a' + hex(33), message: 'Add release-notes and browser-smoke to experimental group', author: 'joan', acceptedAt: at(2 * day + 5 * hour),
      changes: { added: ['release-notes', 'browser-smoke'], modified: [], removed: [], agentSources: [], nodes: [] }, shortSha: '', warnings: [] },
    { id: uuid(), sourceRevision: 'e2277fb' + hex(33), message: 'Split agent sources into personal and work', author: 'joan', acceptedAt: at(3 * day + 22 * hour),
      changes: { added: [], modified: [], removed: [], agentSources: ['personal', 'work'], nodes: [] }, shortSha: '', warnings: [] },
    { id: uuid(), sourceRevision: 'c08d4be' + hex(33), message: 'Enroll build runners; restrict them to core and backend', author: 'ci-bot', acceptedAt: at(6 * day + 3 * hour),
      changes: { added: [], modified: [], removed: ['jira-triage'], agentSources: [], nodes: ['build-runner-01', 'build-runner-02', 'build-runner-03'] }, shortSha: '', warnings: [] },
  ];
  revisions.forEach(r => { r.shortSha = r.sourceRevision.slice(0, 7); });
  const R = revisions;
  R[0]!.warnings = [{
    code: 'duplicate_skill',
    message: "Skill 'code-review' exists in groups core and experimental. Nodes that select both receive the core copy (earlier group wins).",
    sourceLocations: ['skills/core/code-review/', 'skills/experimental/code-review/'],
  }];

  const source = {
    remote: 'git@github.com:jcarcaboso/agent-skills.git',
    branch: 'main',
    scans: [
      { id: uuid(), outcome: 'unchanged', sourceRevision: R[0]!.sourceRevision, code: null, diagnostic: null, observedAt: at(5 * min), requestedBy: null, durationMs: 1840 },
      { id: uuid(), outcome: 'accepted', sourceRevision: R[0]!.sourceRevision, code: null, diagnostic: null, observedAt: at(18 * min), requestedBy: 'joan', durationMs: 4210, changedAssignments: 23 },
      { id: uuid(), outcome: 'invalid', sourceRevision: 'f71a0c3' + hex(33), code: 'manifest_invalid',
        diagnostic: "fleet.yml:41:9 nodes.build-runner-02.targets.skills.groups[1]: unknown Skill group 'infra-old'. Known groups: core, backend, infra, experimental.",
        observedAt: at(31 * min), requestedBy: 'joan', durationMs: 2930 },
      { id: uuid(), outcome: 'unchanged', sourceRevision: R[1]!.sourceRevision, code: null, diagnostic: null, observedAt: at(36 * min), requestedBy: null, durationMs: 1720 },
      { id: uuid(), outcome: 'failed', sourceRevision: null, code: 'git_fetch_failed',
        diagnostic: 'git fetch exited 128: ssh: connect to host github.com port 22: Connection timed out (after 30s).',
        observedAt: at(3 * hour + 41 * min), requestedBy: null, durationMs: 30_012 },
      { id: uuid(), outcome: 'accepted', sourceRevision: R[1]!.sourceRevision, code: null, diagnostic: null, observedAt: at(19 * hour + 50 * min), requestedBy: 'ana', durationMs: 3980, changedAssignments: 3 },
    ] satisfies DataScan[],
  };

  // ---- Error catalogue: what each Agent error code means and how to fix it
  const errorCatalog: Record<string, DataCatalogEntry> = {
    ownership_conflict: {
      title: 'Path is not owned by Fleet',
      explanation: 'The Target already contains a file or directory that is not recorded in the Fleet receipt. The Agent never overwrites content it does not own.',
      causes: ['A Skill was copied there by hand before enrollment', 'Another tool (dotfiles, stow) manages the same path'],
      fix: ['Move the existing path aside on the Node', 'Or remove the Skill from this Node in fleet.yml', 'The Agent retries on its next poll'],
      retryable: true,
    },
    ai_client_reconcile_failed: {
      title: 'AI client configuration could not be updated',
      explanation: 'The Agent could not safely edit the Fleet-owned fields of the client configuration file.',
      causes: ['The configuration file is not valid JSON/TOML', 'The model catalog for the proxy is unavailable'],
      fix: ['Fix the syntax error in the reported file', 'Resolve any CLIProxy issue first', 'AI-client setup retries after one minute'],
      retryable: true,
    },
    lock_failed: {
      title: 'Another Agent process holds the state lock',
      explanation: 'Two fleet-agent processes are running for the same state directory. Only one may reconcile at a time.',
      causes: ['A Homebrew service and a `fleet-agent service install` unit are both running', 'A foreground `fleet-agent run` was left open'],
      fix: ['Stop one of the services (`brew services list`, `systemctl --user status fleet-agent`)', 'Keep the Homebrew service and run `fleet-agent service uninstall`'],
      retryable: true,
    },
    unsupported_schema: {
      title: 'Agent is too old for this assignment',
      explanation: 'The assignment uses a schema or AI client that this Agent version does not understand.',
      causes: ['The Agent was not upgraded after a Server upgrade'],
      fix: ['Upgrade the Agent (`brew upgrade fleet-agent`)', 'Restart the service after upgrading'],
      retryable: false,
    },
    bundle_digest_mismatch: {
      title: 'Downloaded bundle failed verification',
      explanation: 'The bytes received did not hash to the digest the Server published. The download was discarded; nothing was activated.',
      causes: ['A proxy or captive portal altered the response', 'Transient network corruption'],
      fix: ['Usually resolves on retry', 'If it repeats, check for TLS-intercepting proxies on the Node network'],
      retryable: true,
    },
    owned_skill_drift: {
      title: 'Fleet-owned files were edited locally',
      explanation: 'Files Fleet installed were changed on the Node. The Agent repairs them from the verified cache.',
      causes: ['Someone edited a managed Skill in place'],
      fix: ['No action needed; drift is repaired automatically', 'Make permanent changes in Git instead'],
      retryable: true,
    },
  };

  // ---- Nodes
  const proxy = 'https://proxy.lab.internal/v1';
  const backupProxy = 'https://proxy-backup.lab.internal/v1';

  const specs: NodeSpec[] = [
    { alias: 'mbp-joan', os: 'macOS 15.1 Sequoia', platform: 'macos', arch: 'arm64', hostname: 'Joans-MacBook-Pro', user: 'joan', agent: '0.8.1', install: 'homebrew',
      contact: 22e3, enrolled: 41 * day, groups: [], agentSource: 'personal',
      clients: { codex: { mode: 'cliproxy', baseUrl: proxy, model: 'gpt-6-codex', version: '0.71.0' }, claude: { mode: 'cliproxy', baseUrl: proxy, model: 'claude-sonnet-4-1', version: '2.4.3' }, opencode: { mode: 'native', version: '1.3.2' } },
      states: { skills: 'applying' } },
    { alias: 'studio-mini', os: 'macOS 15.0 Sequoia', platform: 'macos', arch: 'arm64', hostname: 'studio-mini.lan', user: 'joan', agent: '0.8.1', install: 'homebrew',
      contact: 41e3, enrolled: 38 * day, groups: ['core', 'infra'], agentSource: 'work',
      clients: { claude: { mode: 'cliproxy', baseUrl: proxy, model: 'claude-opus-4-1', version: '2.4.3' }, codex: { mode: 'cliproxy', baseUrl: proxy, model: 'gpt-6-codex', version: '0.71.0' } },
      states: { 'ai-client/claude': 'failed' },
      failures: { 'ai-client/claude': { code: 'ai_client_reconcile_failed', since: 19 * hour + 48 * min, tries: 1188,
        diagnostic: '~/.claude/settings.json: expected value at line 14 column 3 (trailing comma). Fleet will not rewrite a file it cannot parse.',
        path: '~/.claude/settings.json', excerpt: ['12 |   "permissions": {', '13 |     "allow": ["Bash(git:*)"],', '14 |   },', '   |   ^ trailing comma', '15 | }'] } } },
    { alias: 'homelab-nuc', os: 'Fedora Linux 44', platform: 'linux', arch: 'amd64', hostname: 'nuc.lab.internal', user: 'ops', agent: '0.8.1', install: 'homebrew',
      contact: 9e3, enrolled: 52 * day, groups: ['core', 'infra'], agentSource: 'work',
      clients: { codex: { mode: 'cliproxy', baseUrl: proxy, model: 'gpt-6-codex', version: '0.71.0' }, opencode: { mode: 'cliproxy', baseUrl: proxy, model: 'gemini-2.5-pro', version: '1.3.2' } },
      states: {} },
    { alias: 'fedora-ws', os: 'Fedora Linux 44', platform: 'linux', arch: 'amd64', hostname: 'fedora-ws', user: 'joan', agent: '0.8.0', install: 'archive',
      contact: 34e3, enrolled: 47 * day, groups: [], agentSource: 'personal',
      clients: { claude: { mode: 'native', version: '2.4.1' }, codex: { mode: 'cliproxy', baseUrl: proxy, model: 'gpt-6-codex', version: '0.70.2' } },
      states: { skills: 'failed' },
      failures: { skills: { code: 'ownership_conflict', since: 16 * min, tries: 3,
        diagnostic: '~/.agents/skills/postgres-migrations already exists and is not recorded in the Fleet receipt. Refusing to replace unowned content.',
        path: '~/.agents/skills/postgres-migrations', excerpt: ['$ ls -la ~/.agents/skills/postgres-migrations', 'drwxr-xr-x  joan  staff  SKILL.md   (modified 2026-10-02)', 'drwxr-xr-x  joan  staff  examples/'] } } },
    { alias: 'build-runner-01', os: 'Ubuntu 24.04 LTS', platform: 'linux', arch: 'amd64', hostname: 'runner-01', user: 'ci', agent: '0.8.1', install: 'systemd',
      contact: 14e3, enrolled: 6 * day, groups: ['core', 'backend'], agentSource: null, clients: {}, states: {} },
    { alias: 'build-runner-02', os: 'Ubuntu 24.04 LTS', platform: 'linux', arch: 'amd64', hostname: 'runner-02', user: 'ci', agent: '0.8.1', install: 'systemd',
      contact: 48e3, enrolled: 6 * day, groups: ['core', 'backend'], agentSource: null, clients: {}, states: { skills: 'pending' } },
    { alias: 'build-runner-03', os: 'Ubuntu 24.04 LTS', platform: 'linux', arch: 'amd64', hostname: 'runner-03', user: 'ci', agent: '0.7.0', install: 'systemd',
      contact: 3 * hour + 12 * min, enrolled: 6 * day, groups: ['core', 'backend'], agentSource: null, clients: {}, states: { skills: 'pending' },
      staleNote: 'Last poll before host reboot at 11:18. The user service did not restart: lingering is not enabled for user ci.' },
    { alias: 'mba-travel', os: 'macOS 14.6 Sonoma', platform: 'macos', arch: 'amd64', hostname: 'Joans-MacBook-Air', user: 'joan', agent: '0.8.1', install: 'homebrew',
      contact: 2 * day + 4 * hour, enrolled: 33 * day, groups: ['core'], agentSource: 'personal',
      clients: { codex: { mode: 'cliproxy', baseUrl: proxy, model: 'gpt-6-codex', version: '0.69.0' } }, states: { skills: 'pending', 'agent-file/codex': 'pending' },
      certExpiresIn: 1 * day + 7 * hour, staleNote: 'Laptop has been asleep or offline since Thursday.' },
    { alias: 'design-imac', os: 'macOS 15.1 Sequoia', platform: 'macos', arch: 'arm64', hostname: 'design-imac', user: 'mika', agent: '0.8.1', install: 'homebrew',
      contact: 27e3, enrolled: 29 * day, groups: ['core'], agentSource: 'work',
      clients: { claude: { mode: 'cliproxy', baseUrl: proxy, model: 'claude-sonnet-4-1', version: '2.4.3' } },
      states: { 'agent-file/claude': 'failed', 'ai-client/claude': 'failed' },
      failures: {
        'agent-file/claude': { code: 'lock_failed', since: 2 * hour + 5 * min, tries: 124,
          diagnostic: 'State lock ~/.local/state/fleet-agent/agent.lock is held by pid 4127 (fleet-agent run, started 2026-10-25 12:24). Two Agent services are running.',
          path: '~/.local/state/fleet-agent/agent.lock', excerpt: ['$ pgrep -fl fleet-agent', '4127 /usr/local/bin/fleet-agent run', '4388 /opt/homebrew/opt/fleet-agent/bin/fleet-agent run'] },
        'ai-client/claude': { code: 'lock_failed', since: 2 * hour + 5 * min, tries: 124,
          diagnostic: 'State lock ~/.local/state/fleet-agent/agent.lock is held by pid 4127.', path: '~/.local/state/fleet-agent/agent.lock', excerpt: [] },
      } },
    { alias: 'gpu-box', os: 'Arch Linux (6.17)', platform: 'linux', arch: 'amd64', hostname: 'gpu-box', user: 'joan', agent: '0.8.1', install: 'archive',
      contact: 4e3, enrolled: 18 * day, groups: ['core', 'backend', 'experimental'], agentSource: 'personal',
      clients: { opencode: { mode: 'cliproxy', baseUrl: backupProxy, model: 'gemini-2.5-flash', version: '1.3.2' } },
      states: { skills: 'applying' },
      retry: { skills: { code: 'bundle_digest_mismatch', ago: 70e3,
        diagnostic: 'postgres-migrations: received sha256:7c1e9a…f402, expected sha256:4b90d3…11ac. Download discarded; retrying.' } } },
    { alias: 'kitchen-mini', os: 'macOS 13.7 Ventura', platform: 'macos', arch: 'amd64', hostname: 'kitchen-mini', user: 'family', agent: '0.6.6', install: 'homebrew',
      contact: 51e3, enrolled: 44 * day, groups: ['core'], agentSource: 'personal',
      clients: { claude: { mode: 'cliproxy', baseUrl: proxy, model: 'claude-sonnet-4-1', version: '2.3.0' } },
      states: { 'ai-client/claude': 'failed' },
      failures: { 'ai-client/claude': { code: 'unsupported_schema', since: 19 * hour + 46 * min, tries: 1,
        diagnostic: "Agent 0.6.6 does not support AI client 'claude' (fleet.ai-client/v1). Claude Code support requires Agent 0.7.0 or newer.",
        path: null, excerpt: [] } } },
    { alias: 'laptop-ana', os: 'macOS 15.1 Sequoia', platform: 'macos', arch: 'arm64', hostname: 'Anas-MacBook-Pro', user: 'ana', agent: '0.8.1', install: 'homebrew',
      contact: 17e3, enrolled: 21 * day, groups: ['core', 'backend'], agentSource: 'work',
      clients: { claude: { mode: 'cliproxy', baseUrl: proxy, model: 'claude-opus-4-1', version: '2.4.3' }, codex: { mode: 'native', version: '0.71.0' } },
      states: {} },
    { alias: 'lab-vm-07', os: null, platform: 'linux', arch: 'amd64', hostname: null, user: null, agent: null, install: null,
      contact: null, enrolled: 19 * min, groups: ['core'], agentSource: null, clients: {}, states: { skills: 'pending' },
      staleNote: 'Enrolled 19 minutes ago but has never polled. The Agent service was probably not started after `fleet-agent enroll`.' },
    { alias: 'old-laptop', os: 'macOS 14.2 Sonoma', platform: 'macos', arch: 'amd64', hostname: 'old-laptop', user: 'joan', agent: '0.5.2', install: 'homebrew',
      contact: 15 * day, enrolled: 90 * day, groups: [], agentSource: 'personal', clients: {}, states: {}, revoked: { at: 15 * day - 2 * hour, by: 'joan' } },
  ];

  const skillsFor = (groups: string[]): string[] => {
    const chosen = groups.length ? groups : Object.keys(skillGroups);
    const seen = new Set<string>();
    return chosen.flatMap(g => skillGroups[g]!).filter(name => !seen.has(name) && seen.add(name));
  };
  type Failure = NonNullable<NodeSpec['failures']>[string];
  // Revision whose rollout created a failing Target's current Assignment.
  const failureRevision = (failure: Failure): DataRevision => R[failure.since > 2 * hour ? 1 : 0]!;
  // A finished attempt that started `startMs` ago and ran for `durationMs`.
  const finished = (revision: DataRevision, state: AssignmentState, startMs: number, durationMs: number, extra?: Partial<DataAttempt>): DataAttempt => ({
    id: uuid(), revision: revision.shortSha, state, errorCode: null, diagnostic: null,
    startedAt: at(startMs), finishedAt: at(startMs - durationMs), durationMs, ...extra,
  });
  const attemptsFor = (spec: NodeSpec, target: string, state: AssignmentState, failure: Failure | null, contactMs: number | null): DataAttempt[] => {
    // Newest first: the current attempt, then history from earlier rollouts that reached the Node.
    // Nodes that never polled have no attempts; revoked Nodes have none after revocation.
    if (spec.contact == null || spec.revoked || contactMs == null) return [];
    const list: DataAttempt[] = [];
    const offline = contactMs > staleAfterSeconds * 1000;
    if (failure) {
      const duration = 380 + Math.floor(rand() * 900);
      list.push(finished(failureRevision(failure), 'failed', contactMs + duration, duration, { errorCode: failure.code, diagnostic: failure.diagnostic, retries: failure.tries }));
    } else if (state === 'applying') {
      list.push({ id: uuid(), revision: R[0]!.shortSha, state: 'applying', errorCode: null, diagnostic: null, startedAt: at(contactMs + 2e3), finishedAt: null, durationMs: null });
      const r = spec.retry?.[target];
      if (r) list.push(finished(R[0]!, 'failed', r.ago + 4100, 4100, { errorCode: r.code, diagnostic: r.diagnostic }));
    } else if (state === 'succeeded' && !offline) {
      list.push(finished(R[0]!, 'succeeded', 16 * min, 600 + Math.floor(rand() * 2400)));
    }
    // Revision 9b14e07 only targeted the Nodes it names.
    const failedOnR1 = failure && failureRevision(failure) === R[1];
    if (R[1]!.changes.nodes.includes(spec.alias) && !failedOnR1 && contactMs < 19 * hour) {
      list.push(finished(R[1]!, state === 'succeeded' && offline ? 'succeeded' : 'superseded', 19 * hour + 47 * min, 900 + Math.floor(rand() * 1500)));
    }
    if (contactMs < 2 * day + 4 * hour + 57 * min && spec.enrolled > 2 * day + 5 * hour) {
      list.push(finished(R[2]!, 'succeeded', 2 * day + 4 * hour + 58 * min, 700 + Math.floor(rand() * 2000)));
    }
    return list;
  };

  const nodes: DataNode[] = specs.map(spec => {
    const id = uuid();
    const lastContactAt = spec.contact == null ? null : at(spec.contact);
    const freshness = spec.revoked ? 'revoked' : spec.contact == null ? 'never_contacted' : spec.contact > staleAfterSeconds * 1000 ? 'stale' : 'fresh';
    const targets: DataTarget[] = [];
    const offline = spec.contact != null && spec.contact > staleAfterSeconds * 1000;
    const add = (name: string, kind: DataTarget['kind'], base: 'home', path: string, extra: Partial<DataTarget>): void => {
      const state: AssignmentState = spec.revoked ? 'superseded' : spec.states[name] ?? 'succeeded';
      const failure = spec.failures?.[name] ?? null;
      // desiredRevision: the revision whose rollout created this Target's current Assignment.
      // appliedRevision: the revision last completed on the Node (null if none ever was).
      let desired: DataRevision | null = R[0]!;
      let applied: DataRevision | null = R[0]!;
      if (spec.revoked) { desired = null; applied = null; }
      else if (spec.contact == null) applied = null;
      else if (failure) { desired = failureRevision(failure); applied = R[2]!; }
      else if (state === 'succeeded' && offline) { desired = R[2]!; applied = R[2]!; }
      else if (state !== 'succeeded') applied = R[2]!;
      targets.push({
        name, kind, base, path, state,
        desiredRevision: desired?.shortSha ?? null,
        appliedRevision: applied?.shortSha ?? null,
        updatedAt: spec.revoked ? at(spec.revoked.at) : failure ? at(spec.contact!) : state === 'succeeded' && !offline ? at(16 * min) : at(spec.contact ?? spec.enrolled),
        failure: failure && { code: failure.code, diagnostic: failure.diagnostic, firstSeenAt: at(failure.since), retries: failure.tries, path: failure.path, excerpt: failure.excerpt },
        attempts: attemptsFor(spec, name, state, failure, spec.contact),
        ...extra,
      });
    };
    add('skills', 'skills', 'home', '.agents/skills', { skills: skillsFor(spec.groups) });
    if (spec.agentSource) {
      for (const client of Object.keys(spec.clients)) {
        const file = client === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
        const dir = ({ codex: '.codex', opencode: '.config/opencode', claude: '.claude' } as Record<string, string>)[client]!;
        add(`agent-file/${client}`, 'agent-file', 'home', dir, { file, agentSource: spec.agentSource });
      }
    }
    for (const [client, cfg] of Object.entries(spec.clients)) {
      const dir = ({ codex: '.codex', opencode: '.config/opencode', claude: '.claude' } as Record<string, string>)[client]!;
      add(`ai-client/${client}`, 'ai-client', 'home', dir, { aiClient: { client, mode: cfg.mode, baseUrl: cfg.baseUrl ?? null, model: cfg.model ?? null, clientVersion: cfg.version } });
    }

    // Check-in history (prototype only; the mock server derives its own hourly buckets): 48 half-hour buckets for the last 24h.
    const checkins = Array.from({ length: 48 }, (_, i) => {
      const bucketEnd = NOW - (47 - i) * 30 * min;
      if (spec.revoked || spec.contact == null) return 0;
      if (bucketEnd - 30 * min > NOW - spec.contact) return 0;
      if (spec.alias === 'build-runner-03' && bucketEnd === NOW - 13 * hour) return 12;
      if (spec.platform === 'macos' && spec.user !== 'family' && ['mbp-joan', 'laptop-ana'].includes(spec.alias)) {
        const h = new Date(bucketEnd).getUTCHours();
        if (h >= 22 || h < 6) return 0;
      }
      return 28 + Math.floor(rand() * 4);
    });

    // Certificates are issued at enrollment and renewed by polling Agents; a revoked Node stopped renewing.
    const certIssued = spec.revoked ? NOW - spec.revoked.at - 3 * day
      : spec.certExpiresIn != null ? NOW - (certificateLifetimeDays * day - spec.certExpiresIn)
        : Math.max(NOW - spec.enrolled, NOW - Math.floor(rand() * 4 * day) - hour);
    const lastPollLatencyMs = spec.contact == null ? null : 40 + Math.floor(rand() * 180);
    return {
      id, alias: spec.alias, platform: spec.platform, arch: spec.arch,
      enrolledAt: at(spec.enrolled), lastContactAt, freshness,
      revokedAt: spec.revoked ? at(spec.revoked.at) : null, revokedBy: spec.revoked?.by ?? null,
      groups: spec.groups, agentSource: spec.agentSource,
      os: spec.os, hostname: spec.hostname, user: spec.user, agentVersion: spec.agent, installMethod: spec.install,
      pollIntervalSeconds: defaultPollSeconds, stateDir: spec.user ? (spec.platform === 'macos' ? `/Users/${spec.user}` : `/home/${spec.user}`) + '/.local/state/fleet-agent' : null,
      lastPollLatencyMs,
      note: spec.staleNote ?? null,
      credential: {
        id: uuid(), certificateSha256: hex(64),
        notBefore: new Date(certIssued).toISOString(),
        notAfter: new Date(certIssued + certificateLifetimeDays * day).toISOString(),
        renewals: Math.max(0, Math.floor((NOW - (NOW - spec.enrolled)) / (5 * day))),
        revokedAt: spec.revoked ? at(spec.revoked.at) : null,
      },
      checkins,
      targets,
    };
  });

  // ---- Rollouts
  const countStates = (list: string[]): StateCounts => list.reduce((acc, s) => { acc[s as AssignmentState] = (acc[s as AssignmentState] ?? 0) + 1; return acc; },
    { pending: 0, applying: 0, succeeded: 0, failed: 0, superseded: 0 } as StateCounts);
  const live = nodes.filter(n => !n.revokedAt);
  const rollouts: DataRollout[] = [
    { id: uuid(), revisionId: R[0]!.id, shortSha: R[0]!.shortSha, createdAt: R[0]!.acceptedAt, nodeCount: live.length,
      assignments: countStates(live.flatMap(n => n.targets.map(t => t.state))) },
    { id: uuid(), revisionId: R[1]!.id, shortSha: R[1]!.shortSha, createdAt: R[1]!.acceptedAt, nodeCount: 3, assignments: { pending: 0, applying: 0, succeeded: 0, failed: 4, superseded: 7 } },
    { id: uuid(), revisionId: R[2]!.id, shortSha: R[2]!.shortSha, createdAt: R[2]!.acceptedAt, nodeCount: 12, assignments: { pending: 0, applying: 0, succeeded: 2, failed: 0, superseded: 9 } },
    { id: uuid(), revisionId: R[3]!.id, shortSha: R[3]!.shortSha, createdAt: R[3]!.acceptedAt, nodeCount: 12, assignments: { pending: 0, applying: 0, succeeded: 3, failed: 0, superseded: 15 } },
    { id: uuid(), revisionId: R[4]!.id, shortSha: R[4]!.shortSha, createdAt: R[4]!.acceptedAt, nodeCount: 3, assignments: { pending: 0, applying: 0, succeeded: 0, failed: 0, superseded: 3 } },
  ];

  // ---- CLIProxy
  const model = (id: string, family: string, reasoning: string[], selected: boolean): DataCatalogModel => ({ id, family, reasoning, selected });
  const cliproxy = {
    refreshIntervalHours: 1,
    keyConfigured: true,
    catalogs: [
      { baseUrl: proxy, status: 'ok', errorCode: null, lastSuccessAt: at(20 * min), lastAttemptAt: at(20 * min), nextRefreshAt: new Date(NOW + 40 * min).toISOString(),
        latencyMs: 212, assignedNodes: ['mbp-joan', 'studio-mini', 'homelab-nuc', 'fedora-ws', 'mba-travel', 'design-imac', 'kitchen-mini', 'laptop-ana'],
        newFamiliesEnabled: true, restrictClaude: true, version: 14,
        models: [
          model('claude-opus-4-1', 'Claude', ['low', 'medium', 'high'], true),
          model('claude-opus-4-1-20250805', 'Claude', ['low', 'medium', 'high'], true),
          model('claude-sonnet-4-1', 'Claude', ['low', 'medium', 'high'], true),
          model('claude-sonnet-4-20250514', 'Claude', ['low', 'medium', 'high'], false),
          model('gemini-2.5-pro', 'Gemini', ['low', 'medium', 'high'], true),
          model('gemini-2.5-flash', 'Gemini', ['low', 'medium', 'high'], true),
          model('gpt-6-codex', 'GPT 6', ['low', 'medium', 'high', 'xhigh'], true),
          model('gpt-6-chat-latest', 'GPT 6', ['low', 'medium', 'high'], false),
        ] },
      { baseUrl: backupProxy, status: 'error', errorCode: 'upstream_http_401', lastSuccessAt: at(3 * day + 2 * hour), lastAttemptAt: at(20 * min), nextRefreshAt: new Date(NOW + 40 * min).toISOString(),
        latencyMs: 88, assignedNodes: ['gpu-box'], newFamiliesEnabled: true, restrictClaude: false, version: 3,
        models: [
          model('gemini-2.5-pro', 'Gemini', ['low', 'medium', 'high'], true),
          model('gemini-2.5-flash', 'Gemini', ['low', 'medium', 'high'], true),
          model('gpt-6-codex', 'GPT 6', ['low', 'medium', 'high', 'xhigh'], true),
          model('claude-sonnet-4-1', 'Claude', ['low', 'medium', 'high'], true),
          model('claude-opus-4-1', 'Claude', ['low', 'medium', 'high'], false),
          model('gpt-6-chat-latest', 'GPT 6', ['low', 'medium', 'high'], false),
        ] },
    ] satisfies DataCatalog[],
  };

  // ---- Enrollment links
  const enrollmentLinks: DataLink[] = [
    { id: uuid(), alias: 'lab-vm-08', createdBy: 'joan', createdAt: at(6 * min), expiresAt: new Date(NOW + 9 * min).toISOString(), state: 'active' },
    { id: uuid(), alias: 'lab-vm-07', createdBy: 'joan', createdAt: at(24 * min), expiresAt: at(9 * min), state: 'consumed', consumedAt: at(19 * min) },
    { id: uuid(), alias: 'tablet-test', createdBy: 'ana', createdAt: at(26 * hour), expiresAt: at(25 * hour + 45 * min), state: 'expired' },
    { id: uuid(), alias: 'guest-mbp', createdBy: 'joan', createdAt: at(3 * day), expiresAt: at(3 * day - 15 * min), state: 'revoked', revokedAt: at(3 * day - 4 * min), revokedBy: 'joan' },
  ];

  // ---- Audit
  const audit: DataAudit[] = [
    { recordedAt: at(6 * min), action: 'enrollment_authorization_created', actor: 'joan', subject: 'lab-vm-08' },
    { recordedAt: at(18 * min), action: 'source_rescan_requested', actor: 'joan', subject: R[0]!.shortSha },
    { recordedAt: at(19 * min), action: 'node_enrolled', actor: 'enrollment', subject: 'lab-vm-07' },
    { recordedAt: at(24 * min), action: 'enrollment_authorization_created', actor: 'joan', subject: 'lab-vm-07' },
    { recordedAt: at(31 * min), action: 'source_rescan_requested', actor: 'joan', subject: 'f71a0c3' },
    { recordedAt: at(2 * hour + 40 * min), action: 'node_credential_renewed', actor: 'agent', subject: 'homelab-nuc' },
    { recordedAt: at(5 * hour), action: 'cliproxy_selection_saved', actor: 'ana', subject: proxy },
    { recordedAt: at(9 * hour), action: 'node_credential_renewed', actor: 'agent', subject: 'gpu-box' },
    { recordedAt: at(19 * hour + 50 * min), action: 'source_rescan_requested', actor: 'ana', subject: R[1]!.shortSha },
    { recordedAt: at(26 * hour), action: 'enrollment_authorization_created', actor: 'ana', subject: 'tablet-test' },
    { recordedAt: at(2 * day + 1 * hour), action: 'node_alias_changed', actor: 'joan', subject: 'studio → studio-mini' },
    { recordedAt: at(3 * day - 4 * min), action: 'enrollment_authorization_revoked', actor: 'joan', subject: 'guest-mbp' },
    { recordedAt: at(15 * day - 2 * hour), action: 'node_revoked', actor: 'joan', subject: 'old-laptop' },
  ];

  return { now: new Date(NOW).toISOString(), revisions, nodes, rollouts, source, errorCatalog, cliproxy, enrollmentLinks, audit };
}
