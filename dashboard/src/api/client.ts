import { CREDENTIALS_REJECTED, MESSAGES, SIGN_IN_REQUIRED, networkMessage, statusMessage } from './messages';
import type { CsrfResponse, ErrorBody, Page, QueryParams } from './types';

/**
 * The typed client for `/dashboard/api` (ported from api.js).
 *
 * Every request sends the session cookie (`credentials: "include"`), `Accept: application/json` and the caller's
 * `AbortSignal`. Mutations also send `Content-Type: application/json` and `X-Fleet-CSRF`; the token comes from
 * `GET csrf`, is held in memory only, and is fetched again once when the Server answers `invalid_csrf`.
 * Passwords are only ever passed to `post('login', …)` and the password routes; nothing is written to storage, the URL or logs.
 */

/** The error every failed call throws. `message` is safe to show to the user. */
export class ApiError extends Error {
  readonly status: number;
  /** The Server's snake_case code, `network_error`, `cancelled`, `unauthorized` or `invalid_credentials`; `null` when the Server sent none. */
  readonly code: string | null;
  /** The parsed error body when the Server sent one (for example the `models` of `pinned_model_excluded`). */
  readonly details: ErrorBody | null;
  /** Silent errors (cancelled calls, a 401 already handled by the sign-in redirect) must never be shown. */
  readonly silent: boolean;

  constructor(message: string, status: number, code: string | null, details: ErrorBody | null = null, silent = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.silent = silent;
  }
}

export interface RequestOptions {
  /** Aborting it cancels the request; the call then rejects with a silent `cancelled` error. */
  signal?: AbortSignal;
  /** Only for `post('login')`: a 401 means the name or password was wrong, not that the session ended. */
  login?: boolean;
}

export interface ApiClientOptions {
  /** The Server origin from `config.json`, for example `https://fleet.home.arpa:7443` (no trailing slash needed). */
  apiUrl: string;
  /** The `fetch` to use. Tests and mock mode pass the mock API; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Called when a call other than login gets 401. The session uses it to go back to the sign-in page. */
  onUnauthorized?: () => void;
  /** Called when a call gets 403 `password_change_required`: the account must change its password before anything else. */
  onPasswordChangeRequired?: () => void;
  /** Called when a call gets 403. The error is also thrown; views show it inline. */
  onForbidden?: (error: ApiError) => void;
}

export interface AllOptions {
  params?: QueryParams;
  /** Pages to read at most (100 items each). When the last one still has a cursor, `truncated` is true. */
  maxPages?: number;
  signal?: AbortSignal;
}

export interface ApiClient {
  readonly apiUrl: string;
  get<T = unknown>(path: string, params?: QueryParams, opts?: RequestOptions): Promise<T>;
  post<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  /** Not used by any current route (CORS allows GET, POST and OPTIONS only); mutations share `post`'s CSRF handling. */
  put<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  /** Reads one page of a list: `limit` defaults to 100, `after` is the cursor, `order: 'newest'` where the contract offers it. */
  page<T>(path: string, params?: QueryParams, opts?: RequestOptions): Promise<Page<T>>;
  /** Follows the cursor up to `maxPages`, for lists a screen needs whole (machines, warnings, links). */
  all<T>(path: string, options?: AllOptions): Promise<{ items: T[]; truncated: boolean }>;
  /** Fetches a fresh CSRF token (also done automatically before the first mutation and once after `invalid_csrf`). */
  renewCsrf(signal?: AbortSignal): Promise<void>;
  /** Forgets the CSRF token; the next mutation fetches a new one (used after sign-out). */
  clearCsrf(): void;
}

const BASE_PATH = '/dashboard/api/';

/** Builds the query string; `undefined`, `null` and `''` are skipped. */
export function queryString(params?: QueryParams): string {
  const q = Object.entries(params ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return q ? '?' + q : '';
}

/** One percent-encoded path segment, for Node aliases and IDs: `rack/A 100%` becomes `rack%2FA%20100%25`. */
export const segment = (value: string): string => encodeURIComponent(value);

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

const cancelled = (): ApiError => new ApiError('Request cancelled', 0, 'cancelled', null, true);

export function createApiClient(options: ApiClientOptions): ApiClient {
  const apiUrl = options.apiUrl.replace(/\/+$/, '');
  const doFetch = (input: string, init: RequestInit): Promise<Response> => (options.fetch ?? globalThis.fetch.bind(globalThis))(input, init);
  let csrf = '';

  async function request<T>(method: 'GET' | 'POST' | 'PUT', path: string, body: unknown, opts: RequestOptions, retried = false): Promise<T> {
    const mutating = method !== 'GET';
    const signal = opts.signal;
    if (signal?.aborted) throw cancelled();
    if (mutating && !csrf) await renewCsrf(signal);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (mutating) {
      headers['Content-Type'] = 'application/json';
      headers['X-Fleet-CSRF'] = csrf;
    }
    let response: Response;
    try {
      response = await doFetch(apiUrl + BASE_PATH + path, {
        method,
        mode: 'cors',
        credentials: 'include',
        cache: 'no-store',
        headers,
        body: mutating ? JSON.stringify(body ?? {}) : undefined,
        signal,
      });
    } catch (cause) {
      /* A caller that cancels its own request does not want an error shown. */
      if (signal?.aborted || (cause as { name?: string } | null)?.name === 'AbortError') throw cancelled();
      throw new ApiError(networkMessage(apiUrl), 0, 'network_error');
    }
    const payload = await parseBody(response);
    if (signal?.aborted) throw cancelled();
    if (response.ok) return payload as T;

    const error = (payload && typeof payload === 'object' ? (payload as ErrorBody) : null) ?? null;
    const code = typeof error?.code === 'string' ? error.code : null;
    if (response.status === 401) {
      if (opts.login) throw new ApiError(CREDENTIALS_REJECTED, 401, 'invalid_credentials');
      const failure = new ApiError(SIGN_IN_REQUIRED, 401, 'unauthorized', error, true);
      options.onUnauthorized?.();
      throw failure;
    }
    if (code === 'invalid_csrf' && mutating && !retried) {
      await renewCsrf(signal);
      return request<T>(method, path, body, opts, true);
    }
    const message = (code && MESSAGES[code]) || statusMessage(response.status);
    const failure = new ApiError(message, response.status, code, error);
    if (response.status === 403) {
      if (code === 'password_change_required') options.onPasswordChangeRequired?.();
      options.onForbidden?.(failure);
    }
    throw failure;
  }

  async function renewCsrf(signal?: AbortSignal): Promise<void> {
    csrf = '';
    const result = await request<CsrfResponse | null>('GET', 'csrf', undefined, { signal });
    csrf = result?.token || '';
  }

  const client: ApiClient = {
    apiUrl,
    get: (path, params, opts = {}) => request('GET', path + queryString(params), undefined, opts),
    post: (path, body, opts = {}) => request('POST', path, body, opts),
    put: (path, body, opts = {}) => request('PUT', path, body, opts),
    async page<T>(path: string, params?: QueryParams, opts: RequestOptions = {}): Promise<Page<T>> {
      const result = await client.get<Partial<Page<T>> | null>(path, { limit: 100, ...params }, opts);
      return { items: result?.items ?? [], nextCursor: result?.nextCursor ?? null };
    },
    async all<T>(path: string, { params = {}, maxPages = 10, signal }: AllOptions = {}): Promise<{ items: T[]; truncated: boolean }> {
      const items: T[] = [];
      let after: string | null = null;
      let truncated = false;
      for (let page = 0; page < maxPages; page++) {
        const result: Partial<Page<T>> | null = await client.get<Partial<Page<T>> | null>(path, { limit: 100, ...params, after }, { signal });
        items.push(...(result?.items ?? []));
        after = result?.nextCursor ?? null;
        if (!after) break;
        if (page === maxPages - 1) truncated = true;
      }
      return { items, truncated };
    },
    renewCsrf,
    clearCsrf: () => {
      csrf = '';
    },
  };
  return client;
}
