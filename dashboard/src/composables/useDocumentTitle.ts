import { onScopeDispose, shallowRef, toValue, watchEffect, type MaybeRefOrGetter } from 'vue';

export const APP_TITLE = 'Fleet Manager';

/** A view's own title (a machine alias, a revision subject). It wins over the route's `meta.title` while the view is alive. */
const override = shallowRef<string | null>(null);

/** Sets the page title to "<title> · Fleet Manager" while the calling view is alive. Pass a getter for a title that loads later. */
export function useDocumentTitle(title: MaybeRefOrGetter<string | null | undefined>): void {
  watchEffect(() => {
    override.value = toValue(title) || null;
  });
  onScopeDispose(() => {
    override.value = null;
  });
}

/** Used by `AppShell`: keeps `document.title` at the view's title, else the route's, else the app name. */
export function useShellTitle(routeTitle: () => string | undefined): void {
  watchEffect(() => {
    const t = override.value ?? routeTitle();
    document.title = t ? `${t} · ${APP_TITLE}` : APP_TITLE;
  });
}
