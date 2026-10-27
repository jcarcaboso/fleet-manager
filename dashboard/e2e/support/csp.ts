import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The Content-Security-Policy that the dashboard container sends, read from `nginx/entrypoint.sh` so that the e2e preview server
 * cannot drift from production. `$origin` (the Server's origin in `connect-src`) is dropped: the mock API runs in the page and
 * needs no cross-origin request, so any attempt to reach another origin is a violation the tests must see.
 */
export function productionCsp(): string {
  const script = readFileSync(fileURLToPath(new URL('../../nginx/entrypoint.sh', import.meta.url)), 'utf8');
  const match = /add_header Content-Security-Policy \\"([^"]+?)\\" always;/.exec(script);
  if (!match) throw new Error('nginx/entrypoint.sh no longer writes a Content-Security-Policy header the e2e suite can read.');
  return match[1].replace(' $origin', '');
}
