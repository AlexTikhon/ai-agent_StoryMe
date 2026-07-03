import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import HomePage from './page';
import { useAuth } from '@/lib/auth/auth-context';

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: vi.fn(),
}));

function mockAuth(status: 'loading' | 'authed' | 'anon') {
  vi.mocked(useAuth).mockReturnValue({
    user: null,
    status,
    authMode: 'jwt',
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  });
}

describe('HomePage', () => {
  beforeEach(() => {
    mockAuth('anon');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the StoryMe heading', () => {
    render(<HomePage />);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toBeDefined();
    expect(heading.textContent).toBe('StoryMe');
  });

  it('renders the primary CTA link', () => {
    render(<HomePage />);
    const cta = screen.getByRole('link', { name: /create your first book/i });
    expect(cta).toBeDefined();
  });

  it('renders a link to view existing books', () => {
    render(<HomePage />);
    const viewBooks = screen.getByRole('link', { name: /view my books/i });
    expect(viewBooks).toBeDefined();
  });

  it('points the primary CTA at /register when unauthenticated', () => {
    mockAuth('anon');
    render(<HomePage />);
    const cta = screen.getByRole('link', { name: /create your first book/i }) as HTMLAnchorElement;
    const viewBooks = screen.getByRole('link', { name: /view my books/i }) as HTMLAnchorElement;
    expect(cta.getAttribute('href')).toBe('/register');
    expect(viewBooks.getAttribute('href')).toBe('/dashboard');
  });

  it('points the primary CTA at /dashboard when authenticated', () => {
    mockAuth('authed');
    render(<HomePage />);
    const cta = screen.getByRole('link', { name: /create your first book/i }) as HTMLAnchorElement;
    expect(cta.getAttribute('href')).toBe('/dashboard');
  });

  it('renders a Sign In link to /login when unauthenticated', () => {
    mockAuth('anon');
    render(<HomePage />);
    const signIn = screen.getByRole('link', { name: /sign in/i }) as HTMLAnchorElement;
    expect(signIn.getAttribute('href')).toBe('/login');
  });

  it('does not render a Sign In link when already authenticated', () => {
    mockAuth('authed');
    render(<HomePage />);
    expect(screen.queryByRole('link', { name: /sign in/i })).toBeNull();
  });
});
