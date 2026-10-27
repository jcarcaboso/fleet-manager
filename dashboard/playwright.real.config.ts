import { defineConfig, devices } from '@playwright/test';

/**
 * Real-stack e2e: the journeys of `e2e/real/` against a running Server and dashboard. Nothing is started here; point it at a
 * stack with these environment variables (`scripts/e2e-stack.sh` builds, seeds and tears down a disposable one and sets them):
 *
 *   FLEET_E2E_DASHBOARD_URL     the dashboard origin, for example https://localhost:7444
 *   FLEET_E2E_SERVER_URL        the Server origin, for example https://localhost:7443
 *   FLEET_E2E_OPERATOR_TOKEN    an admin Operator token (read from the environment only, never printed or stored)
 *   FLEET_E2E_READ_TOKEN        optional: a token with the read scope
 *   FLEET_E2E_OPERATE_TOKEN     optional: a token with the operate scope
 *   FLEET_E2E_IGNORE_HTTPS_ERRORS=1   accept the private CA's certificates (a disposable stack uses its own CA)
 *   FLEET_E2E_AGENT_ALIAS       an enrolled machine that has reported (OS and disk)
 *   FLEET_E2E_IDLE_ALIAS        an enrolled machine that has never checked in
 *   FLEET_E2E_AGENT_RUN         a command that runs that machine's Agent once: it is called as `COMMAND ALIAS`
 *
 * Without the first three variables every test is skipped and the run still succeeds. The browser is chosen as in
 * playwright.config.ts (PLAYWRIGHT_CHROMIUM_EXECUTABLE or Playwright's own Chromium).
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;
const truthy = (value: string | undefined): boolean => /^(1|true|yes)$/i.test(value ?? '');

export default defineConfig({
  testDir: './e2e/real',
  outputDir: './test-results/real',
  fullyParallel: false,
  workers: 1, // one stack, one set of machines: the journeys share it and run in order
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/real' }]],
  use: {
    baseURL: process.env.FLEET_E2E_DASHBOARD_URL,
    ignoreHTTPSErrors: truthy(process.env.FLEET_E2E_IGNORE_HTTPS_ERRORS),
    // No traces: a trace records what was typed, and the sign-in field holds the real Operator token.
    trace: 'off',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath },
  },
  projects: [{ name: 'real-stack', use: { ...devices['Desktop Chrome'] } }],
});
