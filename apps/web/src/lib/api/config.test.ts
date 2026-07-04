import { describe, it, expect, afterEach, vi } from 'vitest';
import { getApiBase, DEFAULT_API_BASE } from './config';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getApiBase', () => {
  it('falls back to localhost when NEXT_PUBLIC_API_URL is unset outside production', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', '');
    vi.stubEnv('NODE_ENV', 'test');
    expect(getApiBase()).toBe(DEFAULT_API_BASE);
  });

  it('uses NEXT_PUBLIC_API_URL when set', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/api');
    vi.stubEnv('NODE_ENV', 'test');
    expect(getApiBase()).toBe('https://api.example.com/api');
  });

  it('uses NEXT_PUBLIC_API_URL when set in production', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/api');
    vi.stubEnv('NODE_ENV', 'production');
    expect(getApiBase()).toBe('https://api.example.com/api');
  });

  it('throws instead of falling back to localhost when unset in production', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', '');
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => getApiBase()).toThrow(/NEXT_PUBLIC_API_URL is not set/);
  });
});
