'use strict';
/* Fleet dashboard: same-origin client for the /dashboard/api Operator API.
   The session is the __Host-Fleet-Session cookie. Non-GET requests send the CSRF token from GET csrf
   in the X-Fleet-CSRF header. The Operator token is posted once at login and never stored. */
(function () {
  const Fleet = window.Fleet = window.Fleet || {};
  const Api = Fleet.api = { session: { actor: null, scope: null } };
  const BASE = '/dashboard/api/';
  let csrf = '';

  const MESSAGES = {
    invalid_csrf: 'Your session changed. Refresh the page and try again.',
    invalid_origin: 'This page was not opened from the Server’s public address. Open the dashboard from that address and try again.',
    insufficient_scope: 'Your Operator scope does not allow this action. Ask an admin for a token with a broader scope.',
    node_not_found: 'That machine no longer exists. It may have been renamed or removed.',
    target_not_found: 'That Target is not assigned to this machine.',
    target_not_failed: 'That Target is no longer failed, so there is nothing to retry. The page was refreshed.',
    node_revoked: 'That machine has been revoked.',
    enrollment_link_not_found: 'That enrollment link no longer exists.',
    enrollment_not_found: 'That enrollment link no longer exists.',
    invalid_request: 'The Server rejected that request.',
    node_alias_in_use: 'That alias is already in use.',
    invalid_node_alias: 'Choose a nonblank alias of at most 200 characters.',
    invalid_node_name: 'Choose a nonblank alias of at most 200 characters.',
    invalid_alias: 'Choose a nonblank alias of at most 200 characters.',
    invalid_expiry: 'Choose an expiry between 1 and 60 minutes.',
    node_alias_changed: 'This machine was renamed. Refresh the page before removing it.',
    stale_selection: 'Another operator saved this selection. It was reloaded; review it and save again.',
    invalid_selection: 'This selection is invalid or would leave no models enabled.',
    catalog_unavailable: 'This model catalog is no longer available. Reload the selection.',
    pinned_model_excluded: 'A pinned default model cannot be excluded. Keep it selected, change the pinned default, or turn off the Claude restriction for other clients.',
  };

  class ApiError extends Error {
    constructor(message, status, code, details) { super(message); this.status = status; this.code = code; this.details = details; }
  }
  Api.ApiError = ApiError;
  Api.onUnauthorized = null;

  async function parse(response) {
    const text = await response.text().catch(() => '');
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
  }

  async function request(method, path, body, opts = {}) {
    const mutating = method !== 'GET';
    const headers = {};
    if (mutating) { headers['Content-Type'] = 'application/json'; headers['X-Fleet-CSRF'] = csrf; }
    let response;
    try {
      response = await fetch(BASE + path, {
        method, credentials: 'same-origin', cache: 'no-store', headers,
        body: mutating ? JSON.stringify(body ?? {}) : undefined, signal: opts.signal,
      });
    } catch (cause) {
      /* A caller that cancels its own request does not want an error shown. */
      if (opts.signal?.aborted) { const cancelled = new ApiError('Request cancelled', 0, 'cancelled'); cancelled.silent = true; throw cancelled; }
      throw new ApiError('Could not reach the Server. Check your connection and try again.', 0, 'network_error');
    }
    if (response.ok) return parse(response);
    const error = (await parse(response)) || {};
    if (response.status === 401) {
      if (opts.login) throw new ApiError('That token was not accepted. Check it and try again.', 401, 'invalid_token');
      const failure = new ApiError('Sign in with a valid Operator token.', 401, 'unauthorized');
      failure.silent = true;
      if (Api.onUnauthorized) Api.onUnauthorized();
      throw failure;
    }
    if (error.code === 'invalid_csrf' && mutating && !opts.retried) {
      await Api.renewCsrf();
      return request(method, path, body, { ...opts, retried: true });
    }
    const message = MESSAGES[error.code] || (response.status === 403 ? MESSAGES.insufficient_scope
      : response.status >= 500 ? `The Server had a problem (${response.status}). Try again in a moment.`
        : `The Server rejected the request (${response.status}). Refresh and try again.`);
    throw new ApiError(message, response.status, error.code || null, error);
  }

  const query = params => {
    const q = Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    return q ? '?' + q : '';
  };

  Api.get = (path, params, opts) => request('GET', path + query(params), undefined, opts);
  Api.post = (path, body, opts) => request('POST', path, body, opts);
  Api.renewCsrf = async () => { csrf = (await request('GET', 'csrf'))?.token || ''; };

  /* Lists return { items, nextCursor }. Api.page reads one page. Api.all follows the cursor up to maxPages, for lists that a
     screen needs whole (machines, warnings, links). Lists that are shown newest first use Api.page with order=newest. */
  Api.all = async (path, { params = {}, maxPages = 10 } = {}) => {
    const items = [];
    let after = null, truncated = false;
    for (let page = 0; page < maxPages; page++) {
      const result = await Api.get(path, { limit: 100, ...params, after });
      items.push(...(result?.items || []));
      after = result?.nextCursor || null;
      if (!after) break;
      if (page === maxPages - 1) truncated = true;
    }
    return { items, truncated };
  };
  Api.page = async (path, params, opts) => {
    const result = await Api.get(path, { limit: 100, ...params }, opts);
    return { items: result?.items || [], nextCursor: result?.nextCursor || null };
  };

  /* ---------------------------------------------------------------- session and scope */
  const RANK = { read: 0, operate: 1, admin: 2 };
  Api.can = level => (RANK[Api.session.scope] ?? 0) >= RANK[level];
  Api.scopeLabel = () => Api.session.scope || 'read';
  Api.scopeTitle = () => { const s = Api.scopeLabel(); return s.charAt(0).toUpperCase() + s.slice(1); };
  Api.loadSession = async () => {
    const session = await Api.get('session');
    /* A Server without scopes behaves as admin, matching a credential with no scope entry. */
    Api.session = { actor: session.actor, scope: RANK[session.scope] !== undefined ? session.scope : 'admin' };
    return Api.session;
  };
  Api.login = async token => {
    await Api.post('login', { token }, { login: true });
    await Api.renewCsrf();
    return Api.loadSession();
  };
  Api.logout = async () => {
    try { await Api.post('logout', {}); } finally {
      Api.session = { actor: null, scope: null };
      await Api.renewCsrf().catch(() => { csrf = ''; });
    }
  };
  /* Explains why an action is unavailable, for hover text and inline hints. */
  Api.denied = level => `Needs the ${level} scope. Your token has ${Api.scopeLabel()} access.`;

  /* ---------------------------------------------------------------- error catalog (GET errors) */
  let catalogPromise = null;
  const catalog = Fleet.catalog = { map: new Map(), loaded: false };
  catalog.load = () => {
    if (!catalogPromise) {
      catalogPromise = Api.get('errors').then(result => {
        catalog.map = new Map((result?.items || []).map(entry => [entry.code, entry]));
        catalog.loaded = true;
        return catalog.map;
      }).catch(error => { catalogPromise = null; if (error.silent) throw error; return catalog.map; });
    }
    return catalogPromise;
  };
  catalog.get = code => (code && catalog.map.get(code)) || null;
  catalog.title = code => catalog.get(code)?.title || code || 'Unknown problem';
  catalog.reset = () => { catalogPromise = null; catalog.map = new Map(); catalog.loaded = false; };
})();
