'use client';

import Link from 'next/link';
import { ScenarioCatalogue } from './scenario-catalogue';
import { StoryLibrary } from './story-library';
import { useStartStory } from './use-start-story';

export default function InteractiveIntroPage() {
  const { start, retry, starting, error, active } = useStartStory();

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
        <h1 className="mt-2 font-display text-4xl font-bold text-stone-50">Choose a story</h1>
        <p className="mt-4 text-sm text-stone-400">
          Ask questions, follow small clues, and decide what to do. Your progress is saved, so you
          can leave and come back to the same story.
        </p>

        <ScenarioCatalogue
          onStart={start}
          starting={starting}
          active={active}
          startError={error}
          onRetryStart={retry}
        />

        <StoryLibrary />
      </div>
    </main>
  );
}
