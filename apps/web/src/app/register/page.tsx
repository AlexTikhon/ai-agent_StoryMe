'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/auth-context';

const inputCls =
  'rounded-lg border border-border-default bg-white px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-violet-600 focus:outline-none focus:ring-1 focus:ring-violet-600';

export default function RegisterPage() {
  const { register, status, authMode } = useAuth();
  const router = useRouter();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // router is intentionally excluded: only auth state transitions should
    // trigger the redirect, not router identity.
    if (authMode === 'jwt' && status === 'authed') {
      router.replace('/dashboard');
    }
  }, [authMode, status]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const trimmedName = name.trim();
      await register(email, password, trimmedName || undefined);
      router.push('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to register');
      setSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg-base px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border-default bg-bg-surface p-6 shadow-sm">
        <h1 className="mb-6 font-display text-2xl font-bold text-text-primary">
          Create an account
        </h1>

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
            <span className="text-sm font-medium text-text-secondary">
              Name <span className="text-text-muted">(optional)</span>
            </span>
            <input
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              className={inputCls}
            />
          </label>

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
            <span className="text-sm font-medium text-text-secondary">Password</span>
            <input
              required
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              className={inputCls}
            />
            <span className="text-xs text-text-muted">
              At least 8 characters, with one uppercase letter and one number.
            </span>
          </label>

          <button
            type="submit"
            disabled={submitting}
            className="mt-2 inline-flex h-10 items-center justify-center rounded-xl bg-violet-600 text-sm font-semibold text-white shadow-brand transition-all hover:bg-violet-500 disabled:opacity-60"
          >
            {submitting ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-text-muted">
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-violet-600 hover:text-violet-500">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
