'use client';

import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { authApi } from '@/lib/api/auth';

type VerifyStatus = 'verifying' | 'success' | 'error';

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmailContent />
    </Suspense>
  );
}

function VerifyEmailContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const [status, setStatus] = useState<VerifyStatus>('verifying');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setError('Missing verification token.');
      return;
    }
    let cancelled = false;
    authApi
      .verifyEmail(token)
      .then(() => {
        if (!cancelled) setStatus('success');
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setStatus('error');
          setError(err instanceof Error ? err.message : 'Verification failed.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg-base px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border-default bg-bg-surface p-6 text-center shadow-sm">
        {status === 'verifying' && <p className="text-sm text-text-muted">Verifying your email…</p>}

        {status === 'success' && (
          <>
            <h1 className="mb-2 font-display text-xl font-bold text-text-primary">
              Email verified
            </h1>
            <p className="mb-6 text-sm text-text-muted">You can now sign in.</p>
            <Link
              href="/login"
              className="inline-flex h-10 items-center justify-center rounded-xl bg-violet-600 px-5 text-sm font-semibold text-white shadow-brand transition-all hover:bg-violet-500"
            >
              Go to sign in
            </Link>
          </>
        )}

        {status === 'error' && (
          <>
            <h1 className="mb-2 font-display text-xl font-bold text-text-primary">
              Verification failed
            </h1>
            <p role="alert" className="mb-6 text-sm text-danger-base">
              {error}
            </p>
            <Link
              href="/login"
              className="text-sm font-medium text-violet-600 hover:text-violet-500"
            >
              Back to sign in
            </Link>
          </>
        )}
      </div>
    </main>
  );
}
