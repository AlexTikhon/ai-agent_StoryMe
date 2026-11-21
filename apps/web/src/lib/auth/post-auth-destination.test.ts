import { describe, expect, it } from 'vitest';
import {
  BOOK_CREATION_PATH,
  authPageHref,
  resolvePostAuthDestination,
} from './post-auth-destination';

describe('resolvePostAuthDestination', () => {
  it.each([
    '/dashboard',
    '/dashboard/books/new',
    '/dashboard/books/3f2b1c9a-0000-4000-8000-000000000000',
    '/dashboard/books?page=2',
    '/dashboard/child-profiles',
    '/dashboard/credits',
  ])('accepts supported dashboard destination %s', (input) => {
    expect(resolvePostAuthDestination(input)).toBe(input);
  });

  it('normalizes dot segments that stay inside a supported section', () => {
    expect(resolvePostAuthDestination('/dashboard/credits/../books/new')).toBe(
      '/dashboard/books/new',
    );
  });

  it.each([
    ['retired interactive catalogue', '/dashboard/interactive'],
    ['retired interactive reader', '/dashboard/interactive/3f2b1c9a-0000-4000-8000-000000000000'],
    [
      'retired interactive transcript',
      '/dashboard/interactive/3f2b1c9a-0000-4000-8000-000000000000/transcript',
    ],
    ['retired destination with query', '/dashboard/interactive?scenario=warsaw-last-delivery'],
    ['dot segments into a retired section', '/dashboard/books/../interactive'],
    ['unknown dashboard section', '/dashboard/bookshelf'],
    ['section-prefixed sibling', '/dashboard/books-archive'],
  ])('falls back to /dashboard for a stale or unsupported %s', (_label, input) => {
    expect(resolvePostAuthDestination(input)).toBe('/dashboard');
  });

  it.each([
    ['absent', null],
    ['undefined', undefined],
    ['empty', ''],
    ['external URL', 'https://evil.example/dashboard'],
    ['scheme-relative', '//evil.example/dashboard'],
    ['bare relative path', 'dashboard/books/new'],
    ['javascript URL', 'javascript:alert(1)'],
    ['backslash', '/dashboard\\..\\evil'],
    ['backslash after slash', '/\\evil.example'],
    ['tab', '/dashboard/\tbooks'],
    ['newline', '/dashboard/\nbooks'],
    ['NUL', '/dashboard/\u0000'],
    ['DEL', '/dashboard/\u007f'],
    ['non-dashboard internal path', '/login'],
    ['dashboard-prefixed sibling', '/dashboardx'],
    ['traversal out of dashboard', '/dashboard/../login'],
    ['encoded traversal out of dashboard', '/dashboard/%2e%2e/login'],
    ['mixed-case encoded traversal', '/dashboard/%2E./login'],
    ['over-long', `/dashboard/books/${'a'.repeat(600)}`],
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

  it('preserves the book-creation destination, encoded', () => {
    expect(authPageHref('/register', BOOK_CREATION_PATH)).toBe(
      '/register?next=%2Fdashboard%2Fbooks%2Fnew',
    );
    expect(authPageHref('/login', '/dashboard/books?page=2')).toBe(
      '/login?next=%2Fdashboard%2Fbooks%3Fpage%3D2',
    );
  });

  it('drops a stale retired destination instead of carrying it through auth', () => {
    expect(authPageHref('/login', '/dashboard/interactive')).toBe('/login');
    expect(authPageHref('/register', '/dashboard/interactive/abc/transcript')).toBe('/register');
  });
});
