import { reactive, readonly } from 'vue';

/**
 * The colour theme. `dark` is the default; `system` follows the operating system's `prefers-color-scheme`. The preference is the
 * only thing the dashboard keeps in browser storage (`fleet-theme`): it is not a secret and it must apply before the first paint
 * of the next visit. `:root` in tokens.css is the dark palette, so a page without `data-theme` is already dark.
 */
export type ThemePreference = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'fleet-theme';
export const THEME_PREFERENCES: readonly ThemePreference[] = ['dark', 'light', 'system'];
const DEFAULT_THEME: ThemePreference = 'dark';
const LIGHT_QUERY = '(prefers-color-scheme: light)';

interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
}

const state = reactive<ThemeState>({ preference: DEFAULT_THEME, resolved: 'dark' });
/** The current preference and the theme it resolves to. Change it with `setTheme`. */
export const theme: Readonly<ThemeState> = readonly(state);

let media: MediaQueryList | null = null;

const isPreference = (value: unknown): value is ThemePreference => typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value);

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; /* Blocked storage (privacy settings, sandboxed frames) throws on access. */
  }
}

function readPreference(): ThemePreference {
  try {
    const value = storage()?.getItem(THEME_STORAGE_KEY);
    return isPreference(value) ? value : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function systemTheme(): ResolvedTheme {
  return media?.matches ? 'light' : 'dark';
}

function apply(): void {
  state.resolved = state.preference === 'system' ? systemTheme() : state.preference;
  document.documentElement.dataset.theme = state.resolved;
}

const onSystemChange = (): void => {
  if (state.preference === 'system') apply();
};

/** Reads the stored preference, applies it to `<html data-theme>` and follows the system setting while the preference is `system`. */
export function initTheme(): void {
  if (!media && typeof globalThis.matchMedia === 'function') {
    media = globalThis.matchMedia(LIGHT_QUERY);
    media.addEventListener('change', onSystemChange);
  }
  state.preference = readPreference();
  apply();
}

/** Applies and stores a preference. A storage failure keeps the choice for this page only. */
export function setTheme(preference: ThemePreference): void {
  if (!isPreference(preference)) return;
  state.preference = preference;
  apply();
  try {
    storage()?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    /* Storage full or blocked: the theme still applies until the page is reloaded. */
  }
}

/** Test hook: forgets the media query listener and returns to the default. */
export function resetTheme(): void {
  media?.removeEventListener('change', onSystemChange);
  media = null;
  state.preference = DEFAULT_THEME;
  state.resolved = 'dark';
  delete document.documentElement.dataset.theme;
}
