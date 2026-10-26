import { afterEach } from 'vitest';
import { resetModals } from '@/composables/modalStack';
import { hideTip } from '@/composables/tooltip';

/* Global state that lives outside a mounted app is reset between tests. */
afterEach(() => {
  resetModals();
  hideTip();
  document.body.innerHTML = '';
  document.body.className = 'app';
  document.title = '';
});
