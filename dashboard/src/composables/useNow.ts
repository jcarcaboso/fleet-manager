import { getCurrentScope, onScopeDispose, ref, type Ref } from 'vue';

/**
 * A reactive "now" in epoch milliseconds that ticks every second while at least one consumer is alive.
 * Use it for countdowns and elapsed timers instead of `setInterval` in views.
 */
const current = ref(Date.now());
let users = 0;
let timer: ReturnType<typeof setInterval> | null = null;

export function useNow(): Readonly<Ref<number>> {
  current.value = Date.now();
  users++;
  if (timer === null) timer = setInterval(() => (current.value = Date.now()), 1000);
  if (getCurrentScope()) {
    onScopeDispose(() => {
      users--;
      if (users <= 0 && timer !== null) {
        clearInterval(timer);
        timer = null;
        users = 0;
      }
    });
  }
  return current;
}
