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

  it("leads with personalized illustrated children's storybooks", () => {
    render(<HomePage />);
    expect(
      screen.getByText(/personalized illustrated storybooks starring your child/i),
    ).toBeDefined();
  });

  it('explains the actual journey: personalize, illustrated story, read and download', () => {
    render(<HomePage />);
    expect(screen.getByRole('heading', { name: /personalize it/i })).toBeDefined();
    expect(screen.getByRole('heading', { name: /get an illustrated story/i })).toBeDefined();
    expect(screen.getByRole('heading', { name: /read and download/i })).toBeDefined();
  });

  it('describes the supported input contract accurately', () => {
    const { container } = render(<HomePage />);
    const text = container.textContent ?? '';
    expect(text).toMatch(/age \(1 to 12\)/i);
    expect(text).toMatch(/English, Russian or Polish/);
    expect(text).toMatch(/4 to 12 pages/);
    expect(text).toMatch(/PDF/);
  });

  it('does not promise measured quality, guaranteed likeness, safety or the retired product', () => {
    const { container } = render(<HomePage />);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/guarantee|100%|perfect|always safe|completely safe|exact likeness/i);
    expect(text).not.toMatch(/interactive|branching|detective|choose your path|scenario/i);
    expect(text).toMatch(/cannot catch everything/i);
    expect(text).toMatch(/rather than reproducing your child.s likeness/i);
  });

  describe('when unauthenticated', () => {
    it.each(['anon', 'loading'] as const)(
      'sends the primary CTA to registration with the book-creation destination (%s)',
      (status) => {
        mockAuth(status);
        render(<HomePage />);
        expect(linkHref(/^create a book$/i)).toBe('/register?next=%2Fdashboard%2Fbooks%2Fnew');
        expect(linkHref(/^sign in$/i)).toBe('/login?next=%2Fdashboard%2Fbooks%2Fnew');
        expect(linkHref(/open my library/i)).toBe('/dashboard');
      },
    );
  });

  describe('when authenticated', () => {
    beforeEach(() => mockAuth('authed'));

    it('sends the primary CTA straight to the book wizard', () => {
      render(<HomePage />);
      expect(linkHref(/^create a book$/i)).toBe('/dashboard/books/new');
    });

    it('does not render a sign-in link', () => {
      render(<HomePage />);
      expect(screen.queryByRole('link', { name: /sign in/i })).toBeNull();
    });

    it('keeps the library link', () => {
      render(<HomePage />);
      expect(linkHref(/open my library/i)).toBe('/dashboard');
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
