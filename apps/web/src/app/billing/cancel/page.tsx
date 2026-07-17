'use client';

import Link from 'next/link';

export default function BillingCancelPage() {
  return (
    <main className="min-h-dvh bg-bg-base px-4 py-10">
      <div className="mx-auto max-w-lg">
        <h1 className="mb-6 mt-4 font-display text-3xl font-bold text-text-primary">
          Checkout cancelled
        </h1>

        <div className="rounded-2xl border border-border-default bg-bg-surface p-6 shadow-sm">
          <p role="status" className="mb-4 text-sm text-text-secondary">
            Your checkout was cancelled. No credits were added and you were not charged.
          </p>
          <Link
            href="/dashboard/credits"
            className="text-sm font-semibold text-violet-600 hover:text-violet-500"
          >
            Back to credits
          </Link>
        </div>
      </div>
    </main>
  );
}
