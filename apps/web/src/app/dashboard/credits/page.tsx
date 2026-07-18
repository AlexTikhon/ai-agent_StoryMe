'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CreditReason } from '@book/types';
import type { CreditPackageCatalogDto, CreditPackageId, CreditTransactionDto } from '@book/types';
import { billingApi } from '@/lib/api/billing';
import { creditsApi } from '@/lib/api/credits';

const REASON_LABELS: Record<CreditReason, string> = {
  [CreditReason.BookCreation]: 'Book creation',
  [CreditReason.RegenPage]: 'Page regeneration',
  [CreditReason.RefundGenerationFailure]: 'Refund — generation failed',
  [CreditReason.RefundGenerationCancelled]: 'Refund — generation cancelled',
  [CreditReason.Purchase]: 'Credit purchase',
  [CreditReason.SubscriptionGrant]: 'Subscription grant',
  [CreditReason.PromotionalGrant]: 'Promotional grant',
  [CreditReason.AdminAdjustment]: 'Admin adjustment',
};

function reasonLabel(reason: CreditReason): string {
  return REASON_LABELS[reason] ?? reason;
}

function packageName(id: CreditPackageId): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** Fails closed: only a well-formed https:// URL is ever navigated to. */
function isSafeCheckoutUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export default function CreditsPage() {
  // ── Balance ──────────────────────────────────────────────────────────────
  const [balance, setBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(true);
  const [balanceError, setBalanceError] = useState<string | null>(null);

  const loadBalance = useCallback(async () => {
    setBalanceLoading(true);
    setBalanceError(null);
    try {
      const data = await creditsApi.getBalance();
      setBalance(data.balance);
    } catch (err) {
      setBalanceError(err instanceof Error ? err.message : 'Failed to load balance');
    } finally {
      setBalanceLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBalance();
  }, [loadBalance]);

  // ── Packages ─────────────────────────────────────────────────────────────
  const [catalog, setCatalog] = useState<CreditPackageCatalogDto | null>(null);
  const [packagesLoading, setPackagesLoading] = useState(true);
  const [packagesError, setPackagesError] = useState<string | null>(null);

  const loadPackages = useCallback(async () => {
    setPackagesLoading(true);
    setPackagesError(null);
    try {
      const data = await billingApi.getPackages();
      setCatalog(data);
    } catch (err) {
      setPackagesError(err instanceof Error ? err.message : 'Failed to load credit packages');
    } finally {
      setPackagesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPackages();
  }, [loadPackages]);

  // ── Checkout submission (one at a time, deduped via a fresh Idempotency-Key) ──
  const submittingRef = useRef(false);
  const idempotencyKeyRef = useRef<string | null>(null);
  const [submittingPackageId, setSubmittingPackageId] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  const handleBuy = async (packageId: CreditPackageId) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmittingPackageId(packageId);
    setCheckoutError(null);
    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current = crypto.randomUUID();
    }
    try {
      const session = await billingApi.createCheckout(packageId, idempotencyKeyRef.current);
      if (!isSafeCheckoutUrl(session.url)) {
        setCheckoutError('Checkout could not be started. Please try again.');
        return;
      }
      window.location.assign(session.url);
    } catch (err) {
      setCheckoutError(err instanceof Error ? err.message : 'Failed to start checkout');
    } finally {
      idempotencyKeyRef.current = null;
      submittingRef.current = false;
      setSubmittingPackageId(null);
    }
  };

  // ── Transaction history (cursor-paginated) ────────────────────────────────
  const [transactions, setTransactions] = useState<CreditTransactionDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [txLoading, setTxLoading] = useState(true);
  const [txLoadingMore, setTxLoadingMore] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);

  const loadTransactions = useCallback(async (cursor?: string) => {
    if (cursor) setTxLoadingMore(true);
    else setTxLoading(true);
    setTxError(null);
    try {
      const page = await creditsApi.getTransactions(cursor ? { cursor } : {});
      setTransactions((prev) => (cursor ? [...prev, ...page.items] : page.items));
      setNextCursor(page.nextCursor);
    } catch (err) {
      setTxError(err instanceof Error ? err.message : 'Failed to load transaction history');
    } finally {
      setTxLoading(false);
      setTxLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    void loadTransactions();
  }, [loadTransactions]);

  return (
    <main className="min-h-dvh bg-bg-base px-4 py-10">
      <div className="mx-auto max-w-lg">
        <Link
          href="/dashboard"
          className="mb-8 inline-flex items-center gap-1 text-sm font-medium text-text-muted hover:text-text-primary"
        >
          ← My Book Drafts
        </Link>

        <h1 className="mb-6 mt-4 font-display text-3xl font-bold text-text-primary">Credits</h1>

        {/* ── Balance ── */}
        <section
          aria-label="Credit balance"
          className="mb-6 rounded-2xl border border-border-default bg-bg-surface p-6 shadow-sm"
        >
          {balanceLoading && <p className="text-sm text-text-muted">Loading balance…</p>}
          {!balanceLoading && balanceError && (
            <div role="alert" className="flex items-center justify-between gap-4">
              <p className="text-sm text-danger-base">{balanceError}</p>
              <button
                onClick={() => void loadBalance()}
                className="shrink-0 text-sm font-semibold text-danger-base underline"
              >
                Retry
              </button>
            </div>
          )}
          {!balanceLoading && !balanceError && balance !== null && (
            <p className="text-2xl font-semibold text-text-primary">
              {balance} credit{balance === 1 ? '' : 's'}
            </p>
          )}
        </section>

        {/* ── Packages ── */}
        <section className="mb-6">
          <h2 className="mb-3 font-display text-xl font-semibold text-text-primary">
            Buy more credits
          </h2>

          {packagesLoading && <p className="text-sm text-text-muted">Loading packages…</p>}

          {!packagesLoading && packagesError && (
            <div
              role="alert"
              className="flex items-center justify-between gap-4 rounded-xl border border-danger-base/20 bg-danger-light px-5 py-4"
            >
              <p className="text-sm text-danger-base">{packagesError}</p>
              <button
                onClick={() => void loadPackages()}
                className="shrink-0 text-sm font-semibold text-danger-base underline"
              >
                Retry
              </button>
            </div>
          )}

          {!packagesLoading && !packagesError && catalog && !catalog.checkoutEnabled && (
            <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
              Buying credits isn&apos;t available right now. Please check back later.
            </p>
          )}

          {!packagesLoading && !packagesError && catalog && catalog.packages.length > 0 && (
            <ul className="grid gap-3 sm:grid-cols-3">
              {catalog.packages.map((pkg) => {
                const isSubmittingThis = submittingPackageId === pkg.id;
                const disabled = !catalog.checkoutEnabled || submittingPackageId !== null;
                return (
                  <li
                    key={pkg.id}
                    className="flex flex-col items-center gap-2 rounded-2xl border border-border-default bg-bg-surface p-5 text-center shadow-xs"
                  >
                    <p className="font-display text-lg font-semibold text-text-primary">
                      {packageName(pkg.id)}
                    </p>
                    <p className="text-sm text-text-muted">{pkg.credits} credits</p>
                    <button
                      onClick={() => void handleBuy(pkg.id)}
                      disabled={disabled}
                      aria-disabled={disabled}
                      className="mt-2 w-full rounded-xl bg-violet-600 py-2 text-sm font-semibold text-white shadow-brand transition-all hover:bg-violet-500 disabled:opacity-60"
                    >
                      {isSubmittingThis ? 'Redirecting…' : 'Continue to secure checkout'}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {submittingPackageId && (
            <p role="status" aria-live="polite" className="mt-3 text-sm text-text-muted">
              Creating your secure checkout session…
            </p>
          )}

          {checkoutError && (
            <p
              role="alert"
              className="mt-3 rounded-lg bg-danger-light px-4 py-3 text-sm text-danger-base"
            >
              {checkoutError}
            </p>
          )}
        </section>

        {/* ── Transaction history ── */}
        <section>
          <h2 className="mb-3 font-display text-xl font-semibold text-text-primary">
            Transaction history
          </h2>

          {txLoading && <p className="text-sm text-text-muted">Loading transaction history…</p>}

          {!txLoading && txError && (
            <div
              role="alert"
              className="flex items-center justify-between gap-4 rounded-xl border border-danger-base/20 bg-danger-light px-5 py-4"
            >
              <p className="text-sm text-danger-base">{txError}</p>
              <button
                onClick={() => void loadTransactions()}
                className="shrink-0 text-sm font-semibold text-danger-base underline"
              >
                Retry
              </button>
            </div>
          )}

          {!txLoading && !txError && transactions.length === 0 && (
            <p className="text-sm text-text-muted">No transactions yet.</p>
          )}

          {!txLoading && !txError && transactions.length > 0 && (
            <>
              <ul className="divide-y divide-border-subtle rounded-2xl border border-border-default bg-bg-surface">
                {transactions.map((tx) => {
                  const isDebit = tx.amount < 0;
                  return (
                    <li key={tx.id} className="flex items-center justify-between gap-4 px-5 py-3">
                      <div>
                        <p className="text-sm font-medium text-text-primary">
                          {reasonLabel(tx.reason)}
                        </p>
                        <p className="text-xs text-text-muted">
                          {new Date(tx.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="text-right">
                        <p
                          className={`text-sm font-semibold ${isDebit ? 'text-danger-base' : 'text-success-base'}`}
                        >
                          <span aria-hidden="true">{isDebit ? '−' : '+'}</span>{' '}
                          {Math.abs(tx.amount)}{' '}
                          <span className="text-xs font-normal text-text-muted">
                            ({isDebit ? 'debit' : 'credit'})
                          </span>
                        </p>
                        <p className="text-xs text-text-muted">Balance: {tx.balanceAfter}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
              {nextCursor && (
                <div className="mt-4 flex justify-center">
                  <button
                    onClick={() => void loadTransactions(nextCursor)}
                    disabled={txLoadingMore}
                    className="rounded-lg border border-border-default px-4 py-1.5 text-sm font-medium text-text-secondary transition-all hover:bg-stone-100 disabled:opacity-60"
                  >
                    {txLoadingMore ? 'Loading…' : 'Load more'}
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
