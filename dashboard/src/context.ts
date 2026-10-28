import { inject, reactive, watch, type InjectionKey } from 'vue';
import { createApiClient, type ApiClient } from '@/api/client';
import { createSession, type Session } from '@/api/session';
import type { AppConfig } from '@/config';
import { createErrorCatalog, type ErrorCatalog } from '@/composables/catalog';
import { createNavSummary, type NavSummary } from '@/composables/summary';
import { createToasts, type ToastStore } from '@/composables/toasts';
import type { StatusMeta } from '@/lib/status';
import { createEnrollmentBus, type EnrollmentBus } from '@/views/Enrollment/enrollmentBus';
import type { GalleryPrefs } from '@/views/Machines/galleryPrefs';

/** The result of the last repository sync or model refresh, shown on every page that has the button. */
export interface ActionResult extends StatusMeta {
  text: string;
}

/** State shared by buttons that appear on several pages (the old `Fleet.shared`). */
export interface SharedState {
  syncing: boolean;
  lastSync: ActionResult | null;
  refreshing: boolean;
  lastRefresh: ActionResult | null;
}

export interface WizardState {
  /** `AppShell` mounts `views/Enrollment/AddMachineWizard.vue` while this is true. */
  open: boolean;
  show(): void;
  hide(): void;
}

export interface ShellState {
  /** ISO time shown in the footer ("Loaded 14:30 UTC"). Call `markLoaded()` after a page finishes loading. */
  loadedAt: string | null;
  /** Set on every navigation; the first heading that mounts afterwards takes keyboard focus (`useHeadingFocus`). */
  focusPending: boolean;
  markLoaded(): void;
}

export interface FleetContext {
  config: AppConfig;
  api: ApiClient;
  session: Session;
  catalog: ErrorCatalog;
  summary: NavSummary;
  toasts: ToastStore;
  shared: SharedState;
  wizard: WizardState;
  shell: ShellState;
  /** Open/closed state of `<details>` elements by key, kept across repaints (the old `Fleet.openState`). */
  openState: Map<string, boolean>;
  /** The "Renamed from …" sentence for the page a rename opens, by the new alias. Taken by that page; dropped when the session ends. */
  renameNotes: Map<string, string>;
  /** How the Machines gallery is arranged, search text included. Kept between visits; the search is cleared at the moments the old `galleryReset` was called. */
  gallery: GalleryPrefs;
  /** What the Enrollment page, the Machines gallery and the Add machine wizard tell each other (see `views/Enrollment/enrollmentBus.ts`). */
  enrollmentBus: EnrollmentBus;
}

export const FLEET_KEY: InjectionKey<FleetContext> = Symbol('fleet');

export interface ContextOptions {
  config: AppConfig;
  /** The `fetch` the client uses: the mock API in mock mode and in tests; the global `fetch` otherwise. */
  fetch?: typeof fetch;
}

/** Builds everything the app shares, wired together: the client, the session and its 401 hook, the catalog, the badges and the stores. */
export function createFleetContext({ config, fetch }: ContextOptions): FleetContext {
  let session!: Session;
  const api = createApiClient({
    apiUrl: config.apiUrl, fetch,
    onUnauthorized: () => session.handleUnauthorized(),
    onPasswordChangeRequired: () => session.handlePasswordChangeRequired(),
  });
  session = createSession(api);
  const catalog = createErrorCatalog(api);
  const summary = createNavSummary(api);
  const toasts = createToasts();
  const shared = reactive<SharedState>({ syncing: false, lastSync: null, refreshing: false, lastRefresh: null });
  const wizard = reactive<WizardState>({ open: false, show: () => { wizard.open = true; }, hide: () => { wizard.open = false; } });
  const shell = reactive<ShellState>({ loadedAt: null, focusPending: false, markLoaded: () => { shell.loadedAt = new Date().toISOString(); } });
  const renameNotes = new Map<string, string>();
  const gallery = reactive<GalleryPrefs>({ groupBy: 'status', sort: 'attention', retiredOpen: false, search: '' });
  const enrollmentBus = createEnrollmentBus();
  /* Everything cached for one Operator is dropped when the session starts or ends. */
  watch(() => session.state.status, () => {
    catalog.reset();
    summary.reset();
    toasts.clear();
    wizard.open = false;
    shared.syncing = shared.refreshing = false;
    shared.lastSync = shared.lastRefresh = null;
    renameNotes.clear();
    gallery.search = '';
    enrollmentBus.reset();
  }, { flush: 'sync' });
  return { config, api, session, catalog, summary, toasts, shared, wizard, shell, openState: new Map(), renameNotes, gallery, enrollmentBus };
}

export function useFleet(): FleetContext {
  const ctx = inject(FLEET_KEY, null);
  if (!ctx) throw new Error('useFleet() needs the Fleet context: install it with app.provide(FLEET_KEY, createFleetContext(...)).');
  return ctx;
}
export const useApi = (): ApiClient => useFleet().api;
export const useSession = (): Session => useFleet().session;
export const useToasts = (): ToastStore => useFleet().toasts;
