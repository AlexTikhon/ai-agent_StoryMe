import { describe, expect, it } from 'vitest';
import {
  INTERACTIVE_CATALOGUE_PATH,
  authPageHref,
  resolvePostAuthDestination,
} from './post-auth-destination';

describe('resolvePostAuthDestination', () => {
  it.each([
    '/dashboard',
    '/dashboard/interactive',
    '/dashboard/books/new',
    '/dashboard/interactive/3f2b1c9a-0000-4000-8000-000000000000',
    '/dashboard/books?page=2',
  ])('accepts internal dashboard destination %s', (input) => {
    expect(resolvePostAuthDestination(input)).toBe(input);
  });

  it('normalizes dot segments that stay inside the dashboard', () => {
    expect(resolvePostAuthDestination('/dashboard/books/../interactive')).toBe(
      '/dashboard/interactive',
    );
  });

  it.each([
    ['absent', null],
    ['undefined', undefined],
    ['empty', ''],
    ['external URL', 'https://evil.example/dashboard'],
    ['scheme-relative', '//evil.example/dashboard'],
    ['bare relative path', 'dashboard/interactive'],
    ['javascript URL', 'javascript:alert(1)'],
    ['backslash', '/dashboard\\..\\evil'],
    ['backslash after slash', '/\\evil.example'],
    ['tab', '/dashboard/\tinteractive'],
    ['newline', '/dashboard/\ninteractive'],
    ['NUL', '/dashboard/\u0000'],
    ['DEL', '/dashboard/\u007f'],
    ['non-dashboard internal path', '/login'],
    ['dashboard-prefixed sibling', '/dashboardx'],
    ['traversal out of dashboard', '/dashboard/../login'],
    ['encoded traversal out of dashboard', '/dashboard/%2e%2e/login'],
    ['mixed-case encoded traversal', '/dashboard/%2E./login'],
    ['over-long', `/dashboard/${'a'.repeat(600)}`],
  ])('falls back to /dashboard for %s', (_label, input) => {
    expect(resolvePostAuthDestination(input)).toBe('/dashboard');
  });
});

describe('authPageHref', () => {
  it('keeps the plain page link when there is no non-default destination', () => {
    expect(authPageHref('/register', null)).toBe('/register');
    expect(authPageHref('/login', '/dashboard')).toBe('/login');
    expect(authPageHref('/login', 'https://evil.example')).toBe('/login');
  });

  it('preserves a valid destination, encoded', () => {
    expect(authPageHref('/register', INTERACTIVE_CATALOGUE_PATH)).toBe(
      '/register?next=%2Fdashboard%2Finteractive',
    );
    expect(authPageHref('/login', '/dashboard/books?page=2')).toBe(
      '/login?next=%2Fdashboard%2Fbooks%3Fpage%3D2',
    );
  });
});
