/**
 * Runtime configuration. The page fetches `/config.json` (`cache: "no-store"`) before it mounts:
 *
 *     { "apiUrl": "https://fleet.home.arpa:7443" }
 *
 * `apiUrl` is the Server's origin (no path). It must be `https`, except `http://localhost` and `http://127.0.0.1`
 * for local development. A missing or invalid file shows a configuration error page, never a blank screen.
 */

export interface AppConfig {
  /** The validated Server origin without a trailing slash. */
  apiUrl: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/** Validates `apiUrl` and returns the origin. Throws `ConfigError` with a message that says what to change. */
export function validateApiUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new ConfigError('config.json must contain "apiUrl", the origin of the Fleet Server, for example "https://fleet.home.arpa:7443".');
  const text = value.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigError(`"apiUrl" is not a valid URL: ${JSON.stringify(text)}. Use an origin such as "https://fleet.home.arpa:7443".`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
    throw new ConfigError('"apiUrl" must use https. Plain http is accepted only for http://localhost and http://127.0.0.1.');
  }
  if (url.username || url.password) throw new ConfigError('"apiUrl" must not contain a user name or password.');
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new ConfigError('"apiUrl" must be an origin only: scheme, host and optional port, without a path, query or fragment.');
  }
  return url.origin;
}

/** Fetches and validates `/config.json`. `fetchImpl` and `url` exist for tests. */
export async function loadConfig(fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis), url = '/config.json'): Promise<AppConfig> {
  let response: Response;
  try {
    response = await fetchImpl(url, { cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/json' } });
  } catch {
    throw new ConfigError('config.json could not be loaded. Check that the dashboard container is running and that /config.json is served.');
  }
  if (!response.ok) throw new ConfigError(`config.json could not be loaded (HTTP ${response.status}). The container writes it from FLEET_API_ORIGIN.`);
  let data: unknown;
  try {
    data = JSON.parse(await response.text());
  } catch {
    throw new ConfigError('config.json is not valid JSON. It must look like { "apiUrl": "https://fleet.home.arpa:7443" }.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ConfigError('config.json must be a JSON object with an "apiUrl" property.');
  return { apiUrl: validateApiUrl((data as { apiUrl?: unknown }).apiUrl) };
}
