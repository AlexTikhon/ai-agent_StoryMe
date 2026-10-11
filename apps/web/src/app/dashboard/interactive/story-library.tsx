'use client';

import { useEffect, useId, useRef } from 'react';
import Link from 'next/link';
import type { InteractiveSessionSummaryDto } from '@book/types';
import { useSessionLibrary, type RemovalErrorKind, type RemovalState } from './use-session-library';

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

const DANGER_BUTTON = `rounded-lg bg-red-300 px-4 py-2 text-sm font-semibold text-stone-950 hover:bg-red-200 disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS_RING}`;

/** Ambiguous outcomes say so: a lost response is not proof that nothing was removed. */
function removalFailureMessage(error: RemovalErrorKind, title: string): string {
  switch (error) {
    case 'timeout':
    case 'network':
      return `We couldn’t confirm that “${title}” was removed. It may or may not have been. Trying again is safe.`;
    case 'rate-limited':
      return "You're removing stories too quickly. Wait a moment, then try again.";
    case 'unavailable':
      return `The service is having trouble, so “${title}” may not have been removed. Trying again is safe.`;
    case 'rejected':
      return `“${title}” couldn’t be removed.`;
  }
}

interface RemovalControls {
  /** The removal in progress, if any (for any story). */
  removal: RemovalState | null;
  /** Its feedback is shown outside the list, because its row is not displayed. */
  detached: boolean;
  request: (sessionId: string) => void;
  cancel: () => void;
  confirm: () => void;
  retry: () => void;
}

/** Confirmation, progress or failure for one story's removal, shown inside its row. */
function RemovalPanel({
  title,
  ended,
  removal,
  controls,
  onClose,
}: {
  title: string;
  ended: boolean;
  removal: RemovalState;
  controls: RemovalControls;
  onClose: () => void;
}) {
  const headingId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirming = removal.status === 'confirming';

  // The safe choice takes focus when the question opens.
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  if (removal.status === 'removing') {
    return (
      <p role="status" className="basis-full text-sm text-stone-300">
        Removing “{title}”…
      </p>
    );
  }

  if (removal.status === 'failed' && removal.error) {
    return (
      <div
        role="alert"
        className="basis-full rounded-lg border border-red-400/40 bg-red-950/60 px-4 py-3 text-sm text-red-200"
      >
        <p>{removalFailureMessage(removal.error, title)}</p>
        <div className="mt-3 flex flex-wrap gap-3">
          {removal.error !== 'rejected' && (
            <button type="button" onClick={controls.retry} className={SECONDARY_BUTTON}>
              Try again
            </button>
          )}
          <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className="basis-full rounded-lg border border-stone-700 bg-stone-950/60 px-4 py-3 text-sm text-stone-200"
    >
      <p id={headingId} className="font-semibold text-stone-50">
        Remove “{title}” from your stories?
      </p>
      <p className="mt-1 text-stone-300">
        You can no longer {ended ? 'read it again' : 'continue it'}. This takes it out of your
        library but does not erase the data we have stored for it.
      </p>
      <div className="mt-3 flex flex-wrap gap-3">
        <button type="button" onClick={controls.confirm} className={DANGER_BUTTON}>
          Yes, remove story
        </button>
        <button ref={cancelRef} type="button" onClick={onClose} className={SECONDARY_BUTTON}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function StoryItem({
  story,
  controls,
}: {
  story: InteractiveSessionSummaryDto;
  controls: RemovalControls;
}) {
  const title = scenarioTitle(story);
  const ended = story.status === 'ended';
  const removeRef = useRef<HTMLButtonElement>(null);
  const own = controls.removal?.sessionId === story.sessionId ? controls.removal : null;
  const panelOpen = own?.status === 'confirming';
  // Dismissing hands focus back to the control that opened the question.
  const close = () => {
    controls.cancel();
    removeRef.current?.focus();
  };
  const actionLabel = ended ? 'Read again' : 'Continue';
  // A finished story is reread chapter by chapter; the reader only shows its ending.
  const href = `/dashboard/interactive/${encodeURIComponent(story.sessionId)}${ended ? '/transcript' : ''}`;
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
      <div className="flex flex-wrap items-center gap-3">
        <button
          ref={removeRef}
          type="button"
          aria-label={`Remove ${title}, ${ended ? 'completed' : 'in progress'}, started ${formatDate(story.createdAt)}`}
          aria-expanded={panelOpen}
          onClick={() => controls.request(story.sessionId)}
          disabled={controls.removal?.status === 'removing' || controls.detached}
          className={SECONDARY_BUTTON}
        >
          Remove
        </button>
        <Link
          href={href}
          aria-label={`${actionLabel} ${title}, ${ended ? 'completed' : 'in progress'}, started ${formatDate(story.createdAt)}`}
          className={`rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-stone-950 hover:bg-amber-300 ${FOCUS_RING}`}
        >
          {actionLabel}
        </Link>
      </div>
      {own && (
        <RemovalPanel
          title={title}
          ended={ended}
          removal={own}
          controls={controls}
          onClose={close}
        />
      )}
    </li>
  );
}

/** "Your stories": the signed-in user's earlier sessions, each resumable through its reader URL. */
export function StoryLibrary() {
  const library = useSessionLibrary();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const controls: RemovalControls = {
    removal: library.removal,
    detached: library.detachedRemoval !== null,
    request: library.requestRemoval,
    cancel: library.cancelRemoval,
    confirm: library.confirmRemoval,
    retry: library.retryRemoval,
  };
  const removed = library.removed;
  const detached = library.detachedRemoval;

  // The removed row held focus's place; move it to the section so keyboard and
  // screen-reader users are not dropped at the top of the page.
  useEffect(() => {
    if (removed) headingRef.current?.focus();
  }, [removed]);

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
        <h2
          id="your-stories-title"
          ref={headingRef}
          tabIndex={-1}
          className="font-display text-2xl font-bold text-stone-50 focus:outline-none"
        >
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

      {/* The row is not displayed (a refresh reloaded only the first page), so its
          progress and failure controls are rendered here instead of inside the row. */}
      {detached && (
        <div role="group" aria-label="Story removal" className="mt-4 flex">
          <RemovalPanel
            title={scenarioTitle(detached.story)}
            ended={detached.story.status === 'ended'}
            removal={detached}
            controls={controls}
            onClose={() => {
              library.cancelRemoval();
              headingRef.current?.focus();
            }}
          />
        </div>
      )}

      {phase === 'ready' && removed && (
        <p role="status" className="mt-4 text-sm text-stone-300">
          “{scenarioTitle(removed)}” was removed from your stories.
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
            <StoryItem key={story.sessionId} story={story} controls={controls} />
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
