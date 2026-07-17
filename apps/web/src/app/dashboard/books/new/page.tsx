'use client';

import Link from 'next/link';
import Image from 'next/image';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  DEFAULT_BOOK_PAGE_COUNT,
  MAX_BOOK_PAGE_COUNT,
  MIN_BOOK_PAGE_COUNT,
  SupportedLanguage,
} from '@book/types';
import { booksApi } from '@/lib/api/books';

// ── Types ──────────────────────────────────────────────────────────────────────

type WizardStep = 1 | 2 | 3;

interface WizardValues {
  childName: string;
  childAge: number;
  language: SupportedLanguage;
  theme: string;
  educationalMessage: string;
  pageCount: number;
  /** Optional child reference photo — uploaded separately right after the book is created. */
  childPhoto: File | null;
}

const DEFAULT_VALUES: WizardValues = {
  childName: '',
  childAge: 4,
  language: SupportedLanguage.English,
  theme: '',
  educationalMessage: '',
  pageCount: DEFAULT_BOOK_PAGE_COUNT,
  childPhoto: null,
};

// Mirrors apps/api/src/books/child-photo.constants.ts.
const MAX_CHILD_PHOTO_BYTES = 5 * 1024 * 1024;
const ALLOWED_CHILD_PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const PAGE_COUNT_OPTIONS: number[] = Array.from(
  { length: MAX_BOOK_PAGE_COUNT - MIN_BOOK_PAGE_COUNT + 1 },
  (_, i) => MIN_BOOK_PAGE_COUNT + i,
);

const LANGUAGES: { value: SupportedLanguage; label: string }[] = [
  { value: SupportedLanguage.English, label: 'English' },
  { value: SupportedLanguage.Russian, label: 'Russian' },
  { value: SupportedLanguage.Polish, label: 'Polish' },
];

const STEP_LABELS: Record<WizardStep, string> = { 1: 'Child', 2: 'Story', 3: 'Review' };

function langLabel(lang: SupportedLanguage): string {
  return LANGUAGES.find((l) => l.value === lang)?.label ?? lang;
}

const inputCls =
  'rounded-lg border border-border-default bg-white px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-violet-600 focus:outline-none focus:ring-1 focus:ring-violet-600';

// ── Page ──────────────────────────────────────────────────────────────────────

export default function NewBookPage() {
  const router = useRouter();
  const [step, setStep] = useState<WizardStep>(1);
  const [values, setValues] = useState<WizardValues>(DEFAULT_VALUES);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const patch = (p: Partial<WizardValues>) => setValues((v) => ({ ...v, ...p }));

  const handleCreate = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const childName = values.childName.trim();
      const theme = values.theme.trim();
      const educationalMessage = values.educationalMessage.trim();
      const created = await booksApi.create({
        title: `${childName}'s Story`,
        childName,
        childAge: values.childAge,
        language: values.language,
        theme,
        ...(educationalMessage && { educationalMessage }),
        pageCount: values.pageCount,
      });
      if (values.childPhoto) {
        // Best-effort: the book itself was created successfully, so a photo
        // upload failure must not block navigation — personalization is an
        // enhancement, not a requirement for book creation to work.
        try {
          await booksApi.uploadChildPhoto(created.id, values.childPhoto);
        } catch (err) {
          console.error('Child photo upload failed', err);
        }
      }
      router.push(`/dashboard/books/${created.id}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to create book');
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-dvh bg-bg-base px-4 py-10">
      <div className="mx-auto max-w-lg">
        <Link
          href="/dashboard"
          className="mb-8 inline-flex items-center gap-1 text-sm font-medium text-text-muted hover:text-text-primary"
        >
          ← My Book Drafts
        </Link>

        <h1 className="mb-6 mt-4 font-display text-3xl font-bold text-text-primary">New Book</h1>

        <StepIndicator current={step} />

        <div className="rounded-2xl border border-border-default bg-bg-surface p-6 shadow-sm">
          {step === 1 && <StepChild values={values} onChange={patch} onNext={() => setStep(2)} />}
          {step === 2 && (
            <StepStory
              values={values}
              onChange={patch}
              onBack={() => setStep(1)}
              onNext={() => setStep(3)}
            />
          )}
          {step === 3 && (
            <StepReview
              values={values}
              onBack={() => setStep(2)}
              onSubmit={() => {
                void handleCreate();
              }}
              submitting={submitting}
              error={submitError}
            />
          )}
        </div>
      </div>
    </main>
  );
}

// ── Step indicator ─────────────────────────────────────────────────────────────

function StepIndicator({ current }: { current: WizardStep }) {
  return (
    <nav aria-label="Wizard steps" className="mb-6 flex items-center gap-0">
      {([1, 2, 3] as WizardStep[]).map((s, i) => (
        <div key={s} className="flex items-center">
          {i > 0 && (
            <div
              aria-hidden="true"
              className={`h-px w-8 ${current > i ? 'bg-violet-600' : 'bg-border-default'}`}
            />
          )}
          <div className="flex items-center gap-2">
            <div
              aria-current={current === s ? 'step' : undefined}
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                current === s
                  ? 'bg-violet-600 text-white'
                  : current > s
                    ? 'bg-violet-100 text-violet-700'
                    : 'bg-stone-100 text-text-muted'
              }`}
            >
              {current > s ? '✓' : s}
            </div>
            <span
              className={`mr-2 text-sm font-medium ${current === s ? 'text-text-primary' : 'text-text-muted'}`}
            >
              {STEP_LABELS[s]}
            </span>
          </div>
        </div>
      ))}
    </nav>
  );
}

// ── Step 1: Child ─────────────────────────────────────────────────────────────

interface StepChildProps {
  values: WizardValues;
  onChange: (p: Partial<WizardValues>) => void;
  onNext: () => void;
}

function StepChild({ values, onChange, onNext }: StepChildProps) {
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!values.childName.trim()) return;
    onNext();
  };

  const handlePhotoChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    e.target.value = '';
    if (!file) return;

    if (!ALLOWED_CHILD_PHOTO_MIME_TYPES.includes(file.type)) {
      setPhotoError('Please choose a JPG, PNG, or WEBP photo.');
      return;
    }
    if (file.size > MAX_CHILD_PHOTO_BYTES) {
      setPhotoError('Photo must be smaller than 5MB.');
      return;
    }

    setPhotoError(null);
    setPhotoPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
    onChange({ childPhoto: file });
  };

  const removePhoto = () => {
    setPhotoPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setPhotoError(null);
    onChange({ childPhoto: null });
  };

  return (
    <form onSubmit={handleSubmit}>
      <h2 className="mb-5 font-display text-xl font-semibold text-text-primary">About the child</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-text-secondary">
            Child&apos;s name{' '}
            <span className="text-danger-base" aria-hidden="true">
              *
            </span>
          </span>
          <input
            required
            value={values.childName}
            onChange={(e) => onChange({ childName: e.target.value })}
            placeholder="e.g. Emma"
            maxLength={80}
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-text-secondary">
            Age{' '}
            <span className="text-danger-base" aria-hidden="true">
              *
            </span>
          </span>
          <input
            required
            type="number"
            min={1}
            max={12}
            value={values.childAge}
            onChange={(e) => onChange({ childAge: Number(e.target.value) })}
            className={inputCls}
          />
        </label>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <label htmlFor="child-photo" className="text-sm font-medium text-text-secondary">
            Child&apos;s photo <span className="text-text-muted">(optional)</span>
          </label>
          <p id="child-photo-help" className="text-xs leading-relaxed text-text-muted">
            Used only as inspiration for a stylized, illustrated storybook character — never placed
            directly in the book. JPG, PNG, or WEBP, up to 5MB.
          </p>
          {photoPreviewUrl ? (
            <div className="mt-1 flex items-center gap-3 rounded-xl border border-border-subtle bg-bg-subtle p-3">
              <Image
                src={photoPreviewUrl}
                alt="Selected child photo preview"
                width={64}
                height={64}
                unoptimized
                className="h-16 w-16 shrink-0 rounded-lg border border-border-subtle object-cover shadow-xs"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-text-primary">
                  {values.childPhoto?.name}
                </p>
                <p className="mt-0.5 text-xs text-text-muted">Ready to use as inspiration</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <label
                    htmlFor="child-photo"
                    className="inline-flex h-8 cursor-pointer items-center rounded-lg border border-border-default bg-white px-3 text-xs font-semibold text-text-secondary transition-colors hover:border-violet-300 hover:text-violet-700 focus-within:ring-2 focus-within:ring-violet-600 focus-within:ring-offset-2"
                  >
                    Change
                    <input
                      id="child-photo"
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      aria-describedby="child-photo-help child-photo-error"
                      onChange={handlePhotoChange}
                      className="sr-only"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={removePhoto}
                    className="inline-flex h-8 items-center rounded-lg px-3 text-xs font-semibold text-danger-base transition-colors hover:bg-danger-light"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <label
              htmlFor="child-photo"
              className="group mt-1 flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-border-default bg-bg-subtle px-4 py-3 transition-colors hover:border-violet-400 hover:bg-violet-50/50 focus-within:border-violet-600 focus-within:ring-2 focus-within:ring-violet-600 focus-within:ring-offset-2"
            >
              <span
                aria-hidden="true"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-violet-700 transition-colors group-hover:bg-violet-200"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  className="h-5 w-5"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M4 16.5V7.75A1.75 1.75 0 0 1 5.75 6h2.1l.9-1.25h6.5l.9 1.25h2.1A1.75 1.75 0 0 1 20 7.75v8.75a1.75 1.75 0 0 1-1.75 1.75H5.75A1.75 1.75 0 0 1 4 16.5Z"
                  />
                  <circle cx="12" cy="12" r="3.25" />
                </svg>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-text-primary">Add a photo</span>
                <span className="mt-0.5 block text-xs text-text-muted">
                  Choose an image from your device
                </span>
              </span>
              <span className="hidden rounded-lg border border-border-default bg-white px-3 py-1.5 text-xs font-semibold text-violet-700 shadow-xs transition-colors group-hover:border-violet-300 sm:inline-flex">
                Browse
              </span>
              <input
                id="child-photo"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                aria-describedby="child-photo-help child-photo-error"
                onChange={handlePhotoChange}
                className="sr-only"
              />
            </label>
          )}
          {photoError && (
            <p id="child-photo-error" role="alert" className="text-sm text-danger-base">
              {photoError}
            </p>
          )}
        </div>
      </div>
      <div className="mt-6 flex justify-end">
        <button
          type="submit"
          className="inline-flex h-10 items-center rounded-xl bg-violet-600 px-5 text-sm font-semibold text-white shadow-brand transition-all hover:bg-violet-500"
        >
          Next
        </button>
      </div>
    </form>
  );
}

// ── Step 2: Story ─────────────────────────────────────────────────────────────

interface StepStoryProps {
  values: WizardValues;
  onChange: (p: Partial<WizardValues>) => void;
  onBack: () => void;
  onNext: () => void;
}

function StepStory({ values, onChange, onBack, onNext }: StepStoryProps) {
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!values.theme.trim()) return;
    onNext();
  };

  return (
    <form onSubmit={handleSubmit}>
      <h2 className="mb-5 font-display text-xl font-semibold text-text-primary">About the story</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-text-secondary">
            Language{' '}
            <span className="text-danger-base" aria-hidden="true">
              *
            </span>
          </span>
          <select
            value={values.language}
            onChange={(e) => onChange({ language: e.target.value as SupportedLanguage })}
            className={inputCls}
          >
            {LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-text-secondary">
            Theme{' '}
            <span className="text-danger-base" aria-hidden="true">
              *
            </span>
          </span>
          <input
            required
            value={values.theme}
            onChange={(e) => onChange({ theme: e.target.value })}
            placeholder="e.g. Friendship and courage"
            maxLength={120}
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-text-secondary">Number of pages</span>
          <select
            value={values.pageCount}
            onChange={(e) => onChange({ pageCount: Number(e.target.value) })}
            className={inputCls}
          >
            {PAGE_COUNT_OPTIONS.map((count) => (
              <option key={count} value={count}>
                {count} pages
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="text-sm font-medium text-text-secondary">
            Educational message <span className="text-text-muted">(optional)</span>
          </span>
          <textarea
            value={values.educationalMessage}
            onChange={(e) => onChange({ educationalMessage: e.target.value })}
            placeholder="e.g. It's okay to make mistakes and try again"
            maxLength={300}
            rows={2}
            className={inputCls}
          />
        </label>
      </div>
      <div className="mt-6 flex justify-between">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex h-10 items-center rounded-xl border border-border-default px-5 text-sm font-semibold text-text-primary transition-all hover:bg-stone-100"
        >
          Back
        </button>
        <button
          type="submit"
          className="inline-flex h-10 items-center rounded-xl bg-violet-600 px-5 text-sm font-semibold text-white shadow-brand transition-all hover:bg-violet-500"
        >
          Next
        </button>
      </div>
    </form>
  );
}

// ── Step 3: Review ────────────────────────────────────────────────────────────

interface StepReviewProps {
  values: WizardValues;
  onBack: () => void;
  onSubmit: () => void;
  submitting: boolean;
  error: string | null;
}

function StepReview({ values, onBack, onSubmit, submitting, error }: StepReviewProps) {
  return (
    <div>
      <h2 className="mb-5 font-display text-xl font-semibold text-text-primary">
        Review &amp; create
      </h2>

      {error && (
        <p
          role="alert"
          className="mb-4 rounded-lg bg-danger-light px-4 py-3 text-sm text-danger-base"
        >
          {error}
        </p>
      )}

      <dl className="mb-6 divide-y divide-border-subtle text-sm">
        <div className="flex justify-between py-2.5">
          <dt className="font-medium text-text-muted">Child</dt>
          <dd className="text-text-primary">
            {values.childName}, age {values.childAge}
          </dd>
        </div>
        {values.childPhoto && (
          <div className="flex justify-between py-2.5">
            <dt className="font-medium text-text-muted">Photo</dt>
            <dd className="text-text-primary">Attached</dd>
          </div>
        )}
        <div className="flex justify-between py-2.5">
          <dt className="font-medium text-text-muted">Language</dt>
          <dd className="text-text-primary">{langLabel(values.language)}</dd>
        </div>
        <div className="flex justify-between py-2.5">
          <dt className="font-medium text-text-muted">Theme</dt>
          <dd className="text-text-primary">{values.theme}</dd>
        </div>
        <div className="flex justify-between py-2.5">
          <dt className="font-medium text-text-muted">Pages</dt>
          <dd className="text-text-primary">{values.pageCount}</dd>
        </div>
        {values.educationalMessage.trim() && (
          <div className="flex justify-between py-2.5">
            <dt className="font-medium text-text-muted">Lesson</dt>
            <dd className="text-text-primary">{values.educationalMessage.trim()}</dd>
          </div>
        )}
      </dl>

      <div className="flex justify-between">
        <button
          type="button"
          onClick={onBack}
          disabled={submitting}
          className="inline-flex h-10 items-center rounded-xl border border-border-default px-5 text-sm font-semibold text-text-primary transition-all hover:bg-stone-100 disabled:opacity-60"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={submitting}
          className="inline-flex h-10 items-center rounded-xl bg-violet-600 px-5 text-sm font-semibold text-white shadow-brand transition-all hover:bg-violet-500 disabled:opacity-60"
        >
          {submitting ? 'Creating…' : 'Create Book'}
        </button>
      </div>
    </div>
  );
}
