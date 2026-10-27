import type { AppConfig } from '@/config';
import { parseMockOptions } from './options';
import { createMockServer, type MockServer } from './server';

/** The Server origin the mock pretends to be (shown in "could not reach the Server at …" messages). */
export const MOCK_API_URL = 'https://mock.fleet.invalid';

/**
 * Starts the mock for `npm run dev:mock`: reads the switches from the page's query string and returns the config and
 * the `fetch` to give to the client. No config file and no Server are needed. The mock also appears as `window.__MOCK`
 * (call log, state, records) for manual inspection in the browser console.
 */
export function startMock(search: string = location.search): { config: AppConfig; fetch: typeof fetch; server: MockServer } {
  const server = createMockServer({ ...parseMockOptions(search), origin: location.origin });
  (window as unknown as { __MOCK?: MockServer }).__MOCK = server;
  return { config: { apiUrl: MOCK_API_URL }, fetch: server.fetch, server };
}
