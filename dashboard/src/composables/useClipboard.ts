import { onScopeDispose, ref, type Ref } from 'vue';

/** Copies text. Uses the async Clipboard API in a secure context and falls back to a hidden textarea and `execCommand`. */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof window !== 'undefined' && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to the textarea */
    }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

export interface ClipboardState {
  /** `null` idle, `'copied'` for 1.6 s after a success, `'failed'` after a failure ("Press Ctrl+C"). */
  status: Ref<null | 'copied' | 'failed'>;
  copy(text: string): Promise<boolean>;
}
export function useClipboard(resetMs = 1600): ClipboardState {
  const status = ref<null | 'copied' | 'failed'>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;
  onScopeDispose(() => {
    if (timer !== null) clearTimeout(timer);
  });
  return {
    status,
    async copy(text) {
      const ok = await copyText(text);
      status.value = ok ? 'copied' : 'failed';
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        status.value = null;
      }, resetMs);
      return ok;
    },
  };
}
