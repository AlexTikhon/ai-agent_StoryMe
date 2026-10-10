'use client';

import type { InteractiveScenarioCatalogueEntryDto } from '@book/types';
import type { StartTarget } from './use-start-story';
import { useScenarioCatalogue } from './use-scenario-catalogue';

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300';
const SECONDARY_BUTTON = `rounded-lg border border-stone-600 px-4 py-2 text-sm font-semibold text-stone-100 hover:border-stone-400 disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS_RING}`;
const ALERT = 'rounded-lg border border-red-400/40 bg-red-950/60 px-4 py-3 text-sm text-red-200';

interface ScenarioCatalogueProps {
  onStart: (target: StartTarget) => void;
  /** A start is in flight (true) or its outcome is unresolved (false while `active` is set). */
  starting: boolean;
  /** The story of the unresolved start, if any; every card is disabled while it is set. */
  active: StartTarget | null;
  /** Failure of the start itself, with its manual retry of the exact held command. */
  startError: string | null;
  onRetryStart: () => void;
}

function StoryCard({
  entry,
  onStart,
  starting,
  active,
}: { entry: InteractiveScenarioCatalogueEntryDto } & Pick<
  ScenarioCatalogueProps,
  'onStart' | 'starting' | 'active'
>) {
  const titleId = `story-title-${entry.scenarioId}`;
  const isActive = active?.scenarioId === entry.scenarioId;
  return (
    <li>
      <article
        aria-labelledby={titleId}
        className="rounded-lg border border-stone-800 bg-stone-900/60 p-5"
      >
        <h2 id={titleId} className="font-display text-2xl font-bold text-stone-50">
          {entry.title}
        </h2>
        <p className="mt-3 font-book text-lg leading-relaxed text-stone-300">{entry.synopsis}</p>
        <button
          type="button"
          onClick={() =>
            onStart({ scenarioId: entry.scenarioId, scenarioVersion: entry.scenarioVersion })
          }
          disabled={active !== null}
          aria-label={starting && isActive ? undefined : `Start story: ${entry.title}`}
          className={`mt-5 rounded-lg bg-amber-400 px-6 py-3 text-base font-semibold text-stone-950 hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS_RING}`}
        >
          {starting && isActive ? 'Starting…' : 'Start story'}
        </button>
      </article>
    </li>
  );
}

/**
 * The published stories, straight from the API: nothing about a story (title,
 * synopsis, id, version) is known to the browser except what the catalogue says.
 * A story starts only on a click; a catalogue failure leaves the rest of the
 * page, including the session library, usable.
 */
export function ScenarioCatalogue({
  onStart,
  starting,
  active,
  startError,
  onRetryStart,
}: ScenarioCatalogueProps) {
  const catalogue = useScenarioCatalogue();

  return (
    <section aria-label="Choose a story" className="mt-8">
      {catalogue.phase === 'loading' && (
        <p role="status" className="text-sm text-stone-400">
          Loading stories…
        </p>
      )}

      {catalogue.phase === 'error' && (
        <div role="alert" className={ALERT}>
          <p>
            {catalogue.error === 'rate-limited'
              ? "You're loading stories too quickly. Wait a moment, then try again."
              : "We couldn't load the available stories. Your existing stories below are still available."}
          </p>
          <button type="button" onClick={catalogue.retry} className={`mt-3 ${SECONDARY_BUTTON}`}>
            Try again
          </button>
        </div>
      )}

      {catalogue.phase === 'ready' && catalogue.scenarios.length === 0 && (
        <p className="text-sm text-stone-400">
          No stories are available right now. Please check back later.
        </p>
      )}

      {startError && (
        <div role="alert" className={`mb-4 ${ALERT}`}>
          <p>{startError}</p>
          {active !== null && !starting && (
            <button type="button" onClick={onRetryStart} className={`mt-3 ${SECONDARY_BUTTON}`}>
              Try again
            </button>
          )}
        </div>
      )}

      {catalogue.phase === 'ready' && catalogue.scenarios.length > 0 && (
        <ul aria-label="Available stories" className="space-y-4">
          {catalogue.scenarios.map((entry) => (
            <StoryCard
              key={`${entry.scenarioId}@${entry.scenarioVersion}`}
              entry={entry}
              onStart={onStart}
              starting={starting}
              active={active}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
