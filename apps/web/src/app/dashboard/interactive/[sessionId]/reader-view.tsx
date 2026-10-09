'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import type { useInteractiveReader } from './use-interactive-reader';

type Reader = ReturnType<typeof useInteractiveReader>;

interface StartAnother {
  start: () => void;
  starting: boolean;
  error: string | null;
  /** The previous start's outcome is unresolved; the next click resends the same command. */
  pending?: boolean;
}

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300';
const LINK_BUTTON = `rounded-lg bg-amber-400 px-5 py-2.5 text-sm font-semibold text-stone-950 hover:bg-amber-300 ${FOCUS_RING}`;
const PRIMARY_BUTTON = `${LINK_BUTTON} disabled:cursor-not-allowed disabled:opacity-60`;

/** Narration is plain text: React escapes it, and blank lines become paragraphs. */
function Narration({ text }: { text: string }) {
  const paragraphs = text.split(/\n{2,}/).filter((paragraph) => paragraph.trim() !== '');
  return (
    <div className="space-y-4 font-book text-lg leading-relaxed text-stone-200">
      {paragraphs.map((paragraph, index) => (
        <p key={index} className="whitespace-pre-line">
          {paragraph}
        </p>
      ))}
    </div>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-dvh bg-stone-950 px-4 py-8 text-stone-100 sm:py-10">
      <div className="mx-auto max-w-2xl">
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

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="status"
      className="rounded-lg border border-stone-600 bg-stone-800/70 px-4 py-3 text-sm text-stone-200"
    >
      {children}
    </p>
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

export function InteractiveReaderView({
  reader,
  startAnother,
}: {
  reader: Reader;
  startAnother: StartAnother;
}) {
  const { phase, view, command, syncRequired, syncing, syncError, notice } = reader;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const shownRevision = useRef<number | null>(null);

  // After the story advances, move focus to the new scene so keyboard and
  // screen-reader users land on it. Not done for the first render.
  useEffect(() => {
    if (!view) {
      shownRevision.current = null;
      return;
    }
    if (shownRevision.current !== null && shownRevision.current !== view.revision) {
      headingRef.current?.focus();
    }
    shownRevision.current = view.revision;
  }, [view]);

  if (phase === 'loading') {
    return (
      <Frame>
        <p role="status" className="text-stone-400">
          Loading your story…
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

  if (phase === 'auth-required') {
    return (
      <Frame>
        <p role="alert" className="text-stone-200">
          Your session has expired. Please sign in again to continue your story.
        </p>
      </Frame>
    );
  }

  if (phase === 'load-error' || !view) {
    return (
      <Frame>
        <Problem>
          <p>{reader.loadError ?? "We couldn't load this story."}</p>
          <button
            type="button"
            onClick={reader.retryLoad}
            className={`font-semibold underline ${FOCUS_RING}`}
          >
            Try again
          </button>
        </Problem>
      </Frame>
    );
  }

  const inProgress = view.status === 'in_progress';

  return (
    <Frame>
      <article aria-labelledby="scene-title">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-300">
          The Last Delivery
        </p>
        <h1
          id="scene-title"
          ref={headingRef}
          tabIndex={-1}
          className="mt-2 font-display text-3xl font-bold text-stone-50 focus:outline-none"
        >
          {view.scene.title}
        </h1>
        <div className="mt-5">
          <Narration text={view.narration} />
        </div>
      </article>

      <div className="mt-6 space-y-3">
        {notice && <Notice>{notice}</Notice>}

        {command?.phase === 'submitting' && <Notice>Sending your choice…</Notice>}

        {command?.phase === 'retryable' && (
          <Problem>
            <p>{command.message}</p>
            <p className="text-red-200/80">
              Trying again resends the same choice, so it can&apos;t be recorded twice.
            </p>
            <button type="button" onClick={reader.retryCommand} className={PRIMARY_BUTTON}>
              Retry choice
            </button>
          </Problem>
        )}

        {command?.phase === 'confirming' && (
          <Problem>
            <p>{command.message}</p>
            <button type="button" onClick={reader.retryCommand} className={PRIMARY_BUTTON}>
              Check again
            </button>
          </Problem>
        )}

        {command?.phase === 'inconsistent' && (
          <Problem>
            <p>{command.message}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className={PRIMARY_BUTTON}
            >
              Reload story
            </button>
          </Problem>
        )}

        {syncRequired && syncing && <Notice>Loading the latest story state…</Notice>}

        {syncRequired && !syncing && syncError && (
          <Problem>
            <p>{syncError}</p>
            <button type="button" onClick={reader.retrySync} className={PRIMARY_BUTTON}>
              Try again
            </button>
          </Problem>
        )}
      </div>

      {inProgress && (
        <section aria-labelledby="choices-title" className="mt-8">
          <h2
            id="choices-title"
            className="text-sm font-semibold uppercase tracking-wide text-stone-400"
          >
            What do you do?
          </h2>
          <ul className="mt-3 space-y-3">
            {view.choices.map((choice) => (
              <li key={choice.id}>
                <button
                  type="button"
                  disabled={!reader.choicesEnabled}
                  aria-busy={command?.phase === 'submitting' && command.choiceId === choice.id}
                  onClick={() => reader.submitChoice(choice.id)}
                  className={`w-full rounded-lg border border-stone-600 bg-stone-900 px-4 py-3 text-left text-base text-stone-100 hover:border-amber-300 hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-stone-600 disabled:hover:bg-stone-900 ${FOCUS_RING}`}
                >
                  {choice.label}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.status === 'ended' && view.ending && (
        <section
          aria-labelledby="ending-title"
          className="mt-8 rounded-xl border border-amber-300/40 bg-stone-900 p-5"
        >
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-300">The end</p>
          <h2 id="ending-title" className="mt-1 font-display text-2xl font-bold text-stone-50">
            {view.ending.title}
          </h2>
          <p className="mt-3 font-book text-lg leading-relaxed text-stone-200">
            {view.ending.summary}
          </p>
          {startAnother.error && (
            <p
              role="alert"
              className="mt-4 rounded-lg border border-red-400/40 bg-red-950/60 px-4 py-3 text-sm text-red-100"
            >
              {startAnother.error}
            </p>
          )}
          <button
            type="button"
            onClick={startAnother.start}
            disabled={startAnother.starting}
            className={`mt-5 ${PRIMARY_BUTTON}`}
          >
            {startAnother.starting
              ? 'Starting…'
              : startAnother.pending
                ? 'Try again'
                : 'Start another story'}
          </button>
        </section>
      )}

      <div className="mt-10 grid gap-6 sm:grid-cols-2">
        <section aria-labelledby="clues-title">
          <h2
            id="clues-title"
            className="text-sm font-semibold uppercase tracking-wide text-stone-400"
          >
            Clues
          </h2>
          {view.player.knowledge.length === 0 ? (
            <p className="mt-2 text-sm text-stone-500">Nothing discovered yet.</p>
          ) : (
            <ul className="mt-2 list-disc space-y-2 pl-5 text-sm text-stone-300">
              {view.player.knowledge.map((fact) => (
                <li key={fact.id}>{fact.text}</li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="items-title">
          <h2
            id="items-title"
            className="text-sm font-semibold uppercase tracking-wide text-stone-400"
          >
            Carrying
          </h2>
          {view.player.inventory.length === 0 ? (
            <p className="mt-2 text-sm text-stone-500">Nothing in your hands.</p>
          ) : (
            <ul className="mt-2 list-disc space-y-2 pl-5 text-sm text-stone-300">
              {view.player.inventory.map((item) => (
                <li key={item.id}>{item.name}</li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Frame>
  );
}
