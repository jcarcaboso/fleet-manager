import { computed, reactive } from 'vue';

/** The open `Modal`s, topmost last. `AppShell` shows `#modal-root` only while one is open; only the topmost reacts to Escape and Tab. */
const stack = reactive<number[]>([]);
let next = 1;

export const modalOpenCount = computed(() => stack.length);
export function pushModal(): number {
  const id = next++;
  stack.push(id);
  return id;
}
export function popModal(id: number): void {
  const i = stack.indexOf(id);
  if (i >= 0) stack.splice(i, 1);
}
export const isTopModal = (id: number): boolean => stack[stack.length - 1] === id;
/** For tests. */
export function resetModals(): void {
  stack.splice(0);
}
