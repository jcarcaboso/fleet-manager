import { reactive } from 'vue';
import { useFleet, type FleetContext } from '@/context';

/**
 * What the Enrollment page, the Machines gallery and the Add machine wizard tell each other. It belongs to the app context
 * (one per session of the page), not to any component, so a request that completes after its view is gone can still report.
 *
 * - `version` goes up whenever links or machines may have changed (a link was created or revoked, a wizard that made a link
 *   closed). The two list pages watch it and reload quietly; a page that is not open loads fresh when it is opened.
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
  /** The last revoked link, and a counter so the same ID can be announced twice. */
  revokedId: string | null;
  revokedTick: number;
  request: WizardRequest | null;
  formMsg: string;
  formErr: boolean;
  /** Links or machines may have changed. */
  changed(): void;
  /** A link was revoked (also counts as a change). */
  revoked(id: string): void;
}

const buses = new WeakMap<object, EnrollmentBus>();

export function enrollmentBus(ctx: FleetContext): EnrollmentBus {
  let bus = buses.get(ctx.wizard);
  if (!bus) {
    const b: EnrollmentBus = reactive({
      version: 0, revokedId: null, revokedTick: 0, request: null, formMsg: '', formErr: false,
      changed: () => { b.version++; },
      revoked: (id: string) => { b.revokedId = id; b.revokedTick++; b.version++; },
    });
    bus = b;
    buses.set(ctx.wizard, bus);
  }
  return bus;
}

export const useEnrollmentBus = (): EnrollmentBus => enrollmentBus(useFleet());
