import { fileURLToPath } from 'node:url';
import { mergeConfig, type Plugin } from 'vite';
import base from '../../vite.config';
import { productionCsp } from './csp';
import { E2E_OUT_DIR, E2E_PORT } from './server';

/** The application routes nginx answers with index.html, including dotted aliases (`/machines/build.box`): see `nginx/nginx.conf`. */
const APP_ROUTE = /^\/(machines|problems|deployments|repository|models|enrollment|audit|login)(\/|$)/;

/**
 * `vite preview` serves index.html for unknown paths, but not for paths that look like files (a Node alias can contain dots).
 * nginx does, for exactly the application routes, so the preview does the same.
 */
const nginxRoutes: Plugin = {
  name: 'e2e-nginx-routes',
  configurePreviewServer(server) {
    server.middlewares.use((req, _res, next) => {
      const path = (req.url ?? '').split('?')[0];
      if (APP_ROUTE.test(path)) req.url = '/index.html';
      next();
    });
  },
};

/**
 * Vite configuration of the e2e mock server: the production config, built in mock mode into a private directory and previewed
 * on a fixed loopback port with the production Content-Security-Policy and the same security headers as nginx.
 */
export default mergeConfig(base, {
  root: fileURLToPath(new URL('../..', import.meta.url)),
  plugins: [nginxRoutes],
  build: { outDir: E2E_OUT_DIR, emptyOutDir: true },
  preview: {
    host: '127.0.0.1',
    port: E2E_PORT,
    strictPort: true,
    headers: {
      'Content-Security-Policy': productionCsp(),
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  },
});
