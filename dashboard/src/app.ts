import { createApp, type App as VueApp } from 'vue';
import type { Router, RouterHistory } from 'vue-router';
import App from './App.vue';
import type { AppConfig } from './config';
import { FLEET_KEY, createFleetContext, type FleetContext } from './context';
import { createAppRouter } from './router';

export interface FleetApp {
  app: VueApp;
  router: Router;
  ctx: FleetContext;
}

/**
 * Builds the whole application without mounting it: the context (client, session, stores), the router and the Vue app.
 * `main.ts` mounts it on `#root`; the tests mount it on a detached element with the mock API (see `tests/helpers/app.ts`).
 */
export function createFleetApp(options: { config: AppConfig; fetch?: typeof fetch; history?: RouterHistory }): FleetApp {
  const ctx = createFleetContext({ config: options.config, fetch: options.fetch });
  const router = createAppRouter({ session: ctx.session, history: options.history });
  const app = createApp(App);
  app.provide(FLEET_KEY, ctx);
  app.use(router);
  return { app, router, ctx };
}
