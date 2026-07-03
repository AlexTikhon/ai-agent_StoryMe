import type { Book } from '@prisma/client';
import {
  BookStatus,
  SupportedLanguage,
  type BookDto,
  type BookLayout,
  type BookPreview,
  type CharacterCard,
  type ImageGenerationResult,
  type StoryPlan,
} from '@book/types';

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
    characterCard: book.characterCard as unknown as CharacterCard | null,
    storyPlan: book.storyPlan as unknown as StoryPlan | null,
    bookPreview: book.bookPreview as unknown as BookPreview | null,
    imageGenerationResult: book.imageGenerationResult as unknown as ImageGenerationResult | null,
    bookLayout: book.bookLayout as unknown as BookLayout | null,
    previewPdfUrl: book.previewPdfUrl,
    createdAt: book.createdAt.toISOString(),
    updatedAt: book.updatedAt.toISOString(),
  };
}
