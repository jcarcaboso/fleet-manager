import { config } from '@vue/test-utils';
import { afterEach, beforeEach } from 'vitest';
import { resetModals } from '@/composables/modalStack';
import { hideTip } from '@/composables/tooltip';
import { installConsoleGuard, record, removeConsoleGuard } from './helpers/console';
import { checkMalformed } from './helpers/strict';

/* Vue warnings (a missing prop, a failed injection, a hydration or reactivity problem) fail the test like console.error does. This covers every
   `mount()` of @vue/test-utils, the whole app and single components alike. */
config.global.config.warnHandler = (message, _instance, trace) => record('warn', `[Vue warn] ${message}${trace ? '\n' + trace : ''}`);

beforeEach(() => installConsoleGuard());

/* Global state that lives outside a mounted app is reset between tests. */
afterEach(() => {
  resetModals();
  hideTip();
  document.body.innerHTML = '';
  document.body.className = 'app';
  document.title = '';
  const problems: string[] = [];
  const unexpected = removeConsoleGuard();
  if (unexpected.length) problems.push(`The test logged to the console (declare it with expectConsole() if that is expected):\n${unexpected.join('\n')}`);
  const refused = checkMalformed();
  if (refused.length) problems.push(`The mock refused request bodies that the Server would refuse too (400 invalid_request; allowMalformedBodies() if that is the point of the test):\n${refused.join('\n')}`);
  if (problems.length) throw new Error(problems.join('\n\n'));
});
