import type { UserDto } from '@book/types';
import { ApiError, parseApiError } from './api-error';
import { getApiBase } from './config';

const API_BASE = getApiBase();

export interface AuthResponse {
  accessToken: string;
  user: UserDto;
}

async function authPost(path: string, body?: unknown): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    method: 'POST',
    // Required so the storyme_refresh HttpOnly cookie round-trips cross-origin.
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function throwApiError(res: Response): Promise<never> {
  const { message, code } = await parseApiError(res);
  throw new ApiError(res.status, message, code);
}

async function authResponse(path: string, body?: unknown): Promise<AuthResponse> {
  const res = await authPost(path, body);
  if (!res.ok) {
    await throwApiError(res);
  }
  return res.json() as Promise<AuthResponse>;
}

export const authApi = {
  register: (email: string, password: string, name?: string): Promise<AuthResponse> =>
    authResponse('/auth/register', { email, password, ...(name ? { name } : {}) }),

  login: (email: string, password: string): Promise<AuthResponse> =>
    authResponse('/auth/login', { email, password }),

  /** No body — reads the refresh cookie server-side. */
  refresh: (): Promise<AuthResponse> => authResponse('/auth/refresh'),

  logout: async (): Promise<void> => {
    const res = await authPost('/auth/logout');
    if (!res.ok && res.status !== 204) {
      await throwApiError(res);
    }
  },

  verifyEmail: async (token: string): Promise<void> => {
    const res = await authPost('/auth/verify-email', { token });
    if (!res.ok) {
      await throwApiError(res);
    }
  },

  /** Never throws on "unknown email" — the API intentionally responds the same way regardless. */
  resendVerification: async (email: string): Promise<void> => {
    const res = await authPost('/auth/resend-verification', { email });
    if (!res.ok && res.status !== 204) {
      await throwApiError(res);
    }
  },

  /** Never throws on "unknown email" — the API intentionally responds the same way regardless. */
  requestPasswordReset: async (email: string): Promise<void> => {
    const res = await authPost('/auth/request-password-reset', { email });
    if (!res.ok) {
      await throwApiError(res);
    }
  },

  resetPassword: async (token: string, password: string): Promise<void> => {
    const res = await authPost('/auth/reset-password', { token, password });
    if (!res.ok) {
      await throwApiError(res);
    }
  },
};
