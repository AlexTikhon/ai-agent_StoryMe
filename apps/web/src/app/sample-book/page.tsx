import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { BOOK_CREATION_PATH, authPageHref } from '@/lib/auth/post-auth-destination';
import {
  SAMPLE_BOOK,
  SAMPLE_SECTION_IDS,
  type SampleIllustration,
} from '@/sample-book/sample-book';

export const metadata: Metadata = {
  title: `Sample book: ${SAMPLE_BOOK.title}`,
  description:
    "Read a complete curated sample of a StoryMe illustrated children's book and download its PDF. No account needed.",
};

const FOCUS =
  'rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-600 focus-visible:ring-offset-2';
const PRIMARY = `inline-flex min-h-12 items-center justify-center rounded-xl bg-violet-600 px-6 text-base font-semibold text-white shadow-brand hover:bg-violet-500 ${FOCUS}`;
const SECONDARY = `inline-flex min-h-12 items-center justify-center rounded-xl border border-border-default bg-bg-surface px-6 text-base font-semibold text-text-primary hover:bg-stone-100 ${FOCUS}`;
const TEXT_LINK = `font-medium text-violet-700 underline underline-offset-2 hover:text-violet-500 ${FOCUS}`;

const CONTENTS_ID = 'contents';
const PDF_FILE_NAME = SAMPLE_BOOK.pdf.href.split('/').pop() ?? 'storyme-sample-book.pdf';
// Anonymous visitors register first; signed-in visitors are sent straight on.
const CREATE_HREF = authPageHref('/register', BOOK_CREATION_PATH);

interface Section {
  id: string;
  label: string;
  heading: string;
  illustration: SampleIllustration;
  body: ReactNode;
}

const SECTIONS: Section[] = [
  {
    id: SAMPLE_SECTION_IDS.cover,
    label: 'Cover',
    heading: 'Cover',
    illustration: SAMPLE_BOOK.cover.illustration,
    body: (
      <p className="text-center font-display text-2xl font-semibold text-text-primary sm:text-3xl">
        {SAMPLE_BOOK.title}
      </p>
    ),
  },
  ...SAMPLE_BOOK.pages.map((page) => ({
    id: SAMPLE_SECTION_IDS.page(page.pageNumber),
    label: `Page ${page.pageNumber}`,
    heading: `Page ${page.pageNumber}: ${page.heading}`,
    illustration: page.illustration,
    body: <p className="font-book text-lg leading-relaxed text-text-primary">{page.text}</p>,
  })),
  {
    id: SAMPLE_SECTION_IDS.backCover,
    label: 'Back cover',
    heading: 'Back cover',
    illustration: SAMPLE_BOOK.backCover.illustration,
    body: (
      <>
        <p className="text-center font-book text-lg italic leading-relaxed text-text-primary">
          {SAMPLE_BOOK.backCover.text}
        </p>
        <p className="mt-3 text-center text-sm text-text-muted">The end.</p>
      </>
    ),
  },
];

function PdfLink({ className }: { className: string }) {
  return (
    <a href={SAMPLE_BOOK.pdf.href} download={PDF_FILE_NAME} className={className}>
      Download the sample PDF
    </a>
  );
}

/**
 * Public, fully static sample book. It renders only the bundled fixture and
 * public assets: no API requests, no auth, no user data. The whole story and
 * its anchor navigation work without JavaScript.
 */
export default function SampleBookPage() {
  return (
    <main className="min-h-dvh bg-bg-base">
      <div className="mx-auto max-w-3xl px-4 py-6 sm:py-10">
        <a href="/" className={`text-sm ${TEXT_LINK}`}>
          ← Back to StoryMe home
        </a>

        <header className="mt-6">
          <p className="text-sm font-semibold uppercase tracking-wide text-violet-700">
            Sample book · {SAMPLE_BOOK.readingAge}
          </p>
          <h1 className="mt-1 font-display text-4xl font-bold text-text-primary sm:text-5xl">
            {SAMPLE_BOOK.title}
          </h1>
          <aside
            aria-label="About this sample"
            className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-stone-800"
          >
            <p className="font-semibold">About this sample</p>
            <p className="mt-1">{SAMPLE_BOOK.provenance}</p>
            <p className="mt-2">
              Books you create in StoryMe are generated from the details you provide, so their story
              and pictures will differ from this one.
            </p>
          </aside>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <PdfLink className={PRIMARY} />
            <a href={CREATE_HREF} className={SECONDARY}>
              Create your own book
            </a>
          </div>
        </header>

        <nav
          id={CONTENTS_ID}
          aria-label="Sample book pages"
          className="mt-8 scroll-mt-4 rounded-xl border border-border-subtle bg-bg-surface p-4"
        >
          <h2 className="font-display text-lg font-semibold text-text-primary">Contents</h2>
          <ol className="mt-2 flex flex-wrap gap-2">
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className={`inline-flex min-h-11 items-center rounded-lg border border-border-default px-3 text-sm font-medium text-text-secondary hover:bg-violet-50 hover:text-violet-700 ${FOCUS}`}
                >
                  {section.label}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        {SECTIONS.map((section, index) => {
          const previous = SECTIONS[index - 1];
          const next = SECTIONS[index + 1];
          const headingId = `${section.id}-heading`;
          return (
            <section
              key={section.id}
              id={section.id}
              aria-labelledby={headingId}
              className="mt-8 scroll-mt-4 overflow-hidden rounded-2xl border border-border-subtle bg-bg-surface shadow-sm"
            >
              <h2
                id={headingId}
                className="px-4 pt-4 font-display text-xl font-semibold text-text-primary sm:px-6"
              >
                {section.heading}
              </h2>
              <figure className="mt-3">
                <img
                  src={section.illustration.src}
                  alt={section.illustration.alt}
                  width={section.illustration.width}
                  height={section.illustration.height}
                  decoding="async"
                  className="block h-auto w-full bg-sky-100"
                />
              </figure>
              <div className="px-4 py-5 sm:px-6">{section.body}</div>
              <nav
                aria-label={`${section.label} navigation`}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border-subtle px-4 py-3 text-sm sm:px-6"
              >
                {previous ? (
                  <a href={`#${previous.id}`} className={TEXT_LINK}>
                    ← Previous: {previous.label}
                  </a>
                ) : (
                  <a href={`#${CONTENTS_ID}`} className={TEXT_LINK}>
                    ↑ Contents
                  </a>
                )}
                {next ? (
                  <a href={`#${next.id}`} className={TEXT_LINK}>
                    Next: {next.label} →
                  </a>
                ) : (
                  <a href={`#${CONTENTS_ID}`} className={TEXT_LINK}>
                    ↑ Back to contents
                  </a>
                )}
              </nav>
            </section>
          );
        })}

        <section
          aria-labelledby="sample-next-heading"
          className="mt-10 rounded-2xl bg-violet-50 p-6 text-center"
        >
          <h2
            id="sample-next-heading"
            className="font-display text-2xl font-semibold text-text-primary"
          >
            Make a book starring your child
          </h2>
          <p className="mx-auto mt-2 max-w-prose text-text-secondary">
            Choose your child&apos;s name, age, a theme and a language, and StoryMe writes and
            illustrates a picture book you can read here and download as a PDF.
          </p>
          <div className="mt-5 flex flex-col justify-center gap-3 sm:flex-row">
            <a href={CREATE_HREF} className={PRIMARY}>
              Create your own book
            </a>
            <PdfLink className={SECONDARY} />
          </div>
          <p className="mt-5 text-sm">
            <a href="/" className={TEXT_LINK}>
              Back to StoryMe home
            </a>
          </p>
        </section>
      </div>
    </main>
  );
}
