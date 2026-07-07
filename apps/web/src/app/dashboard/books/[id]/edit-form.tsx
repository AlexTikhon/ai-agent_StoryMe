import {
  SupportedLanguage,
  DEFAULT_BOOK_PAGE_COUNT,
  MAX_BOOK_PAGE_COUNT,
  MIN_BOOK_PAGE_COUNT,
} from '@book/types';
import type { BookDto } from '@book/types';

export interface EditForm {
  title: string;
  childName: string;
  childAge: number;
  language: SupportedLanguage;
  theme: string;
  educationalMessage: string;
  pageCount: number;
}

export function defaultEditForm(): EditForm {
  return {
    title: '',
    childName: '',
    childAge: 4,
    language: SupportedLanguage.English,
    theme: '',
    educationalMessage: '',
    pageCount: DEFAULT_BOOK_PAGE_COUNT,
  };
}

export function formFromBook(book: BookDto): EditForm {
  return {
    title: book.title ?? '',
    childName: book.childName ?? '',
    childAge: book.childAge ?? 4,
    language: book.language ?? SupportedLanguage.English,
    theme: book.theme ?? '',
    educationalMessage: book.educationalMessage ?? '',
    pageCount: book.pageCount ?? DEFAULT_BOOK_PAGE_COUNT,
  };
}

export function validateEdit(form: EditForm): string | null {
  if (!form.title.trim()) return 'Title is required';
  if (!form.childName.trim()) return "Child's name is required";
  if (form.childAge < 1 || form.childAge > 12) return 'Age must be between 1 and 12';
  if (!form.theme.trim()) return 'Theme is required';
  return null;
}

const LANGUAGES: { value: SupportedLanguage; label: string }[] = [
  { value: SupportedLanguage.English, label: 'English' },
  { value: SupportedLanguage.Russian, label: 'Russian' },
  { value: SupportedLanguage.Polish, label: 'Polish' },
];

const PAGE_COUNT_OPTIONS: number[] = Array.from(
  { length: MAX_BOOK_PAGE_COUNT - MIN_BOOK_PAGE_COUNT + 1 },
  (_, i) => MIN_BOOK_PAGE_COUNT + i,
);

const inputCls =
  'rounded-lg border border-border-default bg-white px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-violet-600 focus:outline-none focus:ring-1 focus:ring-violet-600';

interface EditFormFieldsProps {
  values: EditForm;
  onChange: (v: EditForm) => void;
  submitting: boolean;
  onCancel: () => void;
}

export function EditFormFields({ values, onChange, submitting, onCancel }: EditFormFieldsProps) {
  const set = (patch: Partial<EditForm>) => onChange({ ...values, ...patch });

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="text-sm font-medium text-text-secondary">
            Title{' '}
            <span className="text-danger-base" aria-hidden="true">
              *
            </span>
          </span>
          <input
            value={values.title}
            onChange={(e) => set({ title: e.target.value })}
            placeholder="Book title"
            maxLength={120}
            className={inputCls}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-text-secondary">
            Child&apos;s name{' '}
            <span className="text-danger-base" aria-hidden="true">
              *
            </span>
          </span>
          <input
            value={values.childName}
            onChange={(e) => set({ childName: e.target.value })}
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
            type="number"
            min={1}
            max={12}
            value={values.childAge}
            onChange={(e) => set({ childAge: Number(e.target.value) })}
            className={inputCls}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-text-secondary">
            Language{' '}
            <span className="text-danger-base" aria-hidden="true">
              *
            </span>
          </span>
          <select
            value={values.language}
            onChange={(e) => set({ language: e.target.value as SupportedLanguage })}
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
            value={values.theme}
            onChange={(e) => set({ theme: e.target.value })}
            placeholder="e.g. Friendship and courage"
            maxLength={120}
            className={inputCls}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-text-secondary">Number of pages</span>
          <select
            value={values.pageCount}
            onChange={(e) => set({ pageCount: Number(e.target.value) })}
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
            onChange={(e) => set({ educationalMessage: e.target.value })}
            placeholder="e.g. It's okay to make mistakes and try again"
            maxLength={300}
            rows={2}
            className={inputCls}
          />
        </label>
      </div>

      <div className="mt-5 flex gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex h-10 items-center gap-2 rounded-xl bg-violet-600 px-5 text-sm font-semibold text-white shadow-brand transition-all hover:bg-violet-500 disabled:opacity-60"
        >
          {submitting ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-10 items-center rounded-xl border border-border-default px-5 text-sm font-semibold text-text-primary transition-all hover:bg-stone-100"
        >
          Cancel
        </button>
      </div>
    </>
  );
}
