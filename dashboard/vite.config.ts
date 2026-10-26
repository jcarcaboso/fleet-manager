import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

// `npm run dev` against a real Server needs HTTPS (the session cookie is Secure and SameSite=Strict). Point these at a
// certificate for the host the Server's `Fleet:DashboardOrigin` names, for example a mkcert certificate for localhost.
const tls = process.env.DEV_TLS_CERT && process.env.DEV_TLS_KEY
  ? { cert: readFileSync(process.env.DEV_TLS_CERT), key: readFileSync(process.env.DEV_TLS_KEY) }
  : undefined;

// The dashboard is served under a Content-Security-Policy of `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'`.
// Nothing may be inlined: assetsInlineLimit 0 keeps every asset a separate file, and CSS is extracted to its own file.
export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    outDir: 'dist',
    target: 'es2022',
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    sourcemap: false,
  },
  server: { host: process.env.DEV_HOST || '127.0.0.1', port: 5173, https: tls },
  preview: { host: '127.0.0.1', port: 4173 },
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
