'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import { authApi } from '@/lib/api/auth';

interface DashboardLayoutProps {
  children: ReactNode;
}

export default function DashboardLayout({ children }: DashboardLayoutProps) {
  const { status, user, authMode, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [resendStatus, setResendStatus] = useState<'idle' | 'sending' | 'sent'>('idle');

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

  const handleLogout = () => {
    void logout().then(() => router.push('/login'));
  };

  return (
    <div>
      <div className="flex items-center justify-end gap-4 border-b border-border-subtle bg-bg-surface px-4 py-2 text-sm">
        <span className="text-text-muted">
          Signed in as{' '}
          <span className="font-medium text-text-secondary">
            {user?.email ?? 'dev@storyme.local'}
          </span>
        </span>
        {authMode === 'jwt' && (
          <button
            onClick={handleLogout}
            className="font-medium text-violet-600 hover:text-violet-500"
          >
            Log out
          </button>
        )}
      </div>
      {authMode === 'jwt' && user && !user.emailVerified && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle bg-amber-50 px-4 py-2 text-sm text-amber-900"
        >
          <span>Please verify your email address to keep full access to your account.</span>
          <button
            onClick={() => void handleResend()}
            disabled={resendStatus === 'sending' || resendStatus === 'sent'}
            className="font-medium text-violet-700 hover:text-violet-600 disabled:opacity-60"
          >
            {resendStatus === 'sent'
              ? 'Verification email sent'
              : resendStatus === 'sending'
                ? 'Sending…'
                : 'Resend verification email'}
          </button>
        </div>
      )}
      {children}
    </div>
  );
}
