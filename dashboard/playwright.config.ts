import { defineConfig, devices } from '@playwright/test';
import { E2E_ORIGIN } from './e2e/support/server';

/**
 * Mock-mode e2e suite: the mock bundle (`vite build --mode mock`) served by `vite preview` on a fixed loopback port with the
 * production Content-Security-Policy. The real-Server journeys have their own config, `playwright.real.config.ts`.
 *
 * Browser: Playwright's own Chromium (`npx playwright install --with-deps chromium`), or the executable named by
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE (for example a chrome-headless-shell that is already on the machine).
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;
const config = './e2e/support/vite.e2e.config.ts';

export default defineConfig({
  testDir: './e2e/mock',
  outputDir: './test-results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0, // a flaky test is a bug in the test or in the dashboard; it is fixed, not retried
  workers: process.env.CI ? 2 : undefined,
  timeout: 30_000,
  expect: { timeout: 7_500 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: E2E_ORIGIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { executablePath },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx vite build --config ${config} --configLoader runner --mode mock && npx vite preview --config ${config} --configLoader runner --mode mock`,
    url: `${E2E_ORIGIN}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});

