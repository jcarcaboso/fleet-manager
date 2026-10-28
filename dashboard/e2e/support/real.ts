import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, type Page } from '@playwright/test';
import { test as base } from './fixtures';
import type { Allow } from './guard';

/** A dashboard account whose password has already been changed (scripts/e2e-stack.sh creates them). */
export interface Account {
  name: string;
  password: string;
}

/**
 * Settings of the real-stack journeys, all from the environment (see playwright.real.config.ts). The account passwords are read here
 * and used only to fill the sign-in form; they are never logged, written to disk, put in a URL or attached to a report.
 */
export interface Stack {
  dashboard: string;
  server: string;
  /** An admin account. */
  admin: Account;
  read?: Account;
  operate?: Account;
  agentAlias?: string;
  idleAlias?: string;
  agentRun?: string;
}

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;
const origin = (url: string): string => new URL(url).origin;
const account = (key: string): Account | undefined => {
  const name = env(`FLEET_E2E_${key}_NAME`);
  const password = env(`FLEET_E2E_${key}_PASSWORD`);
  return name && password ? { name, password } : undefined;
};

export function stackFromEnv(): Stack | null {
  const dashboard = env('FLEET_E2E_DASHBOARD_URL');
  const server = env('FLEET_E2E_SERVER_URL');
  const admin = account('ADMIN');
  if (!dashboard || !server || !admin) return null;
  return {
    dashboard: origin(dashboard),
    server: origin(server),
    admin,
    read: account('READ'),
    operate: account('OPERATE'),
    agentAlias: env('FLEET_E2E_AGENT_ALIAS'),
    idleAlias: env('FLEET_E2E_IDLE_ALIAS'),
    agentRun: env('FLEET_E2E_AGENT_RUN'),
  };
}

export const stack = stackFromEnv();
export const NOT_CONFIGURED = 'real-stack mode needs FLEET_E2E_DASHBOARD_URL, FLEET_E2E_SERVER_URL, FLEET_E2E_ADMIN_NAME and FLEET_E2E_ADMIN_PASSWORD (scripts/e2e-stack.sh sets them)';

/** `test` for the real-stack journeys: the same fixture rules as the mock suite, and a clean skip without a stack. */
export const test = base.extend<{ stack: Stack }>({
  // eslint-disable-next-line no-empty-pattern
  stack: async ({}, use, testInfo) => {
    testInfo.skip(!stack, NOT_CONFIGURED);
    await use(stack as Stack);
  },
});
export { expect };

/**
 * Signs in through the page. A visitor without a session is answered 401 by `GET session` (the Server's way of saying "sign in"), which
 * the browser logs as a failed resource; the test says it expects that.
 */
export async function signIn(page: Page, s: Stack, allow: Allow, as: Account = s.admin): Promise<void> {
  allow.request(/GET \S+\/dashboard\/api\/session -> 401$/);
  allow.console(/Failed to load resource: the server responded with a status of 401/);
  await page.goto('/login');
  await page.getByLabel('Name', { exact: true }).fill(as.name);
  await page.getByLabel('Password', { exact: true }).fill(as.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(url => !url.pathname.startsWith('/login'));
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

/** Runs the Agent of an enrolled machine once, through the command the stack provides (`FLEET_E2E_AGENT_RUN ALIAS`). */
export async function runAgentOnce(s: Stack, alias: string): Promise<void> {
  if (!s.agentRun) throw new Error('FLEET_E2E_AGENT_RUN is not set: the stack gave no way to run an Agent');
  await promisify(execFile)(s.agentRun, [alias], { timeout: 60_000 });
}
