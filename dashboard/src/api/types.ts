/**
 * Wire types of the Operator API under `/dashboard/api`, as documented in `docs/technical-design/operator-api.md`
 * and fixed by `contracts/operator/*.json`. JSON is camelCase, enums are snake_case, timestamps are ISO 8601 UTC
 * strings, absent values are `null` (never omitted), except where a property is marked optional because a Server
 * from before a phase does not send it (the dashboard must keep working against such a Server).
 */

/** ISO 8601 UTC timestamp, for example `2026-10-25T14:29:10Z`. */
export type IsoTime = string;
/** Node ID or enrollment link ID etc. (a UUID). */
export type Uuid = string;

/* ------------------------------------------------------------------ conventions */

/** Operator scope. `admin` includes `operate`, which includes `read`. */
export type Scope = 'read' | 'operate' | 'admin';

/** A list response. `nextCursor` is opaque and valid only with the `order` it came from. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Every error response body: the HTTP status carries the class, `code` is snake_case. Some codes add fields (see `pinned_model_excluded`). */
export interface ErrorBody {
  code: string;
  message: string;
  [extra: string]: unknown;
}

/** Query parameters accepted by `ApiClient.get`. `undefined`, `null` and `''` are left out of the URL. */
export type QueryParams = Record<string, string | number | boolean | null | undefined>;

/* ------------------------------------------------------------------ session */

export interface SessionInfo {
  actor: string;
  scope: Scope;
}
export interface CsrfResponse {
  token: string;
}
export interface LoginRequest {
  token: string;
}
export type LoginResponse = SessionInfo;
export interface LogoutResponse {
  signedOut: boolean;
}

/* ------------------------------------------------------------------ nodes */

export type Freshness = 'fresh' | 'stale' | 'never_contacted';
/** `macos` and `linux` today; a newer Agent may report another value, so the dashboard treats it as free text. */
export type Platform = 'macos' | 'linux' | (string & {});
export type AssignmentState = 'pending' | 'applying' | 'succeeded' | 'failed' | 'superseded';
/** Assignments or Targets per state. */
export type StateCounts = Record<AssignmentState, number>;
export type InstallMethod = 'homebrew' | 'cargo' | 'binary';
export type ServiceManager = 'systemd' | 'launchd' | 'none';
/** Step names an Agent reports for a failed Attempt. A newer Agent may send another one. */
export type AttemptStep = 'lock' | 'download' | 'verify' | 'stage' | 'activate' | 'recover' | 'receipt' | 'configure' | 'validate' | (string & {});

/** The fullest volume of a Node, in `GET nodes` items. `null` when the Node never reported. */
export interface NodeListDisk {
  label: string;
  usedPercent: number;
  usedBytes: number;
  availableBytes: number;
  totalBytes: number;
  measuredAt: IsoTime;
}
export interface DiskVolume {
  label: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedPercent: number;
}
/** `GET nodes/{node}` disk. `null` when the Node never reported and no refresh is pending. */
export interface NodeDisk {
  measuredAt: IsoTime | null;
  refreshRequestedAt: IsoTime | null;
  volumes: DiskVolume[];
}

export interface NodeListAgent {
  version: string | null;
  outdated: boolean;
  os: { name: string | null; version: string | null };
  arch: string | null;
  hostname: string | null;
}
export interface NodeAgent {
  version: string;
  latestVersion: string;
  outdated: boolean;
  os: { name: string | null; version: string | null; kernel: string | null };
  arch: string | null;
  hostname: string | null;
  user: string | null;
  installMethod: InstallMethod | null;
  serviceManager: ServiceManager | null;
  stateDirectory: string | null;
  reportedAt: IsoTime;
}

/** An item of `GET nodes`. `disk` and `agent` are absent on a Server before disk usage / phase 3. */
export interface NodeListItem {
  nodeId: Uuid;
  name: string;
  revoked: boolean;
  lastContactAt: IsoTime | null;
  freshness: Freshness;
  platform: Platform | null;
  enrolledAt: IsoTime | null;
  revokedAt: IsoTime | null;
  credentialNotAfter: IsoTime | null;
  targets: StateCounts;
  currentRevision: string | null;
  disk?: NodeListDisk | null;
  agent?: NodeListAgent | null;
}

export interface NodeCredential {
  credentialId: Uuid;
  notBefore: IsoTime;
  notAfter: IsoTime;
  revokedAt: IsoTime | null;
  revokedBy: string | null;
  renewals: number;
}
export interface TargetDesiredRevision {
  desiredRevisionId: Uuid;
  sourceRevision: string;
  acceptedAt: IsoTime;
}
export interface TargetLatestAttempt {
  attemptId: Uuid;
  state: AssignmentState;
  errorCode: string | null;
  /** Phase 2 attempt detail: `null` when the Agent sent none (Agents before 0.9.0, or a failure without detail). */
  diagnostic: string | null;
  path?: string | null;
  step?: AttemptStep | null;
  updatedAt: IsoTime;
}
export interface TargetSkill {
  name: string;
  bundleDigest: string;
}
export interface TargetFile {
  name: string;
  /** `null` for a removal. */
  bundleDigest: string | null;
}
export interface TargetAiClient {
  client: string;
  mode: 'cliproxy' | 'native' | (string & {});
  baseUrl: string | null;
  model: string | null;
}
export interface NodeTarget {
  /** `skills`, `agent-file/<client>` or `ai-client/<client>`. */
  name: string;
  kind: string;
  /** `home` or another base. */
  base: string;
  path: string;
  assignmentId: Uuid;
  state: AssignmentState;
  assignedAt: IsoTime;
  desiredRevision: TargetDesiredRevision | null;
  lastSucceededRevision: string | null;
  latestAttempt: TargetLatestAttempt | null;
  failedAttempts: number;
  firstFailedAt: IsoTime | null;
  skills: TargetSkill[];
  file: TargetFile | null;
  aiClient: TargetAiClient | null;
}
/** Files the Agent repaired in a Target it owns (phase 4). */
export interface DriftEvent {
  target: string;
  files: string[];
  detectedAt: IsoTime;
}
/** `GET nodes/{node}`. `disk`, `agent` and `drift` are absent on a Server before disk usage, phase 3 and phase 4. */
export interface NodeDetail {
  nodeId: Uuid;
  name: string;
  platform: Platform | null;
  enrolledAt: IsoTime | null;
  lastContactAt: IsoTime | null;
  freshness: Freshness;
  revoked: boolean;
  revokedAt: IsoTime | null;
  credential: NodeCredential | null;
  targets: NodeTarget[];
  summary: StateCounts;
  disk?: NodeDisk | null;
  agent?: NodeAgent | null;
  drift?: DriftEvent[];
}

/** An item of `GET nodes/{node}/attempts` (newest first). `path` and `step` are absent before phase 2. */
export interface NodeAttempt {
  attemptId: Uuid;
  assignmentId: Uuid;
  rolloutId: Uuid;
  targetName: string;
  sourceRevision: string;
  state: AssignmentState;
  errorCode: string | null;
  diagnostic: string | null;
  path?: string | null;
  step?: AttemptStep | null;
  updatedAt: IsoTime;
}
export interface CheckinBucket {
  /** Start of the UTC hour. */
  hour: IsoTime;
  polls: number;
}
export interface CheckinsResponse {
  hours: number;
  buckets: CheckinBucket[];
}

export interface RetryRequest {
  target: string;
}
export interface RetryResponse {
  assignmentId: Uuid;
  attemptId: Uuid;
  state: 'pending';
}
export interface RenameRequest {
  currentAlias: string;
  alias: string;
}
export interface RenameResponse {
  nodeId: Uuid;
  alias: string;
}
export interface RevokeNodeResponse {
  revoked: boolean;
}
export interface RemoveNodeRequest {
  /** The current alias, as confirmation. */
  alias: string;
}
export interface RemoveNodeResponse {
  removed: boolean;
}
export interface DiskRefreshResponse {
  refreshRequestedAt: IsoTime;
}

/* ------------------------------------------------------------------ issues and the error catalog */

export type IssueSeverity = 'error' | 'warning';
export type IssueStateKey = 'open' | 'acknowledged' | 'snoozed';
export interface Issue {
  /** Stable for the same underlying problem: `code`, plus Node ID and Target where they apply. */
  id: string;
  code: string;
  severity: IssueSeverity;
  title: string;
  detail: string;
  action: string;
  section: string;
  errorCode: string | null;
  nodeId: Uuid | null;
  nodeName: string | null;
  target: string | null;
  since: IsoTime | null;
  /** `fleet` command lines that inspect or fix the issue. May be empty. */
  commands: string[];
  /** Phase 2 detail from the latest failed Attempt; absent before phase 2. */
  diagnostic?: string | null;
  path?: string | null;
  step?: AttemptStep | null;
  /** Phase 4 issue state; absent before phase 4 (every issue is then open). */
  state?: IssueStateKey;
  stateBy?: string | null;
  stateAt?: IsoTime | null;
  snoozedUntil?: IsoTime | null;
}
/** `GET issues` is not paged and holds at most 200 items. */
export interface IssuesResponse {
  items: Issue[];
}
export type IssueAction = 'acknowledge' | 'snooze' | 'reopen';
export interface IssueStateRequest {
  id: string;
  action: IssueAction;
  /** 1 to 168; required for `snooze` and not allowed otherwise. */
  hours?: number;
}
/** `POST issues/state` answers with the updated issue. */
export type IssueStateResponse = Issue;

export type ErrorSource = 'agent' | 'server' | 'issue';
export interface ErrorCatalogEntry {
  code: string;
  source: ErrorSource;
  title: string;
  explanation: string;
  fix: string[];
}
export interface ErrorsResponse {
  items: ErrorCatalogEntry[];
}

/* ------------------------------------------------------------------ source, revisions, rollouts, audit */

export type ScanOutcome = 'accepted' | 'unchanged' | 'invalid' | 'failed';
export interface SourceStatus {
  sourceRevision: string | null;
  outcome: ScanOutcome;
  code: string | null;
  diagnostic: string | null;
  observedAt: IsoTime;
  requestedBy: string | null;
}
export interface SourceScan extends SourceStatus {
  scanId: Uuid;
}
export interface RescanResponse {
  outcome: ScanOutcome;
  sourceRevision: string | null;
  code?: string | null;
  diagnostic?: string | null;
}

export interface CommitInfo {
  subject: string;
  author: string;
  committedAt: IsoTime;
}
/** An item of `GET desired-revisions`. `commit` is `null` for a revision accepted before phase 4; absent on a Server before it. */
export interface DesiredRevisionItem {
  desiredRevisionId: Uuid;
  sourceRevision: string;
  acceptedAt: IsoTime;
  commit?: CommitInfo | null;
}
export interface RevisionSkillChanges {
  added: string[];
  changed: string[];
  removed: string[];
}
export interface RevisionTargetChanges {
  added: number;
  changed: number;
  removed: number;
  nodes: number;
}
/** `GET desired-revisions/{id}`: the revision, the previous one and what changed. */
export interface DesiredRevisionDetail {
  desiredRevisionId: Uuid;
  sourceRevision: string;
  acceptedAt: IsoTime;
  commit: CommitInfo | null;
  previous: { desiredRevisionId: Uuid; sourceRevision: string } | null;
  rolloutId: Uuid | null;
  skills: RevisionSkillChanges;
  targets: RevisionTargetChanges;
}

/** An item of `GET rollouts`: the assignments per state sit at the top level. */
export interface RolloutItem extends StateCounts {
  rolloutId: Uuid;
  desiredRevisionId: Uuid;
  createdAt: IsoTime;
}
export interface RolloutTargetState {
  name: string;
  state: AssignmentState;
  errorCode: string | null;
  updatedAt: IsoTime;
}
export interface RolloutNode {
  nodeId: Uuid;
  nodeName: string;
  /** The worst state of its Targets: failed, applying, pending, succeeded, superseded. */
  state: AssignmentState;
  firstAttemptAt: IsoTime | null;
  lastAttemptAt: IsoTime | null;
  targets: RolloutTargetState[];
}
/** `GET rollouts/{id}`: at most 500 Nodes, ordered by name. */
export interface RolloutDetail {
  rolloutId: Uuid;
  desiredRevisionId: Uuid;
  sourceRevision: string;
  createdAt: IsoTime;
  summary: StateCounts;
  nodes: RolloutNode[];
}
/** An item of `GET rollouts/{id}/attempts`. `path` and `step` are absent before phase 2. */
export interface RolloutAttempt {
  attemptId: Uuid;
  assignmentId: Uuid;
  state: AssignmentState;
  errorCode: string | null;
  diagnostic: string | null;
  path?: string | null;
  step?: AttemptStep | null;
  updatedAt: IsoTime;
}
/** An item of `GET warnings`. */
export interface RevisionWarning {
  desiredRevisionId: Uuid;
  code: string;
  message: string;
  sourceLocations: string[];
}

export interface AuditEvent {
  recordedAt: IsoTime;
  action: string;
  /** An Operator name, `enrollment`, or an Agent's Node ID. */
  actor: string;
  nodeId: Uuid | null;
  credentialId: Uuid | null;
  /** `null` if the Node was removed. */
  nodeName: string | null;
}

/* ------------------------------------------------------------------ enrollment */

export type EnrollmentLinkState = 'active' | 'consumed' | 'expired' | 'revoked';
/** Tokens and links are never returned by the list routes. */
export interface EnrollmentLink {
  id: Uuid;
  alias: string;
  expiresAt: IsoTime;
  consumedAt: IsoTime | null;
  revokedAt: IsoTime | null;
  revokedBy: string | null;
  nodeId: Uuid | null;
  state: EnrollmentLinkState;
}
export interface CreateEnrollmentLinkRequest {
  alias: string;
  /** 60 to 3600; defaults to 900. */
  expiresInSeconds?: number;
}
/** The only response that carries the one-time `link` (`SERVER_ORIGIN/enroll#fleet-v1=…`). */
export interface CreateEnrollmentLinkResponse {
  id: Uuid;
  expiresAt: IsoTime;
  link: string;
}
export interface RevokeLinkResponse {
  revoked: boolean;
}
export interface EnrollmentTokenResponse {
  token: string;
  expiresAt: IsoTime;
}

/* ------------------------------------------------------------------ CLIProxy */

export type CatalogOutcome = 'succeeded' | 'failed';
export interface CatalogStatus {
  baseUrl: string;
  modelCount: number;
  lastSuccess: IsoTime | null;
  nextRefresh: IsoTime | null;
  outcome: CatalogOutcome;
  errorCode: string | null;
}
export interface CliProxyStatus {
  /** Whether the Fleet key is configured. */
  enabled: boolean;
  intervalSeconds: number;
  errorCode: string | null;
  catalogs: CatalogStatus[];
}
export interface SelectionPolicy {
  includeNew: boolean;
  disabledFamilies: string[];
  enabledFamilies: string[];
  modelOverrides: Record<string, boolean>;
  skipClaudeModelsForOtherClients: boolean;
}
export interface SelectionModel {
  id: string;
  reasoningLevels: string[];
  familyKey: string;
  familyLabel: string;
  selected: boolean;
}
export interface CatalogSelection {
  baseUrl: string;
  models: SelectionModel[];
  policy: SelectionPolicy;
  /** Optimistic-concurrency version: send it back unchanged when saving. */
  version: number;
}
export interface CliProxySelectionResponse {
  catalogs: CatalogSelection[];
}
export interface SaveSelectionRequest {
  baseUrl: string;
  version: number;
  policy: SelectionPolicy;
}
export interface SaveSelectionResponse {
  catalog: CatalogSelection;
}
/** The 409 body of `pinned_model_excluded` lists the models a Node is assigned. */
export interface PinnedModelExcludedBody extends ErrorBody {
  code: 'pinned_model_excluded';
  models: string[];
}
