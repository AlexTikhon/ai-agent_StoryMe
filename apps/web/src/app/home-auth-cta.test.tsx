import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HomeAuthCta } from './home-auth-cta';
import { useAuth, type AuthStatus } from '@/lib/auth/auth-context';

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: vi.fn(),
}));

function setStatus(status: AuthStatus) {
  vi.mocked(useAuth).mockReturnValue({
    user: null,
    status,
    authMode: 'jwt',
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    retrySession: vi.fn(),
  });
}

const href = (name: string | RegExp) => screen.getByRole('link', { name }).getAttribute('href');

describe('HomeAuthCta', () => {
  beforeEach(() => {
    vi.mocked(useAuth).mockReset();
  });

  describe.each(['anon', 'loading', 'error'] as const)('while %s', (status) => {
    beforeEach(() => setStatus(status));

    it('sends the primary CTA to registration, preserving the book-creation destination', () => {
      render(<HomeAuthCta />);
      expect(href(/^create a book$/i)).toBe('/register?next=%2Fdashboard%2Fbooks%2Fnew');
    });

    it('offers a sign-in path preserving the same destination', () => {
      render(<HomeAuthCta />);
      expect(href(/^sign in$/i)).toBe('/login?next=%2Fdashboard%2Fbooks%2Fnew');
    });

    it('keeps a clear route to the existing library', () => {
      render(<HomeAuthCta />);
      expect(href(/open my library/i)).toBe('/dashboard');
    });

    it('links nowhere near the retired interactive product', () => {
      const { container } = render(<HomeAuthCta />);
      const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
      expect(hrefs.join(' ')).not.toMatch(/interactive/);
    });
  });

  describe('when authenticated', () => {
    beforeEach(() => setStatus('authed'));

    it('sends the primary CTA straight to the book wizard', () => {
      render(<HomeAuthCta />);
      expect(href(/^create a book$/i)).toBe('/dashboard/books/new');
    });

    it('offers the library as the secondary action', () => {
      render(<HomeAuthCta />);
      expect(href(/open my library/i)).toBe('/dashboard');
    });

    it('does not show sign-in or registration prompts', () => {
      render(<HomeAuthCta />);
      expect(screen.queryByRole('link', { name: /sign in/i })).toBeNull();
      const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href') ?? '');
      expect(hrefs.filter((h) => /^\/(register|login)/.test(h))).toEqual([]);
    });
  });
});
