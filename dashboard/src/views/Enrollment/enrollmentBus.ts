import { reactive } from 'vue';

/**
 * What the Enrollment page, the Machines gallery and the Add machine wizard tell each other. It belongs to the app context
 * (`useFleet().enrollmentBus`, one per page load), not to any component, so a request that completes after its view is gone can
 * still report. The session-change watcher of the context resets it, so nothing of one Operator's session reaches the next.
 *
 * - `version` goes up whenever links or machines may have changed (a link was created or revoked, a wizard that made a link
 *   closed). The two list pages watch it and reload quietly; a page that is not open loads fresh when it is opened.
 * - `created` goes up only when a link was created (or a wizard that made one closed): the Machines gallery clears its search then,
 *   so a machine that was just enrolled is visible. A revoked link does not touch the search.
 * - `request` is how the Enrollment page's form starts the wizard with an alias and an expiry (`wizard.show()` takes no arguments).
 * - `formMsg` / `formErr` are the line under the Enrollment form: a link that could not be created says why there once the
 *   wizard is closed.
 */
export interface WizardRequest {
  alias: string;
  expiry: number;
}
export interface EnrollmentBus {
  version: number;
  created: number;
  /** The last revoked link, and a counter so the same ID can be announced twice. */
  revokedId: string | null;
  revokedTick: number;
  request: WizardRequest | null;
  formMsg: string;
  formErr: boolean;
  /** A link was created, or a wizard that made one closed: links and machines may have changed. */
  linkCreated(): void;
  /** A link was revoked (links changed; machines did not). */
  revoked(id: string): void;
  /** Forgets everything but the counters (the session changed). */
  reset(): void;
}

export function createEnrollmentBus(): EnrollmentBus {
  const b: EnrollmentBus = reactive({
    version: 0, created: 0, revokedId: null, revokedTick: 0, request: null, formMsg: '', formErr: false,
    linkCreated: () => { b.created++; b.version++; },
    revoked: (id: string) => { b.revokedId = id; b.revokedTick++; b.version++; },
    reset: () => { b.revokedId = null; b.request = null; b.formMsg = ''; b.formErr = false; },
  });
  return b;
}
