import { createApp, type App as VueApp } from 'vue';
import type { Router, RouterHistory } from 'vue-router';
import App from './App.vue';
import type { AppConfig } from './config';
import { FLEET_KEY, createFleetContext, type FleetContext } from './context';
import { applyLegacyHash } from './legacyHash';
import { createAppRouter } from './router';

export interface FleetApp {
  app: VueApp;
  router: Router;
  ctx: FleetContext;
}

/**
 * Builds the whole application without mounting it: the context (client, session, stores), the router and the Vue app.
 * Without `history` it is the browser's address bar: an old `#/…` bookmark is translated first (`legacyHash.ts`).
 * `main.ts` mounts it on `#root`; the tests mount it on a detached element with the mock API (see `tests/helpers/app.ts`).
 */
export function createFleetApp(options: { config: AppConfig; fetch?: typeof fetch; history?: RouterHistory }): FleetApp {
  const ctx = createFleetContext({ config: options.config, fetch: options.fetch });
  /* Before the router reads the address: a bookmark of the old hash-routed dashboard becomes the path of the same page. */
  if (!options.history) applyLegacyHash(window, import.meta.env.BASE_URL);
  const router = createAppRouter({ session: ctx.session, history: options.history });
  const app = createApp(App);
  app.provide(FLEET_KEY, ctx);
  app.use(router);
  return { app, router, ctx };
}
