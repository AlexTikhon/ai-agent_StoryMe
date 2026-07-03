const API_BASE = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:4000/api';
const DEV_EMAIL = 'dev@storyme.local';
const DEV_NAME = 'Dev User';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'x-user-email': DEV_EMAIL,
      'x-user-name': DEV_NAME,
      ...(init?.headers as Record<string, string>),
    },
  });

  if (res.status === 204) return undefined as T;

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string | string[] };
      if (body.message) {
        message = Array.isArray(body.message) ? body.message.join(', ') : String(body.message);
      }
    } catch {
      // ignore parse error
    }
    throw new ApiError(res.status, message);
  }

  return res.json() as Promise<T>;
}

/** Like apiFetch, but for endpoints that return a binary body (e.g. PDF downloads). */
export async function apiFetchBlob(path: string, init?: RequestInit): Promise<Blob> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'x-user-email': DEV_EMAIL,
      'x-user-name': DEV_NAME,
      ...(init?.headers as Record<string, string>),
    },
  });

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string | string[] };
      if (body.message) {
        message = Array.isArray(body.message) ? body.message.join(', ') : String(body.message);
      }
    } catch {
      // ignore parse error
    }
    throw new ApiError(res.status, message);
  }

  return res.blob();
}
