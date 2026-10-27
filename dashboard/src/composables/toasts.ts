import { reactive } from 'vue';
import { isSilent } from '@/lib/errors';

export type ToastTone = 'good' | 'info' | 'warning' | 'critical';
export interface Toast {
  id: number;
  title: string;
  text: string;
  tone: ToastTone;
  /** Set shortly before removal so CSS can fade it out. */
  out: boolean;
}
export interface ToastOptions {
  tone?: ToastTone;
  text?: string;
  /** Stays 12 s instead of 6 s. */
  sticky?: boolean;
}

export interface ToastStore {
  readonly items: Toast[];
  /** Shows a toast and returns its id. */
  push(title: string, options?: ToastOptions): number;
  dismiss(id: number): void;
  /**
   * Shows an error as a sticky toast ("critical", or "warning" for 403). Silent errors (cancelled calls, a 401 already
   * handled by the sign-in redirect) show nothing, so call it freely from `catch` blocks (the old `ui.fail`).
   */
  fail(error: unknown, title?: string): void;
  clear(): void;
}

export function createToasts(): ToastStore {
  const items = reactive<Toast[]>([]);
  const timers = new Map<number, Array<ReturnType<typeof setTimeout>>>();
  let next = 1;
  const store: ToastStore = {
    items,
    push(title, options = {}) {
      const id = next++;
      items.push({ id, title, text: options.text ?? '', tone: options.tone ?? 'good', out: false });
      const fade = setTimeout(() => {
        const t = items.find(x => x.id === id);
        if (t) t.out = true;
      }, options.sticky ? 12000 : 6000);
      const remove = setTimeout(() => store.dismiss(id), options.sticky ? 12400 : 6400);
      timers.set(id, [fade, remove]);
      return id;
    },
    dismiss(id) {
      for (const t of timers.get(id) ?? []) clearTimeout(t);
      timers.delete(id);
      const i = items.findIndex(x => x.id === id);
      if (i >= 0) items.splice(i, 1);
    },
    fail(error, title = 'That did not work') {
      if (isSilent(error)) return;
      const e = error as { status?: number; message?: string } | null;
      store.push(title, { tone: e?.status === 403 ? 'warning' : 'critical', text: e?.message ?? '', sticky: true });
    },
    clear() {
      for (const id of [...timers.keys()]) store.dismiss(id);
      items.splice(0);
    },
  };
  return store;
}
