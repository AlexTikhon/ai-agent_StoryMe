'use client';

import Link from 'next/link';
import { Suspense, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { authApi } from '@/lib/api/auth';

const inputCls =
  'rounded-lg border border-border-default bg-white px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-violet-600 focus:outline-none focus:ring-1 focus:ring-violet-600';

type Status = 'form' | 'submitting' | 'success' | 'error';

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [status, setStatus] = useState<Status>(token ? 'form' : 'error');
  const [error, setError] = useState<string | null>(token ? null : 'Missing reset token.');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!token) {
      setStatus('error');
      setError('Missing reset token.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setStatus('submitting');
    try {
      await authApi.resetPassword(token, password);
      setStatus('success');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Failed to reset password.');
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg-base px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border-default bg-bg-surface p-6 text-center shadow-sm">
        {status === 'success' ? (
          <>
            <h1 className="mb-2 font-display text-xl font-bold text-text-primary">
              Password reset
            </h1>
            <p className="mb-6 text-sm text-text-muted">
              Your password has been updated. You can now sign in.
            </p>
            <Link
              href="/login"
              className="inline-flex h-10 items-center justify-center rounded-xl bg-violet-600 px-5 text-sm font-semibold text-white shadow-brand transition-all hover:bg-violet-500"
            >
              Go to sign in
            </Link>
          </>
        ) : status === 'error' && !token ? (
          <>
            <h1 className="mb-2 font-display text-xl font-bold text-text-primary">
              Reset link invalid
            </h1>
            <p role="alert" className="mb-6 text-sm text-danger-base">
              {error}
            </p>
            <Link
              href="/forgot-password"
              className="text-sm font-medium text-violet-600 hover:text-violet-500"
            >
              Request a new reset link
            </Link>
          </>
        ) : (
          <>
            <h1 className="mb-6 text-left font-display text-xl font-bold text-text-primary">
              Reset password
            </h1>
            <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4 text-left">
              {error && (
                <p
                  role="alert"
                  className="rounded-lg bg-danger-light px-4 py-3 text-sm text-danger-base"
                >
                  {error}
                </p>
              )}

              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-text-secondary">New password</span>
                <input
                  required
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={inputCls}
                />
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-text-secondary">Confirm password</span>
                <input
                  required
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className={inputCls}
                />
              </label>

              <button
                type="submit"
                disabled={status === 'submitting'}
                className="mt-2 inline-flex h-10 items-center justify-center rounded-xl bg-violet-600 text-sm font-semibold text-white shadow-brand transition-all hover:bg-violet-500 disabled:opacity-60"
              >
                {status === 'submitting' ? 'Resetting…' : 'Reset password'}
              </button>
            </form>

            <p className="mt-6 text-center text-sm text-text-muted">
              <Link href="/login" className="font-medium text-violet-600 hover:text-violet-500">
                Back to sign in
              </Link>
            </p>
          </>
        )}
      </div>
    </main>
  );
}
