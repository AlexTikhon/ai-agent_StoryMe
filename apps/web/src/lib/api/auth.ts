import type { UserDto } from '@book/types';
import { ApiError, parseApiError } from './api-error';

const API_BASE = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:4000/api';

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
};
