/** User-facing text for Server error codes (ported from api.js). Anything not listed falls back to a message by status. */
export const MESSAGES: Readonly<Record<string, string>> = {
  invalid_csrf: 'Your session changed. Refresh the page and try again.',
  invalid_origin: 'This page was not opened from the dashboard address the Server allows. Open the dashboard from that address and try again.',
  insufficient_scope: 'Your scope does not allow this action. Ask an admin for a broader scope.',
  password_change_required: 'Change your password before continuing.',
  invalid_current_password: 'Your current password is not correct.',
  invalid_password: 'Choose a password of 10 to 256 characters that differs from the current one.',
  invalid_account_name: 'Use 1 to 64 letters, digits, dots, dashes or underscores for the name, starting with a letter or digit.',
  invalid_scope: 'Choose read, operate or admin.',
  account_exists: 'An account with that name already exists.',
  account_not_found: 'That account no longer exists. The list was refreshed.',
  last_admin: 'At least one admin account must remain.',
  cannot_delete_self: 'You cannot delete the account you are signed in with.',
  node_not_found: 'That machine no longer exists. It may have been renamed or removed.',
  target_not_found: 'That Target is not assigned to this machine.',
  target_not_failed: 'That Target is no longer failed, so there is nothing to retry. The page was refreshed.',
  node_revoked: 'That machine has been revoked.',
  enrollment_link_not_found: 'That enrollment link no longer exists.',
  enrollment_not_found: 'That enrollment link no longer exists.',
  invalid_request: 'The Server rejected that request.',
  node_alias_in_use: 'That alias is already in use.',
  invalid_node_alias: 'Choose a nonblank alias of at most 200 characters.',
  invalid_node_name: 'Choose a nonblank alias of at most 200 characters.',
  invalid_alias: 'Choose a nonblank alias of at most 200 characters.',
  invalid_expiry: 'Choose an expiry between 1 and 60 minutes.',
  node_alias_changed: 'This machine was renamed. Refresh the page before removing it.',
  stale_selection: 'Another operator saved this selection. It was reloaded; review it and save again.',
  invalid_selection: 'This selection is invalid or would leave no models enabled.',
  catalog_unavailable: 'This model catalog is no longer available. Reload the selection.',
  issue_not_found: 'That problem is gone. It may have been fixed. The page was refreshed.',
  revision_not_found: 'That revision no longer exists.',
  rollout_not_found: 'That rollout no longer exists.',
  rate_limited: 'Too many requests. Wait a moment and try again.',
  pinned_model_excluded:
    'A pinned default model cannot be excluded. Keep it selected, change the pinned default, or turn off the Claude restriction for other clients.',
};

/** Shown when a login succeeded but the next call carries no session: the browser dropped the `SameSite=Strict` cookie. */
export const SESSION_COOKIE_NOT_SENT =
  'Your browser did not send the session cookie. The dashboard and the Server must be on the same site.';

export const CREDENTIALS_REJECTED = 'That name and password were not accepted. Check them and try again.';
export const SIGN_IN_REQUIRED = 'Sign in with your account.';

/** The message for a network failure; it names the configured API address so a wrong `apiUrl` is easy to spot. */
export const networkMessage = (apiUrl: string): string =>
  `Could not reach the Server at ${apiUrl}. Check your connection, that the Server is running, and that this dashboard is allowed to call it, then try again.`;

/** The message for an error response without a known code. */
export function statusMessage(status: number): string {
  if (status === 403) return MESSAGES.insufficient_scope as string;
  if (status >= 500) return `The Server had a problem (${status}). Try again in a moment.`;
  return `The Server rejected the request (${status}). Refresh and try again.`;
}
