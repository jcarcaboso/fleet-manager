/**
 * Bookmarks of the old, Server-embedded dashboard. It used hash routes (`https://SERVER/dashboard#/nodes/studio-mini/problems`); the Server now
 * redirects `/dashboard` to this application and browsers keep the fragment, so such a bookmark arrives as
 * `https://DASHBOARD/#/nodes/studio-mini/problems`. Once at start-up, before the router is installed, the hash is translated into the
 * path of the same page and the address is replaced (no history entry):
 *
 *   #/nodes                      /machines
 *   #/nodes/<alias>[/<tab>]      /machines/<alias>[/<tab>]        (the alias exactly as encoded; an unknown tab opens Overview)
 *   #/problems                   /problems
 *   #/deployments[/<id>]         /deployments[/<id>]              (a short SHA still scrolls the list, see router.ts)
 *   #/repository  #/models  #/enrollment  #/audit                 the same paths
 *   #/add                        /machines?add=1                  (the gallery opens the Add machine wizard)
 *
 * Anything else (including `#/` and an empty hash) is ignored. Nothing here decodes a segment, so what the old dashboard wrote with
 * `encodeURIComponent` is what the router reads; segments never contain `/`, so the target is always a path of this application.
 */
const PLAIN = new Set(['problems', 'repository', 'models', 'enrollment', 'audit']);

/** The path (with query) the old hash route stands for, or `null` when it is not one of the old routes. */
export function legacyHashPath(hash: string): string | null {
  const parts = String(hash).replace(/^#/, '').split('?')[0]!.split('/').filter(Boolean);
  const [name, first, second] = parts;
  if (!name) return null;
  if (name === 'nodes') return first ? `/machines/${first}${second ? `/${second}` : ''}` : '/machines';
  if (name === 'add') return '/machines?add=1';
  if (name === 'deployments') return first ? `/deployments/${first}` : '/deployments';
  return PLAIN.has(name) ? `/${name}` : null;
}

/**
 * Replaces an old hash address by the new one. Only the address at the root of the application is looked at (`base` is the Vite base,
 * `/`). Returns the new path, or `null` when the address was left alone.
 */
export function applyLegacyHash(win: Pick<Window, 'location' | 'history'>, base = '/'): string | null {
  const { pathname, hash } = win.location;
  if (!hash.startsWith('#/') || pathname !== base) return null;
  const path = legacyHashPath(hash);
  if (!path) return null;
  const target = base.replace(/\/$/, '') + path;
  win.history.replaceState(win.history.state, '', target);
  return target;
}
