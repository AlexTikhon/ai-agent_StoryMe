'use client';

import Link from 'next/link';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { CheckoutGrantStatusDto } from '@book/types';
import { billingApi } from '@/lib/api/billing';
import { notifyCreditsUpdated } from '@/lib/credits-events';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 60_000;

/** Mirrors the API's own bound (apps/api/src/billing/billing.service.ts) — checked client-side too so a malformed value never triggers a request. */
const SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]{1,255}$/;

type PollState =
  | { kind: 'invalid' }
  | { kind: 'pending' }
  | { kind: 'credited'; creditsGranted: number; balance: number }
  | { kind: 'timeout' }
  | { kind: 'error'; message: string };

export default function BillingSuccessPage() {
  return (
    <Suspense fallback={null}>
      <BillingSuccessContent />
    </Suspense>
  );
}

function BillingSuccessContent() {
  const searchParams = useSearchParams();
  const rawSessionId = searchParams.get('session_id');
  const sessionId = rawSessionId && SESSION_ID_PATTERN.test(rawSessionId) ? rawSessionId : null;

  const [state, setState] = useState<PollState>(
    sessionId ? { kind: 'pending' } : { kind: 'invalid' },
  );
  const [attempt, setAttempt] = useState(0);
  const notifiedRef = useRef(false);

  useEffect(() => {
    if (!sessionId) return;

    let cancelled = false;
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    const stop = () => clearInterval(timer);

    const poll = async () => {
      let result: CheckoutGrantStatusDto;
      try {
        result = await billingApi.getCheckoutStatus(sessionId);
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Failed to check payment status',
        });
        stop();
        return;
      }
      if (cancelled) return;

      if (result.status === 'credited') {
        setState({
          kind: 'credited',
          creditsGranted: result.creditsGranted,
          balance: result.balance,
        });
        if (!notifiedRef.current) {
          notifiedRef.current = true;
          notifyCreditsUpdated();
        }
        stop();
        return;
      }

      if (Date.now() >= deadline) {
        setState({ kind: 'timeout' });
        stop();
        return;
      }

      setState({ kind: 'pending' });
    };

    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    void poll();

    return () => {
      cancelled = true;
      stop();
    };
  }, [sessionId, attempt]);

  return (
    <main className="min-h-dvh bg-bg-base px-4 py-10">
      <div className="mx-auto max-w-lg">
        <h1 className="mb-6 mt-4 font-display text-3xl font-bold text-text-primary">Checkout</h1>

        <div className="rounded-2xl border border-border-default bg-bg-surface p-6 shadow-sm">
          {state.kind === 'invalid' && (
            <div role="alert">
              <p className="mb-4 text-sm text-danger-base">
                We couldn&apos;t find your checkout session.
              </p>
              <Link
                href="/dashboard/credits"
                className="text-sm font-semibold text-violet-600 hover:text-violet-500"
              >
                Back to credits
              </Link>
            </div>
          )}

          {state.kind === 'pending' && (
            <p role="status" aria-live="polite" className="text-sm text-text-secondary">
              Confirming your purchase… this usually takes just a few seconds.
            </p>
          )}

          {state.kind === 'credited' && (
            <div>
              <h2 className="mb-2 font-display text-xl font-semibold text-emerald-800">
                Payment confirmed!
              </h2>
              <p className="mb-1 text-sm text-text-secondary">
                {state.creditsGranted} credit{state.creditsGranted === 1 ? '' : 's'} added.
              </p>
              <p className="mb-4 text-sm text-text-secondary">
                New balance: {state.balance} credit{state.balance === 1 ? '' : 's'}.
              </p>
              <div className="flex gap-4">
                <Link
                  href="/dashboard/credits"
                  className="text-sm font-semibold text-violet-600 hover:text-violet-500"
                >
                  View credits
                </Link>
                <Link
                  href="/dashboard/books/new"
                  className="text-sm font-semibold text-violet-600 hover:text-violet-500"
                >
                  Create a book
                </Link>
              </div>
            </div>
          )}

          {(state.kind === 'timeout' || state.kind === 'error') && (
            <div role="status">
              <p className="mb-4 text-sm text-text-secondary">
                {state.kind === 'timeout'
                  ? "This is taking longer than expected. We'll keep checking, or you can check again now."
                  : `We couldn't confirm your purchase yet: ${state.message}`}
              </p>
              <div className="flex flex-wrap gap-4">
                <button
                  onClick={() => setAttempt((n) => n + 1)}
                  className="text-sm font-semibold text-violet-600 hover:text-violet-500"
                >
                  Check again
                </button>
                <Link
                  href="/dashboard/credits"
                  className="text-sm font-semibold text-violet-600 hover:text-violet-500"
                >
                  Go to credits
                </Link>
                <Link
                  href="/dashboard"
                  className="text-sm font-semibold text-violet-600 hover:text-violet-500"
                >
                  Go to dashboard
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
