import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_STORAGE_KEY, initTheme, resetTheme, setTheme, theme } from '@/theme';

/** A controllable `prefers-color-scheme: light` query. */
function stubSystem(light: boolean): { set(light: boolean): void } {
  const listeners = new Set<() => void>();
  const query = {
    matches: light,
    media: '(prefers-color-scheme: light)',
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  vi.stubGlobal('matchMedia', vi.fn(() => query));
  return {
    set(next) {
      query.matches = next;
      for (const fn of listeners) fn();
    },
  };
}

const applied = (): string | undefined => document.documentElement.dataset.theme;

describe('theme', () => {
  beforeEach(() => {
    resetTheme();
    localStorage.clear();
  });
  afterEach(() => {
    resetTheme();
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('defaults to dark when nothing is stored', () => {
    stubSystem(true);
    initTheme();
    expect(theme.preference).toBe('dark');
    expect(theme.resolved).toBe('dark');
    expect(applied()).toBe('dark');
  });

  it('restores and persists the preference', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    initTheme();
    expect(theme.preference).toBe('light');
    expect(applied()).toBe('light');
    setTheme('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(applied()).toBe('dark');
  });

  it('ignores an invalid stored value and unknown preferences', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'neon');
    initTheme();
    expect(theme.preference).toBe('dark');
    setTheme('neon' as never);
    expect(theme.preference).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('neon');
  });

  it('falls back to dark and still applies a choice when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    initTheme();
    expect(applied()).toBe('dark');
    setTheme('light');
    expect(applied()).toBe('light');
  });

  it('follows the system setting while the preference is system', () => {
    const system = stubSystem(false);
    initTheme();
    setTheme('system');
    expect(theme.resolved).toBe('dark');
    system.set(true);
    expect(theme.resolved).toBe('light');
    expect(applied()).toBe('light');
    setTheme('dark');
    system.set(false);
    system.set(true);
    expect(applied()).toBe('dark');
  });
});
