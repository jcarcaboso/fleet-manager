import type { MockServer } from '@/api/mock';

/**
 * The mock refuses a request body the Server would refuse (an unknown member, a wrong type, a missing required member: 400 invalid_request,
 * `api/mock/bind.ts`). A view that sends such a body would then fail in its own way, which a test may not look at, so every mock a test creates
 * through `mountApp`, `componentHarness` or `mockApi` is watched, and `tests/setup.ts` fails the test that made the mock refuse a body.
 * A test that sends malformed bodies on purpose through the app's client says so with `allowMalformedBodies()`.
 */
const watched = new Set<MockServer>();
let allowed = false;

export function watchMock(mock: MockServer): MockServer {
  watched.add(mock);
  return mock;
}

export function allowMalformedBodies(): void {
  allowed = true;
}

/** The refused requests of the watched mocks since the last call (and forgets the mocks). */
export function takeMalformed(): string[] {
  const out = [...watched].flatMap(m => m.calls.filter(c => c.malformed).map(c => `${c.method} ${c.path} ${JSON.stringify(c.body)}`));
  watched.clear();
  return out;
}

/** Called by `tests/setup.ts` after each test: what the test did wrong, or an empty list. */
export function checkMalformed(): string[] {
  const refused = takeMalformed();
  const ok = allowed;
  allowed = false;
  return ok ? [] : refused;
}
