import { watch } from 'vue';
import { START_LOCATION, createRouter, createWebHistory, type RouteLocationNormalizedLoaded, type RouteLocationRaw, type Router, type RouterHistory } from 'vue-router';
import type { Session } from '@/api/session';
import { isUuid } from '@/lib/format';

/**
 * Route table (history mode, no `#`). Names are stable: views link with `{ name, params }`.
 *
 *   /                          redirect to /machines
 *   /login                     login            (public)
 *   /machines                  machines         Machines gallery
 *   /machines/:alias/:tab?     node             one machine; tab is overview|installed|problems|activity|security|settings
 *   /problems                  problems
 *   /deployments               deployments
 *   /deployments/:revisionId   revision         one revision (a UUID); anything else redirects to /deployments?revision=<value>
 *                                              (the old "list scrolled to that short SHA"; DeploymentsView reads route.query.revision)
 *   /repository                repository
 *   /models                    models
 *   /enrollment                enrollment
 *   /audit                     audit
 *   anything else              notFound
 *
 * `meta.title` is the page title, `meta.nav` the key of the navigation entry to highlight, `meta.public` skips the sign-in guard.
 */
export const NODE_TABS = ['overview', 'installed', 'problems', 'activity', 'security', 'settings'] as const;
export type NodeTab = (typeof NODE_TABS)[number];
export const NAV_KEYS = ['machines', 'problems', 'deployments', 'repository', 'models', 'enrollment', 'audit'] as const;
export type NavKey = (typeof NAV_KEYS)[number];

declare module 'vue-router' {
  interface RouteMeta {
    title?: string;
    nav?: NavKey;
    public?: boolean;
  }
}

/** An unknown tab opens Overview (as before). */
export const normalizeTab = (tab: unknown): NodeTab => (NODE_TABS as readonly string[]).includes(String(tab)) ? (tab as NodeTab) : 'overview';

/** Route location of a machine (by alias or ID) and tab. The alias travels as one percent-encoded path segment (`rack/A 100%` → `rack%2FA%20100%25`). */
export const nodeRoute = (aliasOrId: string, tab?: NodeTab | string): RouteLocationRaw =>
  tab && tab !== 'overview' ? { name: 'node', params: { alias: aliasOrId, tab } } : { name: 'node', params: { alias: aliasOrId } };

/** `/deployments/:revisionId`: a UUID opens the revision page; anything else is redirected to the list with `?revision=`. */
export const isRevisionId = (id: unknown): id is string => isUuid(id);

/**
 * The key the `<RouterView>` component is rendered with. A page that is reused for another machine or revision gets a fresh
 * component (state, requests and polls of the old one are gone); switching tabs on the same machine keeps it.
 */
export function routeViewKey(route: RouteLocationNormalizedLoaded): string {
  const p = route.params;
  return `${String(route.name ?? route.path)}:${String(p.alias ?? '')}:${String(p.revisionId ?? '')}`;
}

/** A same-app path to return to after sign-in; anything else (another origin, `//host`, `/login`) is dropped. */
export function safeRedirect(value: unknown): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v !== 'string' || !v.startsWith('/') || v.startsWith('//') || v.includes('\\')) return null;
  const path = v.split(/[?#]/)[0];
  if (path === '/login' || path === '/') return null;
  return v;
}

export interface RouterOptions {
  session: Session;
  /** `createWebHistory()` in the browser; tests pass `createMemoryHistory()`. */
  history?: RouterHistory;
}

export function createAppRouter({ session, history = createWebHistory(import.meta.env.BASE_URL) }: RouterOptions): Router {
  const router = createRouter({
    history,
    routes: [
      { path: '/', redirect: { name: 'machines' } },
      { path: '/login', name: 'login', component: () => import('@/views/Login/LoginView.vue'), meta: { title: 'Sign in', public: true } },
      { path: '/machines', name: 'machines', component: () => import('@/views/Machines/MachinesView.vue'), meta: { title: 'Machines', nav: 'machines' } },
      { path: '/machines/:alias/:tab?', name: 'node', component: () => import('@/views/Node/NodeView.vue'), meta: { title: 'Machine', nav: 'machines' } },
      { path: '/problems', name: 'problems', component: () => import('@/views/Problems/ProblemsView.vue'), meta: { title: 'Problems', nav: 'problems' } },
      { path: '/deployments', name: 'deployments', component: () => import('@/views/Deployments/DeploymentsView.vue'), meta: { title: 'Deployments', nav: 'deployments' } },
      {
        path: '/deployments/:revisionId', name: 'revision', component: () => import('@/views/Revision/RevisionView.vue'), meta: { title: 'Revision', nav: 'deployments' },
        /* An address that is not a revision ID (the old /deployments/<short SHA>) is the list, to be scrolled to that revision. */
        beforeEnter: to => (isRevisionId(to.params.revisionId) ? true : { name: 'deployments', query: { revision: String(to.params.revisionId) }, replace: true }),
      },
      { path: '/repository', name: 'repository', component: () => import('@/views/Repository/RepositoryView.vue'), meta: { title: 'Repository', nav: 'repository' } },
      { path: '/models', name: 'models', component: () => import('@/views/Models/ModelsView.vue'), meta: { title: 'Models', nav: 'models' } },
      { path: '/enrollment', name: 'enrollment', component: () => import('@/views/Enrollment/EnrollmentView.vue'), meta: { title: 'Enrollment', nav: 'enrollment' } },
      { path: '/audit', name: 'audit', component: () => import('@/views/Audit/AuditView.vue'), meta: { title: 'Audit', nav: 'audit' } },
      { path: '/:pathMatch(.*)*', name: 'notFound', component: () => import('@/views/NotFound/NotFoundView.vue'), meta: { title: 'Not found' } },
    ],
    scrollBehavior(to, from, saved) {
      if (saved) return saved;
      if (to.name === 'node' && from.name === 'node' && to.params.alias === from.params.alias) return false;
      return { top: 0 };
    },
  });

  /* Restore the session once (GET session), then keep signed-out visitors on /login with the intended path in ?redirect=. */
  router.beforeEach(async to => {
    await session.ensure();
    if (session.state.bootError) return true; // the shell shows "Try again"
    if (to.meta.public) {
      if (session.signedIn && to.name === 'login') return safeRedirect(to.query.redirect) ?? { name: 'machines' };
      return true;
    }
    if (!session.signedIn) {
      const redirect = to.fullPath === '/' || to.fullPath === '/machines' ? undefined : to.fullPath;
      return { name: 'login', query: redirect ? { redirect } : {} };
    }
    return true;
  });

  /* A session that ends while a page is open (401) goes back to the sign-in page and returns here after sign-in. */
  watch(() => session.state.status, status => {
    const current = router.currentRoute.value;
    /* The first navigation is handled by the guard above. */
    if (status === 'signedOut' && current !== START_LOCATION && !current.meta.public) {
      const redirect = current.fullPath === '/' || current.fullPath === '/machines' ? undefined : current.fullPath;
      void router.replace({ name: 'login', query: redirect ? { redirect } : {} });
    }
  }, { flush: 'sync' });

  return router;
}
