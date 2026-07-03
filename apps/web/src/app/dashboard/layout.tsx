'use client';

import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/auth-context';

interface DashboardLayoutProps {
  children: ReactNode;
}

export default function DashboardLayout({ children }: DashboardLayoutProps) {
  const { status, user, authMode, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

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
      {children}
    </div>
  );
}
