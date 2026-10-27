import { expect, test as base } from '@playwright/test';
import { Allow, watch } from './guard';

export { expect };

/**
 * `test` with the fixture rules in force on every test (see `guard.ts`): console errors and warnings, page errors, CSP violations
 * and failed requests fail the test unless it declares them with `allow`.
 */
export const test = base.extend<{ allow: Allow }>({
  allow: [
    async ({ context }, use) => {
      const allow = new Allow();
      await watch(context, allow);
      await use(allow);
      expect(allow.problems(), 'console, page errors, CSP violations and failed requests').toEqual([]);
    },
    { auto: true },
  ],
});
