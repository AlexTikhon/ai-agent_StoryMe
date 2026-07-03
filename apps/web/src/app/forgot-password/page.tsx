'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { authApi } from '@/lib/api/auth';

const inputCls =
  'rounded-lg border border-border-default bg-white px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-violet-600 focus:outline-none focus:ring-1 focus:ring-violet-600';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await authApi.requestPasswordReset(email);
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send reset link');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg-base px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border-default bg-bg-surface p-6 shadow-sm">
        <h1 className="mb-6 font-display text-2xl font-bold text-text-primary">Forgot password</h1>

        {submitted ? (
          <p role="status" className="text-sm text-text-secondary">
            If an account exists for this email, a reset link has been sent.
          </p>
        ) : (
          <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
            {error && (
              <p
                role="alert"
                className="rounded-lg bg-danger-light px-4 py-3 text-sm text-danger-base"
              >
                {error}
              </p>
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

            <button
              type="submit"
              disabled={submitting}
              className="mt-2 inline-flex h-10 items-center justify-center rounded-xl bg-violet-600 text-sm font-semibold text-white shadow-brand transition-all hover:bg-violet-500 disabled:opacity-60"
            >
              {submitting ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
        )}

        <p className="mt-6 text-center text-sm text-text-muted">
          <Link href="/login" className="font-medium text-violet-600 hover:text-violet-500">
            Back to sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
