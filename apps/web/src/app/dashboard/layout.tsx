'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import { authApi } from '@/lib/api/auth';
import { creditsApi } from '@/lib/api/credits';
import { CREDITS_UPDATED_EVENT } from '@/lib/credits-events';
import { isHomeProductMode } from '@/lib/product-mode';

interface DashboardLayoutProps {
  children: ReactNode;
}

type DashboardSection = 'books' | 'child-profiles' | 'interactive';

const CONTENT_ID = 'dashboard-content';

const FOCUS_RING =
  'rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-600 focus-visible:ring-offset-2';

const NAV_LINK = `inline-block py-1 font-medium text-text-secondary hover:text-violet-700 aria-[current=page]:text-violet-700 aria-[current=page]:underline aria-[current=page]:decoration-2 aria-[current=page]:underline-offset-4 ${FOCUS_RING}`;

/** True when `pathname` is `base` itself or a route below it (segment-bounded). */
function isWithin(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

function currentSection(rawPathname: string | null): DashboardSection | null {
  const pathname = (rawPathname ?? '').replace(/(.)\/+$/, '$1');
  if (pathname === '/dashboard' || isWithin(pathname, '/dashboard/books')) return 'books';
  if (isWithin(pathname, '/dashboard/child-profiles')) return 'child-profiles';
  if (isWithin(pathname, '/dashboard/interactive')) return 'interactive';
  return null;
}

export default function DashboardLayout({ children }: DashboardLayoutProps) {
  const { status, user, authMode, logout, retrySession } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const homeMode = isHomeProductMode();
  const [resendStatus, setResendStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
  const contentRef = useRef<HTMLDivElement>(null);

  const [balance, setBalance] = useState<number | null>(null);
  const [balanceFailed, setBalanceFailed] = useState(false);

  const loadBalance = useCallback(async () => {
    try {
      const data = await creditsApi.getBalance();
      setBalance(data.balance);
      setBalanceFailed(false);
    } catch {
      // A failed balance fetch must never block dashboard navigation/rendering.
      setBalanceFailed(true);
    }
  }, []);

  useEffect(() => {
    if (status !== 'authed' || homeMode) return;
    void loadBalance();
  }, [status, homeMode, loadBalance]);

  // Refreshes the header balance immediately once a checkout is confirmed
  // credited (see /billing/success), rather than waiting for an unrelated
  // re-render.
  useEffect(() => {
    if (homeMode) return;
    const onCreditsUpdated = () => void loadBalance();
    window.addEventListener(CREDITS_UPDATED_EVENT, onCreditsUpdated);
    return () => window.removeEventListener(CREDITS_UPDATED_EVENT, onCreditsUpdated);
  }, [homeMode, loadBalance]);

  const handleResend = async () => {
    if (!user) return;
    setResendStatus('sending');
    try {
      await authApi.resendVerification(user.email);
    } finally {
      setResendStatus('sent');
    }
  };

  // Dev mode has no real login wall — identity travels via header on every
  // request, so the dashboard is never gated in that mode.
  const gated = authMode === 'jwt';

  useEffect(() => {
    if (gated && status === 'anon') {
      router.replace(`/login?next=${encodeURIComponent(pathname || '/dashboard')}`);
    }
  }, [gated, status, pathname, router]);

  if (gated && status === 'loading') {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg-base">
        <p className="text-sm text-text-muted">Loading…</p>
      </div>
    );
  }

  if (gated && status === 'anon') {
    return null;
  }

  // A temporary outage (network failure, 429, 5xx) is not a logged-out
  // session: show a recoverable error without mounting authenticated content.
  if (gated && status === 'error') {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg-base">
        <div role="alert" className="max-w-sm space-y-3 text-center">
          <p className="text-sm text-text-secondary">
            We couldn&apos;t reach the service to restore your session. Your account is still signed
            in — please try again.
          </p>
          <button
            onClick={retrySession}
            className="font-medium text-violet-600 hover:text-violet-500"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  const handleLogout = () => {
    void logout().then(() => router.push('/login'));
  };

  // Focus the content wrapper directly rather than following the fragment, so
  // the app router never sees a hash navigation.
  const handleSkipToContent = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    contentRef.current?.focus();
  };

  const section = currentSection(pathname);
  const ariaCurrent = (target: DashboardSection) => (section === target ? 'page' : undefined);

  return (
    <div>
      <a
        href={`#${CONTENT_ID}`}
        onClick={handleSkipToContent}
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-bg-surface focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-violet-700 focus:shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-600"
      >
        Skip to content
      </a>
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-b border-border-subtle bg-bg-surface px-4 py-2 text-sm">
        <nav aria-label="Dashboard">
          <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <li>
              <Link href="/dashboard" aria-current={ariaCurrent('books')} className={NAV_LINK}>
                {homeMode ? 'Family library' : 'Books'}
              </Link>
            </li>
            <li>
              <Link
                href="/dashboard/child-profiles"
                aria-current={ariaCurrent('child-profiles')}
                className={NAV_LINK}
              >
                Child profiles
              </Link>
            </li>
            <li>
              <Link
                href="/dashboard/interactive"
                aria-current={ariaCurrent('interactive')}
                className={NAV_LINK}
              >
                Interactive story
              </Link>
            </li>
          </ul>
        </nav>
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          {!homeMode && (
            <>
              <Link
                href="/dashboard/credits"
                className={`py-1 font-medium text-text-secondary hover:text-violet-700 ${FOCUS_RING}`}
              >
                {balanceFailed
                  ? 'Credits unavailable'
                  : balance !== null
                    ? `${balance} credit${balance === 1 ? '' : 's'}`
                    : 'Credits…'}
              </Link>
              <Link
                href="/dashboard/credits"
                className={`py-1 font-medium text-violet-600 hover:text-violet-500 ${FOCUS_RING}`}
              >
                Buy credits
              </Link>
            </>
          )}
          <span className="min-w-0 text-text-muted">
            Signed in as{' '}
            <span className="font-medium text-text-secondary [overflow-wrap:anywhere]">
              {user?.email ?? 'dev@storyme.local'}
            </span>
          </span>
          {authMode === 'jwt' && (
            <button
              onClick={handleLogout}
              className={`py-1 font-medium text-violet-600 hover:text-violet-500 ${FOCUS_RING}`}
            >
              Log out
            </button>
          )}
        </div>
      </header>
      {authMode === 'jwt' && user && !user.emailVerified && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle bg-amber-50 px-4 py-2 text-sm text-amber-900"
        >
          <span>Please verify your email address to keep full access to your account.</span>
          <button
            onClick={() => void handleResend()}
            disabled={resendStatus === 'sending' || resendStatus === 'sent'}
            className={`font-medium text-violet-700 hover:text-violet-600 disabled:opacity-60 ${FOCUS_RING}`}
          >
            {resendStatus === 'sent'
              ? 'Verification email sent'
              : resendStatus === 'sending'
                ? 'Sending…'
                : 'Resend verification email'}
          </button>
        </div>
      )}
      {/* Pages render their own <main>; this wrapper is only the skip-link target. */}
      <div id={CONTENT_ID} ref={contentRef} tabIndex={-1} className="outline-none">
        {children}
      </div>
    </div>
  );
}
