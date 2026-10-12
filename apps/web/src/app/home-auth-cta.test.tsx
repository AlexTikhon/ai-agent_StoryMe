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

    it('sends the primary CTA to registration, preserving the interactive destination', () => {
      render(<HomeAuthCta />);
      expect(href(/start your first story/i)).toBe('/register?next=%2Fdashboard%2Finteractive');
    });

    it('offers a sign-in path preserving the same destination', () => {
      render(<HomeAuthCta />);
      expect(href(/^sign in$/i)).toBe('/login?next=%2Fdashboard%2Finteractive');
    });

    it('keeps the book links on their existing destinations', () => {
      render(<HomeAuthCta />);
      expect(href(/create a personalized book/i)).toBe('/register');
      expect(href(/view my books/i)).toBe('/dashboard');
    });
  });

  describe('when authenticated', () => {
    beforeEach(() => setStatus('authed'));

    it('sends the primary CTA straight to the interactive catalogue', () => {
      render(<HomeAuthCta />);
      expect(href(/open the story catalogue/i)).toBe('/dashboard/interactive');
    });

    it('does not show sign-in or registration prompts', () => {
      render(<HomeAuthCta />);
      expect(screen.queryByRole('link', { name: /sign in/i })).toBeNull();
      expect(screen.queryByRole('link', { name: /start your first story/i })).toBeNull();
    });

    it('keeps the book links on their existing destinations', () => {
      render(<HomeAuthCta />);
      expect(href(/create a personalized book/i)).toBe('/dashboard');
      expect(href(/view my books/i)).toBe('/dashboard');
    });
  });
});
