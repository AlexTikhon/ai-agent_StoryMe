'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { UserDto } from '@book/types';
import { ApiError, apiFetch, AUTH_EXPIRED_EVENT } from '../api/client';
import { authApi } from '../api/auth';
import { getAuthMode, type AuthMode } from './mode';
import {
  advanceSessionEpoch,
  getSessionEpoch,
  setAccessToken,
  setAccessTokenForEpoch,
} from './token-store';

// 'error' means session restoration failed for a temporary reason (network
// failure, 429, 5xx) — the session may still be valid, so it must not be
// treated as anonymous. Only a definitive 401 produces 'anon'.
export type AuthStatus = 'loading' | 'authed' | 'anon' | 'error';

export interface AuthContextValue {
  user: UserDto | null;
  status: AuthStatus;
  authMode: AuthMode;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name?: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Re-attempts session restoration after a temporary failure (status 'error'). */
  retrySession: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserDto | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const authMode = getAuthMode();

  // Restores the session on load: GET /api/auth/me carries dev headers in dev
  // mode (always succeeds) or no bearer token yet in jwt mode, which 401s and
  // triggers apiFetch's built-in refresh-once-on-401 using the HttpOnly
  // refresh cookie — the same silent-restore flow, with no separate call.
  const restoreAttemptRef = useRef(0);

  const restoreSession = useCallback(() => {
    const epoch = getSessionEpoch();
    const attempt = ++restoreAttemptRef.current;
    const isCurrent = () => restoreAttemptRef.current === attempt && getSessionEpoch() === epoch;
    setStatus('loading');
    apiFetch<UserDto>('/auth/me')
      .then((me) => {
        if (isCurrent()) {
          setUser(me);
          setStatus('authed');
        }
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return;
        setUser(null);
        if (authMode === 'dev') {
          setStatus('authed');
        } else if (error instanceof ApiError && error.status === 401) {
          // Definitive credential rejection: the session really is gone.
          setStatus('anon');
        } else {
          setStatus('error');
        }
      });
  }, [authMode]);

  useEffect(() => {
    restoreSession();
    const attemptRef = restoreAttemptRef;
    return () => {
      // Invalidate any in-flight restore on unmount.
      attemptRef.current += 1;
    };
  }, [restoreSession]);

  // A later request's silent refresh can also fail (refresh cookie expired or
  // revoked mid-session, after the initial restore already succeeded) — drop
  // back to anon so the dashboard layout's redirect effect sends the user to
  // /login instead of leaving them on a page that just keeps 401ing.
  useEffect(() => {
    const onAuthExpired = () => {
      setUser(null);
      setStatus('anon');
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, onAuthExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onAuthExpired);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const epoch = advanceSessionEpoch();
    const res = await authApi.login(email, password);
    if (!setAccessTokenForEpoch(res.accessToken, epoch)) return;
    setUser(res.user);
    setStatus('authed');
  }, []);

  const register = useCallback(async (email: string, password: string, name?: string) => {
    const epoch = advanceSessionEpoch();
    const res = await authApi.register(email, password, name);
    if (!setAccessTokenForEpoch(res.accessToken, epoch)) return;
    setUser(res.user);
    setStatus('authed');
  }, []);

  const logout = useCallback(async () => {
    const epoch = advanceSessionEpoch();
    setAccessToken(null);
    setUser(null);
    setStatus(authMode === 'dev' ? 'authed' : 'anon');
    try {
      await authApi.logout();
    } catch {
      // best-effort — clear local state regardless of server-side outcome
    }
    if (getSessionEpoch() !== epoch) return;
    // Dev mode has no real session to end (identity travels via header on
    // every request), so it stays "authed" rather than showing a login wall.
    setStatus(authMode === 'dev' ? 'authed' : 'anon');
  }, [authMode]);

  return (
    <AuthContext.Provider
      value={{ user, status, authMode, login, register, logout, retrySession: restoreSession }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
