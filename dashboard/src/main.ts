import { createApp } from 'vue';
import { createFleetApp } from './app';
import ConfigErrorView from './views/ConfigError/ConfigErrorView.vue';
import { ConfigError, loadConfig } from './config';
import { initTheme } from './theme';
import './styles/index';

/**
 * Entry point. Applies the stored colour theme, loads `/config.json` (or, in mock mode, starts the in-browser mock API), then mounts the app. A missing or
 * invalid configuration mounts a configuration error page instead of leaving a blank screen.
 */
async function start(): Promise<void> {
  const target = '#root';
  initTheme();
  try {
    if (import.meta.env.VITE_MOCK === '1') {
      const { startMock } = await import('./api/mock/browser');
      const { config, fetch } = startMock();
      createFleetApp({ config, fetch }).app.mount(target);
    } else {
      const config = await loadConfig();
      createFleetApp({ config }).app.mount(target);
    }
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : 'The dashboard could not start.';
    if (!(error instanceof ConfigError)) console.error(error);
    createApp(ConfigErrorView, { message }).mount(target);
  }
}
void start();
