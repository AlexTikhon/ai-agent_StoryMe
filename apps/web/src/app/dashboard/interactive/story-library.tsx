'use client';

import Link from 'next/link';
import type { InteractiveSessionSummaryDto } from '@book/types';
import { useSessionLibrary } from './use-session-library';

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300';
const SECONDARY_BUTTON = `rounded-lg border border-stone-600 px-4 py-2 text-sm font-semibold text-stone-100 hover:border-stone-400 disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS_RING}`;

const FALLBACK_TITLE = 'Interactive story';

/** The title is the server's (resolved from the session's pinned version); never derived from the id. */
function scenarioTitle(story: InteractiveSessionSummaryDto): string {
  const title = typeof story.scenarioTitle === 'string' ? story.scenarioTitle.trim() : '';
  return title || FALLBACK_TITLE;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function StoryItem({ story }: { story: InteractiveSessionSummaryDto }) {
  const title = scenarioTitle(story);
  const ended = story.status === 'ended';
  const actionLabel = ended ? 'Read again' : 'Continue';
  return (
    <li className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-stone-800 bg-stone-900/60 p-4">
      <div className="min-w-0">
        <p className="font-display text-lg font-semibold text-stone-50">{title}</p>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
              ended ? 'bg-emerald-400/15 text-emerald-200' : 'bg-amber-400/15 text-amber-200'
            }`}
          >
            {ended ? 'Completed' : 'In progress'}
          </span>
          <span className="text-stone-300">
            {ended && story.endingTitle
              ? `Ending: ${story.endingTitle}`
              : `At: ${story.sceneTitle}`}
          </span>
        </p>
        <p className="mt-1 text-xs text-stone-400">
          {ended ? 'Finished' : 'Started'} {formatDate(ended ? story.updatedAt : story.createdAt)}
        </p>
      </div>
      <Link
        href={`/dashboard/interactive/${encodeURIComponent(story.sessionId)}`}
        aria-label={`${actionLabel} ${title}, ${ended ? 'completed' : 'in progress'}, started ${formatDate(story.createdAt)}`}
        className={`rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-stone-950 hover:bg-amber-300 ${FOCUS_RING}`}
      >
        {actionLabel}
      </Link>
    </li>
  );
}

/** "Your stories": the signed-in user's earlier sessions, each resumable through its reader URL. */
export function StoryLibrary() {
  const library = useSessionLibrary();
  const { phase, sessions, refreshing, refreshFailed, loadingMore, loadMoreFailed, error } =
    library;
  const loading = phase === 'loading' || (phase === 'error' && refreshing);
  const message =
    error === 'rate-limited'
      ? "You're refreshing too quickly. Wait a moment, then try again."
      : "We couldn't load your stories.";

  return (
    <section aria-labelledby="your-stories-title" className="mt-14 border-t border-stone-800 pt-8">
      <div className="flex items-center justify-between gap-4">
        <h2 id="your-stories-title" className="font-display text-2xl font-bold text-stone-50">
          Your stories
        </h2>
        {phase === 'ready' && (
          <button
            type="button"
            onClick={() => void library.refresh()}
            disabled={refreshing}
            className={SECONDARY_BUTTON}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        )}
      </div>

      {loading && (
        <p role="status" className="mt-4 text-sm text-stone-400">
          Loading your stories…
        </p>
      )}

      {phase === 'error' && !refreshing && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-red-400/40 bg-red-950/60 px-4 py-3 text-sm text-red-200"
        >
          <p>{message}</p>
          <button
            type="button"
            onClick={() => void library.refresh()}
            className={`mt-3 ${SECONDARY_BUTTON}`}
          >
            Try again
          </button>
        </div>
      )}

      {phase === 'ready' && refreshFailed && (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-red-400/40 bg-red-950/60 px-4 py-3 text-sm text-red-200"
        >
          {error === 'rate-limited'
            ? "You're refreshing too quickly. Wait a moment, then try again."
            : "We couldn't refresh your stories. The list below may be out of date."}
        </p>
      )}

      {phase === 'ready' && sessions.length === 0 && (
        <p className="mt-4 text-sm text-stone-400">
          No stories yet. Start one above and it will be listed here, so you can come back to it any
          time.
        </p>
      )}

      {phase === 'ready' && sessions.length > 0 && (
        <ul className="mt-4 space-y-3">
          {sessions.map((story) => (
            <StoryItem key={story.sessionId} story={story} />
          ))}
        </ul>
      )}

      {phase === 'ready' && library.nextCursor && (
        <div className="mt-4">
          {loadMoreFailed && (
            <p role="alert" className="mb-3 text-sm text-red-200">
              {error === 'rate-limited'
                ? "You're loading too quickly. Wait a moment, then try again."
                : "We couldn't load more stories."}
            </p>
          )}
          <button
            type="button"
            onClick={() => void library.loadMore()}
            disabled={loadingMore || refreshing}
            className={SECONDARY_BUTTON}
          >
            {loadingMore ? 'Loading…' : loadMoreFailed ? 'Try again' : 'Load more'}
          </button>
        </div>
      )}
    </section>
  );
}
