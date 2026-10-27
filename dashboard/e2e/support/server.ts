/** Where the mock-mode suite serves the dashboard: a fixed loopback port, nothing else listens here. */
export const E2E_PORT = 4179;
export const E2E_ORIGIN = `http://127.0.0.1:${E2E_PORT}`;
/** Private output directory of the mock bundle (git-ignored); `npm run dev:mock` and `npm run build:mock` never touch it. */
export const E2E_OUT_DIR = '.e2e-dist';
