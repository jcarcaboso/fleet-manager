import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { vi } from 'vitest';
import { createMemoryHistory, type Router } from 'vue-router';
import App from '@/App.vue';
import { createMockServer, MOCK_API_URL, type MockOptions, type MockServer } from '@/api/mock';
import type { Scope } from '@/api/types';
import { FLEET_KEY, createFleetContext, type FleetContext } from '@/context';
import { createAppRouter } from '@/router';
import { watchMock } from './strict';

/** A token the mock accepts (32 to 1024 characters, not starting with "bad"). */
export const TOKEN = 'operator-token-0123456789-abcdefghijkl';
export const BAD_TOKEN = 'bad-token-0123456789-abcdefghijklmnopq';

export interface TestApp {
  wrapper: VueWrapper;
  router: Router;
  ctx: FleetContext;
  mock: MockServer;
  /** `router.push(path)` and settle. */
  go(path: string): Promise<void>;
  /** Lets pending promises, lazy route components and renders finish (real timers). */
  settle(): Promise<void>;
  /** Signs in through the session (not through the form) and settles. */
  signIn(): Promise<void>;
  /** Changes the scope on both sides: the mock's session and the page's session. */
  setScope(scope: Scope): void;
  unmount(): void;
}

export interface MountOptions {
  /** Path to open (default `/machines`). */
  path?: string;
  /** Mock switches (the URL parameters of `dev:mock`, as options). `signedOut: true` starts at the sign-in page. */
  mock?: Partial<MockOptions>;
  /** Mount `App` for real (default). `false` only builds the context, router and mock, for tests that mount single components. */
  mountApp?: boolean;
}

/** Lets promises, lazy route components and renders finish. Works with fake timers as long as `setImmediate` is not faked. */
export async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await flushPromises();
}

/**
 * Waits until `check` returns something truthy (real timers: polls every 5 ms; fake timers: advances the clock by 5 ms
 * per round). Throws the last error or a timeout.
 */
export async function waitFor<T>(check: () => T | Promise<T>, { timeout = 3000, label = 'condition' }: { timeout?: number; label?: string } = {}): Promise<NonNullable<T>> {
  const fake = vi.isFakeTimers();
  const started = Date.now();
  let waited = 0;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value) return value as NonNullable<T>;
    } catch (e) {
      lastError = e;
    }
    if ((fake ? waited : Date.now() - started) > timeout) throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for ${label}`);
    if (fake) {
      await vi.advanceTimersByTimeAsync(5);
      waited += 5;
    } else await new Promise(r => setTimeout(r, 5));
    await flushPromises();
  }
}

/** Mounts the whole app (shell, router, session) against a fresh mock API. Call `unmount()` in `afterEach`. */
export async function mountApp(options: MountOptions = {}): Promise<TestApp> {
  const mock = watchMock(createMockServer({ ...options.mock }));
  const ctx = createFleetContext({ config: { apiUrl: MOCK_API_URL }, fetch: mock.fetch });
  const router = createAppRouter({ session: ctx.session, history: createMemoryHistory() });
  const host = document.createElement('div');
  host.id = 'root';
  document.body.append(host);
  const wrapper = options.mountApp === false
    ? (undefined as unknown as VueWrapper)
    : mount(App, { global: { plugins: [router], provide: { [FLEET_KEY as symbol]: ctx } }, attachTo: host });
  /* Navigations in flight (a lazy route component is still loading), so settle() can wait for them. */
  let pending = 0;
  router.beforeEach(() => { pending++; });
  router.afterEach(() => { pending--; });
  router.onError(() => { pending--; });
  const app: TestApp = {
    wrapper, router, ctx, mock,
    async go(path) {
      await router.push(path);
      await app.settle();
    },
    async settle() {
      for (let i = 0; i < 2000 && (i < 6 || pending > 0); i++) await flushPromises();
    },
    async signIn() {
      await ctx.session.login(TOKEN);
      await app.settle();
    },
    setScope(scope) {
      mock.state.scope = scope;
      ctx.session.state.scope = scope;
    },
    unmount() {
      wrapper?.unmount();
      mock.dispose();
      host.remove();
    },
  };
  if (options.mountApp !== false) {
    await router.push(options.path ?? '/machines');
    await router.isReady();
    await app.settle();
  }
  return app;
}

/** The text content of the element, whitespace collapsed. */
export const textOf = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

export interface ComponentHarness {
  ctx: FleetContext;
  mock: MockServer;
  router: Router;
  cleanup(): void;
}

/**
 * Context for mounting a single component: a fresh mock, a signed-in session (with the scope from `mock.scope`), the router
 * and the provide for `useFleet()`. Use it as `mount(Comp, { global: harness.global })`.
 */
export async function componentHarness(options: Partial<MockOptions> = {}): Promise<ComponentHarness & { global: { plugins: Router[]; provide: Record<symbol, FleetContext> } }> {
  const mock = watchMock(createMockServer(options));
  const ctx = createFleetContext({ config: { apiUrl: MOCK_API_URL }, fetch: mock.fetch });
  const router = createAppRouter({ session: ctx.session, history: createMemoryHistory() });
  if (!options.signedOut) await ctx.session.restore();
  return {
    ctx, mock, router,
    global: { plugins: [router], provide: { [FLEET_KEY as symbol]: ctx } },
    cleanup: () => mock.dispose(),
  };
}
