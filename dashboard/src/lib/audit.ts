import { isUuid } from './format';
import type { AuditEvent } from '@/api/types';
import type { IconName } from './icons';

/** Labels and icons of audit actions (ported from view-audit.js; the Node Activity tab uses them too). */
const ACTION: Record<string, readonly [IconName, string]> = {
  enrollment_authorization_created: ['link', 'Created an enrollment link'],
  enrollment_authorization_revoked: ['ban', 'Revoked an enrollment link'],
  source_rescan_requested: ['sync', 'Requested a repository sync'],
  node_enrolled: ['check', 'Machine enrolled'],
  node_credential_renewed: ['key', 'Certificate renewed'],
  node_credential_revoked: ['ban', 'Revoked a credential'],
  cliproxy_selection_saved: ['spark', 'Saved a model selection'],
  cliproxy_refresh_requested: ['spark', 'Refreshed model catalogs'],
  node_alias_changed: ['pencil', 'Renamed a machine'],
  node_revoked: ['ban', 'Revoked a machine'],
  node_removed: ['trash', 'Removed a machine'],
  'assignment.retry_requested': ['retry', 'Requested a retry'],
  'issue.acknowledged': ['ack', 'Acknowledged a problem'],
  'issue.snoozed': ['snooze', 'Snoozed a problem'],
  'issue.reopened': ['retry', 'Reopened a problem'],
};
export const auditLabel = (action: string): string => ACTION[action]?.[1] || String(action).replace(/[._]/g, ' ').replace(/^./, c => c.toUpperCase());
export const auditIcon = (action: string): IconName => ACTION[action]?.[0] ?? 'info';
/** An Agent's events carry its Node ID as the actor. */
export const isAgentActor = (e: Pick<AuditEvent, 'actor'>): boolean => isUuid(e.actor);
export const actorName = (e: Pick<AuditEvent, 'actor'>): string => (isAgentActor(e) ? 'Agent' : e.actor);
export const actorRole = (e: Pick<AuditEvent, 'actor'>): string => (isAgentActor(e) ? 'Agent' : e.actor === 'enrollment' ? 'Enrollment' : 'Operator');
