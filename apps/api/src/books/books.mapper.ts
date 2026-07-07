import { Logger } from '@nestjs/common';
import type { Book } from '@prisma/client';
import { BookStatus, SupportedLanguage, type BookDto } from '@book/types';
import type { ZodTypeAny } from 'zod';
import {
  bookLayoutSchema,
  bookPreviewSchema,
  characterCardSchema,
  imageGenerationResultSchema,
  storyPlanSchema,
} from './books.schemas';

const logger = new Logger('BooksMapper');

/**
 * Safe-parses a Prisma `Json` column against its expected shape. Older or
 * hand-edited rows can drift from the current `@book/types` interfaces —
 * rather than shipping a malformed object to clients that trust `BookDto`'s
 * types, a mismatch is logged and degrades to `null`, same as a book that
 * hasn't reached that pipeline step yet.
 *
 * `T` is left for the call site's contextual type (the BookDto property being
 * assigned) rather than inferred from `schema`, since zod's `.optional()`
 * output type (`X | undefined`) conflicts with exactOptionalPropertyTypes on
 * the hand-written @book/types interfaces (`x?: X`) even though safeParse
 * never actually sets a key to `undefined` on parsed JSON.
 */
function parseJsonField<T>(schema: ZodTypeAny, value: unknown, fieldName: string, bookId: string): T | null {
  if (value === null || value === undefined) return null;
  const result = schema.safeParse(value);
  if (!result.success) {
    logger.warn(`Book ${bookId}: stored ${fieldName} does not match the expected shape; returning null.`);
    return null;
  }
  return result.data as T;
}

export function toBookDto(book: Book): BookDto {
  return {
    id: book.id,
    userId: book.userId,
    title: book.title,
    childName: book.childName,
    childAge: book.childAge,
    language: book.language as unknown as SupportedLanguage | null,
    theme: book.theme,
    educationalMessage: book.educationalMessage,
    pageCount: book.pageCount,
    status: book.status as unknown as BookStatus,
    characterCard: parseJsonField(characterCardSchema, book.characterCard, 'characterCard', book.id),
    storyPlan: parseJsonField(storyPlanSchema, book.storyPlan, 'storyPlan', book.id),
    bookPreview: parseJsonField(bookPreviewSchema, book.bookPreview, 'bookPreview', book.id),
    imageGenerationResult: parseJsonField(
      imageGenerationResultSchema,
      book.imageGenerationResult,
      'imageGenerationResult',
      book.id,
    ),
    bookLayout: parseJsonField(bookLayoutSchema, book.bookLayout, 'bookLayout', book.id),
    previewPdfUrl: book.previewPdfUrl,
    createdAt: book.createdAt.toISOString(),
    updatedAt: book.updatedAt.toISOString(),
  };
}
