import { onScopeDispose } from 'vue';

/**
 * A model save or catalog refresh outlives the screen that started it. When its answer arrives for a Models page that is gone
 * (or replaced by a newer load), nothing of the old page is touched; instead the Models page that is open now, if any, is
 * reloaded quietly so it shows the saved state. The page registers itself here while it is mounted.
 */
let current: (() => void) | null = null;

export function registerModelsPage(reload: () => void): void {
  current = reload;
  onScopeDispose(() => {
    if (current === reload) current = null;
  });
}

/** Reloads the Models page that is open, if there is one. */
export function catchUpModelsPage(): void {
  current?.();
}
