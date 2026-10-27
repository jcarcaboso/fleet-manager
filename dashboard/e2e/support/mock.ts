import type { Page } from '@playwright/test';

/** The mock's URL switches (`dashboard/README.md`, "Mock API"). `true` writes `name=1`. */
export type Switches = Record<string, string | number | true>;

/** A path of the app with the mock switches as its query: `appUrl('/machines', { scope: 'read' })`. */
export function appUrl(path: string, switches: Switches = {}): string {
  const query = new URLSearchParams(Object.entries(switches).map(([name, value]) => [name, value === true ? '1' : String(value)]));
  const text = query.toString();
  if (!text) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${text}`;
}

/** A call the mock answered (`window.__MOCK.calls`, see `src/api/mock/server.ts`). */
export interface MockCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  status: number;
  settled: boolean;
  aborted: boolean;
  malformed: boolean;
}

/** Every call the page made to the mock API since it started. */
export function mockCalls(page: Page): Promise<MockCall[]> {
  return page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as { __MOCK: { calls: unknown[] } }).__MOCK.calls)) as MockCall[]);
}

/** The calls that change something (everything but GET), without the sign-in and CSRF plumbing. */
export async function mockWrites(page: Page): Promise<MockCall[]> {
  return (await mockCalls(page)).filter(call => call.method !== 'GET' && call.path !== 'login');
}
