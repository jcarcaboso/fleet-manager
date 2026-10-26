import { createApiClient, type ApiClient } from '@/api/client';
import { createMockServer, MOCK_API_URL, type MockOptions, type MockServer } from '@/api/mock';
import { createSession, type Session } from '@/api/session';
import { TOKEN } from './app';

/** A client and a session wired to a fresh mock server, without any component. */
export function mockApi(options: Partial<MockOptions> = {}): { mock: MockServer; api: ApiClient; session: Session; unauthorized: number } {
  const mock = createMockServer(options);
  const hooks = { unauthorized: 0 };
  let session!: Session;
  const api = createApiClient({ apiUrl: MOCK_API_URL, fetch: mock.fetch, onUnauthorized: () => { hooks.unauthorized++; session.handleUnauthorized(); } });
  session = createSession(api);
  return { mock, api, session, get unauthorized() { return hooks.unauthorized; } };
}

/** Logs the client in with a valid token (for tests that start signed out with `signedOut: true`). */
export async function loginClient(api: ApiClient): Promise<void> {
  await api.post('login', { token: TOKEN }, { login: true });
}
