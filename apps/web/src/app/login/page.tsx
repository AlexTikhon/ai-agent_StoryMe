'use client';

import Link from 'next/link';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth/auth-context';
import { ApiError } from '@/lib/api/api-error';
import { authApi } from '@/lib/api/auth';

const inputCls =
  'rounded-lg border border-border-default bg-white px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-violet-600 focus:outline-none focus:ring-1 focus:ring-violet-600';

function safeNextPath(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const { login, status, authMode } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);
  const [resendStatus, setResendStatus] = useState<'idle' | 'sending' | 'sent'>('idle');

  useEffect(() => {
    // router/searchParams are intentionally excluded: only auth state
    // transitions should trigger the redirect, not router/param identity.
    if (authMode === 'jwt' && status === 'authed') {
      router.replace(safeNextPath(searchParams.get('next')));
    }
  }, [authMode, status]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setUnverifiedEmail(null);
    setResendStatus('idle');
    try {
      await login(email, password);
      router.push(safeNextPath(searchParams.get('next')));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'EMAIL_NOT_VERIFIED') {
        setError('Please verify your email before signing in.');
        setUnverifiedEmail(email);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to sign in');
      }
      setSubmitting(false);
    }
  };

  const handleResend = async () => {
    if (!unverifiedEmail) return;
    setResendStatus('sending');
    try {
      await authApi.resendVerification(unverifiedEmail);
    } finally {
      setResendStatus('sent');
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg-base px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border-default bg-bg-surface p-6 shadow-sm">
        <h1 className="mb-6 font-display text-2xl font-bold text-text-primary">Sign in</h1>

        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
          {error && (
            <p
              role="alert"
              className="rounded-lg bg-danger-light px-4 py-3 text-sm text-danger-base"
            >
              {error}
            </p>
          )}

          {unverifiedEmail && (
            <button
              type="button"
              onClick={() => void handleResend()}
              disabled={resendStatus === 'sending' || resendStatus === 'sent'}
              className="-mt-2 self-start text-sm font-medium text-violet-600 hover:text-violet-500 disabled:opacity-60"
            >
              {resendStatus === 'sent'
                ? 'Verification email sent — check your inbox.'
                : resendStatus === 'sending'
                  ? 'Sending…'
                  : 'Resend verification email'}
            </button>
          )}

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-text-secondary">Email</span>
            <input
              required
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputCls}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-text-secondary">Password</span>
              <Link
                href="/forgot-password"
                className="text-xs font-medium text-violet-600 hover:text-violet-500"
              >
                Forgot password?
              </Link>
            </div>
            <input
              required
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputCls}
            />
          </label>

          <button
            type="submit"
            disabled={submitting}
            className="mt-2 inline-flex h-10 items-center justify-center rounded-xl bg-violet-600 text-sm font-semibold text-white shadow-brand transition-all hover:bg-violet-500 disabled:opacity-60"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-text-muted">
          Don&apos;t have an account?{' '}
          <Link href="/register" className="font-medium text-violet-600 hover:text-violet-500">
            Register
          </Link>
        </p>
      </div>
    </main>
  );
}
