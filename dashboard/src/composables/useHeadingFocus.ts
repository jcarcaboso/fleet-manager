import { inject, onMounted, ref, type Ref } from 'vue';
import { FLEET_KEY } from '@/context';

/**
 * After a navigation the first page heading that mounts takes keyboard focus (so screen readers announce the new page),
 * as the old dashboard did. `PageHead`, `EmptyState` (with `h="h1"`) and `ErrorState` use this; bind the returned ref to the
 * element. `enabled` can switch it off (for example an `h2` empty state).
 */
export function useHeadingFocus(enabled: () => boolean = () => true): Ref<HTMLElement | null> {
  const el = ref<HTMLElement | null>(null);
  const ctx = inject(FLEET_KEY, null);
  onMounted(() => {
    if (!ctx || !ctx.shell.focusPending || !enabled() || !el.value) return;
    ctx.shell.focusPending = false;
    el.value.focus({ preventScroll: true });
  });
  return el;
}
