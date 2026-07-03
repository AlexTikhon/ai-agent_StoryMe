'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { UserDto } from '@book/types';
import { apiFetch, AUTH_EXPIRED_EVENT } from '../api/client';
import { authApi } from '../api/auth';
import { getAuthMode, type AuthMode } from './mode';
import { setAccessToken } from './token-store';

export type AuthStatus = 'loading' | 'authed' | 'anon';

export interface AuthContextValue {
  user: UserDto | null;
  status: AuthStatus;
  authMode: AuthMode;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name?: string) => Promise<void>;
  logout: () => Promise<void>;
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
  useEffect(() => {
    let cancelled = false;
    apiFetch<UserDto>('/auth/me')
      .then((me) => {
        if (!cancelled) {
          setUser(me);
          setStatus('authed');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUser(null);
          setStatus(authMode === 'dev' ? 'authed' : 'anon');
        }
      });
    return () => {
      cancelled = true;
    };
    // Intentionally runs once on mount only — authMode is an env-derived
    // constant for the lifetime of the app, not reactive state.
  }, []);

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
    const res = await authApi.login(email, password);
    setAccessToken(res.accessToken);
    setUser(res.user);
    setStatus('authed');
  }, []);

  const register = useCallback(async (email: string, password: string, name?: string) => {
    const res = await authApi.register(email, password, name);
    setAccessToken(res.accessToken);
    setUser(res.user);
    setStatus('authed');
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      // best-effort — clear local state regardless of server-side outcome
    }
    setAccessToken(null);
    setUser(null);
    // Dev mode has no real session to end (identity travels via header on
    // every request), so it stays "authed" rather than showing a login wall.
    setStatus(authMode === 'dev' ? 'authed' : 'anon');
  }, [authMode]);

  return (
    <AuthContext.Provider value={{ user, status, authMode, login, register, logout }}>
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
