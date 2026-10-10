'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import type { InteractiveTranscriptStepDto } from '@book/types';
import { Narration } from '../reader-view';
import { useSessionMetadata } from '../use-session-metadata';
import type { TranscriptFailure, useInteractiveTranscript } from './use-interactive-transcript';

type Transcript = ReturnType<typeof useInteractiveTranscript>;

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300';
const LINK_BUTTON = `rounded-lg bg-amber-400 px-5 py-2.5 text-sm font-semibold text-stone-950 hover:bg-amber-300 ${FOCUS_RING}`;
const SECONDARY_BUTTON = `rounded-lg border border-stone-600 px-4 py-2 text-sm font-semibold text-stone-100 hover:border-stone-400 disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS_RING}`;

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-dvh bg-stone-950 px-4 py-8 text-stone-100 sm:py-10">
      <div className="mx-auto max-w-3xl">
        <Link
          href="/dashboard/interactive"
          className={`mb-6 inline-flex rounded text-sm font-medium text-stone-400 hover:text-stone-100 ${FOCUS_RING}`}
        >
          ← Interactive story
        </Link>
        {children}
      </div>
    </main>
  );
}

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="alert"
      className="space-y-3 rounded-lg border border-red-400/40 bg-red-950/60 px-4 py-3 text-sm text-red-100"
    >
      {children}
    </div>
  );
}

function failureMessage(failure: TranscriptFailure, hasChapters: boolean): string {
  if (failure === 'rate-limited') {
    return "You're loading too quickly. Wait a moment, then try again.";
  }
  if (failure === 'inconsistent') {
    return hasChapters
      ? "The next part of the story didn't match what you've read, so it wasn't added. What is shown is unchanged."
      : "This story's history didn't load correctly, so nothing is shown.";
  }
  return hasChapters
    ? "We couldn't load the next chapters. What you've read so far is kept."
    : "We couldn't load this story. Check your connection and try again.";
}

function Chapter({ step }: { step: InteractiveTranscriptStepDto }) {
  const headingId = `chapter-${step.revision}`;
  return (
    <li>
      <article aria-labelledby={headingId} data-testid="transcript-chapter">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-400">
          Chapter {step.revision + 1}
        </p>
        <h2
          id={headingId}
          tabIndex={-1}
          className="mt-1 font-display text-2xl font-bold text-stone-50 focus:outline-none"
        >
          {step.scene.title}
        </h2>
        {step.arrivedByChoiceLabel !== null && (
          <p className="mt-3 border-l-2 border-amber-300/60 pl-3 text-sm italic text-amber-100">
            You chose: {step.arrivedByChoiceLabel}
          </p>
        )}
        <div className="mt-4 max-w-2xl">
          <Narration text={step.narration} />
        </div>
        {step.ending && (
          <section
            aria-label="Ending"
            className="mt-6 rounded-xl border border-amber-300/40 bg-stone-900 p-5"
          >
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-300">
              The end
            </p>
            <h3 className="mt-1 font-display text-2xl font-bold text-stone-50">
              {step.ending.title}
            </h3>
            <p className="mt-3 font-book text-lg leading-relaxed text-stone-200">
              {step.ending.summary}
            </p>
          </section>
        )}
      </article>
    </li>
  );
}

export function InteractiveTranscriptView({
  sessionId,
  transcript,
}: {
  sessionId: string;
  transcript: Transcript;
}) {
  const { phase, chapters, identity, complete, loadingMore, failure } = transcript;
  // Cosmetic only: never gates the chapters.
  const { title: storyTitle } = useSessionMetadata(identity);
  const shownCount = useRef(0);

  // After a "Load more", move focus to the first new chapter so keyboard and
  // screen-reader users continue reading where the new text starts.
  useEffect(() => {
    const previous = shownCount.current;
    shownCount.current = chapters.length;
    if (previous > 0 && chapters.length > previous) {
      document.getElementById(`chapter-${chapters[previous]!.revision}`)?.focus();
    }
  }, [chapters]);

  if (phase === 'loading') {
    return (
      <Frame>
        <p role="status" className="text-stone-400">
          Loading the story…
        </p>
      </Frame>
    );
  }

  if (phase === 'unavailable') {
    return (
      <Frame>
        <h1 className="font-display text-3xl font-bold text-stone-50">
          This story isn&apos;t available
        </h1>
        <p className="mt-4 text-stone-300">
          It may not exist, or it may not belong to your account.
        </p>
        <Link href="/dashboard/interactive" className={`mt-6 inline-flex ${LINK_BUTTON}`}>
          Go to the story page
        </Link>
      </Frame>
    );
  }

  if (phase === 'not-completed') {
    return (
      <Frame>
        <h1 className="font-display text-3xl font-bold text-stone-50">
          Rereading comes after the ending
        </h1>
        <p className="mt-4 text-stone-300">
          You can read this story from the beginning once you have finished it. Your place is kept.
        </p>
        <Link
          href={`/dashboard/interactive/${encodeURIComponent(sessionId)}`}
          className={`mt-6 inline-flex ${LINK_BUTTON}`}
        >
          Continue the story
        </Link>
      </Frame>
    );
  }

  if (phase === 'auth-required') {
    return (
      <Frame>
        <p role="alert" className="text-stone-200">
          Your session has expired. Please sign in again to read your story.
        </p>
      </Frame>
    );
  }

  if (phase === 'error' || chapters.length === 0) {
    return (
      <Frame>
        <Problem>
          <p>{failureMessage(failure ?? 'failed', false)}</p>
          <button
            type="button"
            onClick={transcript.loadNext}
            disabled={loadingMore}
            className={`font-semibold underline disabled:opacity-60 ${FOCUS_RING}`}
          >
            {loadingMore ? 'Loading…' : 'Try again'}
          </button>
        </Problem>
      </Frame>
    );
  }

  const total = identity ? identity.completedRevision + 1 : chapters.length;

  return (
    <Frame>
      <header>
        <p
          data-testid="story-title"
          className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-300"
        >
          {storyTitle}
        </p>
        <h1 className="mt-2 font-display text-3xl font-bold text-stone-50">Read again</h1>
        <p data-testid="transcript-progress" className="mt-2 text-sm text-stone-400">
          {complete
            ? `All ${total} chapters, from the beginning to the end.`
            : `Showing ${chapters.length} of ${total} chapters.`}
        </p>
      </header>

      <ol className="mt-8 space-y-10">
        {chapters.map((step) => (
          <Chapter key={step.revision} step={step} />
        ))}
      </ol>

      {!complete && (
        <div className="mt-8 space-y-3">
          {failure && (
            <Problem>
              <p>{failureMessage(failure, true)}</p>
            </Problem>
          )}
          <button
            type="button"
            onClick={transcript.loadNext}
            disabled={loadingMore}
            className={SECONDARY_BUTTON}
          >
            {loadingMore ? 'Loading…' : failure ? 'Try again' : 'Load more'}
          </button>
        </div>
      )}

      {complete && (
        <div className="mt-10 flex flex-wrap items-center gap-4">
          <Link href="/dashboard/interactive" className={LINK_BUTTON}>
            Start another story
          </Link>
          <Link
            href={`/dashboard/interactive/${encodeURIComponent(sessionId)}`}
            className={`rounded text-sm font-semibold text-amber-300 underline hover:text-amber-200 ${FOCUS_RING}`}
          >
            Back to the ending
          </Link>
        </div>
      )}
    </Frame>
  );
}
