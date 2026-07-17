/**
 * Fired when a checkout is confirmed credited (see /billing/success) so any
 * mounted balance indicator (DashboardLayout) can refetch immediately rather
 * than showing a stale pre-purchase balance until its next unrelated
 * re-render. Mirrors the AUTH_EXPIRED_EVENT pattern in lib/api/client.ts.
 */
export const CREDITS_UPDATED_EVENT = 'storyme:credits-updated';

export function notifyCreditsUpdated(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CREDITS_UPDATED_EVENT));
  }
}
