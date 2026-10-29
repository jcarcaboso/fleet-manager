/** Errors that views must treat specially. A "silent" error is never shown to the user. */

/** Thrown after an await when a newer load has started or the view is gone (the old `Fleet.superseded`). */
export class SupersededError extends Error {
  readonly silent = true as const;
  readonly code = 'superseded';
  readonly status = 0;
  constructor() {
    super('Superseded by a newer request');
    this.name = 'SupersededError';
  }
}

/** Creates the error that a stale continuation throws to drop its result. */
export const superseded = (): SupersededError => new SupersededError();

/** True for errors that must never reach the user: cancelled requests, superseded loads, 401s already handled by the sign-in redirect. */
export const isSilent = (error: unknown): boolean => !!error && typeof error === 'object' && (error as { silent?: unknown }).silent === true;

/**
 * Use in `.catch(soft)` for reads whose failure should degrade the page instead of failing it: silent errors are
 * rethrown (so a cancelled view stops), every other error becomes `null` (the old `Fleet.soft`).
 */
export function soft(error: unknown): null {
  if (isSilent(error)) throw error;
  return null;
}

/** A user-facing message for any thrown value. */
export const errorMessage = (error: unknown, fallback = 'Something went wrong.'): string =>
  error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string' && (error as { message: string }).message
    ? (error as { message: string }).message
    : fallback;

/**
 * The Server's own `message` of an error response, else `errorMessage`. For refusals where the Server's text says more than the code
 * (why the Agent release is unavailable, which version the Agent already runs). Show it as text.
 */
export function serverMessage(error: unknown, fallback = 'Something went wrong.'): string {
  const said = (error as { details?: { message?: unknown } | null } | null)?.details?.message;
  return typeof said === 'string' && said.trim() ? said : errorMessage(error, fallback);
}
