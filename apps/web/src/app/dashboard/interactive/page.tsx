'use client';

import Link from 'next/link';
import { StoryLibrary } from './story-library';
import { useStartStory } from './use-start-story';

export default function InteractiveIntroPage() {
  const { start, starting, error, pending } = useStartStory();

  return (
    <main className="min-h-dvh bg-stone-950 px-4 py-10 text-stone-100">
      <div className="mx-auto max-w-xl">
        <Link
          href="/dashboard"
          className="mb-8 inline-flex rounded text-sm font-medium text-stone-400 hover:text-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300"
        >
          ← My Book Drafts
        </Link>

        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-300">
          Interactive story
        </p>
        <h1 className="mt-2 font-display text-4xl font-bold text-stone-50">The Last Delivery</h1>

        <div className="mt-6 space-y-4 font-book text-lg leading-relaxed text-stone-300">
          <p>
            Warsaw, a wet evening. You are a courier with one parcel left and an address in Praga
            where nobody seems to be home.
          </p>
          <p>
            Ask questions, follow small clues, and decide how far you are willing to go for a
            delivery. What you learn and what you carry will shape how the night ends.
          </p>
        </div>

        <p className="mt-6 text-sm text-stone-400">
          A short story with several choices and two possible endings. Your progress is saved, so
          you can leave and come back to the same story.
        </p>

        {error && (
          <p
            role="alert"
            className="mt-6 rounded-lg border border-red-400/40 bg-red-950/60 px-4 py-3 text-sm text-red-200"
          >
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={start}
          disabled={starting}
          className="mt-8 rounded-lg bg-amber-400 px-6 py-3 text-base font-semibold text-stone-950 hover:bg-amber-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {starting ? 'Starting…' : pending ? 'Try again' : 'Start story'}
        </button>

        <StoryLibrary />
      </div>
    </main>
  );
}
