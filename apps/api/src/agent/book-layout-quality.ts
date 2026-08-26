import type { BookLayout } from '@book/types';

export type BookLayoutQualityIssueCode =
  | 'layout_entry_count_mismatch'
  | 'layout_cover_missing'
  | 'layout_back_cover_missing'
  | 'layout_page_order_invalid'
  | 'layout_illustration_missing'
  | 'layout_text_missing'
  | 'layout_unresolved_value';

export class BookLayoutQualityError extends Error {
  constructor(readonly issues: readonly BookLayoutQualityIssueCode[]) {
    super(
      `Book layout failed deterministic quality validation: ${[...new Set(issues)].join(', ')}`,
    );
    this.name = 'BookLayoutQualityError';
  }
}

const UNRESOLVED_VALUE = /(?:\bundefined\b|\bnull\b|\[object Object\]|placeholder)/iu;

/** Validates the structured book model before PDF rendering; no OCR or I/O. */
export function assertBookLayoutQuality(layout: BookLayout, expectedStoryPages: number): void {
  const issues: BookLayoutQualityIssueCode[] = [];
  if (layout.entries.length !== expectedStoryPages + 2) issues.push('layout_entry_count_mismatch');
  if (layout.entries[0]?.kind !== 'cover') issues.push('layout_cover_missing');
  if (layout.entries.at(-1)?.kind !== 'back_cover') issues.push('layout_back_cover_missing');

  const pages = layout.entries.filter((entry) => entry.kind === 'page');
  if (
    pages.length !== expectedStoryPages ||
    pages.some((entry, index) => entry.pageNumber !== index + 1)
  ) {
    issues.push('layout_page_order_invalid');
  }

  for (const entry of layout.entries) {
    if (!entry.imageBlock || entry.imageBlock.imageUrl.trim() === '') {
      issues.push('layout_illustration_missing');
    }
    if (!entry.textBlock || entry.textBlock.text.trim() === '') issues.push('layout_text_missing');
    for (const value of [
      entry.id,
      entry.imageBlock?.imageUrl ?? '',
      entry.imageBlock?.altText ?? '',
      entry.textBlock?.text ?? '',
    ]) {
      if (UNRESOLVED_VALUE.test(value)) issues.push('layout_unresolved_value');
    }
  }

  if (issues.length > 0) throw new BookLayoutQualityError([...new Set(issues)]);
}
