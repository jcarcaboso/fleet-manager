import { reactive } from 'vue';
import { ApiError, type ApiClient } from './client';
import { SESSION_COOKIE_NOT_SENT } from './messages';
import type { Scope, SessionInfo } from './types';

/** A line shown under the sign-in field. */
export interface Notice {
  text: string;
  err: boolean;
}

export type SessionStatus = 'unknown' | 'signedOut' | 'signedIn';

export interface SessionState {
  actor: string | null;
  scope: Scope | null;
  status: SessionStatus;
  /** Shown on the sign-in page once ("Signed out.", "Your session ended. Sign in again."). */
  notice: Notice | null;
  /** Set when the first `GET session` failed for a reason other than 401 (Server unreachable): the shell offers "Try again". */
  bootError: ApiError | Error | null;
}

const RANK: Record<Scope, number> = { read: 0, operate: 1, admin: 2 };
const isScope = (value: unknown): value is Scope => typeof value === 'string' && Object.hasOwn(RANK, value);

/**
 * The reactive session: who is signed in and with which scope. The Operator token is posted once at login and is
 * never kept; only `{ actor, scope }` is held, in memory. The cookie (`__Host-Fleet-Session`, HttpOnly) is invisible to the page.
 */
export interface Session {
  readonly state: SessionState;
  readonly signedIn: boolean;
  /** `true` when the session's scope includes `level` (`admin` includes `operate`, which includes `read`). */
  can(level: Scope): boolean;
  /** The scope, or `read` when signed out (the old `Api.scopeLabel`). */
  scopeLabel(): Scope;
  scopeTitle(): string;
  /** Explains why an action is unavailable, for hover text and inline hints. */
  denied(level: Scope): string;
  /** Restores the session on boot with `GET session`. Resolves `true` when signed in, `false` on 401; rethrows other errors. */
  restore(signal?: AbortSignal): Promise<boolean>;
  /** Runs `restore` once (router guards await it); failures other than 401 land in `state.bootError`. */
  ensure(): Promise<void>;
  /** Forgets a failed boot and restores again (the "Try again" button). */
  retryBoot(): Promise<void>;
  /** Posts the token, then confirms with `GET session`. If that returns 401 the cookie was not sent: throws `session_cookie_not_sent`. */
  login(token: string): Promise<SessionInfo>;
  /** Signs out on the Server, then clears the local session. A failed sign-out keeps the session and rethrows. */
  logout(): Promise<void>;
  /** The client's 401 hook: ends the session with a notice. Ignored when nobody is signed in. */
  handleUnauthorized(): void;
  /** Reads and clears the notice (the sign-in page shows it once). */
  takeNotice(): Notice | null;
}

export function createSession(client: ApiClient): Session {
  const state = reactive<SessionState>({ actor: null, scope: null, status: 'unknown', notice: null, bootError: null });
  let ensured: Promise<void> | null = null;

  const signIn = (info: SessionInfo): SessionInfo => {
    /* A Server without scopes behaves as admin, matching a credential with no scope entry. */
    const scope = isScope(info.scope) ? info.scope : 'admin';
    state.actor = info.actor;
    state.scope = scope;
    state.status = 'signedIn';
    state.bootError = null;
    return { actor: info.actor, scope };
  };
  const signOut = (notice: Notice | null): void => {
    state.actor = null;
    state.scope = null;
    state.status = 'signedOut';
    state.notice = notice;
  };

  const session: Session = {
    state,
    get signedIn() {
      return state.status === 'signedIn';
    },
    can: level => RANK[state.scope ?? 'read'] >= RANK[level],
    scopeLabel: () => state.scope ?? 'read',
    scopeTitle: () => {
      const s = session.scopeLabel();
      return s.charAt(0).toUpperCase() + s.slice(1);
    },
    denied: level => `Needs the ${level} scope. Your token has ${session.scopeLabel()} access.`,
    async restore(signal) {
      try {
        signIn(await client.get<SessionInfo>('session', undefined, { signal }));
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          signOut(null);
          return false;
        }
        throw error;
      }
    },
    ensure() {
      ensured ??= session.restore().then(
        () => undefined,
        error => {
          state.bootError = error as Error;
        },
      );
      return ensured;
    },
    async retryBoot() {
      ensured = null;
      state.bootError = null;
      await session.ensure();
    },
    async login(token) {
      try {
        await client.post('login', { token }, { login: true });
      } catch (error) {
        /* The client already fetched a fresh token and retried once. A second `invalid_csrf` means the browser did not send the
           antiforgery cookie back, which is what a page on another site gets (SameSite=Strict), so say that instead of
           asking for a refresh that cannot help. */
        if (error instanceof ApiError && error.code === 'invalid_csrf') {
          client.clearCsrf();
          throw new ApiError(SESSION_COOKIE_NOT_SENT, 400, 'session_cookie_not_sent');
        }
        throw error;
      }
      client.clearCsrf();
      try {
        return signIn(await client.get<SessionInfo>('session'));
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          throw new ApiError(SESSION_COOKIE_NOT_SENT, 401, 'session_cookie_not_sent');
        }
        throw error;
      }
    },
    async logout() {
      await client.post('logout', {});
      client.clearCsrf();
      signOut({ text: 'Signed out.', err: false });
    },
    handleUnauthorized() {
      if (state.status !== 'signedIn') return;
      client.clearCsrf();
      signOut({ text: 'Your session ended. Sign in again.', err: false });
    },
    takeNotice() {
      const notice = state.notice;
      state.notice = null;
      return notice;
    },
  };
  return session;
}
