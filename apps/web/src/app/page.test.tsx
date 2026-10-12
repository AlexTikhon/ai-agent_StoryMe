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
    retrySession: vi.fn(),
  });
}

const linkHref = (name: RegExp) =>
  (screen.getByRole('link', { name }) as HTMLAnchorElement).getAttribute('href');

describe('HomePage', () => {
  beforeEach(() => {
    mockAuth('anon');
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('renders the StoryMe heading', () => {
    render(<HomePage />);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('StoryMe');
  });

  it('leads with interactive illustrated stories', () => {
    render(<HomePage />);
    expect(screen.getByText(/interactive illustrated stories/i)).toBeDefined();
  });

  it('explains the actual experience: choose, resume, reread with illustrations', () => {
    render(<HomePage />);
    expect(screen.getByRole('heading', { name: /choose a path/i })).toBeDefined();
    expect(screen.getByRole('heading', { name: /resume later/i })).toBeDefined();
    expect(screen.getByRole('heading', { name: /reread with illustrations/i })).toBeDefined();
  });

  it('states that gameplay is deterministic and AI assists only scenario authoring', () => {
    render(<HomePage />);
    expect(screen.getByText(/gameplay is deterministic/i)).toBeDefined();
    expect(screen.getByText(/ai helps authors draft scenarios/i)).toBeDefined();
  });

  it('does not promise live generation, endless stories or suitability for children', () => {
    const { container } = render(<HomePage />);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/children|kids|child-friendly|family-friendly/i);
    expect(text).not.toMatch(/endless|unlimited|library of stories|powered by ai/i);
  });

  describe('when unauthenticated', () => {
    it.each(['anon', 'loading'] as const)(
      'sends the primary CTA to registration with the interactive destination (%s)',
      (status) => {
        mockAuth(status);
        render(<HomePage />);
        expect(linkHref(/start your first story/i)).toBe(
          '/register?next=%2Fdashboard%2Finteractive',
        );
        expect(linkHref(/^sign in$/i)).toBe('/login?next=%2Fdashboard%2Finteractive');
      },
    );

    it('keeps the book links as clearly labelled secondary links', () => {
      render(<HomePage />);
      expect(linkHref(/create a personalized book/i)).toBe('/register');
      expect(linkHref(/view my books/i)).toBe('/dashboard');
    });
  });

  describe('when authenticated', () => {
    beforeEach(() => mockAuth('authed'));

    it('sends the primary CTA straight to the interactive catalogue', () => {
      render(<HomePage />);
      expect(linkHref(/open the story catalogue/i)).toBe('/dashboard/interactive');
    });

    it('does not render a sign-in link', () => {
      render(<HomePage />);
      expect(screen.queryByRole('link', { name: /sign in/i })).toBeNull();
    });

    it('keeps the existing book navigation', () => {
      render(<HomePage />);
      expect(linkHref(/create a personalized book/i)).toBe('/dashboard');
      expect(linkHref(/view my books/i)).toBe('/dashboard');
    });
  });

  describe('infrastructure diagnostics', () => {
    it('displays the configured API health URL in development', () => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/api');
      render(<HomePage />);
      expect(screen.getByText('https://api.example.com/api/health')).toBeDefined();
    });

    it('falls back to the localhost API health URL in development', () => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('NEXT_PUBLIC_API_URL', '');
      render(<HomePage />);
      expect(screen.getByText('http://localhost:4000/api/health')).toBeDefined();
    });

    it.each(['production', 'test'] as const)('is hidden when NODE_ENV is %s', (env) => {
      vi.stubEnv('NODE_ENV', env);
      vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com/api');
      const { container } = render(<HomePage />);
      expect(container.textContent).not.toMatch(/api\.example\.com|API:|diagnostics/i);
    });

    it('renders without a configuration error in production when the API URL is unset', () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('NEXT_PUBLIC_API_URL', '');
      render(<HomePage />);
      expect(screen.queryByText(/NEXT_PUBLIC_API_URL/)).toBeNull();
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('StoryMe');
    });
  });
});
