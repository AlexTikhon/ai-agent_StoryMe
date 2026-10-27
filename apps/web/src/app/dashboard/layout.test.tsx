import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter, usePathname } from 'next/navigation';
import DashboardLayout from './layout';
import { useAuth } from '@/lib/auth/auth-context';
import { authApi } from '@/lib/api/auth';
import { creditsApi } from '@/lib/api/credits';
import { CREDITS_UPDATED_EVENT } from '@/lib/credits-events';
import { UserRole } from '@book/types';
import type { UserDto } from '@book/types';
import type { ReactNode } from 'react';

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
  usePathname: vi.fn(),
}));

vi.mock('next/link', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: vi.fn(),
}));

vi.mock('@/lib/api/auth', () => ({
  authApi: { resendVerification: vi.fn() },
}));

vi.mock('@/lib/api/credits', () => ({
  creditsApi: { getBalance: vi.fn() },
}));

const MOCK_USER: UserDto = {
  id: 'user-1',
  email: 'emma@example.com',
  name: 'Emma',
  role: UserRole.User,
  emailVerified: true,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

describe('DashboardLayout', () => {
  const pushMock = vi.fn();
  const replaceMock = vi.fn();
  const logoutMock = vi.fn();

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_PRODUCT_MODE', 'demo');
    pushMock.mockReset();
    replaceMock.mockReset();
    logoutMock.mockReset();
    vi.mocked(useRouter).mockReturnValue({
      push: pushMock,
      replace: replaceMock,
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(usePathname).mockReturnValue('/dashboard');
    vi.mocked(creditsApi.getBalance).mockReset().mockResolvedValue({
      balance: 5,
      creditsUpdatedAt: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('redirects to /login when unauthenticated in jwt mode', async () => {
    vi.mocked(useAuth).mockReturnValue({
      user: null,
      status: 'anon',
      authMode: 'jwt',
      login: vi.fn(),
      register: vi.fn(),
      logout: logoutMock,
      retrySession: vi.fn(),
    });

    render(
      <DashboardLayout>
        <p>Protected content</p>
      </DashboardLayout>,
    );

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/login?next=%2Fdashboard');
    });
    expect(screen.queryByText('Protected content')).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Skip to content' })).toBeNull();
  });

  it('renders children when authenticated in jwt mode', async () => {
    vi.mocked(useAuth).mockReturnValue({
      user: MOCK_USER,
      status: 'authed',
      authMode: 'jwt',
      login: vi.fn(),
      register: vi.fn(),
      logout: logoutMock,
      retrySession: vi.fn(),
    });

    render(
      <DashboardLayout>
        <p>Protected content</p>
      </DashboardLayout>,
    );

    expect(screen.getByText('Protected content')).toBeDefined();
    expect(replaceMock).not.toHaveBeenCalled();
    expect(screen.getByText(/emma@example.com/)).toBeDefined();
    await waitFor(() => expect(creditsApi.getBalance).toHaveBeenCalled());
  });

  it('shows a recoverable error, without redirecting or mounting content, when restoration failed temporarily', async () => {
    const retrySession = vi.fn();
    vi.mocked(useAuth).mockReturnValue({
      user: null,
      status: 'error',
      authMode: 'jwt',
      login: vi.fn(),
      register: vi.fn(),
      logout: logoutMock,
      retrySession,
    });

    render(
      <DashboardLayout>
        <p>Protected content</p>
      </DashboardLayout>,
    );

    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.queryByText('Protected content')).toBeNull();
    expect(replaceMock).not.toHaveBeenCalled();
    expect(creditsApi.getBalance).not.toHaveBeenCalled();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Skip to content' })).toBeNull();

    screen.getByRole('button', { name: 'Try again' }).click();
    expect(retrySession).toHaveBeenCalledTimes(1);
  });

  it('shows a loading state instead of redirecting while the session is being restored', () => {
    vi.mocked(useAuth).mockReturnValue({
      user: null,
      status: 'loading',
      authMode: 'jwt',
      login: vi.fn(),
      register: vi.fn(),
      logout: logoutMock,
      retrySession: vi.fn(),
    });

    render(
      <DashboardLayout>
        <p>Protected content</p>
      </DashboardLayout>,
    );

    expect(screen.queryByText('Protected content')).toBeNull();
    expect(replaceMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(creditsApi.getBalance).not.toHaveBeenCalled();
  });

  it('never redirects and always renders children in dev mode', () => {
    vi.mocked(useAuth).mockReturnValue({
      user: null,
      status: 'anon',
      authMode: 'dev',
      login: vi.fn(),
      register: vi.fn(),
      logout: logoutMock,
      retrySession: vi.fn(),
    });

    render(
      <DashboardLayout>
        <p>Protected content</p>
      </DashboardLayout>,
    );

    expect(screen.getByText('Protected content')).toBeDefined();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('logout button calls logout() and redirects to /login', async () => {
    logoutMock.mockResolvedValueOnce(undefined);
    vi.mocked(useAuth).mockReturnValue({
      user: MOCK_USER,
      status: 'authed',
      authMode: 'jwt',
      login: vi.fn(),
      register: vi.fn(),
      logout: logoutMock,
      retrySession: vi.fn(),
    });

    const user = userEvent.setup();
    render(
      <DashboardLayout>
        <p>Protected content</p>
      </DashboardLayout>,
    );

    await user.click(screen.getByRole('button', { name: /log out/i }));

    await waitFor(() => {
      expect(logoutMock).toHaveBeenCalled();
      expect(pushMock).toHaveBeenCalledWith('/login');
    });
  });

  it('shows a verify-email banner with a resend action for an unverified jwt user', async () => {
    vi.mocked(authApi.resendVerification).mockResolvedValueOnce(undefined);
    vi.mocked(useAuth).mockReturnValue({
      user: { ...MOCK_USER, emailVerified: false },
      status: 'authed',
      authMode: 'jwt',
      login: vi.fn(),
      register: vi.fn(),
      logout: logoutMock,
      retrySession: vi.fn(),
    });

    const user = userEvent.setup();
    render(
      <DashboardLayout>
        <p>Protected content</p>
      </DashboardLayout>,
    );

    expect(screen.getByRole('status').textContent).toContain('verify your email');
    await user.click(screen.getByRole('button', { name: /resend verification email/i }));

    await waitFor(() => {
      expect(authApi.resendVerification).toHaveBeenCalledWith('emma@example.com');
    });
  });

  it('does not show the verify-email banner for a verified user', async () => {
    vi.mocked(useAuth).mockReturnValue({
      user: MOCK_USER,
      status: 'authed',
      authMode: 'jwt',
      login: vi.fn(),
      register: vi.fn(),
      logout: logoutMock,
      retrySession: vi.fn(),
    });

    render(
      <DashboardLayout>
        <p>Protected content</p>
      </DashboardLayout>,
    );

    expect(screen.queryByRole('status')).toBeNull();
    await waitFor(() => expect(creditsApi.getBalance).toHaveBeenCalled());
  });

  it('does not render a logout button in dev mode', async () => {
    vi.mocked(useAuth).mockReturnValue({
      user: null,
      status: 'authed',
      authMode: 'dev',
      login: vi.fn(),
      register: vi.fn(),
      logout: logoutMock,
      retrySession: vi.fn(),
    });

    render(
      <DashboardLayout>
        <p>Protected content</p>
      </DashboardLayout>,
    );

    expect(screen.queryByRole('button', { name: /log out/i })).toBeNull();
    await waitFor(() => expect(creditsApi.getBalance).toHaveBeenCalled());
  });

  it('renders the credit balance and a Buy credits link once authenticated', async () => {
    vi.mocked(useAuth).mockReturnValue({
      user: MOCK_USER,
      status: 'authed',
      authMode: 'jwt',
      login: vi.fn(),
      register: vi.fn(),
      logout: logoutMock,
      retrySession: vi.fn(),
    });

    render(
      <DashboardLayout>
        <p>Protected content</p>
      </DashboardLayout>,
    );

    await waitFor(() => {
      expect(screen.getByText('5 credits')).toBeDefined();
    });
    expect(screen.getByRole('link', { name: /buy credits/i })).toHaveProperty(
      'href',
      expect.stringContaining('/dashboard/credits'),
    );
  });

  it('uses family wording and does not fetch or render purchases in home mode', () => {
    vi.stubEnv('NEXT_PUBLIC_PRODUCT_MODE', 'home');
    vi.mocked(useAuth).mockReturnValue({
      user: MOCK_USER,
      status: 'authed',
      authMode: 'jwt',
      login: vi.fn(),
      register: vi.fn(),
      logout: logoutMock,
      retrySession: vi.fn(),
    });

    render(
      <DashboardLayout>
        <p>Protected content</p>
      </DashboardLayout>,
    );

    expect(screen.getByRole('link', { name: 'Family library' }).getAttribute('href')).toBe(
      '/dashboard',
    );
    expect(screen.queryByRole('link', { name: 'Books' })).toBeNull();
    expect(screen.queryByRole('link', { name: /credit/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /buy credits/i })).toBeNull();
    expect(creditsApi.getBalance).not.toHaveBeenCalled();
  });

  it.each(['home', 'demo'])('links to the interactive story in %s mode', (mode) => {
    vi.stubEnv('NEXT_PUBLIC_PRODUCT_MODE', mode);
    vi.mocked(useAuth).mockReturnValue({
      user: MOCK_USER,
      status: 'authed',
      authMode: 'jwt',
      login: vi.fn(),
      register: vi.fn(),
      logout: logoutMock,
      retrySession: vi.fn(),
    });

    render(
      <DashboardLayout>
        <p>Protected content</p>
      </DashboardLayout>,
    );

    expect(screen.getByRole('link', { name: 'Interactive story' })).toHaveProperty(
      'href',
      expect.stringContaining('/dashboard/interactive'),
    );
    expect(screen.getByRole('link', { name: 'Child profiles' })).toBeDefined();
  });

  it('does not hide protected children when the balance fetch fails', async () => {
    vi.mocked(creditsApi.getBalance).mockRejectedValueOnce(new Error('boom'));
    vi.mocked(useAuth).mockReturnValue({
      user: MOCK_USER,
      status: 'authed',
      authMode: 'jwt',
      login: vi.fn(),
      register: vi.fn(),
      logout: logoutMock,
      retrySession: vi.fn(),
    });

    render(
      <DashboardLayout>
        <p>Protected content</p>
      </DashboardLayout>,
    );

    await waitFor(() => {
      expect(screen.getByText(/credits unavailable/i)).toBeDefined();
    });
    expect(screen.getByText('Protected content')).toBeDefined();
  });

  it('refetches the balance when a credits-updated event is dispatched', async () => {
    vi.mocked(useAuth).mockReturnValue({
      user: MOCK_USER,
      status: 'authed',
      authMode: 'jwt',
      login: vi.fn(),
      register: vi.fn(),
      logout: logoutMock,
      retrySession: vi.fn(),
    });

    render(
      <DashboardLayout>
        <p>Protected content</p>
      </DashboardLayout>,
    );

    await waitFor(() => {
      expect(screen.getByText('5 credits')).toBeDefined();
    });

    vi.mocked(creditsApi.getBalance).mockResolvedValueOnce({ balance: 15, creditsUpdatedAt: null });
    window.dispatchEvent(new Event(CREDITS_UPDATED_EVENT));

    await waitFor(() => {
      expect(screen.getByText('15 credits')).toBeDefined();
    });
  });

  describe('navigation', () => {
    /** Renders an authed jwt dashboard and lets any demo-mode balance fetch settle. */
    async function renderAuthed(children: ReactNode = <p>Protected content</p>) {
      vi.mocked(useAuth).mockReturnValue({
        user: MOCK_USER,
        status: 'authed',
        authMode: 'jwt',
        login: vi.fn(),
        register: vi.fn(),
        logout: logoutMock,
        retrySession: vi.fn(),
      });
      const result = render(<DashboardLayout>{children}</DashboardLayout>);
      await waitFor(() => expect(screen.queryByText('Credits…')).toBeNull());
      return result;
    }

    const BOOKS_LABEL = { home: 'Family library', demo: 'Books' } as const;

    it.each(['home', 'demo'] as const)(
      'exposes a named navigation landmark with books, profiles and interactive links in %s mode',
      async (mode) => {
        vi.stubEnv('NEXT_PUBLIC_PRODUCT_MODE', mode);
        await renderAuthed();

        const nav = screen.getByRole('navigation', { name: 'Dashboard' });
        const links = within(nav).getAllByRole('link');
        expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
          [BOOKS_LABEL[mode], '/dashboard'],
          ['Child profiles', '/dashboard/child-profiles'],
          ['Interactive story', '/dashboard/interactive'],
        ]);
      },
    );

    it('keeps demo credits and purchase links outside the primary navigation', async () => {
      await renderAuthed();

      await waitFor(() => expect(screen.getByText('5 credits')).toBeDefined());
      const nav = screen.getByRole('navigation', { name: 'Dashboard' });
      expect(within(nav).queryByRole('link', { name: /credit/i })).toBeNull();
      expect(screen.getByRole('link', { name: 'Buy credits' }).getAttribute('href')).toBe(
        '/dashboard/credits',
      );
      expect(creditsApi.getBalance).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['/dashboard', 'Books'],
      ['/dashboard/', 'Books'],
      ['/dashboard/books/new', 'Books'],
      ['/dashboard/books/00000000-0000-4000-8000-000000000006', 'Books'],
      ['/dashboard/child-profiles', 'Child profiles'],
      ['/dashboard/child-profiles/edit', 'Child profiles'],
      ['/dashboard/interactive', 'Interactive story'],
      ['/dashboard/interactive/session-1', 'Interactive story'],
      ['/dashboard/interactive/session-1/transcript', 'Interactive story'],
      ['/dashboard/credits', null],
      ['/dashboard/bookshelf', null],
      ['/dashboard/child-profiles-archive', null],
      ['/dashboard/interactive-legacy', null],
      ['/dashboardx', null],
    ])('marks the current section for %s', async (pathname, expected) => {
      vi.mocked(usePathname).mockReturnValue(pathname);
      await renderAuthed();

      const nav = screen.getByRole('navigation', { name: 'Dashboard' });
      const current = within(nav)
        .getAllByRole('link')
        .filter((link) => link.getAttribute('aria-current') === 'page')
        .map((link) => link.textContent);
      expect(current).toEqual(expected === null ? [] : [expected]);
    });

    it('offers a skip link as the first focusable control that moves focus to the page content', async () => {
      const user = userEvent.setup();
      const { container } = await renderAuthed(
        <main>
          <h1>Page heading</h1>
          <button>First page control</button>
        </main>,
      );

      const skip = screen.getByRole('link', { name: 'Skip to content' });
      const targetId = skip.getAttribute('href')?.replace(/^#/, '') ?? '';
      const target = document.getElementById(targetId);
      expect(target).not.toBeNull();
      expect(target?.contains(screen.getByRole('main'))).toBe(true);
      expect(container.querySelectorAll('main')).toHaveLength(1);

      await user.tab();
      expect(document.activeElement).toBe(skip);
      await user.keyboard('{Enter}');
      expect(document.activeElement).toBe(target);

      await user.tab();
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'First page control' }),
      );
    });

    it('orders the skip link, navigation and account controls before the page content', async () => {
      await renderAuthed(<button>First page control</button>);

      const order = [
        screen.getByRole('link', { name: 'Skip to content' }),
        screen.getByRole('link', { name: 'Books' }),
        screen.getByRole('link', { name: 'Interactive story' }),
        screen.getByRole('link', { name: 'Buy credits' }),
        screen.getByRole('button', { name: /log out/i }),
        screen.getByRole('button', { name: 'First page control' }),
      ];
      for (let i = 1; i < order.length; i++) {
        expect(
          order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      }
    });
  });
});
