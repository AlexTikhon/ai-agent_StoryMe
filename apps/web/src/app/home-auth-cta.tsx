'use client';

import { useAuth } from '@/lib/auth/auth-context';
import { INTERACTIVE_CATALOGUE_PATH, authPageHref } from '@/lib/auth/post-auth-destination';

const primaryCls =
  'inline-flex h-12 items-center justify-center rounded-xl bg-violet-600 px-8 text-base font-semibold text-white shadow-brand transition-all hover:bg-violet-500 focus-visible:ring-2 focus-visible:ring-violet-600 focus-visible:ring-offset-2';
const secondaryCls =
  'inline-flex h-12 items-center justify-center rounded-xl border border-border-default px-8 text-base font-semibold text-text-primary transition-all hover:bg-stone-100';
const textLinkCls =
  'font-medium text-violet-600 underline underline-offset-2 hover:text-violet-500';

/**
 * Server-rendered as the anonymous variant (status starts as 'loading'), so the
 * links are usable before hydration; an authenticated session only upgrades them.
 */
export function HomeAuthCta() {
  const { status } = useAuth();
  const authed = status === 'authed';

  return (
    <>
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
        {authed ? (
          <a href={INTERACTIVE_CATALOGUE_PATH} className={primaryCls}>
            Open the story catalogue
          </a>
        ) : (
          <>
            <a href={authPageHref('/register', INTERACTIVE_CATALOGUE_PATH)} className={primaryCls}>
              Start your first story
            </a>
            <a href={authPageHref('/login', INTERACTIVE_CATALOGUE_PATH)} className={secondaryCls}>
              Sign in
            </a>
          </>
        )}
      </div>

      <p className="mt-8 text-sm text-text-muted">
        Prefer a personalized storybook?{' '}
        <a href={authed ? '/dashboard' : '/register'} className={textLinkCls}>
          Create a personalized book
        </a>
        {' · '}
        <a href="/dashboard" className={textLinkCls}>
          View my books
        </a>
      </p>
    </>
  );
}
